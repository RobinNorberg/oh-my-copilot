/**
 * Runtime-neutral helpers shared by the smoke and the SDK team host
 * (src/team/sdk-host.ts, src/team/runtime-v2.ts): the copilot child env
 * policy, the login-identity copy, and the plugin root lookup.
 *
 * Keep this module dependency-light: no imports of src/mcp/**, src/tools/**,
 * or anything that reaches `@ast-grep/napi`. The team MCP bundle
 * (scripts/build-team-server.mjs) inlines every module reachable from here,
 * including literal dynamic imports. Guarded by
 * tests/lint/team-bundle-no-native.test.ts.
 */
/**
 * Env policy for every copilot child the smoke spawns (the caller's env minus
 * what could redirect, disable, or re-host our hooks; precedent:
 * scripts/verify-graph-contained-fs.mjs).
 *
 * Stripped:
 * - every `OMC_*` var and `DISABLE_OMC` (state dir, plugin root, skip/disable
 *   switches, debug toggles), then only {@link SMOKE_SET_ENV} is re-added;
 * - Claude Code host markers: `CLAUDECODE`, `CLAUDE_SESSION_ID`,
 *   `CLAUDE_PLUGIN_ROOT`, and every `CLAUDE_CODE_*` (incl. CLAUDE_CODE_ENTRYPOINT);
 * - `NODE_OPTIONS` (preloads would run inside our node hooks);
 * - `COPILOT_HOME`, `COPILOT_OFFLINE`, `COPILOT_MODEL` (only `--model` picks the
 *   model), every `COPILOT_PROVIDER_*` (BYO provider routing);
 * - tier 1 with a copied login identity: `GH_TOKEN`, `GITHUB_TOKEN` (see
 *   {@link buildSessionEnv}).
 * Kept: everything else, notably PATH/PATHEXT/SystemRoot/HOME/USERPROFILE/
 * APPDATA/LOCALAPPDATA/TEMP (hooks spawn node and resolve home dirs),
 * `COPILOT_GITHUB_TOKEN`, and the remaining `COPILOT_*` (e.g. COPILOT_CLI_PATH).
 */
export declare const STRIPPED_ENV_EXACT: readonly ["DISABLE_OMC", "CLAUDECODE", "CLAUDE_SESSION_ID", "CLAUDE_PLUGIN_ROOT", "NODE_OPTIONS", "COPILOT_HOME", "COPILOT_OFFLINE", "COPILOT_MODEL"];
export declare const STRIPPED_ENV_PREFIXES: readonly ["OMC_", "CLAUDE_CODE_", "COPILOT_PROVIDER_"];
/** Generic GitHub tokens dropped from the tier 1 session when a stored login was copied. */
export declare const LOGIN_SHADOWING_TOKENS: readonly ["GH_TOKEN", "GITHUB_TOKEN"];
/** Set on every copilot child (on top of COPILOT_HOME). */
export declare const SMOKE_SET_ENV: {
    readonly COPILOT_ALLOW_ALL: "false";
    readonly COPILOT_AUTO_UPDATE: "false";
    readonly NO_COLOR: "1";
};
/** Set on the tier 1 session only: a failing hook must surface as hook.end success:false. */
export declare const SESSION_SET_ENV: {
    readonly OMC_HOOK_FAIL_CLOSED: "1";
};
export declare function isStrippedEnvKey(key: string): boolean;
/** Walk up from this module to the directory holding the oh-my-copilot plugin.json. */
export declare function resolveDefaultPluginRoot(env?: NodeJS.ProcessEnv): string;
/**
 * The oh-my-copilot package root that contains the running module (no env,
 * no cwd fallback), or null when this code is not running from a plugin tree.
 */
export declare function resolvePackageRoot(): string | null;
export interface SessionEnvOptions {
    /** Tier 1 session (adds {@link SESSION_SET_ENV}); false for the tier 0 list commands. */
    session?: boolean;
    /** A stored login was copied into the home: drop {@link LOGIN_SHADOWING_TOKENS}. */
    hasLogin?: boolean;
}
/** Apply the env policy documented at {@link STRIPPED_ENV_EXACT}. */
export declare function buildSessionEnv(base: NodeJS.ProcessEnv, home: string, opts?: SessionEnvOptions): NodeJS.ProcessEnv;
/**
 * Copy only the login identity (`loggedInUsers`, `lastLoggedInUser`) from the
 * user's real config. The token stays in the OS credential store; without
 * these keys an empty COPILOT_HOME falls back to `gh auth token`, whose OAuth
 * app is not entitled to Copilot models ("Model ... is not available").
 *
 * Token precedence (`copilot help environment`, 1.0.91): COPILOT_GITHUB_TOKEN,
 * GH_TOKEN, GITHUB_TOKEN each take precedence over stored credentials. So when
 * a login was copied, the session drops GH_TOKEN/GITHUB_TOKEN (typically gh or
 * Actions tokens, which would shadow the entitled login) and keeps
 * COPILOT_GITHUB_TOKEN (an explicit Copilot opt-in). Without a stored login
 * (CI) all three pass through, since a token is then the only credential.
 */
export declare function loginIdentity(userConfigDir: string): Record<string, unknown>;
//# sourceMappingURL=copilot-session-env.d.ts.map