function resolveParentPid(processRef, overrideParentPid) {
    if (typeof overrideParentPid === 'number') {
        return overrideParentPid;
    }
    if (typeof processRef.ppid === 'number') {
        return processRef.ppid;
    }
    if (typeof process.ppid === 'number') {
        return process.ppid;
    }
    return undefined;
}
/**
 * Register MCP-server shutdown hooks for both explicit signals and the implicit
 * "parent process died" case. The MCP standalone server runs as a detached child
 * and may outlive its parent (Claude Code) if signals are not forwarded.
 *
 * Strategy:
 *   1. SIGTERM / SIGINT / stdin-close: call onShutdown immediately.
 *   2. Parent-PID polling: check every `pollIntervalMs` whether the parent is
 *      still alive. If it disappeared, call onShutdown. This covers cases where
 *      the parent crashes without sending a signal.
 */
export function registerStandaloneShutdownHandlers(options) {
    const { onShutdown, processRef = process, parentPid: parentPidOverride, pollIntervalMs = 5_000, getParentPid, setIntervalFn = setInterval, clearIntervalFn = clearInterval, } = options;
    let shutdownTriggered = false;
    function triggerOnce(reason) {
        if (shutdownTriggered)
            return;
        shutdownTriggered = true;
        if (parentPollTimer != null) {
            clearIntervalFn(parentPollTimer);
            parentPollTimer = null;
        }
        onShutdown(reason);
    }
    // 1. Explicit signals
    processRef.once('SIGTERM', () => triggerOnce('SIGTERM'));
    processRef.once('SIGINT', () => triggerOnce('SIGINT'));
    // stdin close — MCP uses stdio transport; when the parent drops the pipe
    // the server should exit.
    if (processRef.stdin) {
        processRef.stdin.once('close', () => triggerOnce('stdin-close'));
    }
    // 2. Parent-PID polling
    const parentPid = getParentPid
        ? getParentPid()
        : resolveParentPid(processRef, parentPidOverride);
    let parentPollTimer = null;
    if (typeof parentPid === 'number' && parentPid > 0) {
        parentPollTimer = setIntervalFn(() => {
            try {
                // process.kill(pid, 0) throws if the process doesn't exist.
                process.kill(parentPid, 0);
            }
            catch {
                triggerOnce('parent-exit');
            }
        }, pollIntervalMs);
        // Unref so the timer doesn't keep the process alive on its own.
        if (parentPollTimer && typeof parentPollTimer.unref === 'function') {
            parentPollTimer.unref();
        }
    }
}
//# sourceMappingURL=standalone-shutdown.js.map