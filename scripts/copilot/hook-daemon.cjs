#!/usr/bin/env node
'use strict';
/**
 * Opt-in warm hook daemon for the Copilot per-event dispatcher (fork-owned,
 * oh-my-copilot). Off unless OMC_COPILOT_HOOK_DAEMON=1; `=0` or unset keeps
 * every hook on the cold path, dispatch.cjs running the group in its own
 * process. See docs/DEVELOPERS.md "Warm hook daemon".
 *
 * Client (runViaDaemon, called by dispatch.cjs main() after it read stdin):
 * when every hook of the group is daemon-safe (DAEMON_SAFE_HOOKS) it sends
 * the group, the payload, its env, cwd and parent pid to the daemon for this
 * key over a named pipe (Windows) or a unix socket in a 0700 directory, and
 * authenticates with the random token from the daemon's 0600 metadata file.
 * It returns the merged { stdout, stderr, exitCode }, or null on ANY problem
 * (no daemon, stale metadata, refused, busy, version mismatch, protocol
 * error, timeout, dropped connection). On null the dispatcher runs the group
 * itself, exactly as without the daemon. A missing daemon is started
 * detached for the next hook; this hook never waits for it.
 *
 * Daemon (`hook-daemon.cjs --serve`): one per key, the key being the plugin
 * root, package version, the main-thread code (dispatch.cjs, run.cjs, the
 * adapter, this file), node binary and version, host pid and cwd. It runs
 * the request through the same dispatch() as the cold path, after it set
 * process.env to the client's env, chdir'd to the client's cwd and set
 * process.ppid to the client's parent, so every hook keeps its Worker or
 * supervised-child routing, timeouts, merge rules and exit code. Hook code
 * never runs on the daemon's main thread: each hook gets a fresh Worker or
 * child process, as on the cold path. What run.cjs writes to the process's
 * own stdout/stderr during the request is captured for that request.
 * Requests run one at a time; a concurrent one is refused as busy.
 *
 * Lifecycle: exits after OMC_COPILOT_HOOK_DAEMON_IDLE_MS idle (default 10
 * min), when the host pid is gone, after MAX_REQUESTS, and right after a
 * request in which a hook timed out, threw, exited other than 0 or 2, or the
 * client hung up early, so nothing a killed hook left behind outlives the
 * request by more than the cold dispatcher would. A lock file (O_EXCL, pid +
 * nonce, touched every 15 s) keeps one daemon per key; a lock whose owner is
 * dead or that went untouched for 60 s is reclaimed. Its stdio is ignored and
 * it never writes to the client's stdout; the client writes the merged
 * result once, as the dispatcher does.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const PROTOCOL = 1;
const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const DISPATCH_CJS = path.join(__dirname, 'dispatch.cjs');
const RUN_CJS = path.join(SCRIPTS_DIR, 'run.cjs');
const ADAPTER = path.join(SCRIPTS_DIR, 'lib', 'copilot-hook-adapter.cjs');
// The modules that run on the daemon's main thread. Hooks are loaded fresh per run.
const CODE_FILES = [DISPATCH_CJS, RUN_CJS, ADAPTER, __filename];
const EVENT_PATTERN = /^[A-Z][A-Za-z]+$/;

/**
 * Hooks that may run in the daemon. Audited with their whole module closure
 * (docs/DEVELOPERS.md "Daemon safety"): no lock whose staleness depends on
 * the owner pid being dead, no process.ppid, no exit or signal handlers in
 * the host, no async non-detached children, no stdio inheritance. A value is
 * a payload guard that returns a reason when this payload takes an unsafe path.
 */
const DAEMON_SAFE_HOOKS = new Map([
  ['budget-guard.mjs', null],
  ['code-simplifier.mjs', null],
  ['context-guard-stop.mjs', null],
  ['git-guardrails.mjs', null],
  ['permission-handler.mjs', null],
  ['post-tool-directory-context-injector.mjs', null],
  ['post-tool-rules-injector.mjs', null],
  // The AskUserQuestion branch imports dist/notifications, whose session
  // registry lock is reclaimed only once its owner pid is dead.
  ['pre-tool-enforcer.mjs', payload => (
    payload && (payload.tool_name === 'AskUserQuestion' || payload.toolName === 'AskUserQuestion')
      ? 'pre-tool-enforcer.mjs AskUserQuestion branch is not daemon-safe'
      : null
  )],
  ['runs-reconciler.mjs', null],
  ['stale-run-reporter.mjs', null],
  ['verify-deliverables.mjs', null],
  ['workflow-drift-guard.mjs', null],
]);

