/**
 * The `omg factory run` command guard: ship's allowlist (src/ship/exec.ts)
 * extended with the exact shapes the factory engine builds (design §4).
 *
 * - Pushes: only `git push origin <sha40>:refs/heads/factory/<name>`, plain
 *   (no `+`, no flags), never a protected branch. Ship's `HEAD:refs/heads/<b>`
 *   push shape is refused here: the factory pushes nothing else.
 * - GitHub: `gh issue view|comment`, `gh pr create --draft|comment|list|ready`
 *   (one `pr list` is the blocked-by gate's merged lookup on `factory/issue-<n>`)
 *   and `gh repo view --json url` (ci-heal runs) in fixed shapes, plus ship's
 *   `gh pr view|checks` and `gh run list|view|rerun`.
 *   Never `gh api`, `gh -R`, or a merge (merge is always human), except the
 *   human review read (src/forge/github/graphql.ts isReviewFeedbackArgs:
 *   `gh api graphql` with its constant query, pinned to the GithubReadContext
 *   repo) and the three coding-agent shapes below.
 * - Tracker writes (`omg factory enqueue` only, when its TrackerWriteContext is
 *   set): `gh issue create`, `gh issue edit` (title, body, labels) and the
 *   `shipyard-key:` search `gh issue list --search`, each in one exact shape,
 *   pinned to the configured repository, with a body file from the caller's
 *   own directory (gh reads the guard's checked copy) and labels from its allowlist. Never close
 *   (the factory's only close is the coding-agent PR close, bound to CodingAgentContext.pr), delete,
 *   transfer or lock; without the context all three shapes are refused.
 * - The Copilot coding agent (src/forge/github/coding-agent.ts), beside the
 *   review read: its fixed-query `gh api graphql` status read with the
 *   repository-only GithubReadContext; its two writes only with a
 *   CodingAgentContext, which the engine sets around that one step: the REST
 *   assign of exactly the context's issue on exactly its base, and
 *   `gh pr close` of exactly its `pr` (the agent's own PR; the tracker never
 *   closes). Without that context both writes are refused.
 * - Adopting the coding agent's PR (src/factory/run/coding-agent-lane.ts):
 *   `git fetch --no-tags --refmap= origin refs/pull/<n>/head` (only
 *   FETCH_HEAD moves), `git rev-parse --verify FETCH_HEAD^{commit}`,
 *   `git ls-tree -r -z --full-tree <sha40>`, and the link comment
 *   `gh pr comment <pr> --repo <HOST/OWNER/NAME> --body-file <f>` only with a
 *   CodingAgentContext naming that `pr`, run with the guard's own copy of the body.
 * - Azure DevOps: `az devops invoke` on the routes.ts allowlist only, as the
 *   resolved az entry, for the run's forge repo (src/forge/ado/guard.ts).
 *   The work item create and the PATCH's item fields and links pass only with
 *   the TrackerWriteContext (shipyard-factory design PR 7b).
 * - The engine-owned prepare checkout: `git worktree add -B <its branch>
 *   <abs path> <sha40>` and `git merge --abort` (ship's prepare shapes run in it).
 * - Read-only git for the lane tamper check (review-guard.ts) and the review
 *   prompt's diff (no external diff driver, no textconv) and its standards
 *   files (`ls-tree` of docs/standards/ at the base commit).
 * - Every engine git command runs hardened (hardenedGitExec): no hooks and no
 *   fsmonitor, so a hook or fsmonitor a lane planted cannot run in the engine
 *   even if the tamper check missed it.
 */
import { type AdoGuardContext } from '../../forge/ado/guard.js';
import { type CodingAgentContext } from '../../forge/github/coding-agent.js';
import { ShipSafetyError, type Exec } from '../../ship/exec.js';
/** Every branch the factory pushes starts with this prefix (fixed, not configurable). */
export declare const FACTORY_BRANCH_PREFIX = "factory/";
export { MAX_TRACKER_BODY_CHARS } from '../../forge/body-file.js';
export declare class FactorySafetyError extends ShipSafetyError {
    constructor(message: string);
}
/** A plain repo-relative path for the local backlog shapes, shared with the check guard: no `.` or `..` segment. */
export declare const isPlainRepoPath: (p: string) => boolean;
export declare const FOR_EACH_REF_FORMAT = "--format=%(refname) %(objectname)";
/**
 * What `omg factory enqueue` may write (shipyard-factory design §3.3, PR 7a).
 * Only a caller that sets it gets the tracker write shapes.
 */
