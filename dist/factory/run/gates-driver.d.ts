/**
 * Gates driver for `omg factory run` (design §6): loops ship's `watchGates`
 * in-process, one ship window per call. A window that times out (the old
 * `omg ship gates --watch` exit 8) is a heartbeat, not a stop; the overall
 * bound is factory.run.gatesTimeoutMinutes.
 *
 * Head discipline: every read is for the head the engine pushed, and only
 * after GitHub reports that head. The PR's headRefOid must equal it before a
 * window starts (an ancestor of it is GitHub catching up, so the driver
 * waits; anything else moved the head externally). A green or failed read
 * is accepted only when the head is still the pushed one and every check
 * that names an Actions run belongs to a workflow run for that head
 * (`gh run list --commit <head>`); otherwise it is a stale read and the
 * driver polls again. Ship's gate API is used as is: watchGates with
 * `headSha` and fetchHeadSha / fetchWorkflowRuns. On Azure DevOps the same
 * reads go through the forge (`forge`): its PR head is
 * lastMergeSourceCommit, which lags a push the same way (design §8.3).
 */
import type { KnownFlakyTest, ShipConfig } from '../../ship/config.js';
import { type Exec } from '../../ship/exec.js';
import { type GateForge, type GateReport } from '../../ship/gates.js';
/** `pending: no-workflows-triggered` for this long goes to awaiting-human: no-workflows. */
export declare const NO_WORKFLOWS_GRACE_MS: number;
/** Test titles kept from those logs (a log is untrusted, PR-controlled output). */
export declare const MAX_FAILING_TITLES = 50;
export interface GatesDriverInput {
    exec: Exec;
    cwd: string;
    pr: number;
    /** The head the engine pushed (state.head). */
    head: string;
    config: ShipConfig;
    known: readonly KnownFlakyTest[];
    /** Absolute end of the gates phase (ms, `now()` clock). */
    deadline: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    /** The ship state's rerun budget. */
    reruns: {
        count(runId: string): number;
        record(runId: string): void;
    };
    /** Every accepted read (persist lastGates, heartbeat). */
    onReport: (report: GateReport, note: string) => void;
    /** A poll without an accepted read (waiting for GitHub, a stale read). */
    onWait: (note: string) => void;
    cancelled: () => boolean;
    /** The forge reads (ship's GateForge); omitted = GitHub, the gh calls below. */
    forge?: GateForge;
}
export type GatesOutcome = {
    kind: 'green';
    report: GateReport;
} | {
    kind: 'failed';
    report: GateReport;
    tests: string[];
} | {
    kind: 'flaky';
    report: GateReport;
} | {
    kind: 'no-workflows';
    report: GateReport;
} | {
    kind: 'timeout';
    report?: GateReport;
} | {
    kind: 'head-moved';
    headRefOid: string;
} | {
    kind: 'not-open';
    state: string;
} | {
    kind: 'cancelled';
};
/** `gh pr view <pr> --json headRefOid,state`; throws on anything but a full sha and a state (the GitHub forge's prHead). */
export declare function readPrHead(exec: Exec, pr: number, cwd: string): {
    headRefOid: string;
    state: string;
};
/**
 * Why an accepted-looking read is stale (null: it is for `head`): the PR
 * head moved, or a reported check names an Actions run that is not one of
 * the head's workflow runs.
 */
export declare function staleRead(exec: Exec, pr: number, head: string, report: GateReport, cwd: string, forge?: GateForge): string | null;
/** `file > title` of the failing tests in the failed checks' job logs (at most MAX_FAILED_LOGS jobs, MAX_FAILING_TITLES titles). */
export declare function failingTestTitles(exec: Exec, report: GateReport, cwd: string, forge?: GateForge): string[];
export declare function driveGates(o: GatesDriverInput): Promise<GatesOutcome>;
//# sourceMappingURL=gates-driver.d.ts.map