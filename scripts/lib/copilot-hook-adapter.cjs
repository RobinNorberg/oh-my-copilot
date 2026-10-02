'use strict';
/**
 * Copilot CLI hook output/exit adapter (fork-owned, oh-my-copilot).
 *
 * Preloaded by the generated copilot/hooks.json only:
 *   node --require <root>/scripts/lib/copilot-hook-adapter.cjs <root>/scripts/run.cjs <script> [args]
 *   env OMC_HOOK_EVENT=<PascalCaseEvent>
 *
 * The upstream hook scripts speak the Claude Code hook contract. Copilot CLI
 * honours a different subset (see the fork's hook evidence notes):
 *   - only TOP-LEVEL `additionalContext` is injected;
 *   - PreToolUse denies via `permissionDecision` (hookSpecificOutput or top
 *     level); `{decision:'block'}` is ignored; a non-zero exit is fail-CLOSED;
 *   - Stop `{decision:'block', reason}` is honoured.
 * This preload buffers stdout, transforms the single JSON object on process
 * exit, writes it with fs.writeSync(1) and rewrites process.exitCode.
 *
 * It is a strict no-op unless OMC_HOOK_EVENT is set, this is the main thread
 * (run.cjs Workers inherit execArgv and therefore load this file too) and the
 * file was loaded through --require/-r. Claude Code never sets OMC_HOOK_EVENT.
 *
 * Documented choices:
 *   - additionalContext hoist: an existing top-level `additionalContext` wins;
 *     the hookSpecificOutput copy is only hoisted when the top level is absent.
 *   - PreToolUse `hookSpecificOutput.updatedInput` is DROPPED: Copilot would
 *     treat it as `modifiedArgs` and replace the `task` tool args with a
 *     Claude-shaped object (subagent_type, model:'opus'), breaking the call.
 *   - Stop/SubagentStop `continue:false` + `decision:'block'` emits `{}`:
 *     Claude precedence (continue:false beats decision), so the turn stops.
 *   - PermissionRequest exit 2 is kept (exit 2 = deny on both hosts).
 *   - Every other non-zero exit becomes 0 plus one `[omg-hook]` stderr line,
 *     so our own bugs never fail closed. OMC_HOOK_FAIL_CLOSED=1 keeps the code.
 *   - Stdout written by other 'exit' listeners after this one ran is dropped.
 *
 * No dependencies; CommonJS; Node 20+.
 */

const fs = require('fs');
const path = require('path');

const STDERR_TAIL_BYTES = 4096;
const STOP_EVENTS = new Set(['Stop', 'SubagentStop']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : '';
}

/**
 * Parse hook stdout: whole text first, then the last line that is a JSON object,
 * then the text from the last line starting with `{` through the end (a
 * pretty-printed object preceded by log lines).
 */
function parseHookOutput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { kind: 'empty' };
  try {
    const value = JSON.parse(trimmed);
    return isPlainObject(value) ? { kind: 'object', value } : { kind: 'raw' };
  } catch {
    // Fall through to the last-line scan.
  }
  const lines = trimmed.split(/\r?\n/);
  let lastBraceLine = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    // Column-0 `{` only: nested objects of pretty JSON are indented.
    if (lastBraceLine === -1 && lines[index].startsWith('{')) lastBraceLine = index;
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (isPlainObject(value)) return { kind: 'object', value };
    } catch {
      // Keep scanning upwards.
    }
  }
  if (lastBraceLine > 0) {
    try {
      const value = JSON.parse(lines.slice(lastBraceLine).join('\n'));
      if (isPlainObject(value)) return { kind: 'object', value };
    } catch {
      // Not a trailing multi-line object.
    }
  }
  return { kind: 'raw' };
}

function denyOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  };
}

