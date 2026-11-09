import type { ExecResult } from '../../../ship/exec.js';
import { type Harness } from './fake-lanes.js';
export declare const AGENT: Readonly<{
    __typename: "Bot";
    login: "copilot-swe-agent";
}>;
export declare const HUMAN: Readonly<{
    __typename: "User";
    login: "robin";
}>;
/** GitHub times are whole seconds. */
export declare const ghTime: (ms: number) => string;
export interface FakeAgentCommit {
    oid: string;
    at: string;
    /** Mapped to the agent's account (default true). */
    byAgent?: boolean;
    /** Signed by GitHub (web-flow; default true). */
    signed?: boolean;
}
export interface FakeAgentPr {
    number: number;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    head: string;
    base?: string;
    /** When the agent linked it to the issue (a ConnectedEvent by the agent). */
    linkedAt: string;
    commits: FakeAgentCommit[];
    /** The agent's review requests (its finish signal). */
    reviewRequests: string[];
    author?: {
        __typename: string;
        login: string;
    };
}
export declare class FakeAgentGithub {
    private readonly now;
    readonly repo: string;
    available: boolean;
    /** The issue timeline's agent assign events. */
    events: Array<{
        type: 'assigned' | 'unassigned';
        at: string;
    }>;
    prs: FakeAgentPr[];
    /** GitHub cuts the issue timeline. */
    truncate: boolean;
    /** The assign POST: adds an Assigned event at `now()` (`assign`), returns 2xx without one (`silent`), or fails (`fail`). */
    onAssign: 'assign' | 'silent' | 'fail';
    /** What a failing assign POST answers (default: gh's HTTP 422). */
    assignFailure: ExecResult;
    /** The next `gh pr close` calls that fail (a network error), before closes succeed. */
    closeFailures: number;
    readonly assigns: string[][];
    readonly closes: string[][];
    readonly comments: Array<{
        args: string[];
        body: string;
    }>;
    reads: number;
    constructor(now: () => string, repo?: string);
    /** The answer to a coding agent gh call, or undefined for any other call. */
    handle(args: readonly string[]): ExecResult | undefined;
    private prNode;
    /** The status read's JSON (CODING_AGENT_STATUS_QUERY's shape). */
    status(): string;
}
/** Route the coding agent's gh calls of the harness to `fake`; everything else keeps the harness's scripted gh and real git. */
export declare function installFakeAgent(h: Harness, fake: FakeAgentGithub): void;
/**
 * A commit by "the agent" on top of the remote's dev (or `parent`), pushed to
 * the bare remote as refs/pull/<pr>/head; the main checkout does not have it
 * until the engine fetches. Returns its sha.
 */
export declare function agentCommit(h: Harness, pr: number, files: Record<string, string>, parent?: string): string;
/** A human commit on the remote's dev (the configured base moves); returns its sha. */
export declare function humanBaseCommit(h: Harness, files: Record<string, string>): string;
//# sourceMappingURL=fake-coding-agent.d.ts.map