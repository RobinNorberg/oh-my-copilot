import { gitIn } from '../../../copilot-run/__tests__/fake-sdk.js';
import { type Exec } from '../../../ship/exec.js';
import type { LaneProcessOps } from '../engine.js';
import { type LaneBackend, type LaneProcess, type LaneResult, type LaneStartInput, type LaneState } from '../lane.js';
export { gitIn };
export interface LaneCtx {
    input: LaneStartInput;
    worktree: string;
    branch: string;
    baseSha: string;
    /** Main checkout. */
    root: string;
}
export interface LaneOutcome {
    state?: LaneState;
    finalText?: string;
    credits?: number;
    error?: string;
    /** wait() throws LaneLostError (the job vanished with its process). */
    lost?: boolean;
}
export type LaneScript = (ctx: LaneCtx) => LaneOutcome | void;
export declare class FakeLanes implements LaneBackend {
    private readonly root;
    private readonly scripts;
    private readonly runningPolls;
    readonly kind: "local-sdk";
    readonly started: LaneStartInput[];
    readonly cancelled: string[];
    /** Called on every wait() that still reports `running`. */
    onRunningPoll: (remoteId: string) => void;
    private readonly jobs;
    /** `scripts` is consumed in start order; `runningPolls[i]` makes lane i report `running` that many times first. */
    /** '' for the first backend on a repository, then `-g2`, `-g3`, ... */
    private readonly suffix;
    constructor(root: string, scripts: LaneScript[], runningPolls?: number[]);
    start(input: LaneStartInput): Promise<{
        remoteId: string;
    }>;
    private result;
    poll(remoteId: string): Promise<LaneResult>;
    wait(remoteId: string, _timeoutMs: number): Promise<LaneResult>;
    /** cancel() throws a plain error (the backend cannot tell whether the job stopped). */
    cancelFails: boolean;
    cancel(remoteId: string): Promise<{
        supported: boolean;
        result: LaneResult;
    }>;
}
/** The fake Copilot child of a job: a pid no real process has, with a fake start identity. */
export declare const fakeProcess: (remoteId: string) => LaneProcess;
/**
 * A scripted process seam (FactoryEngineOptions.processes): every child is
 * dead unless listed in `live` (killed by terminate only when `killable`) or
 * `unknown`. Records the pids it checked and killed.
 */
export declare class FakeProcesses implements LaneProcessOps {
    readonly live: Set<number>;
    readonly unknown: Set<number>;
    killable: boolean;
    readonly checked: number[];
    readonly killed: number[];
    state(p: LaneProcess): Promise<'live' | 'dead' | 'mismatch' | 'unknown'>;
    terminate(p: LaneProcess): Promise<void>;
}
/** Lane scripts. */
export declare const commitFile: (path: string, content?: string, credits?: number) => LaneScript;
export declare const noCommit: LaneScript;
export declare function verdictBlock(verdict: 'approve' | 'request-changes', sha: string, findings?: unknown[], notes?: string): string;
/** A review lane answering for the sha it was started at; `tamper` runs in the lane first. */
export declare const review: (verdict: "approve" | "request-changes", findings?: unknown[], tamper?: (ctx: LaneCtx) => void) => LaneScript;
export declare const ISSUE = 7;
export declare const REPO_URL = "https://github.com/o/r";
export declare const PR = 42;
export interface Harness {
    dir: string;
    root: string;
    bare: string;
    /** Engine ledger directory, outside the repo (FactoryEngineOptions.ledgerDir). */
    ledgerDir: string;
    exec: Exec;
    /** Commands as the engine built them, with the git hardening prefix (`-c k=v` pairs) left out. */
    calls: string[];
    /** Every command as it reached the exec seam, with its env. */
    raw: Array<{
        cmd: string;
        args: string[];
        env?: Readonly<Record<string, string>>;
    }>;
    /** Called with each recorded call before it runs (tests plant late changes here). */
    onCall?: (call: string) => void;
    gh: {
        /** `author` defaults to the repository owner (`o`, a trusted body author). */
        issue: {
            title: string;
            body: string;
            state: string;
            author?: {
                login: string;
            };
            comments: Array<{
                body: string;
                authorAssociation?: string;
                author?: {
                    login: string;
                };
            }>;
        };
        prCreated: boolean;
        /** Override what `gh pr view` reports as the head (default: the bare remote's factory branch). */
        headOverride?: string;
        openPrs: number[];
    };
}
/** `<dir>/remote.git` (bare) and `<dir>/repo` on `dev` tracking it; `.omg/` ignored. */
export declare function harness(prefix?: string): Harness;
export declare function remoteHead(h: Harness): string | null;
//# sourceMappingURL=fake-lanes.d.ts.map