function shapeObject(event, input, notes, debug) {
  const output = { ...input };
  let hso = isPlainObject(output.hookSpecificOutput) ? { ...output.hookSpecificOutput } : null;

  if (hso && nonEmptyString(hso.additionalContext) && output.additionalContext === undefined) {
    output.additionalContext = hso.additionalContext;
  }

  if (event === 'PreToolUse') {
    if (hso && Object.prototype.hasOwnProperty.call(hso, 'updatedInput')) {
      delete hso.updatedInput;
      if (debug) notes.push('[omg-hook] PreToolUse: dropped hookSpecificOutput.updatedInput (not portable to Copilot tool args)');
    }

    let denyReason = null;
    if (output.decision === 'block') {
      denyReason = nonEmptyString(output.reason) || 'Blocked by PreToolUse hook';
    } else if (output.continue === false) {
      denyReason = nonEmptyString(output.reason) || nonEmptyString(output.stopReason) ||
        nonEmptyString(output.message) || 'Blocked by PreToolUse hook';
    }
    if (denyReason !== null) {
      hso = {
        ...(hso || {}),
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyReason,
      };
    }

    if (hso && typeof hso.permissionDecision === 'string' &&
        (hso.permissionDecision === 'deny' || output.permissionDecision === undefined)) {
      output.permissionDecision = hso.permissionDecision;
      if (typeof hso.permissionDecisionReason === 'string') {
        output.permissionDecisionReason = hso.permissionDecisionReason;
      }
    }
  }

  if (hso) output.hookSpecificOutput = hso;

  if (STOP_EVENTS.has(event) && output.continue === false && output.decision === 'block') {
    const reason = nonEmptyString(output.stopReason) || nonEmptyString(output.reason);
    notes.push(`[omg-hook] ${event}: continue:false overrides decision:block; allowing stop${reason ? `: ${reason}` : ''}`);
    return {};
  }

  return output;
}

/**
 * Pure transform of one hook run.
 * @param {string} event PascalCase hook event (OMC_HOOK_EVENT)
 * @param {{stdout?: string, exitCode?: number, stderrTail?: string, failClosed?: boolean, script?: string, debug?: boolean}} run
 * @returns {{stdout: string, exitCode: number, stderr: string}} stderr holds extra `[omg-hook]` lines ('' if none)
 */
function transform(event, run = {}) {
  const stdout = typeof run.stdout === 'string' ? run.stdout : '';
  const exitCode = Number.isInteger(run.exitCode) ? run.exitCode : 0;
  const stderrReason = String(run.stderrTail || '').trim();
  const failClosed = run.failClosed === true;
  const label = run.script ? path.basename(run.script) : 'hook';
  const notes = [];
  const finish = (text, code) => ({ stdout: text, exitCode: code, stderr: notes.map(line => `${line}\n`).join('') });
  const emitObject = (value, code) => finish(`${JSON.stringify(value)}\n`, code);

  // Claude exit 2 = "block"; stdout is ignored and stderr carries the reason.
  if (exitCode === 2) {
    if (event === 'PreToolUse') {
      return emitObject(denyOutput(stderrReason || 'Blocked by PreToolUse hook (exit 2)'), 0);
    }
    if (STOP_EVENTS.has(event)) {
      return emitObject({ decision: 'block', reason: stderrReason || `Blocked by ${event} hook (exit 2)` }, 0);
    }
    if (event === 'PostToolUseFailure' && stderrReason) {
      return emitObject({ additionalContext: stderrReason }, 0);
    }
  }

  let code = exitCode;
  const keepExit2 = event === 'PermissionRequest' && exitCode === 2;
  if (exitCode !== 0 && !keepExit2 && !failClosed) {
    notes.push(`[omg-hook] ${event} internal error: ${label} exited ${exitCode}; failing open`);
    code = 0;
  }

  const parsed = parseHookOutput(stdout);
  if (parsed.kind === 'empty') return finish('', code);
  if (parsed.kind === 'raw') return finish(stdout, code);
  return emitObject(shapeObject(event, parsed.value, notes, run.debug === true), code);
}

// ~2 s total: a hook whose stdout pipe has not drained in that long is dead
// from the host's point of view, and blocking longer only delays the tool call.
const EAGAIN_MAX_RETRIES = 1000;
const EAGAIN_SLEEP_MS = 2;
let sleepCell = null;

/** Block the thread briefly (no hot spin) while a non-blocking pipe drains. */
function sleepSync(ms) {
  if (!sleepCell) sleepCell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleepCell, 0, 0, ms);
}

