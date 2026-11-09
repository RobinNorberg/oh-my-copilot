/**
 * The GitHub Copilot coding agent as a factory implementer, engine side
 * (factory night 3, goal 6, lane L6b; the forge adapter is
 * src/forge/github/coding-agent.ts). The engine methods live in engine.ts
 * (implement dispatch, the wait, the adopt and the hand-off after publish);
 * this module holds what they share with the guard and the run state:
 *
 * - config: `factory.run.implementer` (`copilot` | `coding-agent`, default
 *   `copilot`), `factory.codingAgent.maxWaitMinutes` (90) and
 *   `factory.codingAgent.maxSessionsPerDay` (5) and `factory.codingAgent.repos`
 *   (the per-repository opt-in), from the trusted user config; the
 *   working-tree project config may only opt out or lower a number (a lane
 *   can drop a file into the checkout, and a session is billed);
 *   chooseCodingAgent reads the user layer first and nothing else without
 *   its opt-in;
 * - the sealed run-state record of the session (CodingAgentRunRecord) and its
 *   shape check, called by state.ts on every load;
 * - session metering: one premium request per session as an estimate
 *   (decision D6), recorded in the budget ledger tagged role `coding-agent`
 *   and mirrored in the engine ledger directory (outside every lane-writable
 *   root), the per-day count the cap reads (the larger of the two), and the
 *   cap check made atomic across engines by a provisional mirror entry
 *   written under the mirror's file lock;
 * - the exact git and gh shapes of the adopt and the hand-off, which the
 *   factory guard (exec.ts) admits: the fetch of one PR head (only with the
 *   step context naming it), the read of FETCH_HEAD, the merge-base of two
 *   commits, the tree listing of one commit, and the link comment on the
 *   agent's PR (only with the step context naming that PR; the guard runs it
 *   with its own copy of the body file, which must be the exact link text).
 *
 * Everything the agent wrote is untrusted lane output. Nothing here reads a
 * title, body, comment or commit message of the agent's PR.
 */
import { type CodingAgentContext, type CodingAgentRepo } from '../../forge/github/coding-agent.js';
/** Waiting for the agent (not a human decision): no issue comment; `omg factory run <n>` reads the status again. */
export declare const CODING_AGENT_WAIT_GATE = "coding-agent-wait";
/** A human must look: the agent is unavailable, busy on the issue, unassigned, ambiguous, closed, or the read was cut. */
export declare const CODING_AGENT_GATE = "coding-agent";
/** The POST returned 2xx but no read showed the agent assigned (the session is counted; never re-assigned). */
export declare const CODING_AGENT_UNCONFIRMED_GATE = "coding-agent-unconfirmed";
/** factory.codingAgent.maxSessionsPerDay reached: nothing was assigned. */
export declare const CODING_AGENT_SESSIONS_GATE = "coding-agent-sessions";
/** A later read's assignedAt differs from the stored session start: a human re-assigned the agent. */
export declare const CODING_AGENT_REASSIGNED_GATE = "coding-agent-reassigned";
/** factory.codingAgent.maxWaitMinutes passed since GitHub's assignedAt while the agent still works. */
export declare const CODING_AGENT_TIMEOUT_GATE = "coding-agent-timeout";
/** The finished PR fails the adopt preconditions (adoptPreconditions or the engine's own checks). */
export declare const CODING_AGENT_ADOPT_GATE = "coding-agent-adopt";
/** The PR head moved between the status read and the fetch (or the re-read after it). */
export declare const CODING_AGENT_HEAD_MOVED_GATE = "coding-agent-head-moved";
/**
 * The pre-assign read's window: from long before any agent existed (a
 * `local` since keeps the skew margin, so the query starts at 2008-01-01),
 * so an assignment or an agent PR of any earlier session shows (item 8).
 */
export declare const PRE_ASSIGN_SINCE: Readonly<{
    at: "2008-01-01T00:02:00Z";
    source: "local";
}>;
/** Re-reads right after a POST whose first read did not confirm the assignment, before the run parks. */
export declare const CODING_AGENT_CONFIRM_READS = 3;
export type FactoryImplementer = 'copilot' | 'coding-agent';
export interface CodingAgentConfig {
    /** `factory.run.implementer`: who implements an issue run on GitHub. */
    implementer: FactoryImplementer;
    /** `factory.codingAgent.maxWaitMinutes`: how long a session may work before the run parks at coding-agent-timeout. */
    maxWaitMinutes: number;
    /** `factory.codingAgent.maxSessionsPerDay`: sessions the factory starts per UTC day (all runs, all repositories of this user). */
    maxSessionsPerDay: number;
    /** `factory.codingAgent.repos`: the `OWNER/NAME` repositories a billed session may start in (user config only; compared case-insensitively). */
    repos: string[];
}
export declare const DEFAULT_CODING_AGENT_CONFIG: Readonly<CodingAgentConfig>;
/**
 * Resolve the coding agent keys: defaults < trusted user config; the
 * working-tree project config may only set the implementer back to
 * `copilot` and lower the numbers (anything else is ignored with a warning).
 * Throws on an ill-typed value.
 */
