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
 * - `OMG_COPILOT_RUN_ALLOW` (a session must not start copilot_run jobs);
 * - tier 1 with a copied login identity: `GH_TOKEN`, `GITHUB_TOKEN` (see
 *   {@link buildSessionEnv}).
 * Kept: everything else, notably PATH/PATHEXT/SystemRoot/HOME/USERPROFILE/
 * APPDATA/LOCALAPPDATA/TEMP (hooks spawn node and resolve home dirs),
 * `COPILOT_GITHUB_TOKEN`, and the remaining `COPILOT_*` (e.g. COPILOT_CLI_PATH).
 */
export declare const STRIPPED_ENV_EXACT: readonly ["DISABLE_OMC", "CLAUDECODE", "CLAUDE_SESSION_ID", "CLAUDE_PLUGIN_ROOT", "NODE_OPTIONS", "COPILOT_HOME", "COPILOT_OFFLINE", "COPILOT_MODEL", "OMG_COPILOT_RUN_ALLOW"];
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
/** Credential env keys matched by exact name (any case on Windows). */
export declare const CREDENTIAL_ENV: readonly ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "NPM_TOKEN", "NODE_AUTH_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "AZURE_DEVOPS_EXT_PAT", "AZURE_DEVOPS_EXT_AZURE_RM_SERVICE_PRINCIPAL_KEY", "AZURE_DEVOPS_EXT_GITHUB_PAT", "SYSTEM_ACCESSTOKEN", "AZURE_CLIENT_SECRET", "AZURE_CLIENT_CERTIFICATE_PATH", "AZURE_CLIENT_CERTIFICATE_PASSWORD", "AZURE_PASSWORD", "AZURE_FEDERATED_TOKEN_FILE", "IDENTITY_ENDPOINT", "IDENTITY_HEADER", "MSI_ENDPOINT", "MSI_SECRET", "AZURE_STORAGE_KEY", "AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_SAS_TOKEN", "ARM_CLIENT_SECRET", "ARM_CLIENT_CERTIFICATE_PATH", "ARM_CLIENT_CERTIFICATE_PASSWORD", "ARM_OIDC_TOKEN", "ARM_OIDC_TOKEN_FILE_PATH", "ARM_OIDC_REQUEST_TOKEN", "ARM_ACCESS_KEY", "ARM_SAS_TOKEN"];
/**
 * Whether a credential-free env drops `key`: a known credential
 * ({@link CREDENTIAL_ENV}), any secret-named var, a `GIT_CONFIG*` override
 * (could re-enable a credential helper) or a `GCM_*` setting. Any case.
 */
export declare function isCredentialEnvKey(key: string): boolean;
export declare function isStrippedEnvKey(key: string): boolean;
/** Walk up from this module to the directory holding the oh-my-copilot plugin.json. */
export declare function resolveDefaultPluginRoot(env?: NodeJS.ProcessEnv): string;
/**
 * The oh-my-copilot package root that contains the running module (no env,
 * no cwd fallback), or null when this code is not running from a plugin tree.
 */
export declare function resolvePackageRoot(): string | null;
/**
 * Cassette env (design .omc/plans/2026-10-29-copilot-replay-design.md,
 * section 8). `OMG_*`, so the `OMC_*` strip above and every credential scrub
 * keep them, and child processes (team sdk hosts) inherit them.
 */
export declare const CASSETTE_ENV: {
    readonly dir: "OMG_COPILOT_CASSETTE";
    readonly mode: "OMG_COPILOT_CASSETTE_MODE";
    readonly scenario: "OMG_COPILOT_CASSETTE_SCENARIO";
    readonly state: "OMG_COPILOT_CASSETTE_STATE";
    /** `strict` or `tolerant` (default): the replay match mode (`--replay-strict`). */
    readonly match: "OMG_COPILOT_CASSETTE_MATCH";
    /** JSON `{ PROJECT, HOME, ROOT, REMOTE, TMP }`: the smoke's dirs, turned into path placeholders. */
    readonly dirs: "OMG_COPILOT_CASSETTE_DIRS";
};
/** A dummy HMAC key: without one the runtime never sends a model request, so the replay handler would never see it. */
export declare const REPLAY_HMAC_KEY = "omg-replay-dummy-hmac-key";
export declare function isReplayEnv(env: NodeJS.ProcessEnv): boolean;
/**
 * The runtime env of a cassette client: in replay every credential
 * ({@link isCredentialEnvKey}) and the HMAC key go and the dummy key is set, so
 * a request that bypassed the handler can neither authenticate nor bill. Both
 * modes disable WebSocket responses (recordings are HTTP only).
 */
export declare function cassetteRuntimeEnv(env: NodeJS.ProcessEnv, mode: 'record' | 'replay'): NodeJS.ProcessEnv;
export interface SessionEnvOptions {
    /** Tier 1 session (adds {@link SESSION_SET_ENV}); false for the tier 0 list commands. */
    session?: boolean;
    /** A stored login was copied into the home: drop {@link LOGIN_SHADOWING_TOKENS}. */
    hasLogin?: boolean;
}
/**
 * Apply the env policy documented at {@link STRIPPED_ENV_EXACT}. In replay
 * ({@link isReplayEnv}) every credential and the HMAC key are dropped too; the
 * cassette vars stay.
 */
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