/**
 * Shared stdin utilities for OMC hooks
 * Provides timeout-protected stdin reading to prevent hangs on Linux and Windows
 * See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/240
 *
 * Mirrors templates/hooks/lib/stdin.mjs. Keep the two copies identical: the
 * installer ships this file to standalone installs and the plugin hooks import
 * it directly, so a fix applied to one copy only reaches half the installs.
 */

/**
 * Longest stdin wait for hooks declared with a 5s manifest timeout, and their
 * wait when run.cjs exported no budget (a hook run directly). Pass it as the
 * cap to hookStdinTimeoutMs(). run.cjs gives such a hook 5000 - 1500 = 3500ms
 * on Windows (500ms cushion elsewhere, so 4500ms); a fixed 3000ms wait plus
 * Node boot overran 3500ms under load.
 */
export const HOOK_STDIN_TIMEOUT_MS = process.platform === 'win32' ? 1500 : 3000;

/**
 * Inner budget (ms) run.cjs exports to the hook it starts, and the epoch ms
 * its clock started: the runner kills the hook at start + budget. Set by
 * scripts/run.cjs.
 */
export const HOOK_INNER_BUDGET_ENV = 'OMC_HOOK_INNER_BUDGET_MS';
export const HOOK_INNER_BUDGET_START_ENV = 'OMC_HOOK_INNER_BUDGET_START_MS';

/**
 * Part of the inner budget kept after the stdin wait: the hook's work on the
 * payload and its exit. Start-up before the wait is not in it; the elapsed
 * time since the budget started is subtracted instead, because on Windows
 * it varies too much for a fixed margin: under load (~100 Node processes)
 * git-guardrails through run.cjs reached its 1.5s wait 0.6-2s after start,
 * and the runner killed it at 3.5s. Windows 1500ms: the median 3s/5s hook run
 * through run.cjs with stdin closed took 0.9-1.4s there, start-up included.
 * POSIX 500ms: the run.cjs cushion the 3s hooks' 2000ms wait already fit in.
 */
export const HOOK_STDIN_MARGIN_MS = process.platform === 'win32' ? 1500 : 500;

/** Shortest derived wait, so a starved budget still reads a ready payload. */
export const HOOK_STDIN_MIN_WAIT_MS = 250;

/**
 * Stdin wait derived from the run.cjs inner budget:
 * max(HOOK_STDIN_MIN_WAIT_MS, min(capMs, budget - elapsed - HOOK_STDIN_MARGIN_MS)),
 * where elapsed is nowMs minus the exported start (0 when that is absent).
 * Without a valid budget in the env, returns fallbackMs.
 *
 * @param {number} capMs - Longest wait the hook wants (default: 2000ms)
 * @param {number} fallbackMs - Wait when no budget is exported (default: capMs)
 * @param {Record<string, string | undefined>} env - Environment to read
 * @param {number} nowMs - Current epoch ms (default: Date.now())
 * @returns {number}
 */
export function hookStdinTimeoutMs(capMs = 2000, fallbackMs = capMs, env = process.env, nowMs = Date.now()) {
  const raw = String(env[HOOK_INNER_BUDGET_ENV] ?? '').trim();
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) return fallbackMs;
  const start = String(env[HOOK_INNER_BUDGET_START_ENV] ?? '').trim();
  const elapsedMs = /^\d+$/.test(start) ? Math.max(0, nowMs - Number(start)) : 0;
  return Math.max(HOOK_STDIN_MIN_WAIT_MS, Math.min(capMs, Number(raw) - elapsedMs - HOOK_STDIN_MARGIN_MS));
}

/**
 * Read all stdin with timeout to prevent indefinite hang on Linux and Windows.
 *
 * The blocking `for await (const chunk of process.stdin)` pattern waits
 * indefinitely for EOF. On Linux, if the parent process doesn't properly
 * close stdin, this hangs forever. This function uses event-based reading
 * with a timeout as a safety net.
 *
 * The default wait is derived from the run.cjs inner budget (2s cap, #765):
 * a wait that outlives the timeout that kills the hook gets the script killed
 * mid-read instead of answering with the bytes it had.
 *
 * @param {number} timeoutMs - Maximum time to wait for stdin (default: hookStdinTimeoutMs())
 * @returns {Promise<string>} - The stdin content, or empty string on error/timeout
 */
export async function readStdin(timeoutMs = hookStdinTimeoutMs()) {
  return (await readStdinWithStatus(timeoutMs)).input;
}

/**
 * readStdin that also reports whether the wait ran out before EOF, so a
 * fail-closed hook can tell a truncated payload from a malformed one.
 *
 * @param {number} timeoutMs - Maximum time to wait for stdin (default: hookStdinTimeoutMs())
 * @returns {Promise<{ input: string, timedOut: boolean }>}
 */
export async function readStdinWithStatus(timeoutMs = hookStdinTimeoutMs()) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        process.stdin.removeAllListeners();
        process.stdin.destroy();
        resolve({ input: Buffer.concat(chunks).toString('utf-8'), timedOut: true });
      }
    }, timeoutMs);

    process.stdin.on('data', (chunk) => {
      chunks.push(chunk);
    });

    process.stdin.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ input: Buffer.concat(chunks).toString('utf-8'), timedOut: false });
      }
    });

    process.stdin.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ input: '', timedOut: false });
      }
    });

    // If stdin is already ended (e.g. empty pipe), 'end' fires immediately
    // But if stdin is a TTY or never piped, we need the timeout as safety net
    if (process.stdin.readableEnded) {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ input: Buffer.concat(chunks).toString('utf-8'), timedOut: false });
      }
    }
  });
}

/**
 * Read one complete SessionEnd JSON frame under strict hook deadlines.
 *
 * @returns {Promise<
 *   | { status: 'ok', value: unknown }
 *   | { status: 'empty' | 'timeout' | 'overflow' | 'invalid' | 'error' }
 * >}
 */
export function readSessionEndFrame() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const chunks = [];
    let byteLength = 0;
    let settled = false;
    let firstByteTimer;
    let totalTimer;

    const cleanup = () => {
      clearTimeout(firstByteTimer);
      clearTimeout(totalTimer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
    };

    const finish = (result, closeStdin = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (closeStdin && !stdin.destroyed) {
        stdin.pause();
        stdin.destroy();
      }
      resolve(result);
    };

    const onData = (chunk) => {
      clearTimeout(firstByteTimer);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      if (byteLength > 64 * 1024) {
        finish({ status: 'overflow' }, true);
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      const input = Buffer.concat(chunks).toString('utf8');
      if (input.trim().length === 0) {
        finish({ status: 'empty' });
        return;
      }
      try {
        finish({ status: 'ok', value: JSON.parse(input) });
      } catch {
        finish({ status: 'invalid' });
      }
    };

    const onError = () => finish({ status: 'error' }, true);

    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);

    if (stdin.readableEnded) {
      onEnd();
      return;
    }

    firstByteTimer = setTimeout(() => finish({ status: 'timeout' }, true), 25);
    totalTimer = setTimeout(() => finish({ status: 'timeout' }, true), 100);
    stdin.resume();
  });
}
