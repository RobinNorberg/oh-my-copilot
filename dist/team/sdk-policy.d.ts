/**
 * Permission and tool policy for headless SDK team workers (`--transport sdk`).
 *
 * Pane workers run with `--allow-all-*`. An SDK worker gets no allow-all: its
 * host answers every `onPermissionRequest` with {@link decideSdkPermission},
 * and removes tools up front with {@link buildSdkExcludedTools}.
 */
/** The subset of the SDK PermissionRequest the policy reads (SDK 1.0.16). */
export interface SdkPermissionRequest {
    kind?: string;
    fullCommandText?: string;
    path?: unknown;
    fileName?: unknown;
    resolvedPath?: unknown;
    serverName?: unknown;
    toolName?: unknown;
    url?: unknown;
    [key: string]: unknown;
}
export interface SdkPolicyContext {
    /** The worker's working directory (its worktree, or the leader cwd without worktrees). */
    cwd: string;
    /** The leader's team state root: inbox, status, heartbeat, shutdown ack, verdicts. */
    stateRoot: string;
    /** The oh-my-copilot plugin root (skills, agents, hook scripts are read from here). */
    pluginRoot: string;
    /** Extra read-only roots (the per-worker COPILOT_HOME). */
    readRoots?: string[];
    /** The plugin MCP server name (`t`). */
    mcpServer: string;
    /** `permissions.workerDenyTools`. */
    denyTools?: string[];
    /** `permissions.workerDenyUrls`. */
    denyUrls?: string[];
    platform?: NodeJS.Platform;
}
export interface SdkPermissionDecision {
    approve: boolean;
    reason: string;
}
/**
 * Deny patterns for `git <global options> <tail>` (`tail` is a regex source),
 * spelled directly or through a variable (`$g="git"; & $g push`, `g=git; $g push`).
 */
export declare function gitSubcommandDeny(tail: string, reason: string): Array<{
    re: RegExp;
    reason: string;
}>;
/**
 * Shell commands a worker must never run, whatever the config says:
 * - team control other than `team api` (nested teams, shutdown of its own team);
 * - `omg smoke` (would spend credits from inside a worker);
 * - the multiplexers (the pane transport's control plane);
 * - `git push` (workers commit in their worktree; the leader integrates), and
 *   the git aliases and config overrides that could rename it.
 *
 * This is a denylist over the command text, not a sandbox: it stops the
 * direct and quoted spellings a model actually writes, but a worker that
 * builds the command indirectly (a script file, `Invoke-Expression`, an
 * encoded command, a shell escape such as `pu\sh`) is not stopped by it. The real boundaries are the
 * write-path check, the credit cap and the per-worker COPILOT_HOME.
 * Patterns run on {@link normalizeShellCommand}'s output.
 */
export declare const SDK_SHELL_DENY_PATTERNS: ReadonlyArray<{
    re: RegExp;
    reason: string;
}>;
/**
 * Drop empty quotes (`c''ommit` -> `commit`), then strip quotes around single
 * tokens (`"omg" 'team'` -> `omg team`), so quoting cannot dodge a pattern.
 */
export declare function normalizeShellCommand(command: string): string;
/** True when `p` is `root` or lies below it (canon: realpath of the deepest existing ancestor, case-folded on win32). Throws as canon does. */
export declare function isUnderRoot(p: string, root: string, platform?: NodeJS.Platform): boolean;
/**
 * True when `p` has a `..` segment. `resolve` collapses `l/../x` lexically to
 * `x`, but the kernel follows the link `l` first and climbs from its target.
 */
export declare function hasDotDotSegment(p: string): boolean;
/**
 * True when `p` names a git dir or gitfile, or an NTFS alternate data stream:
 * a segment that, case-folded with trailing dots and spaces stripped (Win32
 * drops them), is `.git` or an 8.3 short name `git~<n>`, or any `:` past a
 * drive letter (`.git::$DATA`, `foo:stream`). Applied on every platform.
 */
export declare function namesGitPath(p: string): boolean;
/** `shell(<prefix>)` entries of `workerDenyTools`, as command prefixes. */
export declare function shellDenyPrefixes(denyTools?: readonly string[]): string[];
export declare function decideSdkPermission(req: SdkPermissionRequest, ctx: SdkPolicyContext): SdkPermissionDecision;
/**
 * Built-in tools that start or drive other agents. A worker is one agent on
 * one credit cap; these would fan out work (and spend) outside the team's
 * task and claim protocol.
 */
export declare const SDK_AGENT_FANOUT_TOOLS: readonly string[];
/**
 * `excludedTools` for an SDK worker session: the recursion fence (the
 * `<server>-host_smoke` and `<server>-copilot_run_*` tools and
 * {@link SDK_AGENT_FANOUT_TOOLS}) plus each bare
 * `workerDenyTools` name; `<server>(<tool>)` becomes `<server>-<tool>`, the
 * SDK's MCP tool name. `shell(<prefix>)` entries stay with the handler.
 */
export declare function buildSdkExcludedTools(mcpServer: string, denyTools?: readonly string[]): string[];
//# sourceMappingURL=sdk-policy.d.ts.map