export interface TrackerWriteContext {
    /** The configured forge repository as gh's `--repo` value (ghRepoArg, src/forge/github/gh.ts); every write names exactly it. */
    repo: string;
    /** Absolute directory the caller writes bodies into; `--body-file` must be a file directly in it. */
    bodyDir: string;
    /** Labels a write may add or remove (the intake label, `priority:p0`…`p3`); `factory:*` and `harbor:*` never pass. On Azure DevOps: the tags a new work item may carry. */
    labels: readonly string[];
    /** Azure DevOps: the work item types a create may name (factory.intake.itemTypes); none = no create. */
    itemTypes?: readonly string[];
    /** Who writes: `triage` allows only its label edit (GitHub) and tag/priority PATCH (Azure DevOps); unset or `enqueue` = enqueue's shapes. */
    purpose?: 'triage' | 'enqueue';
}
/**
 * What the guard knows about the local forge: the exact mirror path the
 * resolved config names (localMirrorPath), and the base commit the mirror
 * sync read from the local base branch, the one sha it may push there.
 */
export interface LocalGuardContext {
    mirror: string;
    baseSha?: string;
}
/** Same path, case-insensitively only where the file system usually is (Windows, macOS); both sides resolved. */
export declare function sameFsPath(a: string, b: string): boolean;
/** The fetch refspec `git remote add omg-local` writes: the only one the engine accepts. */
export declare const LOCAL_REMOTE_DEFAULT_FETCH = "+refs/heads/*:refs/remotes/omg-local/*";
/**
 * `git config --get-regexp` of the `omg-local` keys the engine checks:
 * `vcs` hands the transport to a `git remote-<vcs>` helper (remote-ext runs
 * a command), `mirror` turns a push into a mirror push, and a `fetch`
 * refspec other than LOCAL_REMOTE_DEFAULT_FETCH could map a branch onto
 * local refs: git moves the refs it maps to after a push to the remote or to
 * its url (git 2.56 does that for a push to the mirror path too), and
 * `--refmap=` covers fetches only.
 */
export declare const LOCAL_REMOTE_REFUSED_CONFIG_ARGS: readonly string[];
/** The refused `key=value`s in the output of LOCAL_REMOTE_REFUSED_CONFIG_ARGS: every vcs or mirror, and any fetch refspec but the default. */
export declare function localRemoteRefusedKeys(stdout: string): string[];
/**
 * `git config -z --get-regexp` of every url rewrite (`url.<base>.insteadOf`
 * / `pushInsteadOf`, any scope or include). A push names the mirror path
 * itself (localTransportArgs), and git rewrites that literal string too: a
 * rewrite whose value is a prefix of it sends the push elsewhere, and an
 * identity `-c url.<mirror>.insteadOf=<mirror>` does not override a longer
 * planted one. `-z`: a url subsection may contain spaces.
 */
export declare const URL_REWRITE_CONFIG_ARGS: readonly string[];
/**
 * The `key=value`s in the output of URL_REWRITE_CONFIG_ARGS that would
 * rewrite `mirror`: the value is a prefix of the mirror path in either slash
 * form, case-insensitively on Windows and macOS. A key without a value counts
 * (an empty prefix matches everything).
 */
export declare function mirrorRewriteKeys(stdout: string, mirror: string): string[];
/**
 * `git config -z --get-regexp` of every `remote.*` key, any scope or include.
 * A push names the mirror path (localTransportArgs), and git first looks up a
 * configured remote of exactly that name: POSIX git skips names that start
 * with `/`, but a Windows path (`C:\...`) is found, so its `url` / `pushurl`
 * redirect the push and its `receivepack` runs a command. Pinning
 * `-c remote.<mirror>.receivepack` cannot cover every spelling of the name,
 * so such a remote is refused instead (mirrorNamedRemoteKeys).
 */
export declare const REMOTE_CONFIG_ARGS: readonly string[];
/**
 * The `key=value`s in the output of REMOTE_CONFIG_ARGS whose remote NAME is
 * a spelling of `mirror`: either slash form, a trailing or doubled slash, the
 * `file://` form, case-insensitively on Windows and macOS.
 */
export declare function mirrorNamedRemoteKeys(stdout: string, mirror: string): string[];
/** The GitHub repository a run reads review feedback from: gh's `HOST/OWNER/NAME` (ghRepoArg). */
export interface GithubReadContext {
    repo: string;
}
/**
 * Throws FactorySafetyError unless the command is a factory shape or a
 * non-push, non-merge ship shape. `extraProtected` adds the run's base.
 * `az` and python go to the Azure DevOps guard (src/forge/ado/guard.ts),
 * which refuses them unless `ado` names the run's forge and az entry.
 * `writes` (enqueue only) adds the tracker write shapes.
 */
