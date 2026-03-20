export interface ShutdownProcessLike {
    once(event: string, listener: () => void): unknown;
    stdin?: {
        once(event: string, listener: () => void): unknown;
    } | null;
    ppid?: number;
}
export interface RegisterStandaloneShutdownHandlersOptions {
    onShutdown: (reason: string) => void | Promise<void>;
    processRef?: ShutdownProcessLike;
    parentPid?: number;
    pollIntervalMs?: number;
    getParentPid?: () => number | undefined;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
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
export declare function registerStandaloneShutdownHandlers(options: RegisterStandaloneShutdownHandlersOptions): void;
//# sourceMappingURL=standalone-shutdown.d.ts.map