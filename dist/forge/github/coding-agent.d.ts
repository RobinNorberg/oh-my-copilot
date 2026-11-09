/**
 * The GitHub Copilot coding agent ("Copilot cloud agent") as a factory
 * implementer, forge side (factory night 3, goal 6, lane L6a). Three exact
 * gh shapes, each pinned by the factory guard (src/factory/run/exec.ts):
 *
 * - assign (WRITE, starts one agent session, billed by GitHub):
 *   `gh api --hostname <host> --method POST repos/<owner>/<name>/issues/<n>/assignees
 *    -f assignees[]=copilot-swe-agent[bot] -f agent_assignment[base_branch]=<base>`
 *   (REST "Add assignees to an issue" with the documented agent_assignment
 *   object). Passes only with a CodingAgentContext naming this repository,
 *   issue and base. REST ignores an assignee it cannot assign, so
 *   assignCodingAgent confirms the assignment with the status read.
 * - status (READ): `gh api graphql` with CODING_AGENT_STATUS_QUERY: whether the
 *   agent is assignable, its assignment on the issue, the pull requests it
 *   linked to the issue, its review requests (its finish signal) and each
 *   PR's commits (oid, date, author account). Passes with the
 *   repository-only GithubReadContext.
 * - close (WRITE): `gh pr close <n> --repo <HOST/OWNER/NAME>`, for the agent's
 *   PR once the engine rebranched it (decision D5). Passes only with a
 *   CodingAgentContext whose `pr` is that number.
 *
 * Everything the agent wrote is untrusted: this module reads no title, body,
 * comment or commit message, and validates every name and sha it hands on.
 * Who acted comes from GitHub's event actors and the PR author (`__typename`
 * Bot and the agent login), never from text. GitHub documents no stable bot
 * id, so the identity is not pinned by databaseId or node id.
 *
 * Commit authorship is advisory only: GitHub maps a commit to an account by
 * its author email, which whoever pushes sets freely (the agent's noreply
 * address can be spoofed). A commit list that is not all the agent's refuses
 * adoption; an all-agent list proves nothing more, and the engine (L6b) still
 * treats the adopted diff as untrusted lane output. Adoption also requires
 * every commit to carry a valid signature made by GitHub itself (web-flow):
 * every agent commit seen live is, a locally pushed commit with a spoofed
 * author email is not. That narrows the spoof to commits created through
 * GitHub's own web or API by someone with write access; it is no proof of
 * authorship either.
 */
import type { Exec } from '../../ship/exec.js';
/** The agent's login as GraphQL reports actors and PR authors (`__typename: Bot`). */
export declare const CODING_AGENT_LOGIN = "copilot-swe-agent";
/** The agent's login in the REST assignees body. */
export declare const CODING_AGENT_REST_ASSIGNEE = "copilot-swe-agent[bot]";
/**
 * The account GitHub maps the agent's commits to (`Commit.author.user`; the
 * issue `assignees` list shows the same account as `User "Copilot"`).
 * Advisory: see the module comment.
 */
export declare const CODING_AGENT_COMMIT_LOGIN = "Copilot";
/**
 * How far before a LOCAL `since` the status window starts: GitHub times are
 * whole seconds and its clock is not ours, so an assignment a little "before"
 * the caller's local `since` still counts. A GitHub `since` gets no margin.
 */
export declare const CODING_AGENT_SINCE_SKEW_SECONDS = 120;
/**
 * The status read, one line (no argv newline on any platform). `owner`,
 * `name` and `since` go in as raw strings (`-f`), `number` as an integer
 * (`-F`). Every list reports whether it was cut (pageInfo): a cut list makes
 * the phase `truncated`, never a guess.
 */
export declare const CODING_AGENT_STATUS_QUERY: string;
/** The parts of a forge repository the shapes name. */
export interface CodingAgentRepo {
    host: string;
    owner: string;
    name: string;
}
/**
 * The write context of ONE coding agent step, set by the engine only around
 * the assign or the close (never for a whole run). `repo` is gh's
 * `HOST/OWNER/NAME` (ghRepoArg). The assign passes only for `issue` on
 * exactly `base`; the close only for `pr`.
 */
export interface CodingAgentContext {
    repo: string;
    issue: number;
    base: string;
    pr?: number;
}
/**
 * Where the status window starts, and whose clock said so:
 * - `local`: the engine's own clock just before the assign. The read keeps
 *   events from CODING_AGENT_SINCE_SKEW_SECONDS before it (codingAgentWindowStart).
 * - `github`: a GitHub time, the `assignedAt` of a previous read of this
 *   session. Used exactly: nothing before it counts, so the window never steps back.
 */
export interface CodingAgentSince {
    at: string;
    source: 'local' | 'github';
}
/**
 * The query's window start for a `since` time: floored to the whole second,
 * minus CODING_AGENT_SINCE_SKEW_SECONDS, whatever its source (the parser cuts a
 * `github` since exactly; the query may return more).
 */
