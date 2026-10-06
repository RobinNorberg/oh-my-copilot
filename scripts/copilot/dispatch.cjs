#!/usr/bin/env node
'use strict';
/**
 * Copilot CLI per-event hook dispatcher (fork-owned, oh-my-copilot).
 *
 * copilot/hooks.json has one entry per (event, matcher) group of
 * hooks/hooks.json, and each entry runs this file:
 *
 *   node --require <root>/scripts/lib/copilot-hook-adapter.cjs \
 *        <root>/scripts/copilot/dispatch.cjs <Event> <script> [args]... [-- <script> [args]...]...
 *   env OMC_HOOK_EVENT=<Event>
 *
 * argv: the event name, then one segment per hook, segments separated by a
 * literal `--`. A segment is the hook script path followed by its extra args
 * (`subagent-tracker.mjs start`). A hook arg can therefore never be `--`;
 * scripts/copilot/build-hooks.mjs rejects one. See encodeDispatchArgv().
 *
 * The payload is read from stdin once. Each hook then runs in order through
 * scripts/run.cjs `runResolvedHook()`, the same routing and manifest timeouts
 * as a direct `run.cjs <script>` call: a Worker for the audited hooks, and the
 * supervised child for entries whose manifest timeout is at most
 * COPILOT_WORKER_MIN_TIMEOUT_MS. The adapter `transform()` is applied to each
 * hook's own stdout and exit code, and the results are merged (mergeHookResults):
 *   - additionalContext and systemMessage: joined with "\n" in hook order
 *     (top level and hookSpecificOutput alike).
 *   - PreToolUse: any `deny` wins, and the first deny reason is kept.
 *   - decision:'block' (Stop/SubagentStop): the first block and its reason win;
 *     later hooks still run. continue:false + block still means "allow the
 *     stop" (adapter rule), now across hooks.
 *   - continue:false: the first one wins, with its stopReason.
 *   - suppressOutput:true only when every object output says so.
 *   - any other key: the first hook that set it wins.
 *   - non-JSON stdout next to JSON output is dropped with an `[omg-hook]` note,
 *     because the host could not parse the combined text.
 *   - exit code: 124 if any hook timed out under OMC_HOOK_FAIL_CLOSED=1, else
 *     the highest per-hook code. Without fail-closed transform() already maps
 *     every code to 0 (one `[omg-hook]` stderr line per failing hook), except
 *     PermissionRequest exit 2, which is kept.
 * A group with a single non-empty output is passed through byte for byte.
 *
 * Kill switch: OMC_COPILOT_HOOK_DISPATCH=0 runs each hook the old way, as its
 * own `node --require adapter run.cjs <script>` process, one after another,
 * and merges their already-adapted outputs with the same rules. No
 * regeneration is needed to compare the two paths live.
 *
 * Claude Code never runs this file (hooks/hooks.json is untouched).
 */

const { spawn } = require('child_process');
const path = require('path');
const { statSync } = require('fs');
const { Writable } = require('stream');
const { transform, parseHookOutput, writeAllSync } = require('../lib/copilot-hook-adapter.cjs');

const SCRIPTS_DIR = path.join(__dirname, '..');
const RUN_CJS = path.join(SCRIPTS_DIR, 'run.cjs');
const ADAPTER = path.join(SCRIPTS_DIR, 'lib', 'copilot-hook-adapter.cjs');
const HOOK_SEPARATOR = '--';
const TIMEOUT_STATUS = 124;
const STDERR_TAIL_BYTES = 4096;
const STOP_EVENTS = new Set(['Stop', 'SubagentStop']);
const EVENT_PATTERN = /^[A-Z][A-Za-z]+$/;
// Kill-switch path only: grace past a child's manifest timeout before the
// dispatcher stops waiting for a run.cjs that failed to enforce its own.
const LEGACY_OUTER_GRACE_MS = 2000;
const LEGACY_CLOSE_SETTLE_MS = 300;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** argv after the script path → { event, hooks: [{ script, args }] }. Throws on a malformed list. */
function parseDispatchArgv(argv) {
  const [event, ...rest] = argv;
  if (!event || !EVENT_PATTERN.test(event)) throw new Error(`invalid event name: ${event || '(none)'}`);
  const hooks = [];
  let current = null;
  for (const arg of rest) {
    if (arg === HOOK_SEPARATOR) {
      if (!current) throw new Error('empty hook segment');
      hooks.push(current);
      current = null;
    } else if (!current) {
      current = { script: arg, args: [] };
    } else {
      current.args.push(arg);
    }
  }
  if (!current) throw new Error(hooks.length ? 'trailing hook separator' : 'no hook scripts');
  hooks.push(current);
  return { event, hooks };
}

