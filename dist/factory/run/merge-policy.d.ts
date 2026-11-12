/**
 * Merge policy for `omg factory run` (owner override of design §8): merge is
 * a human step by DEFAULT. After green gates the engine asks ship's
 * decideMerge for the verdict on the current head, prints the exact admin
 * merge command, comments it on the PR and parks at `awaiting-human: merge`.
 * A later run reads `gh pr view` and finishes as `merged` once the human merged.
 *
 * Opt-in (auto-merge.ts): `factory.merge.auto` in the USER config, per
 * repository, lets the engine itself merge a low-risk PR (tiers docs, tests,
 * small) when every condition holds on the exact head; a committed value is
 * ignored with a notice. Nothing in this file runs a merge. Only the engine
 * merges: the factory guard still refuses `gh pr merge`, and admits the
 * head-pinned GitHub REST merge only inside the engine's auto-merge step.
 * Azure DevOps always stays human.
 */
import { type KnownFlakyTest, type ShipConfig } from '../../ship/config.js';
import type { Exec } from '../../ship/exec.js';
import { type GateHeadReads } from '../../ship/gates.js';
import { type MergeDecision } from '../../ship/merge.js';
import { type ShipState } from '../../ship/state.js';
import type { MergeView } from '../../forge/github/reviews.js';
import type { Forge } from '../../forge/types.js';
import { type FactoryRunKey } from './state.js';
export { MERGE_VIEW_FIELDS, parseMergeView, type MergeView } from '../../forge/github/reviews.js';
/** A merge decision; on Azure DevOps also the body file the human command reads and its SHA-256. */
export interface FactoryMergeDecision extends MergeDecision {
    body?: {
        file: string;
        sha256: string;
    };
    /** The gate read was green with no check at all (NO_CI_CHECKS_NOTE): said in the park and the PR comment. */
    noChecks?: true;
    /** The checks the gate read counted as passed on this head (auto-merge needs at least one). */
    checks?: string[];
}
/**
 * ship's decideMerge on a fresh one-shot gate read for the head (no watch,
 * no rerun) and the commits since the reviewed sha. `view.baseRefOid` must be
 * in the local object store (the trusted config load fetched and checked it).
 * With an Azure DevOps `forge` the gate read goes through it, its blocking
 * branch policies are reasons too, a PR touching the Azure Pipelines
 * definitions (ADO_PIPELINE_PATHS) needs the owner as PROTECTED_PATHS do, and
 * the command is its head-pinned PATCH. `reads` are the gates loop's GitHub
 * reads (GateHeadReads), so this read applies the same no-CI, suite and app rules.
 */
export declare function mergeDecision(exec: Exec, root: string, ship: ShipState, view: MergeView, config: ShipConfig, known: readonly KnownFlakyTest[], forge?: Pick<Forge, 'checks' | 'reviews' | 'merge'>, reads?: GateHeadReads): FactoryMergeDecision;
/** The PR comment of the merge gate: the decision and the exact command a human runs. */
export declare function mergeComment(issue: FactoryRunKey, decision: FactoryMergeDecision, resume?: string): string;
//# sourceMappingURL=merge-policy.d.ts.map