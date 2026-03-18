/**
 * Native tmux shell launch for omg
 * Launches Copilot CLI with tmux session management
 */
/**
 * Extract the OMC-specific --notify flag from launch args.
 * --notify false  → disable notifications (OMC_NOTIFY=0)
 * --notify true   → enable notifications (default)
 * This flag must be stripped before passing args to Copilot CLI.
 */
export declare function extractNotifyFlag(args: string[]): {
    notifyEnabled: boolean;
    remainingArgs: string[];
};
/**
 * Extract the OMC-specific --telegram flag from launch args.
 * Purely presence-based:
 *   --telegram        -> enable Telegram notifications (OMC_TELEGRAM=1)
 *   --telegram=true   -> enable
 *   --telegram=false  -> disable
 *   --telegram=1      -> enable
 *   --telegram=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Copilot CLI.
 */
export declare function extractTelegramFlag(args: string[]): {
    telegramEnabled: boolean | undefined;
    remainingArgs: string[];
};
/**
 * Extract the OMC-specific --discord flag from launch args.
 * Purely presence-based:
 *   --discord        -> enable Discord notifications (OMC_DISCORD=1)
 *   --discord=true   -> enable
 *   --discord=false  -> disable
 *   --discord=1      -> enable
 *   --discord=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Copilot CLI.
 */
export declare function extractDiscordFlag(args: string[]): {
    discordEnabled: boolean | undefined;
    remainingArgs: string[];
};
/**
 * Extract the OMC-specific --slack flag from launch args.
 * Purely presence-based:
 *   --slack        -> enable Slack notifications (OMC_SLACK=1)
 *   --slack=true   -> enable
 *   --slack=false  -> disable
 *   --slack=1      -> enable
 *   --slack=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Copilot CLI.
 */
export declare function extractSlackFlag(args: string[]): {
    slackEnabled: boolean | undefined;
    remainingArgs: string[];
};
/**
 * Extract the OMC-specific --webhook flag from launch args.
 * Purely presence-based:
 *   --webhook        -> enable Webhook notifications (OMC_WEBHOOK=1)
 *   --webhook=true   -> enable
 *   --webhook=false  -> disable
 *   --webhook=1      -> enable
 *   --webhook=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Copilot CLI.
 */
export declare function extractWebhookFlag(args: string[]): {
    webhookEnabled: boolean | undefined;
    remainingArgs: string[];
};
/**
 * Extract the OMC-specific --teams flag from launch args.
 * Purely presence-based:
 *   --teams        -> enable Teams notifications (OMC_MICROSOFT_TEAMS=1)
 *   --teams=true   -> enable
 *   --teams=false  -> disable
 *   --teams=1      -> enable
 *   --teams=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Claude CLI.
 */
export declare function extractTeamsFlag(args: string[]): {
    teamsEnabled: boolean | undefined;
    remainingArgs: string[];
};
/**
 * Normalize Copilot launch arguments
 * Maps --madmax/--yolo to --dangerously-skip-permissions
 * All other flags pass through unchanged
 */
export declare function normalizeCopilotLaunchArgs(args: string[]): string[];
/**
 * preLaunch: Prepare environment before Copilot starts
 * Currently a placeholder - can be extended for:
 * - Session state initialization
 * - Environment setup
 * - Pre-launch checks
 */
export declare function preLaunch(_cwd: string, _sessionId: string): Promise<void>;
/**
 * runCopilot: Launch Copilot CLI (blocks until exit)
 * Handles 3 scenarios:
 * 1. inside-tmux: Launch copilot in current pane
 * 2. outside-tmux: Create new tmux session with copilot
 * 3. direct: tmux not available, run copilot directly
 */
export declare function runCopilot(cwd: string, args: string[], sessionId: string): void;
/**
 * postLaunch: Cleanup after Copilot exits
 * Currently a placeholder - can be extended for:
 * - Session cleanup
 * - State finalization
 * - Post-launch reporting
 */
export declare function postLaunch(_cwd: string, _sessionId: string): Promise<void>;
/**
 * Main launch command entry point
 * Orchestrates the 3-phase launch: preLaunch -> run -> postLaunch
 */
export declare function launchCommand(args: string[]): Promise<void>;
//# sourceMappingURL=launch.d.ts.map