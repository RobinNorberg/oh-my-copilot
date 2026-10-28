import type { CopilotRunSandboxState } from '../../../copilot-run/sandbox.js';
import { gitIn } from '../../../copilot-run/__tests__/fake-sdk.js';
import { type Exec, type ExecResult } from '../../../ship/exec.js';
import type { LaneProcessOps } from '../engine.js';
import type { GateConfigLoader } from '../prepare.js';
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
    sandbox?: CopilotRunSandboxState;
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
/** Lane scripts. A write lane leaves its change uncommitted: the engine commits it (lane-commit.ts). */
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
        /** The run's branch on the bare remote that `gh pr view` reports (default `factory/issue-<ISSUE>`). */
        branch: string;
        /** Override what `gh pr view` reports as the head (default: the bare remote's factory branch). */
        headOverride?: string;
        /** Heads `gh pr view` reports first, one per call (GitHub still showing an older push). */
        headSequence: string[];
        openPrs: number[];
        /** `gh pr ready` ran (the PR is no longer a draft). */
        ready: boolean;
        /** The human merged the PR on GitHub. */
        merged: boolean;
        /** One entry per `gh pr checks` call (the last one repeats); `gh run list` returns the runs of the last entry read. */
        gates: GatesRead[];
        /** `gh run view --job <id> --log` output by job id. */
        logs: Record<string, string>;
    };
    /** `node <script> ...` (prepare's tsc / eslint / vitest / inventory): exit 0 unless scripted. */
    node: (args: string[]) => ExecResult;
}
export interface GatesRead {
    checks: Array<{
        name: string;
        state: string;
        link?: string;
    }>;
    runs: Array<{
        databaseId: number;
        status: string;
        conclusion?: string;
        workflowName?: string;
    }>;
}
/** One required check `Test` from Actions run 100 (job 200), and that run. */
export declare const greenGates: (runId?: number) => GatesRead;
export declare const pendingGates: (runId?: number) => GatesRead;
export declare const failedGates: (runId?: number) => GatesRead;
/** Ship's gate config without a fetch: the one required check `Test`, no advisory checks, no known-flaky tests. */
export declare const testGateConfig: GateConfigLoader;
/** `<dir>/remote.git` (bare) and `<dir>/repo` on `dev` tracking it; `.omg/` ignored. */
export declare function harness(prefix?: string): Harness;
export declare function remoteHead(h: Harness): string | null;
//# sourceMappingURL=fake-lanes.d.ts.map