/**
 * `omg ship` configuration: defaults, the `ship` config block, and the
 * repo's known-flaky test list.
 *
 * Trust model (see loadTrustedShipConfig): the safety keys
 * (SHIP_SAFETY_KEYS) come only from the user-level config at its default
 * location, then the `.copilot/omg.jsonc` committed on a trusted base branch
 * at the sha GitHub reports (`git show <baseRefOid>:.copilot/omg.jsonc`,
 * replace refs off), then the defaults. The working-tree project file and the
 * PR head never set them: a lane can drop an untracked file into the
 * checkout, and a PR can commit one. The legacy `.copilot/omc.jsonc` name is
 * never read from the base branch.
 */
import { type Exec } from './exec.js';
export interface ShipConfig {
    /** Integration branch PRs target and `prepare` merges in. */
    base: string;
    /** Checks that never block a merge (exact names). */
    advisoryChecks: string[];
    /**
     * Checks CI always reports for a PR (exact names). A missing one counts as
     * pending, so a gate read before `needs:`-dependent jobs exist is never green.
     */
    requiredChecks: string[];
    /** Repo-relative JSON file listing known-flaky tests. */
    knownFlakyFile: string;
    /** Fix rounds allowed after the first changes-requested verdict before the run blocks. */
    maxFixRounds: number;
    /**
     * When false, `omg ship merge` prints the admin merge command instead of
     * running it. Owner-only: there is no CLI override, and lanes never edit it.
     */
    allowAdminMerge: boolean;
    /** `gates --watch` reruns a failed run once when every failing test is known-flaky. */
    autoRerunFlaky: boolean;
    pollIntervalSeconds: number;
    /** One `gates --watch` invocation stops after this long (exit 8); 0 = no limit. */
    watchTimeoutMinutes: number;
    /**
     * User config only. Bases whose committed config is read and into which
     * `merge` may admin-merge; for any other base the defaults apply and merge
     * prints the command instead (a lane can create a branch and target it).
     */
    trustedBases: string[];
}
export type ShipConfigInput = Partial<ShipConfig>;
export declare const DEFAULT_SHIP_CONFIG: Readonly<ShipConfig>;
/**
 * Syntactic branch-name check (no git): word characters, `.`, `/`, `-`, never
 * a leading `-` (it would parse as an option). Callers that spawn git also run
 * `git check-ref-format --branch`.
 */
export declare function isPlainBranchName(value: unknown): value is string;
/** Repo-relative forward-slash path: plain segments, no `..`, not absolute or option-shaped. */
export declare function isRepoPath(value: unknown): value is string;
/** Merge a config block over the defaults; ill-typed fields are rejected, not ignored. */
export declare function resolveShipConfig(input: unknown): ShipConfig;
export interface KnownFlakyTest {
    /** Repo-relative test file, forward slashes. */
    file: string;
    /** Required substring of the full test title (a file-wide entry would also cover collection errors). */
    title: string;
    note?: string;
}
/** Parse a known-flaky list (`{ "tests": [...] }`); malformed content throws. */
export declare function parseKnownFlaky(content: string, file: string): KnownFlakyTest[];
/** Ship keys a lane or PR could use to merge a red PR; never read from the working tree or the PR head. */
export declare const SHIP_SAFETY_KEYS: readonly ["allowAdminMerge", "advisoryChecks", "requiredChecks", "knownFlakyFile"];
/** Keys only the user config (default location) sets: ignored in the base-branch and working-tree files. */
export declare const SHIP_USER_ONLY_KEYS: readonly ["trustedBases"];
/** Project config path inside the repo, read from the base branch for the safety keys. */
export declare const BASE_CONFIG_PATH = ".copilot/omg.jsonc";
/**
 * `git show <commit>:<path>` with replace refs off; null when the file does
 * not exist at that commit. Any other failure throws (fail closed).
 */
export declare function readBaseFile(exec: Exec, cwd: string, commit: string, path: string): string | null;
/**
 * Comparable identity of a repository URL: `ado:<org>/<project>/<repo>` for
 * an Azure DevOps URL (every parseAzureDevOpsRepoUrl form, escapes decoded),
 * `gh:<host>/<owner>/<repo>` for any other https / ssh / scp-style URL
 * (case-insensitive, `.git` and a trailing `/` dropped), `path:<url>` for
 * anything else (a local path), so a local path can never equal a hosted
 * repository. `invalid:<url>` for a URL whose authority names another host
 * than git connects to (urlHostAgrees: `https://evil#@github.com/o/r`) or an
 * Azure DevOps URL parseAzureDevOpsRepoUrl refuses (`a%2Fb/c`): it never
 * equals a valid repository's identity.
 */
export declare function repoIdentity(url: string): string;
/** True when both URLs have the same repoIdentity; an `invalid:` identity equals nothing, itself included. */
export declare function sameRepo(a: string, b: string): boolean;
/**
 * Null when `git remote get-url <remote>` (insteadOf rewrites applied, so the
 * URL fetch really uses) names the PR's repository (`repoUrl`, from
 * `gh pr view --json url` without `/pull/<n>`); otherwise why not. Checked
 * before every fetch of the base, so a lane that points the remote at another
 * repository is refused instead of fetched from. Every push URL
 * (`git remote get-url --push --all`: each `pushurl`, else the URL, with
 * pushInsteadOf applied) must name it too, so a planted `pushurl` cannot
 * redirect a push.
 */