export declare function resolveCodingAgentConfig(trustedUser: unknown, project: unknown): {
    config: CodingAgentConfig;
    warnings: string[];
};
export type CodingAgentChoice = {
    use: true;
    config: CodingAgentConfig;
    warnings: string[];
} | {
    use: false;
    warning?: string;
};
/**
 * Whether this run uses the coding agent: only when the trusted user config
 * says `factory.run.implementer: "coding-agent"`, the forge is GitHub, the
 * run's repository is in the user's `factory.codingAgent.repos` and the
 * project config does not opt out. The user layer is looked at first:
 * without its opt-in nothing else is parsed (an ill-typed project value
 * cannot fail a run that never opted in) and `use: false` comes back
 * silently. A forge or repository miss is `use: false` with one warning (the
 * run takes the Copilot implement lane). Throws only on a config error
 * after the user opted in (the engine then parks).
 */
export declare function chooseCodingAgent(trustedUser: unknown, readProject: () => unknown, run: {
    forgeKind: string;
    repoUrl: string;
}): CodingAgentChoice;
/** chooseCodingAgent on `trustedUser` (default: the user's own trusted config) and the checkout's project config (.copilot/omg.jsonc). */
export declare function loadCodingAgentChoice(root: string, run: {
    forgeKind: string;
    repoUrl: string;
}, trustedUser?: unknown): CodingAgentChoice;
/**
 * Why a run may not use the coding agent although the config asks for it,
 * or null: GitHub only (the agent is a GitHub feature), issue runs only (a
 * ci-heal run has no issue to assign).
 */
export declare function codingAgentRefusal(forgeKind: string, runKind: 'issue' | 'ci-heal'): string | null;
/**
 * One coding agent session of a run, sealed with the run state
 * (FactoryRunState.codingAgent) and shape-checked on every load.
 */
export interface CodingAgentRunRecord {
    /** The run's coding-agent lane (FactoryLaneRecord.id). */
    laneId: string;
    /** The engine's LOCAL clock just before the assign POST: the `local` since until a read confirms the session. */
    assignAt: string;
    /**
     * `pending`: written before the POST (a crash after it is treated as
     * posted: counted, never re-assigned); `posted`: the POST returned 2xx (a
     * session is counted whatever the read showed); `failed`: the POST failed,
     * a rerun may assign again after a fresh pre-read.
     */
    assign: 'pending' | 'posted' | 'failed';
    /** GitHub's `assignedAt` of the first confirming read, stored once and never refreshed. */
    since?: {
        at: string;
        source: 'github';
    };
    /** The agent PR and exact head the engine adopted (from the read whose adoptPreconditions passed). */
    adopted?: {
        pr: number;
        head: string;
    };
    /** The link comment is on the agent PR. */
    linked?: boolean;
    /** The agent PR is closed (decision D5). */
    closed?: boolean;
}
/** Why `v` is not a CodingAgentRunRecord (state.ts calls it on load), or null. */
export declare function codingAgentRecordProblem(v: unknown): string | null;
/** The run's repository (`https://<host>/<owner>/<name>`, as intake recorded it from GitHub) as the adapter's parts, or undefined. */
export declare function codingAgentRepoOf(repoUrl: string): CodingAgentRepo | undefined;
/**
 * Open pull requests the agent authored in `repoName` (`OWNER/NAME`) and
 * linked to the issue, from the raw status response, whatever session they
 * belong to (parseCodingAgentStatus files earlier sessions under `ignored`
 * without their state). The pre-assign check refuses on any (item 8).
 */
export declare function openAgentPrs(stdout: string, repoName: string): number[];
/** `git fetch` of the agent PR's head: no tags, no configured refmap, so only FETCH_HEAD (and objects) change. */
export declare function codingAgentFetchArgs(pr: number): string[];
/** The commit the fetch wrote to FETCH_HEAD. */
export declare const CODING_AGENT_FETCH_HEAD_ARGS: readonly string[];
/** Every tree entry of one commit (modes included): the adopt's gitlink and symlink check. */
export declare function codingAgentTreeArgs(sha: string): string[];
/** `git merge-base <sha40> <sha40>`: where the adopted head left the configured base (read-only). */
export declare function codingAgentMergeBaseArgs(base: string, head: string): string[];
/**
 * The engine's coding agent step context: CodingAgentContext plus, for the
 * adopt's fetch, the one PR number it may fetch (`adopt`), and, for the link
 * comment, the numbers, branch and sha its exact body is built from (`link`).
 */
export interface CodingAgentStepContext extends CodingAgentContext {
    adopt?: number;
    link?: {
        ownPr: number;
        branch: string;
        head: string;
    };
}
/**
 * The git shapes the adopt adds to the factory guard (exec.ts), exact argv:
 * codingAgentFetchArgs (only with a step context whose `adopt` is that PR),
 * CODING_AGENT_FETCH_HEAD_ARGS, codingAgentTreeArgs and codingAgentMergeBaseArgs.
 */