export declare function codingAgentWindowStart(since: string): string;
/** `gh` argv that assigns `issue` to the agent, branching from `base`. Throws on values the guard would refuse. */
export declare function codingAgentAssignArgs(repo: CodingAgentRepo, issue: number, base: string): string[];
/**
 * `gh` argv of the status read for `issue`, from the window start of `since`.
 * The query-level since is ALWAYS widened by CODING_AGENT_SINCE_SKEW_SECONDS,
 * for a `github` since too: GitHub's `since` filter excludes an event in the
 * same second (checked live: since=19:18:45Z dropped an event at 19:18:45Z),
 * so querying from the session's own `assignedAt` would drop its Assigned
 * event and read `not-assigned`. The parser then cuts a `github` since exactly.
 * Never remove this margin.
 */
export declare function codingAgentStatusArgs(repo: CodingAgentRepo, issue: number, since: CodingAgentSince): string[];
/** `gh` argv that closes the agent's PR `pr` (after the engine rebranched it). */
export declare function codingAgentCloseArgs(repo: CodingAgentRepo, pr: number): string[];
/**
 * The guard clause for the assign shape: `args` is exactly
 * codingAgentAssignArgs(ctx.repo, ctx.issue, ctx.base). Without a
 * CodingAgentContext it is refused.
 */
export declare function isCodingAgentAssignArgs(args: readonly string[], ctx: CodingAgentContext | undefined): boolean;
/** The guard clause for the status read: exactly codingAgentStatusArgs for `repoArg`, some issue number and a whole-second window start. */
export declare function isCodingAgentStatusArgs(args: readonly string[], repoArg: string | undefined): boolean;
/** The guard clause for the close: exactly codingAgentCloseArgs(ctx.repo, ctx.pr). Without a context naming the PR it is refused. */
export declare function isCodingAgentCloseArgs(args: readonly string[], ctx: CodingAgentContext | undefined): boolean;
/** One pull request the agent linked to the issue, as read (validated fields only). */
export interface CodingAgentPr {
    number: number;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    isDraft: boolean;
    /** The PR's author is the agent (`__typename: Bot`, CODING_AGENT_LOGIN). */
    byAgent: boolean;
    /** Head and base repository are both the read repository, not cross-repository. */
    sameRepo: boolean;
    baseRef?: string;
    headRef?: string;
    /** The head commit (headRefOid), when GitHub reported a 40-hex sha. */
    head?: string;
    /**
     * The newest commit in the PR's commit list, when a 40-hex sha. When it is
     * not `head`, the read does not show the head commit: `finished` is never
     * reported and adoptPreconditions refuses.
     */
    commitsHead?: string;
    /** The head commit's committedDate, when the newest listed commit is that head. */
    headCommittedAt?: string;
    /**
     * Every commit on the PR (all of them, not only those dated after session
     * start: committedDate is set by whoever commits) is mapped to the agent's
     * account (CODING_AGENT_COMMIT_LOGIN). Undefined when the list was cut, is
     * empty, or a commit is unreadable. Advisory: see the module comment.
     */
    allCommitsByAgent?: boolean;
    /**
     * Every commit on the PR has a valid signature made by GitHub
     * (`signature { isValid wasSignedByGitHub }`, the web-flow key). Undefined
     * when the list was cut, is empty, or a commit is unreadable. Advisory: see
     * the module comment.
     */
    allCommitsSignedByGitHub?: boolean;
    /** When the agent linked it to the issue (the newest linking event in the session). */
    linkedAt: string;
    /** The agent's newest review request on the PR at or after session start (its "work finished" signal). */
    finishedAt?: string;
    /** Which of the PR's lists GitHub cut, or false. */
    truncated: false | 'review-requests' | 'commits';
}
/**
 * The agent's state on one issue, for its CURRENT assignment (the session):
 * - `unavailable`: the agent is not assignable in the repository (not enabled, or no Copilot plan);
 * - `not-assigned`: assignable, but not assigned in the window, or unassigned after its newest assignment;
 * - `waiting-pr`: assigned, no pull request of its own linked in this session yet;
 * - `working`: its PR is open and it has not requested a review since its newest commit;
 * - `finished`: its PR is open and its newest review request is at or after the head commit (adoptPreconditions decides what follows);
 * - `closed`: its PR was closed or merged before the engine adopted it;
 * - `ambiguous`: it linked more than one open PR of its own in this session (no `pr` is set);
 * - `truncated`: a list GitHub returned was cut, so the read proves nothing (fail closed: no `pr`;
 *   do not re-assign, do not adopt; count the session if the assign POST returned 2xx). `truncation` names the list.
 */