export declare function remoteRepoMismatch(exec: Exec, cwd: string, remote: string, repoUrl: string | undefined): string | null;
/**
 * The repository URL of a PR URL (`https://github.com/o/r/pull/12` ->
 * `https://github.com/o/r`; Azure DevOps
 * `https://dev.azure.com/o/p/_git/r/pullrequest/12` -> `.../_git/r`, the
 * legacy `<org>.visualstudio.com` form too); undefined when it is not one.
 */
export declare function prRepoUrl(prUrl: unknown): string | undefined;
/**
 * The user config's default location, derived from the account's home
 * directory as the OS reports it (`os.userInfo()`: passwd / the Windows
 * profile, not HOME / USERPROFILE / APPDATA / XDG_CONFIG_HOME, which a lane
 * can set): `<home>/AppData/Roaming/claude-omc/config.jsonc` on Windows,
 * `<home>/.config/claude-omc/config.jsonc` elsewhere, the layout the normal
 * loader (getConfigPaths) uses when those variables are unset.
 */
export declare function trustedUserConfigPath(home?: string): string;
/**
 * The user-config layers for loadTrustedShipConfig: `user` is the file the
 * normal loader reads (env-selected), `trustedUser` the file at the default
 * location (trustedUserConfigPath). When the two differ, the safety keys come
 * only from `trustedUser`. No resolvable home directory = no trusted user layer.
 */
export declare function userConfigLayers(envPath?: string, trustedPath?: string | null): {
    user: unknown;
    trustedUser: unknown;
};
export interface TrustedShipConfigInput {
    exec: Exec;
    /** Repo root (the checkout being shipped). */
    root: string;
    /** The PR's base branch on GitHub (baseRefName). */
    base: string;
    /** GitHub's base sha (baseRefOid): the base layer is read at this commit, after the fetched ref is checked against it. */
    baseSha?: string;
    /** merge: a failed fetch or an unknown / mismatched base sha throws instead of skipping the base layer. */
    strict?: boolean;
    remote?: string;
    /** The PR's repository URL on GitHub (prRepoUrl); the remote must point at it before the base is fetched. */
    repoUrl?: string;
    /** The user config the normal loader reads (env-selected location); non-safety keys. */
    user: unknown;
    /** The user config at its default location (userConfigLayers); the only user source of safety keys. Default: `user`. */
    trustedUser?: unknown;
    /** Working-tree project config content; default: read `.copilot/omg.jsonc` (or the legacy name) under `root`. */
    project?: unknown;
    warn?: (message: string) => void;
}
export interface LoadedShipConfig extends ShipConfig {
    /** Base commit whose committed files were read (equal to GitHub's base sha); undefined when the base layer was skipped. */
    trustedBaseCommit?: string;
}
/**
 * ship.trustedBases (SHIP_USER_ONLY_KEYS) of the user config at its default
 * location (userConfigLayers().trustedUser), else the defaults: the only
 * bases whose committed `.copilot/omg.jsonc` is read.
 */
export declare function resolveTrustedBases(trustedUser: unknown): string[];
/**
 * Resolve the ship config for a run. Precedence:
 * - safety keys (SHIP_SAFETY_KEYS): the user config at its default location,
 *   then the trusted base's committed `.copilot/omg.jsonc`, then the
 *   defaults. A safety key in the working-tree project file that differs from
 *   the base branch, or in an env-selected user config that differs from the
 *   default location's, is ignored with a warning.
 * - trustedBases (SHIP_USER_ONLY_KEYS): the user config at its default location only.
 * - other keys: defaults < base-branch file < user config < working-tree
 *   project file (the usual project-over-user order).
 * The remote must point at the PR's repository (remoteRepoMismatch), the
 * base is fetched and `refs/remotes/<remote>/<base>` must equal GitHub's
 * base sha; the files are then read at that sha with replace refs off. A base
 * outside trustedBases is never read. When the base cannot be verified the
 * base layer is empty with a warning (defaults are the strict setting), or,
 * with `strict`, the load throws.
 */
export declare function loadTrustedShipConfig(input: TrustedShipConfigInput): LoadedShipConfig;
/**
 * Merge-rule paths beyond PROTECTED_PATHS for a guard outside a ship run
 * (copilot_run): a non-default ship.knownFlakyFile from the user config at its
 * default location and from the working-tree project config under `root`.
 * Protection only widens here, so the untrusted project file may add a path
 * but never drop one; the base branch is not read (no fetch). An unreadable
 * layer adds nothing.
 */
export declare function configuredProtectedPaths(root: string): string[];
/**
 * The known-flaky list committed at the verified base commit (never the PR
 * head; LoadedShipConfig.trustedBaseCommit). No commit or no file = empty.
 */
export declare function loadBaseKnownFlaky(exec: Exec, root: string, commit: string | undefined, file: string): KnownFlakyTest[];
//# sourceMappingURL=config.d.ts.map