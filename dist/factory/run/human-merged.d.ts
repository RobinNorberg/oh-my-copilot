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
 * The PR state comes from the forge's own read (GitHub, Azure DevOps). On the
 * local forge the PR store is a file the PR's code could write, so only your
 * base branch counts: the run is merged when refs/heads/<base> contains the
 * head the engine pushed. A failed read changes nothing. A closed, unmerged
 * PR changes nothing either; the caller says so.
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
/** The state before the merge, for the history note: `cancelled`, or `awaiting-human: fix-failed`. */
export declare function previousStateText(s: Pick<FactoryRunState, 'phase' | 'gate'>): string;
/** Move a candidate run to merged (also from cancelled or failed), clearing its gate, with the history note. */
export declare function markMergedByHuman(s: FactoryRunState, now: string): FactoryRunState;
/** What the forge says about the run's PR: OPEN, MERGED or CLOSED. Throws when it cannot tell. */
export type PrStateRead = (s: FactoryRunState) => 'OPEN' | 'MERGED' | 'CLOSED';
/**
 * The PR state through the forge adapter. The local forge: MERGED only when
 * your base branch contains the head the engine pushed (the store's MERGED
 * alone is not trusted; a merge on your base not yet synced to the mirror is
 * merged too).
 */
export declare function forgePrStateReader(forge: Forge, exec: Exec, root: string): PrStateRead;
export type HumanMergeResult = {
    kind: 'merged';
    key: FactoryRunKey;
    pr: number;
    previous: string;
    state: FactoryRunState;
} | {
    kind: 'closed';
    key: FactoryRunKey;
    pr: number;
}
/** `readFailed`: the PR read failed (worth a warning); every other reason is quiet. */
 | {
    kind: 'unchanged';
    key: FactoryRunKey;
    reason: string;
    readFailed?: true;
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