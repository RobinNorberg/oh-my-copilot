/**
 * Rate Limit Wait Feature
 *
 * Auto-resume Claude Code sessions when rate limits reset.
 *
 * Usage:
 *   omg wait status         - Show current rate limit status
 *   omg wait daemon start   - Start the background daemon
 *   omg wait daemon stop    - Stop the daemon
 *   omg wait detect         - Scan for blocked Claude Code sessions
 */
export type { RateLimitStatus, TmuxPane, PaneAnalysisResult, BlockedPane, DaemonState, DaemonConfig, ResumeResult, DaemonCommand, DaemonResponse, } from './types.js';
export { checkRateLimitStatus, formatTimeUntilReset, formatRateLimitStatus, isRateLimitStatusDegraded, shouldMonitorBlockedPanes, } from './rate-limit-monitor.js';
export { isTmuxAvailable, isInsideTmux, isPaneAlive, listTmuxPanes, capturePaneContent, analyzePaneContent, scanForBlockedPanes, sendResumeSequence, sendToPane, formatBlockedPanesSummary, } from './tmux-detector.js';
export { readDaemonState, isDaemonRunning, startDaemon, runDaemonForeground, stopDaemon, getDaemonStatus, detectBlockedPanes, formatDaemonState, } from './daemon.js';
//# sourceMappingURL=index.d.ts.map