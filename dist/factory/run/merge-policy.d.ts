/**
 * Merge policy for `omg factory run` (owner override of design §8): merge is
 * ALWAYS human. There is no `factory.merge` key and no auto mode, and nothing
 * here runs a merge (the factory guard refuses `gh pr merge` outright). After
 * green gates the engine asks ship's decideMerge for the verdict on the
 * current head, prints the exact admin merge command, comments it on the PR
 * and parks at `awaiting-human: merge`. A later run reads `gh pr view` and
 * finishes as `merged` once the human merged.
 */
import { type KnownFlakyTest, type ShipConfig } from '../../ship/config.js';
import type { Exec } from '../../ship/exec.js';
import { type MergeDecision } from '../../ship/merge.js';
import { type ShipState } from '../../ship/state.js';
import type { MergeView } from '../../forge/github/reviews.js';
import { type FactoryRunKey } from './state.js';
export { MERGE_VIEW_FIELDS, parseMergeView, type MergeView } from '../../forge/github/reviews.js';
/**
 * ship's decideMerge on a fresh one-shot gate read for the head (no watch,
 * no rerun) and the commits since the reviewed sha. `view.baseRefOid` must be
 * in the local object store (the trusted config load fetched and checked it).
 */
export declare function mergeDecision(exec: Exec, root: string, ship: ShipState, view: MergeView, config: ShipConfig, known: readonly KnownFlakyTest[]): MergeDecision;
/** The PR comment of the merge gate: the decision and the exact command a human runs. */
export declare function mergeComment(issue: FactoryRunKey, decision: MergeDecision, resume?: string): string;
//# sourceMappingURL=merge-policy.d.ts.map