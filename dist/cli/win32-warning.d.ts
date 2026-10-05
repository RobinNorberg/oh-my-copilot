/**
 * Warn if running on native Windows (win32) without tmux available.
 * Called at CLI startup from src/cli/index.ts.
 * If a tmux-compatible binary (e.g. psmux) is on PATH, the warning is skipped.
 *
 * Always written via console.warn (stderr), never stdout, so `--json`
 * consumers that only read stdout get a pure JSON document. The warning is
 * additionally suppressed outright whenever `--json` appears anywhere in
 * argv, so naive callers that merge both streams (e.g. `2>&1`, or a shell
 * wrapper that captures combined output) still see nothing but the report.
 */
export declare function warnIfWin32(argv?: readonly string[]): void;
//# sourceMappingURL=win32-warning.d.ts.map