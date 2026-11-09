/**
 * `omg factory triage [ids... | --parent <spec> | --source <spec>] [--limit n] [--apply] [--json]`:
 * propose the priority and needs-split / needs-plan labels each intake item
 * should carry (rules.ts), from the same reads `omg factory check` makes.
 *
 * Without `--apply` nothing is written: every call goes through check's
 * read-only guard, so a write shape is refused before it reaches gh or az.
 * `--apply` executes exactly the plan that was printed (the rows are computed
 * once and never re-derived). Its writes pass the factory guard with a
 * TrackerWriteContext whose label allowlist is the plan's own label names
 * (GitHub: src/factory/triage/guard.ts; Azure DevOps: the tracker tag and
 * priority PATCH; the local forge edits backlog files in the working tree,
 * which the human then commits on the base). A label the GitHub repository
 * lacks is never created: its rows are skipped in the plan, in both modes.
 *
 * Exit codes: 0 done (whatever the plan), 1 a read failed or a write failed,
 * 2 usage, 5 incompatible (as check).
 */
import { type AdoGuardContext } from '../../forge/ado/guard.js';
import type { Exec } from '../../ship/exec.js';
import { type FactoryCheckDeps, type FactoryCheckOptions } from '../check/cli.js';
import { type TrackerWriteContext } from '../run/exec.js';
import { type TriageConfig, type TriagePlanRow } from './rules.js';
/** Bumped on any change to the `--json` shape (src/factory/triage/__tests__/cli.test.ts pins it). */
export declare const TRIAGE_JSON_SCHEMA_VERSION = 1;
export interface FactoryTriageOptions extends Pick<FactoryCheckOptions, 'ids' | 'parent' | 'source' | 'limit' | 'json'> {
    apply?: boolean;
}
export interface TriageItemJson extends TriagePlanRow {
    /** `--apply` only: what the tracker answered for a `change` row. */
    result?: {
        ok: boolean;
        detail: string;
    };
}
export interface TriageJson {
    schemaVersion: number;
    ok: boolean;
    mode: 'dry-run' | 'apply';
    forge: string;
    repo: string;
    source: Record<string, unknown> | null;
    config: TriageConfig;
    counts: {
        change: number;
        unchanged: number;
        skip: number;
        applied: number;
        failed: number;
    };
    items: TriageItemJson[];
    /** Labels GitHub's repository lacks (rows needing them are skipped as `label-missing:<name>`). */
    missingLabels: string[];
    notes: string[];
    warnings: string[];
}
/**
 * triage's Exec: every call is check's read guard; while `writing()` the
 * label-only `gh issue edit` (src/factory/triage/guard.ts) and, on Azure
 * DevOps, the work item PATCH go through the factory guard with the plan's
 * TrackerWriteContext. Nothing else writes.
 */
export declare function triageGuardExec(exec: Exec, writes: () => TrackerWriteContext | undefined, writing: () => boolean, ado?: () => AdoGuardContext | undefined): Exec;
export declare function renderTriageTable(items: readonly TriageItemJson[]): string;
/** Run one triage; returns the exit code. Usage and incompatible errors propagate (exit 2 / 5 at the CLI). */
export declare function runFactoryTriage(o: FactoryTriageOptions, deps: FactoryCheckDeps): Promise<number>;
//# sourceMappingURL=cli.d.ts.map