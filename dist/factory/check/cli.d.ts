/**
 * `omg factory check [<id>...] [--source <spec>] [--limit n] [--json] [--mark [--yes]]`
 * (factory forges design §5): bucket intake items as runnable, needs-plan
 * or blocked. Read-only unless `--mark`, which adds `factory.intake.marker`
 * (a GitHub label or an ADO tag) to the runnable items only, after a TTY
 * confirmation or `--yes`, through `forge.tracker.addMarker`.
 *
 * Every command passes checkGuardExec: the gh reads the tracker builds, the
 * open-PR lookup on `factory/issue-<n>`, a dependency PR's state, the marker
 * label lookup, the label write only while marking, the git reads of the base
 * and `git ls-remote origin refs/heads/factory/<name>`. az goes through the factory guard (fail
 * closed until the ADO guard context lands) and only as GET while not marking.
 *
 * Exit codes: 0 checked (whatever the buckets; a declined `--mark` writes
 * nothing), 1 a tracker read or a marker write failed, 2 usage (bad id,
 * source or limit, no intake source, `--mark` without `--yes` and no TTY),
 * 5 incompatible (forge mismatch, unsupported remote, no adapter for the forge).
 */
import type { ForgeFactory } from '../../forge/types.js';
import { type Exec } from '../../ship/exec.js';
import type { AdoGuardContext } from '../../forge/ado/guard.js';
import { type CheckEnv, type CheckResult } from './score.js';
export declare const EXIT_CHECK_FAILED = 1;
export declare const EXIT_CHECK_USAGE = 2;
export declare const EXIT_CHECK_INCOMPATIBLE = 5;
/** Bumped on any change to the `--json` shape (src/factory/check/__tests__/cli.test.ts pins it). */
export declare const CHECK_JSON_SCHEMA_VERSION = 1;
export declare class CheckUsageError extends Error {
}
export declare class CheckIncompatibleError extends Error {
}
/**
 * The `omg factory check` guard. `marker` is set only after `--mark` was
 * confirmed: then, and only then, `gh issue edit <n> --add-label <marker>`
 * and non-GET az calls pass.
 */
export declare function checkGuardExec(exec: Exec, marker?: () => string | undefined, ado?: () => AdoGuardContext | undefined): Exec;
/** `--source` as a config value (resolveForgeConfig validates it): label:x, milestone:x, wiql-query:<guid>, board-column:team/board/column, area-tag:<area path>#<tag>. */
export declare function parseSourceSpec(spec: string): Record<string, string>;
export declare function parseItemId(raw: string): number;
export interface FactoryCheckDeps {
    /** The raw Exec; runFactoryCheck wraps it in checkGuardExec. */
    exec: Exec;
    /** The integration branch (ship.base). */
    base: (root: string) => string;
    /** The user config at its default location (userConfigLayers().trustedUser). */
    trustedUser: () => unknown;
    /** The parsed working-tree project config. */
    projectConfig: (root: string) => unknown;
    /** The forge adapter (src/forge/index.ts createForge; tests inject a fake). */
    createForge: ForgeFactory;
    isTTY: () => boolean;
    confirm: (question: string) => Promise<boolean>;
    out: (line: string) => void;
    err: (line: string) => void;
}
export interface FactoryCheckOptions {
    ids: string[];
    source?: string;
    limit?: number;
    json?: boolean;
    mark?: boolean;
    yes?: boolean;
}
export interface CheckJson {
    schemaVersion: number;
    ok: boolean;
    forge: string;
    repo: string;
    source: Record<string, unknown> | null;
    counts: Record<string, number>;
    items: CheckResult[];
    mark: {
        marker: string;
        requested: boolean;
        confirmed: boolean;
        marked: number[];
        alreadyMarked: number[];
        failed: Array<{
            id: number;
            error: string;
        }>;
    };
    warnings: string[];
}
/**
 * The repository side of a check: the run state under `root` and the plan
 * files at `origin/<base>` (null = no base: every omg-plan is plan-missing).
 * The setup wizard builds its preview env with this too.
 */
export declare function checkEnvFor(exec: Exec, root: string, config: CheckEnv['config'], base: string, baseSha: string | null): CheckEnv;
export declare function renderCheckTable(items: readonly CheckResult[]): string;
/** Run one check; returns the exit code. Errors other than usage / incompatible propagate (exit 1 at the CLI). */
export declare function runFactoryCheck(o: FactoryCheckOptions, deps: FactoryCheckDeps): Promise<number>;
//# sourceMappingURL=cli.d.ts.map