const CONNECT_TIMEOUT_MS = 300;
const ACCEPT_TIMEOUT_MS = 1000;
const REPLY_GRACE_MS = 3000;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const HOST_POLL_MS = 2000;
const LOCK_TOUCH_MS = 15000;
const LOCK_STALE_MS = 60000;
const SPAWN_THROTTLE_MS = 10000;
const MAX_REQUESTS = 1000;
const DRAIN_MS = 2000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_SOCKET_PATH = 100;
const DEFAULT_HOOK_BUDGET_MS = 60000;

function daemonEnabled(env = process.env) {
  return env.OMC_COPILOT_HOOK_DAEMON === '1';
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function realpathOrNull(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

/** null when every hook may run in the daemon for this payload, else the reason it may not. */
function ineligibleReason(event, hooks, input, env = process.env) {
  if (!EVENT_PATTERN.test(String(event))) return 'invalid event';
  if (env.OMC_COPILOT_HOOK_DISPATCH === '0') return 'kill switch OMC_COPILOT_HOOK_DISPATCH=0';
  if (!env.CLAUDE_PLUGIN_ROOT) return 'CLAUDE_PLUGIN_ROOT unset';
  const pluginRoot = realpathOrNull(env.CLAUDE_PLUGIN_ROOT);
  const root = realpathOrNull(ROOT);
  if (!pluginRoot || !root || !samePath(pluginRoot, root)) return 'CLAUDE_PLUGIN_ROOT is not this plugin';
  if (!Array.isArray(hooks) || hooks.length === 0) return 'no hooks';
  let payload;
  for (const hook of hooks) {
    if (!hook || typeof hook.script !== 'string' || !Array.isArray(hook.args) || !hook.args.every(arg => typeof arg === 'string')) {
      return 'malformed hook';
    }
    const name = path.basename(hook.script);
    if (!DAEMON_SAFE_HOOKS.has(name)) return `${name} is not daemon-safe`;
    const target = realpathOrNull(hook.script);
    if (!target || !samePath(target, path.join(root, 'scripts', name))) return `${name} is not this plugin's script`;
    const guard = DAEMON_SAFE_HOOKS.get(name);
    if (guard) {
      if (payload === undefined) {
        try {
          payload = JSON.parse(Buffer.isBuffer(input) ? input.toString('utf8') : String(input || ''));
        } catch {
          payload = null;
        }
      }
      const reason = guard(payload);
      if (reason) return reason;
    }
  }
  return null;
}

function packageVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
}

/** Size and mtime of the main-thread modules: an in-place edit gets a new daemon. */
function codeFingerprint() {
  return CODE_FILES.map((file) => {
    const stat = fs.statSync(file);
    return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  }).join(',');
}

/** The user-level OMC state directory for daemon files: <config dir>/.omg/state/hook-daemon. */
function daemonDir() {
  const { getOmcConfigDir } = require('../lib/config-dir.cjs');
  return path.join(getOmcConfigDir(), 'state', 'hook-daemon');
}

/**
 * Create the directory 0700 and refuse one another user owns or others can
 * enter (POSIX). Windows relies on the profile directory's ACL. true when usable.
 */
function ensurePrivateDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') return true;
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== process.getuid()) return false;
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
    return (fs.statSync(dir).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function filesFor(dir, key) {
  return {
    meta: path.join(dir, `${key}.json`),
    lock: path.join(dir, `${key}.lock`),
    spawn: path.join(dir, `${key}.spawn`),
    socket: path.join(dir, `${key}.sock`),
  };
}

/** The client's view: key, version, code fingerprint and file paths, or a reason string. */
function clientContext() {
  const version = packageVersion();
  if (!version) return 'no package version';
  const code = codeFingerprint();
  const hostPid = process.ppid;
  const cwd = process.cwd();
  const key = crypto.createHash('sha256')
    .update(JSON.stringify([PROTOCOL, ROOT, version, code, process.execPath, process.version, hostPid, cwd]))
    .digest('hex')
    .slice(0, 24);
  const dir = daemonDir();
  const files = filesFor(dir, key);
  if (process.platform !== 'win32' && Buffer.byteLength(files.socket) > MAX_SOCKET_PATH) return 'socket path too long';
  return { version, code, hostPid, cwd, key, dir, files };
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/** A lock held by a live pid and touched within LOCK_STALE_MS. */
function lockIsLive(lockFile) {
  try {
    const stat = fs.statSync(lockFile);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return false;
    const owner = readJson(lockFile);
    return Boolean(owner && pidAlive(owner.pid));
  } catch {
    return false;
  }
}

/** Start a daemon for this key unless one is live or one was started in the last SPAWN_THROTTLE_MS. */
function maybeSpawnDaemon(ctx) {
  try {
    if (lockIsLive(ctx.files.lock)) return 'daemon is starting';
    if (!ensurePrivateDir(ctx.dir)) return 'state directory is not private';
    try {
      if (Date.now() - fs.statSync(ctx.files.spawn).mtimeMs < SPAWN_THROTTLE_MS) return 'daemon start throttled';
    } catch {
      // No recent start.
    }
    fs.writeFileSync(ctx.files.spawn, String(process.pid), { mode: 0o600 });
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [__filename, '--serve', ctx.key, String(ctx.hostPid), ctx.dir], {
      cwd: ctx.dir,
      env: process.env,
      // detached: on Windows libuv would otherwise put it in this process's kill-on-close job.
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
    return 'daemon started for the next hook';
  } catch (error) {
    return `daemon start failed: ${error && error.message ? error.message : String(error)}`;
  }
}

function encodeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

/**
 * One request over one connection: request line, accept line, done line.
 * Resolves { ok: true, reply } or { ok: false, reason, stale }.
 */
function exchange(endpoint, request) {
  return new Promise((resolve) => {
    let settled = false;
    let phase = 'connect';
    let timer = null;
    let buffered = '';
    const socket = net.connect(endpoint);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ ok: false, reason: `${phase} timeout`, stale: phase === 'connect' }), ms);
    };
    arm(CONNECT_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      phase = 'accept';
      arm(ACCEPT_TIMEOUT_MS);
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffered += chunk;
      if (buffered.length > MAX_FRAME_BYTES * 2) return finish({ ok: false, reason: 'reply too large' });
      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return finish({ ok: false, reason: 'protocol error' });
        }
        if (phase === 'accept') {
          if (!message || message.accepted !== true) {
            return finish({ ok: false, reason: `refused: ${message && message.reason ? message.reason : 'unknown'}` });
          }
          phase = 'run';
          const budget = Number.isInteger(message.budgetMs) && message.budgetMs > 0
            ? message.budgetMs
            : DEFAULT_HOOK_BUDGET_MS * request.hooks.length;
          arm(budget + REPLY_GRACE_MS);
        } else if (phase === 'run') {
          const valid = message && message.done === true && typeof message.stdout === 'string' &&
            typeof message.stderr === 'string' && Number.isInteger(message.exitCode);
          return finish(valid ? { ok: true, reply: message } : { ok: false, reason: 'protocol error' });
        }
      }
      return undefined;
    });
    socket.on('error', error => finish({ ok: false, reason: error.code || error.message, stale: phase === 'connect' }));
    socket.on('close', () => finish({ ok: false, reason: `connection closed during ${phase}`, stale: phase === 'connect' }));
  });
}