function writeAllSync(fd, text) {
  const buffer = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  let offset = 0;
  let retries = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (error && error.code === 'EAGAIN' && retries++ < EAGAIN_MAX_RETRIES) {
        sleepSync(EAGAIN_SLEEP_MS);
        continue;
      }
      return;
    }
  }
}

function loadedAsPreload() {
  const argv = process.execArgv;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    let value = null;
    if ((arg === '--require' || arg === '-r') && index + 1 < argv.length) value = argv[index + 1];
    else if (arg.startsWith('--require=')) value = arg.slice('--require='.length);
    if (!value) continue;
    try {
      if (path.resolve(value) === __filename || require.resolve(path.resolve(value)) === __filename) return true;
    } catch {
      // Not this file.
    }
  }
  return false;
}

function checkRunnerTarget(event) {
  // Only the run.cjs launcher form carries the hook script in argv[2].
  if (path.basename(process.argv[1] || '') !== 'run.cjs') return;
  const target = process.argv[2];
  if (target === '--generic-child-supervisor') return;
  const strict = process.env.OMC_HOOK_STRICT === '1';
  let stat = null;
  try {
    if (target) stat = fs.statSync(target);
  } catch {
    stat = null;
  }
  if (stat && stat.isFile()) return;
  writeAllSync(2, `[omg-hook] ${event}: hook target is not a file: ${target || '(none)'}\n`);
  // A missing path may still be recovered by run.cjs's stale-plugin-root
  // lookup, so only a directory / absent argument (or strict mode) stops here.
  if (strict || stat || !target) process.exit(strict ? 1 : 0);
}

function install(event) {
  checkRunnerTarget(event);

  const stdoutChunks = [];
  let stderrTail = Buffer.alloc(0);
  let emitted = false;

  const toBuffer = (chunk, encoding) => {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
  };

  process.stdout.write = function copilotAdapterStdoutWrite(chunk, encoding, callback) {
    const cb = typeof encoding === 'function' ? encoding : callback;
    if (!emitted) {
      try { stdoutChunks.push(toBuffer(chunk, encoding)); } catch { /* unencodable chunk */ }
    }
    if (typeof cb === 'function') process.nextTick(cb);
    return true;
  };

  const originalStderrWrite = process.stderr.write;
  process.stderr.write = function copilotAdapterStderrWrite(chunk, encoding, callback) {
    try {
      const next = Buffer.concat([stderrTail, toBuffer(chunk, encoding)]);
      stderrTail = next.length > STDERR_TAIL_BYTES ? next.subarray(next.length - STDERR_TAIL_BYTES) : next;
    } catch { /* diagnostics only */ }
    return originalStderrWrite.apply(this, arguments);
  };

  process.on('exit', (code) => {
    if (emitted) return;
    emitted = true;
    const originalCode = Number.isInteger(code) ? code : (Number(process.exitCode) || 0);
    const failClosed = process.env.OMC_HOOK_FAIL_CLOSED === '1';
    const rawStdout = Buffer.concat(stdoutChunks);
    let result;
    try {
      result = transform(event, {
        stdout: rawStdout.toString('utf8'),
        exitCode: originalCode,
        stderrTail: stderrTail.toString('utf8'),
        failClosed,
        script: process.argv[2] || process.argv[1] || '',
        debug: Boolean(process.env.OMC_DEBUG_HOOKS),
      });
    } catch (error) {
      result = {
        stdout: rawStdout.toString('utf8'),
        exitCode: failClosed ? originalCode : 0,
        stderr: `[omg-hook] ${event} adapter error: ${error && error.message ? error.message : String(error)}\n`,
      };
    }
    if (result.stdout) writeAllSync(1, result.stdout);
    if (result.stderr) writeAllSync(2, result.stderr);
    process.exitCode = result.exitCode;
  });
}

const hookEvent = process.env.OMC_HOOK_EVENT;
if (hookEvent && require('worker_threads').isMainThread && loadedAsPreload()) {
  install(hookEvent);
}

module.exports = { transform, parseHookOutput, writeAllSync, EAGAIN_MAX_RETRIES };