/** Inverse of parseDispatchArgv. Throws on an arg it could not round-trip. */
function encodeDispatchArgv(event, hooks) {
  if (!EVENT_PATTERN.test(event)) throw new Error(`invalid event name: ${event}`);
  if (!Array.isArray(hooks) || hooks.length === 0) throw new Error('no hook scripts');
  const argv = [event];
  hooks.forEach(({ script, args = [] }, index) => {
    for (const value of [script, ...args]) {
      if (typeof value !== 'string' || value === '' || value === HOOK_SEPARATOR) {
        throw new Error(`hook argument cannot be encoded: ${JSON.stringify(value)}`);
      }
    }
    if (index > 0) argv.push(HOOK_SEPARATOR);
    argv.push(script, ...args);
  });
  return argv;
}

/** 124 (a fail-closed timeout) beats every other code; otherwise the highest code wins. */
function mergeExitCodes(codes) {
  if (codes.includes(TIMEOUT_STATUS)) return TIMEOUT_STATUS;
  return codes.reduce((worst, code) => (Number.isInteger(code) && code > worst ? code : worst), 0);
}

const JOINED_KEYS = new Set(['additionalContext', 'systemMessage']);
const DECISION_KEYS = new Set(['permissionDecision', 'permissionDecisionReason']);

function firstDeny(objects) {
  for (const object of objects) {
    if (object.permissionDecision === 'deny') {
      return { reason: object.permissionDecisionReason };
    }
  }
  return null;
}

/**
 * Merge objects key by key in first-seen order (see the header for the rules).
 * `nested` is true for hookSpecificOutput, which carries no continue/block.
 */
function mergeObjects(event, objects, nested) {
  const merged = {};
  const order = [];
  for (const object of objects) {
    for (const key of Object.keys(object)) if (!order.includes(key)) order.push(key);
  }
  const deny = event === 'PreToolUse' ? firstDeny(objects) : null;
  const stop = nested ? null : objects.find(object => object.continue === false);
  const block = nested ? null : objects.find(object => object.decision === 'block');
  for (const key of order) {
    const holders = objects.filter(object => Object.prototype.hasOwnProperty.call(object, key));
    const first = holders[0][key];
    if (JOINED_KEYS.has(key)) {
      const parts = holders.map(object => object[key]).filter(nonEmptyString);
      merged[key] = parts.length ? parts.join('\n') : first;
    } else if (key === 'hookSpecificOutput') {
      const nestedObjects = holders.map(object => object[key]).filter(isPlainObject);
      merged[key] = nestedObjects.length ? mergeObjects(event, nestedObjects, true) : first;
    } else if (DECISION_KEYS.has(key) && deny) {
      merged[key] = key === 'permissionDecision' ? 'deny' : deny.reason;
    } else if (key === 'continue' && stop) {
      merged[key] = false;
    } else if (key === 'stopReason' && stop) {
      merged[key] = stop.stopReason;
    } else if (key === 'decision' && block) {
      merged[key] = 'block';
    } else if (key === 'reason' && block) {
      merged[key] = block.reason;
    } else if (key === 'suppressOutput' && !nested) {
      if (objects.every(object => object.suppressOutput === true)) merged[key] = true;
    } else {
      merged[key] = first;
    }
  }
  if (deny && !Object.prototype.hasOwnProperty.call(merged, 'permissionDecisionReason') && deny.reason !== undefined) {
    merged.permissionDecisionReason = deny.reason;
  }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged;
}

/**
 * Merge adapted per-hook results ({ script, stdout, exitCode, stderr? }, in
 * hook order) into one host response { stdout, exitCode, stderr }.
 */
