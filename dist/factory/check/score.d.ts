/**
 * `omg factory check` results (factory forges design §5, cut by critic
 * amendments §A.11): every item gets its bucket from the hard rules
 * (rules.ts); there is no 5-factor score, so the order is bucket (runnable,
 * needs-plan, blocked), then priority (ADO Priority 1..4, GitHub
 * `priority:p0..p3` labels as 1..4; none last), then id. Items are read only
 * through `forge.tracker`; the open-PR lookup goes through `forge.reviews`.
 */
import type { Forge, ForgeItem, ResolvedForgeConfig } from '../../forge/types.js';
import type { FactoryPhase } from '../run/state.js';
import { type CheckBucket, type PlanSource } from './rules.js';
export declare const BUCKET_ORDER: readonly CheckBucket[];
/** One row of `omg factory check --json` (CHECK_JSON_SCHEMA_VERSION pins the shape). */
export interface CheckResult {
    id: number;
    /** Untrusted tracker text with ANSI sequences and control characters removed. */
    title: string;
    url: string;
    bucket: CheckBucket;
    /** The exact reason code of the rule that decided the bucket; [] when runnable. */
    reasons: string[];
    detail: string;
    /** 1 (highest) .. 4; null when the item has none. */
    priority: number | null;
    planSource: PlanSource | null;
}
/** What the check reads from the repository (cli.ts builds it from git and the run state). */
export interface CheckEnv {
    config: Pick<ResolvedForgeConfig, 'intake' | 'check'>;
    runState(id: number): {
        phase: FactoryPhase;
        gate?: {
            name: string;
        };
    } | null;
    remoteBranch(branch: string): boolean;
    readPlan(path: string): string | null;
    planBase: string;
}
/** Tracker text for a terminal: ANSI sequences dropped, then every control/format/separator character as a space. */
export declare const plainText: (v: string) => string;
/** ADO Priority, else a GitHub `priority:pN` label (p0 -> 1 ... p3 -> 4). */
export declare function itemPriority(item: ForgeItem): number | null;
export declare function compareResults(a: CheckResult, b: CheckResult): number;
/**
 * The result of one item. A GitHub PR id is `wrong-type`; any other failed
 * read (the item, its run state, PR or branch lookup) is `read-failed`, so one
 * bad item never stops the batch.
 */
export declare function checkItem(forge: Forge, id: number, env: CheckEnv): CheckResult;
/** Every id once, checked and ordered. */
export declare function checkItems(forge: Forge, ids: readonly number[], env: CheckEnv): CheckResult[];
/** The setup wizard's preview row (src/factory/setup/intake-pick.ts PreviewRow). */
export interface CheckPreviewRow {
    id: number;
    title: string;
    url: string;
    readiness: string;
}
/**
 * The scorer for the setup wizard's `PreviewCheck` hook
 * (`(forge, ids) => PreviewRow[]`): `deps.previewCheck = factoryCheckPreview(env)`.
 * Readiness is the bucket and its reason, e.g. `blocked: pr-exists`.
 */
export declare function factoryCheckPreview(env: CheckEnv): (forge: Forge, ids: readonly number[]) => CheckPreviewRow[];
//# sourceMappingURL=score.d.ts.map