/**
 * Run the group in the warm daemon. Resolves the merged result, or null when
 * the caller must run the group itself. Never rejects.
 */
async function runViaDaemon(event, hooks, input) {
  const debug = Boolean(process.env.OMC_DEBUG_HOOKS);
  const started = Date.now();
  const { writeAllSync } = require(ADAPTER);
  const cold = (reason) => {
    if (debug) writeAllSync(2, `[omg-hook] ${event} daemon: ${reason}; running in this process\n`);
    return null;
  };
  try {
    if (!daemonEnabled()) return cold('off');
    const ineligible = ineligibleReason(event, hooks, input);
    if (ineligible) return cold(ineligible);
    const ctx = clientContext();
    if (typeof ctx === 'string') return cold(ctx);
    const meta = readJson(ctx.files.meta);
    if (!meta || typeof meta.endpoint !== 'string' || typeof meta.token !== 'string') {
      return cold(`no daemon (${maybeSpawnDaemon(ctx)})`);
    }
    if (meta.protocol !== PROTOCOL || meta.version !== ctx.version || meta.code !== ctx.code) {
      return cold('daemon metadata does not match this plugin');
    }
    const result = await exchange(meta.endpoint, {
      op: 'run',
      protocol: PROTOCOL,
      token: meta.token,
      version: ctx.version,
      code: ctx.code,
      event,
      hooks: hooks.map(hook => ({ script: hook.script, args: hook.args })),
      input: (Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''))).toString('base64'),
      env: encodeEnv(process.env),
      cwd: ctx.cwd,
      ppid: ctx.hostPid,
    });
    if (!result.ok) {
      const note = result.stale ? ` (${maybeSpawnDaemon(ctx)})` : '';
      return cold(`${result.reason}${note}`);
    }
    const stderr = Buffer.from(result.reply.stderr, 'base64');
    const served = debug
      ? Buffer.from(`[omg-hook] ${event} daemon: served by pid ${meta.pid} in ${Date.now() - started}ms\n`)
      : Buffer.alloc(0);
    return {
      stdout: Buffer.from(result.reply.stdout, 'base64'),
      stderr: Buffer.concat([stderr, served]),
      exitCode: result.reply.exitCode,
    };
  } catch (error) {
    return cold(`error: ${error && error.message ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Daemon side.

function idleMsFrom(env) {
  const raw = String(env.OMC_COPILOT_HOOK_DAEMON_IDLE_MS ?? '').trim();
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value >= 500 && value <= 24 * 60 * 60 * 1000) return value;
  }
  return DEFAULT_IDLE_MS;
}

/** O_EXCL lock with stale reclaim. Returns the owner record, or null when another daemon holds it. */
function acquireLock(lockFile) {
  const owner = { pid: process.pid, nonce: crypto.randomBytes(16).toString('hex'), startedAt: Date.now() };
  const create = () => {
    const fd = fs.openSync(lockFile, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(owner));
    } finally {
      fs.closeSync(fd);
    }
    return owner;
  };
  try {
    return create();
  } catch (error) {
    if (!error || error.code !== 'EEXIST') return null;
  }
  const previous = readJson(lockFile);
  if (lockIsLive(lockFile)) return null;
  // Stale: move it aside, and only proceed when what was moved is what was judged stale.
  const aside = `${lockFile}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lockFile, aside);
  } catch {
    return null;
  }
  const moved = readJson(aside);
  if (!previous || !moved || moved.nonce !== previous.nonce) {
    // Another daemon reclaimed it between the read and the rename: put its lock back.
    try { fs.renameSync(aside, lockFile); } catch { /* it keeps running; this one exits */ }
    return null;
  }
  try { fs.unlinkSync(aside); } catch { /* best effort */ }
  try {
    return create();
  } catch {
    return null;
  }
}