export declare function isCodingAgentGitArgs(a: readonly string[], ctx?: CodingAgentStepContext): boolean;
/** `gh pr comment <pr> --repo <HOST/OWNER/NAME> --body-file <file>`: the D5 link comment on the agent's PR. */
export declare function codingAgentLinkCommentArgs(repo: CodingAgentRepo, pr: number, bodyFile: string): string[];
/** argv index of the link comment's body file (the guard runs the comment with its own copy of it). */
export declare const CODING_AGENT_LINK_BODY_ARG = 6;
/**
 * The guard clause of the link comment: exactly codingAgentLinkCommentArgs
 * for the context's repository and `pr`. Without a CodingAgentContext naming
 * the PR it is refused.
 */
export declare function isCodingAgentLinkCommentArgs(a: readonly string[], ctx: CodingAgentStepContext | undefined): boolean;
/** The link comment (engine text only: numbers, the branch and a sha; nothing the agent wrote). */
export declare function codingAgentLinkBody(o: {
    issue: number;
    ownPr: number;
    branch: string;
    head: string;
}): string;
/** The guard's body check of the link comment: exactly codingAgentLinkBody of the step context's numbers, branch and sha, or why not. */
export declare function codingAgentLinkBodyProblem(body: string, ctx: CodingAgentStepContext | undefined): string | null;
/**
 * New or changed gitlinks (160000) and symlinks (120000) of `head`'s tree
 * against `base`'s (both `ls-tree -r -z --full-tree` output): host git does
 * not enter a nested repository, and a link can point out of the checkout.
 */
export declare function linkEntries(baseTree: string, headTree: string): {
    gitlinks: string[];
    symlinks: string[];
};
/** One session's estimate (decision D6): GitHub bills the agent separately from factory lanes; no AI credits of the run's caps. */
export declare const CODING_AGENT_SESSION_USAGE: Readonly<{
    credits: 0;
    premiumRequests: 1;
    source: "estimated";
}>;
/** The session record exists but cannot be parsed: a writer must not treat it as empty or overwrite it. */
export declare class CodingAgentMirrorUnreadableError extends Error {
    readonly path: string;
    constructor(path: string);
}
export interface CodingAgentSession {
    /** The repository root (the budget ledger lives under its state root). */
    root: string;
    /** The engine ledger directory (outside every lane-writable root). */
    ledgerDir: string;
    laneId: string;
    /** runSlug of the run (`issue-<n>`). */
    run: string;
    /** `HOST/OWNER/NAME`. */
    repo: string;
    /** When the POST returned (engine clock, ISO). */
    at: string;
}
/**
 * Count one session, idempotently per lane (a crash after the POST counts it
 * again under the same keys): the budget ledger record `factory-lane:<laneId>`
 * tagged `{ kind: factory-lane, role: coding-agent, run }`, and the engine
 * ledger mirror. Returns the failures (a write that failed is reported, not
 * thrown: the session is real either way).
 */
export declare function recordCodingAgentSession(s: CodingAgentSession): string[];
/**
 * Sessions the factory started on UTC `day` (`YYYY-MM-DD`): the larger of the
 * budget ledger's role `coding-agent` records and the engine ledger mirror (a
 * lane can reach the repository's state root, not the engine ledger; `omg
 * budget reset` clears the budget ledger, not the mirror).
 */
export declare function codingAgentSessionsOn(root: string, ledgerDir: string, day: string): number;
/** The engine ledger mirror's lock could not be taken in time: another engine is reserving a session (the caller reports busy). */
export declare class CodingAgentSessionsBusyError extends Error {
    constructor(path: string);
}
/**
 * The cap check, atomic across engines: under the mirror's file lock, count
 * the day's sessions and, below `max`, write a provisional mirror entry for
 * this lane before the lock is released, so a second engine counts it before
 * its own POST. `by` (the caller's process identity) is read by the caller
 * BEFORE the lock. A lock timeout throws CodingAgentSessionsBusyError.
 */
export declare function reserveCodingAgentSession(s: CodingAgentSession & {
    by: string;
}, max: number, timeoutMs?: number): {
    ok: boolean;
    used: number;
};
/** Drop the provisional entry after a definite refusal of the assign (no session started), under the same lock. */
export declare function releaseCodingAgentSession(s: Pick<CodingAgentSession, 'ledgerDir' | 'repo' | 'laneId'>, timeoutMs?: number): void;
/**
 * Whether a failed assign POST was refused for certain, so no session
 * started: gh exited with a status and reported an HTTP 4xx for the request.
 * A timeout or signal (no exit status), a network error or a 5xx leaves the
 * outcome unknown. (A guard refusal before the spawn is the caller's other
 * definite case.)
 */
export declare function isDefiniteAssignRefusal(message: string): boolean;
//# sourceMappingURL=coding-agent-lane.d.ts.map