function mergeHookResults(event, results) {
  const notes = [];
  const exitCode = mergeExitCodes(results.map(result => result.exitCode));
  const finish = stdout => ({ stdout, exitCode, stderr: notes.map(line => `${line}\n`).join('') });
  const outputs = results.filter(result => String(result.stdout || '').trim() !== '');
  if (outputs.length === 0) return finish('');
  if (outputs.length === 1) return finish(outputs[0].stdout);

  const objects = [];
  const raw = [];
  for (const result of outputs) {
    const parsed = parseHookOutput(result.stdout);
    if (parsed.kind === 'object') objects.push({ result, value: parsed.value });
    else raw.push(result);
  }
  if (objects.length === 0) {
    return finish(raw.map(result => (result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`)).join(''));
  }
  for (const result of raw) {
    notes.push(`[omg-hook] ${event}: dropped non-JSON stdout of ${path.basename(result.script || 'hook')} while merging`);
  }
  if (objects.length === 1) return finish(objects[0].result.stdout);

  let merged = mergeObjects(event, objects.map(entry => entry.value), false);
  if (STOP_EVENTS.has(event) && merged.continue === false && merged.decision === 'block') {
    const reason = nonEmptyString(merged.stopReason) ? merged.stopReason : (nonEmptyString(merged.reason) ? merged.reason : '');
    notes.push(`[omg-hook] ${event}: continue:false overrides decision:block; allowing stop${reason ? `: ${reason}` : ''}`);
    merged = {};
  }
  return finish(`${JSON.stringify(merged)}\n`);
}

function failClosedEnabled(env = process.env) {
  return env.OMC_HOOK_FAIL_CLOSED === '1';
}

/** Collects every chunk written to it. */
function createCollector() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  stream.text = () => Buffer.concat(chunks).toString('utf8');
  return stream;
}

/** Forwards each chunk to fd 2 at once and keeps the tail for transform(). */
function createStderrTee() {
  let tail = Buffer.alloc(0);
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      writeAllSync(2, buffer);
      const next = Buffer.concat([tail, buffer]);
      tail = next.length > STDERR_TAIL_BYTES ? next.subarray(next.length - STDERR_TAIL_BYTES) : next;
      callback();
    },
  });
  stream.tail = () => tail.toString('utf8');
  return stream;
}

/**
 * The adapter's run.cjs target check, per hook: a note for a non-file target,
 * and a final exit code when the old path would have exited before run.cjs.
 */
function checkHookTarget(event, script, env = process.env) {
  let stat = null;
  try {
    stat = statSync(script);
  } catch {
    stat = null;
  }
  if (stat && stat.isFile()) return null;
  writeAllSync(2, `[omg-hook] ${event}: hook target is not a file: ${script}\n`);
  const strict = env.OMC_HOOK_STRICT === '1';
  if (strict || stat) return { exitCode: strict ? 1 : 0 };
  return null;
}

/** Default path: one hook through run.cjs routing inside this process. */
async function runHookInProcess(event, hook, input) {
  const started = Date.now();
  const early = checkHookTarget(event, hook.script);
  if (early) return { script: hook.script, stdout: '', exitCode: early.exitCode, ms: Date.now() - started };
  const runCjs = require(RUN_CJS);
  const stdout = createCollector();
  const stderr = createStderrTee();
  const resolution = runCjs.resolveTarget(hook.script);
  const status = resolution
    ? await runCjs.runResolvedHook(resolution, hook.args, { input, stdout, stderr })
    : 0;
  let adapted;
  try {
    adapted = transform(event, {
      stdout: stdout.text(),
      exitCode: status,
      stderrTail: stderr.tail(),
      failClosed: failClosedEnabled(),
      script: hook.script,
      debug: Boolean(process.env.OMC_DEBUG_HOOKS),
    });
  } catch (error) {
    adapted = {
      stdout: stdout.text(),
      exitCode: failClosedEnabled() ? status : 0,
      stderr: `[omg-hook] ${event} adapter error: ${error && error.message ? error.message : String(error)}\n`,
    };
  }
  if (adapted.stderr) writeAllSync(2, adapted.stderr);
  return { script: hook.script, stdout: adapted.stdout, exitCode: adapted.exitCode, ms: Date.now() - started };
}

/** Kill-switch path: the old per-hook process, `node --require adapter run.cjs <script> [args]`. */
function runHookAsProcess(event, hook, input) {
  const started = Date.now();
  const { resolveHookTimeoutMs, MAX_DECLARED_GENERIC_TIMEOUT_MS } = require(RUN_CJS);
  let manifestTimeoutMs = MAX_DECLARED_GENERIC_TIMEOUT_MS;
  try {
    manifestTimeoutMs = resolveHookTimeoutMs(hook.script, hook.args)?.timeoutMs || manifestTimeoutMs;
  } catch {
    // Unknown script: keep the generic maximum.
  }
  return new Promise(resolve => {
    const stdout = [];
    let settled = false;
    let exitTimer;
    let child;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(outerTimer);
      clearTimeout(exitTimer);
      resolve({ script: hook.script, stdout: Buffer.concat(stdout).toString('utf8'), exitCode, ms: Date.now() - started });
    };
    const outerTimer = setTimeout(() => {
      writeAllSync(2, `[omg-hook] ${event}: ${path.basename(hook.script)} exceeded ${manifestTimeoutMs}ms in the per-hook process; abandoning it\n`);
      try { child.kill(); } catch { /* already gone */ }
      finish(failClosedEnabled() ? TIMEOUT_STATUS : 0);
    }, manifestTimeoutMs + LEGACY_OUTER_GRACE_MS);
    try {
      child = spawn(process.execPath, ['--require', ADAPTER, RUN_CJS, hook.script, ...hook.args], {
        env: {
          ...process.env,
          OMC_HOOK_EVENT: event,
          // The per-hook process's parent is this dispatcher, not the host.
          OMC_SESSION_OWNER_PID: process.env.OMC_SESSION_OWNER_PID || String(process.ppid),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      writeAllSync(2, `[omg-hook] ${event}: cannot start ${path.basename(hook.script)}: ${error.message}\n`);
      finish(0);
      return;
    }
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => writeAllSync(2, chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.once('error', (error) => {
      writeAllSync(2, `[omg-hook] ${event}: cannot start ${path.basename(hook.script)}: ${error.message}\n`);
      finish(0);
    });
    child.once('exit', (code) => {
      // A leaked descendant may keep the pipes open; do not wait on it for long.
      exitTimer = setTimeout(() => finish(typeof code === 'number' ? code : 0), LEGACY_CLOSE_SETTLE_MS);
    });
    child.once('close', (code) => finish(typeof code === 'number' ? code : 0));
  });
}

function readStdin() {
  return new Promise(resolve => {
    const chunks = [];
    if (!process.stdin || process.stdin.isTTY) {
      resolve(Buffer.alloc(0));
      return;
    }
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.once('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.once('error', () => resolve(Buffer.concat(chunks)));
  });
}

async function dispatch(event, hooks, input) {
  const legacy = process.env.OMC_COPILOT_HOOK_DISPATCH === '0';
  const debug = Boolean(process.env.OMC_DEBUG_HOOKS);
  const results = [];
  for (const hook of hooks) {
    const result = legacy ? await runHookAsProcess(event, hook, input) : await runHookInProcess(event, hook, input);
    if (debug) {
      writeAllSync(2, `[omg-hook] ${event} dispatch${legacy ? ' (per-hook processes)' : ''}: ${path.basename(hook.script)} ${result.ms}ms exit ${result.exitCode}\n`);
    }
    results.push(result);
  }
  return mergeHookResults(event, results);
}

async function main() {
  let parsed;
  try {
    parsed = parseDispatchArgv(process.argv.slice(2));
  } catch (error) {
    writeAllSync(2, `[omg-hook] dispatch: ${error.message}\n`);
    process.exitCode = failClosedEnabled() ? 1 : 0;
    return;
  }
  // run.cjs routing (Copilot Worker path, SessionEnd budget) reads the event from the env.
  process.env.OMC_HOOK_EVENT = parsed.event;
  const input = await readStdin();
  const merged = await dispatch(parsed.event, parsed.hooks, input);
  if (merged.stdout) writeAllSync(1, merged.stdout);
  if (merged.stderr) writeAllSync(2, merged.stderr);
  process.exitCode = merged.exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    writeAllSync(2, `[omg-hook] dispatch error: ${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = failClosedEnabled() ? 1 : 0;
  });
}

module.exports = {
  HOOK_SEPARATOR,
  parseDispatchArgv,
  encodeDispatchArgv,
  mergeExitCodes,
  mergeHookResults,
  dispatch,
};
