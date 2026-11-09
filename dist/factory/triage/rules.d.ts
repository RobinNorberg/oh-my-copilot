/**
 * `omg factory triage` rules (pure): the labels and priority each item should
 * carry, from the item and its `omg factory check` result (read-only import
 * of the check rules). Taxonomy: priority:p0..p3 (mutually exclusive),
 * needs-split, needs-plan. owner:<x> comes with routing and is not proposed yet.
 */
import type { CheckResult } from '../check/score.js';
import type { ForgeItem, ForgeKind } from '../../forge/types.js';
export declare const PRIORITY_LABELS: readonly ["priority:p0", "priority:p1", "priority:p2", "priority:p3"];
export interface TriageConfig {
    needsSplit: string;
    needsPlan: string;
    /** An item with a size above this and no children gets needs-split. */
    sizeSplitAt: number;
    /** p0..p3 for an item with no priority at all; null = leave it unprioritised. */
    defaultPriority: number | null;
}
export declare const DEFAULT_TRIAGE_CONFIG: TriageConfig;
export declare class TriageConfigError extends Error {
}
/**
 * `factory.triage` from the trusted layers only (user config, then the base
 * branch's committed config; the working-tree project config never names a
 * label the write guard will allow). Later layers override earlier ones.
 */
export declare function resolveTriageConfig(layers: readonly unknown[]): TriageConfig;
export type TriageAction = 'change' | 'unchanged' | 'skip';
export interface TriagePlanRow {
    id: number;
    title: string;
    url: string;
    action: TriageAction;
    skipReason: string | null;
    bucket: CheckResult['bucket'] | null;
    /** The check rule reason codes the bucket came from. */
    reasons: string[];
    current: {
        labels: string[];
        priority: number | null;
    };
    /** Exact names to add (canonical spelling). */
    add: string[];
    /** Exact names to remove (the item's own spelling). */
    remove: string[];
    /** New numeric priority 1..4 (Azure DevOps and the local forge only); null = none. */
    priority: number | null;
    why: string[];
}
/** The proposal for one item. Pure: the printed plan and `--apply` both execute exactly this row. */
export declare function planItem(item: ForgeItem, result: CheckResult, kind: ForgeKind, cfg: TriageConfig): TriagePlanRow;
//# sourceMappingURL=rules.d.ts.map