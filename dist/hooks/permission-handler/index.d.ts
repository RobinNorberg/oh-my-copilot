export interface PermissionRequestInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    hook_event_name: 'PermissionRequest';
    tool_name: string;
    tool_input: {
        command?: string;
        file_path?: string;
        content?: string;
        [key: string]: unknown;
    };
    tool_use_id: string;
}
export interface HookOutput {
    continue: boolean;
    hookSpecificOutput?: {
        hookEventName: string;
        decision?: {
            behavior: 'allow' | 'deny' | 'ask';
            reason?: string;
        };
    };
}
interface DenyTracker {
    consecutiveDenials: number;
    totalDenials: number;
    totalAllows: number;
    lastDecision: 'allow' | 'deny' | 'ask' | null;
}
export declare function getCopilotPermissionAllowEntries(directory: string): string[];
export declare function hasCopilotPermissionApproval(directory: string, toolName: 'Edit' | 'Write' | 'Bash', command?: string): boolean;
export interface BackgroundPermissionFallbackResult {
    shouldFallback: boolean;
    missingTools: string[];
}
export declare function getBackgroundTaskPermissionFallback(directory: string, subagentType?: string): BackgroundPermissionFallbackResult;
export declare function getBackgroundBashPermissionFallback(directory: string, command?: string): BackgroundPermissionFallbackResult;
/**
 * Check if a command matches safe patterns
 */
export declare function isSafeCommand(command: string): boolean;
/**
 * Check if a command is a heredoc command with a safe base command.
 * Issue #608: Heredoc commands contain shell metacharacters (<<, \n, $, etc.)
 * that cause isSafeCommand() to reject them. When they fall through to Copilot
 * Code's native permission flow and the user approves "Always allow", the entire
 * heredoc body (potentially hundreds of lines) gets stored in settings.local.json.
 *
 * This function detects heredoc commands and checks whether the base command
 * (first line) matches known-safe patterns, allowing auto-approval without
 * polluting settings.local.json.
 */
export declare function isHeredocWithSafeBase(command: string): boolean;
export declare function isSafeRepoInspectionCommand(command: string, cwd: string): boolean;
export declare function isSafeTargetedLocalTestCommand(command: string, cwd: string): boolean;
export declare function isSafeAutoApprovedCommand(command: string, cwd: string): boolean;
/**
 * Check if an active mode (autopilot/ultrawork/ralph/team) is running
 */
export declare function isActiveModeRunning(directory: string): boolean;
/**
 * Process permission request and decide whether to auto-allow.
 *
 * Decision flow:
 * 1. Escalation check — if too many denials, stop and escalate
 * 2. MCP tool annotations — readOnlyHint tools auto-approved
 * 3. Bash safe patterns — known-safe CLI commands auto-approved
 * 4. Bash heredoc — safe base commands with heredoc content auto-approved
 * 5. Default — pass through to Copilot CLI's native permission prompt
 */
export declare function processPermissionRequest(input: PermissionRequestInput): HookOutput;
/** Get current deny tracker state (for diagnostics/omc-doctor) */
export declare function getPermissionDenyStats(): Readonly<DenyTracker>;
/** Reset deny tracker (e.g., after user explicitly approves) */
export declare function resetDenyTracker(): void;
/**
 * Main hook entry point
 */
export declare function handlePermissionRequest(input: PermissionRequestInput): Promise<HookOutput>;
export {};
//# sourceMappingURL=index.d.ts.map