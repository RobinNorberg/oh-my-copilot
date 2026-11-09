/**
 * The GitHub Copilot coding agent ("Copilot cloud agent") as a factory
 * implementer, forge side (factory night 3, goal 6, lane L6a). Three exact
 * gh shapes, each pinned by the factory guard to the run's repository
 * (GithubReadContext, src/factory/run/exec.ts):
 *
 * - assign (WRITE, starts one agent session, billed by GitHub):
 *   `gh api --hostname <host> --method POST repos/<owner>/<name>/issues/<n>/assignees
 *    -f assignees[]=copilot-swe-agent[bot] -f agent_assignment[base_branch]=<base>`
 *   (REST "Add assignees to an issue" with the documented agent_assignment
 *   object). REST ignores an assignee it cannot assign, so the caller confirms
 *   the assignment with the status read before it counts a session.
 * - status (READ): `gh api graphql` with CODING_AGENT_STATUS_QUERY: whether the
 *   agent is assignable, its assignment on the issue, the pull requests it
 *   linked to the issue, and whether it requested a review (its finish signal).
 * - close (WRITE): `gh pr close <n> --repo <HOST/OWNER/NAME>`, for the agent's
 *   PR once the engine rebranched it (decision D5).
 *
 * Everything the agent wrote is untrusted: this module reads no title, body,
 * comment or commit message, and validates every name and sha it hands on.
 * Who acted comes from GitHub's event actors and the PR author (`__typename`
 * Bot and the agent login), never from text.
 */
/** The agent's login as GraphQL reports actors and PR authors (`__typename: Bot`). */
export declare const CODING_AGENT_LOGIN = "copilot-swe-agent";
/** The agent's login in the REST assignees body. */
export declare const CODING_AGENT_REST_ASSIGNEE = "copilot-swe-agent[bot]";
/**
 * The status read, one line (no argv newline on any platform). `owner` and
 * `name` go in as raw strings (`-f`), `number` as an integer (`-F`).
 */
export declare const CODING_AGENT_STATUS_QUERY: string;
/** The parts of a forge repository the shapes name. */
export interface CodingAgentRepo {
    host: string;
    owner: string;
    name: string;
}
/** `gh` argv that assigns `issue` to the agent, branching from `base`. Throws on values the guard would refuse. */
export declare function codingAgentAssignArgs(repo: CodingAgentRepo, issue: number, base: string): string[];
/** `gh` argv of the status read for `issue`. */
export declare function codingAgentStatusArgs(repo: CodingAgentRepo, issue: number): string[];
/** `gh` argv that closes the agent's PR `pr` (after the engine rebranched it). */
export declare function codingAgentCloseArgs(repo: CodingAgentRepo, pr: number): string[];
/**
 * The guard clause for the assign shape: `args` is exactly
 * codingAgentAssignArgs for the repository `repoArg` (ghRepoArg), some issue
 * number and a plain base branch. Without a repository context it is refused.
 */
export declare function isCodingAgentAssignArgs(args: readonly string[], repoArg: string | undefined): boolean;
/** The guard clause for the status read: exactly codingAgentStatusArgs for `repoArg` and some issue number. */
export declare function isCodingAgentStatusArgs(args: readonly string[], repoArg: string | undefined): boolean;
/** The guard clause for the close: exactly codingAgentCloseArgs for `repoArg` and some PR number. */
export declare function isCodingAgentCloseArgs(args: readonly string[], repoArg: string | undefined): boolean;
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
    /** The head commit, when GitHub reported a 40-hex sha. */
    head?: string;
    /** When the agent linked it to the issue (the newest linking event). */
    linkedAt: string;
    /** The agent's newest review request on the PR (its "work finished" signal), at or after `since`. */
    finishedAt?: string;
}
/**
 * The agent's state on one issue:
 * - `unavailable`: the agent is not assignable in the repository (not enabled, or no Copilot plan);
 * - `not-assigned`: assignable, but not assigned since `since`;
 * - `waiting-pr`: assigned, no pull request linked yet;
 * - `working`: its PR is open and it has not requested a review;
 * - `finished`: its PR is open and it requested a review (adoptPreconditions decides what follows);
 * - `closed`: its PR was closed or merged before the engine adopted it;
 * - `ambiguous`: it linked more than one open PR since `since`.
 */
export type CodingAgentPhase = 'unavailable' | 'not-assigned' | 'waiting-pr' | 'working' | 'finished' | 'closed' | 'ambiguous';
export interface CodingAgentStatus {
    phase: CodingAgentPhase;
    /** `OWNER/NAME` of the repository GitHub answered for (its nameWithOwner). */
    repo: string;
    /** The agent is in the repository's assignable actors. */
    available: boolean;
    /** The newest assignment of the agent at or after `since`, while not unassigned after it. */
    assignedAt?: string;
    /** The PR the phase is about (the newest the agent linked); absent for unavailable, not-assigned and waiting-pr. */
    pr?: CodingAgentPr;
    /** Distinct PRs the agent linked to the issue at or after `since`. */
    candidates: number[];
}
/**
 * The agent's state in one status response (stdout of codingAgentStatusArgs).
 * `since` (ISO time, the engine's assign time) drops older sessions: their
 * assignment, linked PRs and review requests. Only events whose actor is the
 * agent link a PR. Throws when the response has no repository or issue.
 */
export declare function parseCodingAgentStatus(stdout: string, since?: string): CodingAgentStatus;
/** What adopting the agent's PR must match: the run's repository and base branch. */
export interface AdoptExpectation {
    /** `OWNER/NAME` of the run's repository. */
    repo: string;
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
 * `status`: the agent finished; the PR is open, authored by the agent bot,
 * not cross-repository, in the run's repository, on the run's base branch,
 * and its head is a 40-hex sha. The caller fetches exactly that sha (and
 * re-checks it after the fetch) under its tamper snapshot.
 */
export declare function adoptPreconditions(status: CodingAgentStatus, want: AdoptExpectation): AdoptCheck;
//# sourceMappingURL=coding-agent.d.ts.map