export type CodingAgentPhase = 'unavailable' | 'not-assigned' | 'waiting-pr' | 'working' | 'finished' | 'closed' | 'ambiguous' | 'truncated';
/** Why an agent-linked PR is not a candidate. */
export type CodingAgentIgnoreReason = 'not-agent-author' | 'cross-repository' | 'outside-session';
export interface CodingAgentStatus {
    phase: CodingAgentPhase;
    /** `OWNER/NAME` of the repository GitHub answered for (its nameWithOwner). */
    repo: string;
    /** The issue number GitHub answered for. */
    issue: number;
    /** The agent is in the repository's assignable actors. */
    available: boolean;
    /**
     * GitHub's own time of the session start: the first agent assignment after
     * the newest agent unassignment that precedes its newest assignment (the
     * start of the current assignment streak). Absent when the agent is not
     * assigned. L6b stores the first confirmed value as `since` with source
     * `github` for every later read of the session, never refreshing it.
     */
    assignedAt?: string;
    /** The PR the phase is about (the newest the agent linked in this session); absent for unavailable, not-assigned, waiting-pr, ambiguous and truncated. */
    pr?: CodingAgentPr;
    /** Distinct PRs the agent linked in this session that it authored in this repository. */
    candidates: number[];
    /** PRs an agent event linked that are never adopted or closed, with the first reason seen. */
    ignored: Array<{
        number: number;
        reason: CodingAgentIgnoreReason;
    }>;
    /** For `truncated`: which list GitHub cut, on which issue (and PR), so a park message can name it. */
    truncation?: {
        list: 'issue-timeline' | 'assignable-actors' | 'review-requests' | 'commits';
        issue: number;
        pr?: number;
    };
}
/**
 * The agent's state in one status response (stdout of codingAgentStatusArgs).
 * `since` cuts the window (CodingAgentSince): a `local` time keeps events from
 * the skew margin before it, a `github` time (a previous read's `assignedAt`)
 * keeps nothing before it. Within the window the session is the current
 * assignment streak (`assignedAt`); only agent links AFTER its start event in
 * timeline order (by time, ties in GitHub's order) count, earlier links go to
 * `ignored`; agent review requests count at or after its start time. Only events
 * whose actor is the agent link a PR, and only PRs the agent authored in this
 * repository become candidates. Throws when the response has no repository
 * or issue.
 */
export declare function parseCodingAgentStatus(stdout: string, since?: CodingAgentSince): CodingAgentStatus;
/** What assignCodingAgent observed. */
export interface CodingAgentAssignResult {
    /** The assign POST returned 2xx (gh exited 0): GitHub may have started a billed session; count it. */
    posted: true;
    /** The follow-up status read shows the agent assigned. False: not yet visible, not assigned, or the read failed or was cut. */
    confirmed: boolean;
    /** The follow-up read; its `assignedAt` (GitHub's time) is the `since` (source `github`) for later reads. Absent when the read failed. */
    status?: CodingAgentStatus;
    /** Why the follow-up read failed, when it did. */
    readError?: string;
}
/**
 * Assigns `issue` to the agent on `base` and reads the status once.
 * `localSince` is the caller's LOCAL clock just before this call (read with
 * the skew margin). Throws (GhCommandError) only when the POST itself fails;
 * once the POST returned 2xx the result says `posted: true` whatever the read
 * shows, so "posted but not yet visible" (`confirmed: false`) never reads as
 * "not assigned". One read proves nothing negative: re-read later, never
 * re-assign automatically.
 */
export declare function assignCodingAgent(exec: Exec, repo: CodingAgentRepo, issue: number, base: string, localSince: string, cwd: string): CodingAgentAssignResult;
/** What adopting the agent's PR must match: the run's repository, issue and base branch. */
export interface AdoptExpectation {
    /** `OWNER/NAME` of the run's repository. */
    repo: string;
    /** The issue the run assigned to the agent. */
    issue: number;
    /** The run's base branch (FactoryRunState.base). */
    base: string;
}
export type AdoptCheck = {
    ok: true;
    pr: number;
    head: string;
} | {
    ok: false;
    reasons: string[];
};
/**
 * The adopt preconditions (night-3 review checklist point 7) for the PR in
 * `status`: it is for the run's issue; the agent finished; the PR is open,
 * authored by the agent bot, not cross-repository, in the run's repository,
 * on the run's base branch; its head is a 40-hex sha that is the newest
 * commit read; and every commit on it is mapped to the agent's account and
 * signed by GitHub (a cut or unreadable list refuses too). Authorship and
 * signatures are advisory: passing does not make the diff trusted. The
 * caller fetches exactly that sha (and re-checks it after the fetch) under
 * its tamper snapshot.
 */
export declare function adoptPreconditions(status: CodingAgentStatus, want: AdoptExpectation): AdoptCheck;
//# sourceMappingURL=coding-agent.d.ts.map