function removeIfOwned(file, field, value) {
  try {
    const record = readJson(file);
    if (record && record[field] === value) fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/** Replace process.env in place, so it stays the real (on Windows case-insensitive) env object. */
function replaceEnv(next) {
  for (const key of Object.keys(process.env)) if (!Object.prototype.hasOwnProperty.call(next, key)) delete process.env[key];
  for (const [key, value] of Object.entries(next)) process.env[key] = value;
}

function setPpid(value) {
  Object.defineProperty(process, 'ppid', { configurable: true, enumerable: true, writable: false, value });
}

function toBuffer(chunk, encoding) {
  return Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
}

/** Send `stream.write` into `sink` until the returned restore function runs. */
function captureWrites(stream, sink) {
  const original = stream.write;
  stream.write = function captureWrite(chunk, encoding, callback) {
    const done = typeof encoding === 'function' ? encoding : callback;
    sink.push(toBuffer(chunk, encoding));
    if (typeof done === 'function') process.nextTick(done);
    return true;
  };
  return () => {
    stream.write = original;
  };
}

function validRequest(request) {
  return request && typeof request === 'object' &&
    typeof request.event === 'string' && EVENT_PATTERN.test(request.event) &&
    Array.isArray(request.hooks) && request.hooks.length > 0 &&
    request.hooks.every(hook => hook && typeof hook.script === 'string' && Array.isArray(hook.args) && hook.args.every(arg => typeof arg === 'string')) &&
    typeof request.input === 'string' &&
    request.env && typeof request.env === 'object' && !Array.isArray(request.env) &&
    Object.values(request.env).every(value => typeof value === 'string') &&
    typeof request.cwd === 'string' && path.isAbsolute(request.cwd) &&
    Number.isInteger(request.ppid) && request.ppid > 0;
}

function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(given);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function serve(key, hostPid, dir) {
  if (!/^[0-9a-f]{24}$/.test(key) || !Number.isInteger(hostPid) || hostPid <= 0 || !path.isAbsolute(dir)) return;
  if (!ensurePrivateDir(dir)) return;
  const files = filesFor(dir, key);
  const owner = acquireLock(files.lock);
  if (!owner) return;

  const dispatcher = require(DISPATCH_CJS);
  // Loaded now so the first request does not compile it.
  require(RUN_CJS);
  const version = packageVersion();
  const code = codeFingerprint();
  const token = crypto.randomBytes(32).toString('hex');
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\omg-hookd-${key}-${crypto.randomBytes(8).toString('hex')}`
    : files.socket;
  const idleMs = idleMsFrom(process.env);
  const baseEnv = { ...process.env };
  const baseCwd = process.cwd();
  const basePpid = process.ppid;
  let active = 0;
  let served = 0;
  let stopping = false;
  let idleTimer = null;
  const timers = [];
  const sockets = new Set();

  const cleanup = () => {
    removeIfOwned(files.meta, 'token', token);
    removeIfOwned(files.lock, 'nonce', owner.nonce);
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(files.socket); } catch { /* already gone */ }
    }
  };
  process.on('exit', cleanup);
  const exitNow = () => {
    process.exit(0);
  };
  // Exit once every client has read its reply and hung up, or after DRAIN_MS.
  const exitWhenDrained = () => {
    if (sockets.size === 0) exitNow();
    else setTimeout(exitNow, DRAIN_MS).unref();
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // New clients must not find this daemon any more.
    removeIfOwned(files.meta, 'token', token);
    for (const timer of timers) clearInterval(timer);
    clearTimeout(idleTimer);
    server.close();
    if (active === 0) exitWhenDrained();
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (active > 0 ? armIdle() : stop()), idleMs);
    idleTimer.unref();
  };
  process.on('uncaughtException', () => exitNow());
  process.on('unhandledRejection', () => exitNow());

  const handle = async (socket, request) => {
    const refuse = (reason) => {
      socket.end(`${JSON.stringify({ accepted: false, reason })}\n`);
    };
    if (!request || request.protocol !== PROTOCOL || !tokenMatches(token, request.token)) return refuse('unauthorized');
    if (request.version !== version || request.code !== code) {
      refuse('version mismatch');
      return stop();
    }
    if (request.op === 'shutdown') {
      socket.end(`${JSON.stringify({ accepted: true })}\n`);
      return stop();
    }
    if (request.op !== 'run' || !validRequest(request)) return refuse('malformed request');
    if (stopping) return refuse('stopping');
    // One request at a time: process.env, cwd, ppid and the main-thread stdio belong to it.
    if (active > 0) return refuse('busy');
    const input = Buffer.from(request.input, 'base64');
    // Re-check with the client's env: the daemon runs only what the client could have sent it.
    const ineligible = ineligibleReason(request.event, request.hooks, input, request.env);
    if (ineligible) return refuse(ineligible);
    try {
      process.chdir(request.cwd);
    } catch {
      return refuse('cwd unavailable');
    }
    active = 1;
    clearTimeout(idleTimer);
    replaceEnv(request.env);
    setPpid(request.ppid);
    // What the cold dispatcher writes to its own stdout/stderr (run.cjs timeout
    // diagnostics, for one) goes to this request, in order with the hook stderr.
    const stdout = [];
    const stderr = [];
    const restoreStdout = captureWrites(process.stdout, stdout);
    const restoreStderr = captureWrites(process.stderr, stderr);
    let budgetMs = null;
    try {
      budgetMs = dispatcher.groupBudgetMs(request.hooks);
    } catch {
      budgetMs = null;
    }
    let replied = false;
    let clientGone = false;
    socket.on('close', () => { if (!replied) clientGone = true; });
    socket.write(`${JSON.stringify({ accepted: true, budgetMs })}\n`);

    const results = [];
    let merged = null;
    try {
      merged = await dispatcher.dispatch(request.event, request.hooks, input, {
        writeStderr: chunk => stderr.push(toBuffer(chunk)),
        results,
      });
    } catch {
      merged = null;
    }
    restoreStdout();
    restoreStderr();
    replaceEnv(baseEnv);
    setPpid(basePpid);
    try { process.chdir(baseCwd); } catch { /* the state dir is gone; keep the cwd */ }
    active = 0;
    served += 1;
    if (merged) {
      stdout.push(toBuffer(merged.stdout || ''));
      stderr.push(toBuffer(merged.stderr || ''));
      replied = true;
      socket.end(`${JSON.stringify({
        done: true,
        stdout: Buffer.concat(stdout).toString('base64'),
        stderr: Buffer.concat(stderr).toString('base64'),
        exitCode: merged.exitCode,
      })}\n`);
    } else {
      // dispatch() itself failed: drop the connection; the client runs the group cold.
      socket.destroy();
    }
    const abnormal = !merged || clientGone || results.some(result => result.timedOut || result.threw ||
      (Number.isInteger(result.status) && result.status !== 0 && result.status !== 2));
    if (abnormal || served >= MAX_REQUESTS) {
      stop();
      return undefined;
    }
    if (stopping && active === 0) exitWhenDrained();
    else if (!stopping) armIdle();
    return undefined;
  };

  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let started = false;
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      if (stopping && active === 0 && sockets.size === 0) exitNow();
    });
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (started) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;
      started = true;
      let request = null;
      try {
        request = JSON.parse(buffered.subarray(0, newline).toString('utf8'));
      } catch {
        request = null;
      }
      void handle(socket, request).catch(() => socket.destroy());
    });
  });
  server.on('error', exitNow);

  if (process.platform !== 'win32') {
    // The lock is held, so a leftover socket file is stale.
    try { fs.unlinkSync(files.socket); } catch { /* none */ }
  }
  server.listen(endpoint, () => {
    if (process.platform !== 'win32') {
      try { fs.chmodSync(files.socket, 0o600); } catch { /* the 0700 directory still guards it */ }
    }
    const meta = {
      protocol: PROTOCOL,
      pid: process.pid,
      version,
      code,
      root: ROOT,
      hostPid,
      endpoint,
      token,
      startedAt: new Date().toISOString(),
    };
    const temp = `${files.meta}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(meta), { mode: 0o600 });
      fs.renameSync(temp, files.meta);
    } catch {
      try { fs.unlinkSync(temp); } catch { /* none */ }
      exitNow();
      return;
    }
    try { fs.unlinkSync(files.spawn); } catch { /* none */ }
    timers.push(setInterval(() => { if (!pidAlive(hostPid)) stop(); }, HOST_POLL_MS));
    timers.push(setInterval(() => {
      try { fs.utimesSync(files.lock, new Date(), new Date()); } catch { stop(); }
    }, LOCK_TOUCH_MS));
    for (const timer of timers) timer.unref();
    armIdle();
    // Warm the Worker machinery once; no hook code runs.
    try {
      const { Worker } = require('worker_threads');
      new Worker('', { eval: true }).on('error', () => {}).unref();
    } catch {
      // Warm-up is optional.
    }
  });
}

if (require.main === module) {
  const [flag, key, hostPid, dir] = process.argv.slice(2);
  if (flag === '--serve') serve(String(key || ''), Number(hostPid), String(dir || ''));
}

module.exports = {
  DAEMON_SAFE_HOOKS,
  PROTOCOL,
  daemonEnabled,
  ineligibleReason,
  clientContext,
  daemonDir,
  runViaDaemon,
};