export declare function assertFactoryCommand(cmd: string, args: string[], extraProtected?: readonly string[], env?: Readonly<Record<string, string>>, ado?: AdoGuardContext, writes?: TrackerWriteContext, local?: LocalGuardContext, github?: GithubReadContext, agent?: CodingAgentContext): void;
/**
 * Wrap an Exec so every call passes assertFactoryCommand first; `extraProtected` is read per call.
 * An `az devops invoke` write runs with the guard's own copy of its validated --in-file body,
 * and a tracker write (gh issue create/edit) with the guard's own copy of its checked --body-file.
 * `writes` is set only by `omg factory enqueue`: the tracker write shapes pass while it returns a context.
 * `local` (the local forge only) binds the mirror init, the remote add and the base push to this run's mirror and synced base.
 * `github` (GitHub only) names the repository the human review read may query; without it that read is refused.
 * It is read-only: besides the review read it admits only the coding agent's status read.
 * `agent` (GitHub only, set by the engine around one coding agent step, never for a whole run) admits the assign of its
 * issue on its base and the close of its `pr`; without it both writes are refused.
 */
export declare function factoryGuardExec(exec: Exec, extraProtected?: () => readonly string[], ado?: () => AdoGuardContext | undefined, writes?: () => TrackerWriteContext | undefined, local?: () => LocalGuardContext | undefined, github?: () => GithubReadContext | undefined, agent?: () => CodingAgentContext | undefined): Exec;
/** Prepended to every hardened git command, after the guard checked the plain shape. */
export declare function gitHardeningArgs(hooksDir: string): string[];
/**
 * Prepended to a transport command on the local forge's `omg-local` remote:
 * the stock pack programs, so a `remote.omg-local.receivepack` or
 * `uploadpack` planted in the checkout's .git/config never runs. Its url and
 * every push url are compared with the exact mirror path before each fetch
 * and push (localRemoteMismatch), so a planted pushurl or insteadOf refuses.
 */
export declare const LOCAL_REMOTE_PACK_ARGS: readonly string[];
/**
 * The transport git really runs for an `omg-local` command. A fetch never
 * uses the checkout's `remote.omg-local.fetch` refspec (`--refmap=`) or
 * follows tags: a bare branch becomes the explicit
 * `+refs/heads/<b>:refs/remotes/omg-local/<b>`, so only that tracking ref
 * moves, never a planted destination such as `refs/heads/x/*`. A push names
 * the mirror path itself (`mirror`), because a push through the named remote
 * also moves the local refs that remote's fetch refspec maps the pushed
 * branch to (an empty `-c remote.omg-local.fetch=` does not reset it).
 * The remote's url and push urls, with insteadOf / pushInsteadOf applied,
 * are checked to be that path before every push (localRemoteMismatch), so
 * a rewrite that would apply to the path refuses first.
 */
export declare function localTransportArgs(args: readonly string[], mirror?: string): string[];
/**
 * Run git with `core.hooksPath` set to an engine-owned empty directory and
 * `core.fsmonitor=false`, so no hook (pre-push, post-checkout,
 * reference-transaction) and no fsmonitor command runs in the engine.
 * Refuses when the hooks directory is missing or not empty. Other commands
 * pass through unchanged. Wrap it INSIDE factoryGuardExec, so the guard sees
 * the plain shape.
 *
 * The system and global config stay. GIT_CONFIG_NOSYSTEM is not set: Git for
 * Windows keeps `credential.helper` and `core.autocrlf` in the system config,
 * so pushes would lose their credentials and every CRLF checkout would read
 * as modified, and `credential.helper` cannot be blanked either (pushes need
 * the credential manager). The system config needs admin rights to write;
 * the global one and every file a config includes are hashed into the lane
 * snapshot instead (review-guard.ts), so a lane that plants a helper,
 * sshCommand, pushInsteadOf or clean filter there parks the run.
 *
 * `localMirror` (the local forge) is the engine-owned mirror path a push on
 * `omg-local` goes to (localTransportArgs).
 */
export declare function hardenedGitExec(exec: Exec, hooksDir: string, localMirror?: () => string | undefined): Exec;
//# sourceMappingURL=exec.d.ts.map