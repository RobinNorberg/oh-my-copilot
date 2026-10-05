/**
 * Subprocess helpers for `omg smoke`. Every call takes the spawn function as a
 * parameter so unit tests never start a real process.
 */
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
/**
 * Spawn children in their own process group on POSIX so a timeout can kill
 * the whole tree (copilot's node hook and MCP children included). On win32
 * `detached` would open a new console, and taskkill /T walks the tree anyway.
 */
export function useProcessGroup(platform = process.platform) {
    return platform !== 'win32';
}
/**
 * Kill a process and its children. On win32 `child.kill()` only ends the
 * direct child, leaving copilot's node hook/MCP children behind, so use
 * `taskkill /T /F`. On POSIX the child was spawned as a process-group leader
 * ({@link useProcessGroup}), so signal the group (`-pid`), falling back to
 * the pid alone.
 */
export function killProcessTree(pid, spawnSyncFn, platform = process.platform, killFn = (p, sig) => { process.kill(p, sig); }) {
    if (!pid)
        return;
    if (platform === 'win32') {
        try {
            spawnSyncFn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
        }
        catch { /* best effort */ }
        return;
    }
    try {
        killFn(-pid, 'SIGKILL');
        return;
    }
    catch { /* not a group leader or already gone */ }
    try {
        killFn(pid, 'SIGKILL');
    }
    catch { /* already gone */ }
}
/** True once the child has exited; a tree kill would then target a recycled pid. */
export function hasExited(child) {
    return (child.exitCode !== null && child.exitCode !== undefined)
        || (child.signalCode !== null && child.signalCode !== undefined);
}
/** Run a command to completion with stdin input and a hard timeout (tree kill). */
export function runAsync(spawnFn, spawnSyncFn, command, args, opts) {
    const started = Date.now();
    const maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ ...result, stdout, stderr, timedOut, durationMs: Date.now() - started });
        };
        let child;
        try {
            child = spawnFn(command, [...args], {
                cwd: opts.cwd,
                env: opts.env,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                windowsVerbatimArguments: opts.windowsVerbatimArguments,
                detached: useProcessGroup(),
            });
        }
        catch (err) {
            resolve({ code: null, signal: null, stdout, stderr, timedOut, error: err.message, durationMs: Date.now() - started });
            return;
        }
        const timer = setTimeout(() => {
            timedOut = true;
            if (!hasExited(child))
                killProcessTree(child.pid, spawnSyncFn);
            // Some platforms never emit 'close' once the tree is force-killed; settle anyway.
            setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 2_000).unref?.();
        }, opts.timeoutMs);
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => { if (stdout.length < maxOutput)
            stdout += chunk; });
        child.stderr?.on('data', (chunk) => { if (stderr.length < maxOutput)
            stderr += chunk; });
        child.on('error', (err) => finish({ code: null, signal: null, error: err.message }));
        child.on('close', (code, signal) => finish({ code, signal }));
        child.stdin?.on('error', () => { });
        if (opts.input !== undefined)
            child.stdin?.end(opts.input);
        else
            child.stdin?.end();
    });
}
//# sourceMappingURL=process-utils.js.map