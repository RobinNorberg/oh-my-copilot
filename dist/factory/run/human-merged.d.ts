/**
 * A run the factory stopped (cancelled, failed, or parked at a human gate)
 * whose PR a human merged later: it is recorded as `merged`, so a rerun does
 * not resume lanes (and spend requests) on finished work.
 *
 * Who records it:
 * - `omg factory run <n>` before it resumes anything (the engine: start());
 * - `omg factory run status [<n>]`, `omg factory board` and
 *   `omg factory dashboard` through recordHumanMerge below.
 *
 * The PR state comes from the forge's own read (GitHub, Azure DevOps), for the
 * run's own forge, repository and base. On the local forge the PR store is a
 * file the PR's code could write, so your base branch counts: the run is
 * merged when refs/heads/<base> contains the head the engine pushed and the
 * store still names that head (forgePrStateReader, which also names the risk
 * left). A failed read changes nothing. A closed, unmerged PR changes nothing
 * either; the caller says so. A run with a lane the engine could not check
 * (laneTrustProblem) is never read: the caller prints why.
 *
 * recordHumanMerge writes like the engine: under the run's owner file (a live
 * engine on the run: nothing is written), only when the state bytes are the
 * engine's last write (its ledger), and it records the new bytes there.
 */
import { type Exec } from '../../ship/exec.js';
import type { Forge } from '../../forge/types.js';
import { type FactoryRunKey, type FactoryRunState, type OwnerDeps } from './state.js';
/** A run a human may have merged after the factory stopped: it has a PR, is not merged, and is cancelled, failed or parked (not at a tamper park). */
export declare function humanMergeCandidate(s: Pick<FactoryRunState, 'phase' | 'pr' | 'gate'>): boolean;
/**
 * Why a candidate's lanes keep it from a human-merge check, or null. A lane
 * the engine cancelled without a clean tamper check (`problems`, `skipped`,
 * or no record in an older state), a lane whose stop is unconfirmed, a lane
 * still `running` or a lane-unconfirmed park: such a lane may have moved your
 * base branch, so the run is not recorded as merged on any forge. The Copilot
 * coding agent runs on GitHub, not in your checkout, and is not counted.
 */
export declare function laneTrustProblem(s: Pick<FactoryRunState, 'lanes' | 'gate' | 'base'>): string | null;
/** The state before the merge, for the history note: `cancelled`, or `awaiting-human: fix-failed`. */
export declare function previousStateText(s: Pick<FactoryRunState, 'phase' | 'gate'>): string;
/** Move a candidate run to merged (also from cancelled or failed), clearing its gate, with the history note. */
export declare function markMergedByHuman(s: FactoryRunState, now: string): FactoryRunState;
/**
 * What the forge says about the run's PR: OPEN, MERGED or CLOSED. Throws when
 * it cannot tell. `baseTip` (the local forge): the commit of your base branch
 * the check read, without replace objects.
 */
export interface PrStateResult {
    state: 'OPEN' | 'MERGED' | 'CLOSED';
    baseTip?: string;
}
export type PrStateRead = (s: FactoryRunState) => PrStateResult;
/**
 * The PR state through the forge adapter, for the run's own forge and
 * repository only (`repoUrl`: the forge config's repository; another one is a
 * read error, like the engine's resume check).
 *
 * GitHub and Azure DevOps: the adapter's state; a merged PR whose base is not
 * the run's base is a read error.
 *
 * The local forge: MERGED only when your base branch contains the head the
 * engine pushed AND the PR store still names that head for the PR (state not
 * CLOSED). The store's MERGED is not required: it turns MERGED only after the
 * next run or poll syncs your base into the mirror, so it adds nothing to the
 * base check. Replace refs or grafts make every git read a lie: a read error.
 * What remains: a lane that moved your base branch in a run cancelled without
 * a clean tamper check; laneTrustProblem refuses such a run before this read.
 */
export declare function forgePrStateReader(forge: Forge, exec: Exec, root: string, repoUrl: string | undefined): PrStateRead;
export type HumanMergeResult = {
    kind: 'merged';
    key: FactoryRunKey;
    pr: number;
    previous: string;
    state: FactoryRunState;
    baseTip?: string;
} | {
    kind: 'closed';
    key: FactoryRunKey;
    pr: number;
}
/** `readFailed`: the PR read failed; `untrusted`: a lane keeps the run from the check (both worth a line); every other reason is quiet. */
 | {
    kind: 'unchanged';
    key: FactoryRunKey;
    reason: string;
    readFailed?: true;
    untrusted?: true;
};
export interface HumanMergeOptions {
    readPrState: PrStateRead;
    ledgerDir: string;
    now: () => string;
    owner?: OwnerDeps;
}
/**
 * Record one run as merged when its PR is merged on the forge; see the file
 * comment. The local checks come first, so a run that is not the engine's own
 * costs no forge read. Never throws.
 */
export declare function recordHumanMerge(root: string, key: FactoryRunKey, o: HumanMergeOptions): HumanMergeResult;
/** Every candidate in `runs`, recorded when merged; `runs` as readRuns returns them. */
export declare function recordHumanMerges(root: string, runs: Iterable<[FactoryRunKey, FactoryRunState]>, o: HumanMergeOptions): HumanMergeResult[];
/** One line per result worth printing: merged, closed, a failed PR read. */
export declare function humanMergeLines(results: readonly HumanMergeResult[]): string[];
//# sourceMappingURL=human-merged.d.ts.map