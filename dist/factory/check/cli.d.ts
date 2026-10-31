/**
 * `omg factory check [<id>... | --parent <spec> | --source <spec>] [--limit n] [--json] [--mark [--yes]]`
 * (factory forges design §5): bucket intake items as runnable, needs-plan
 * or blocked; `--parent` checks a spec's children (shipyard ↔ factory
 * design §3.1). Read-only unless `--mark`, which adds `factory.intake.marker`
 * (a GitHub label or an ADO tag) to the runnable items only, after a TTY
 * confirmation or `--yes`, through `forge.tracker.addMarker`.
 *
 * Every command passes checkGuardExec: the gh reads the tracker builds, the
 * open-PR lookup on `factory/issue-<n>`, a dependency's merged factory PR
 * into the base, a dependency PR's state, the marker
 * label lookup, the label write only while marking, the git reads of the base
 * and `git ls-remote origin refs/heads/factory/<name>`. az runs through the factory guard's
 * runGuardedAdo (fail closed without an ADO guard context), and while not
 * marking only as a GET or the wit.wiql.POST query.
 *
 * Exit codes: 0 checked (whatever the buckets; a declined `--mark` writes
 * nothing), 1 a tracker read or a marker write failed, 2 usage (bad id,
 * source or limit, no intake source, `--mark` without `--yes` and no TTY),
 * 5 incompatible (forge mismatch, unsupported remote, no adapter for the forge).
 */
import type { ForgeFactory, ResolvedForgeConfig } from '../../forge/types.js';
import { type AzEntry } from '../../forge/ado/az-binary.js';
import { type AzureDevOpsForgeOptions } from '../../forge/ado/index.js';
import { type Exec } from '../../ship/exec.js';
import { type AdoGuardContext } from '../../forge/ado/guard.js';
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
 * and az writes pass (the wit.wiql.POST query is a read and passes without it).
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
    /** The az entry on Azure DevOps (default defaultResolveAz; tests inject one). */
    resolveAz?: (root: string) => AzEntry;
    isTTY: () => boolean;
    confirm: (question: string) => Promise<boolean>;
    out: (line: string) => void;
    err: (line: string) => void;
}
export interface FactoryCheckOptions {
    ids: string[];
    /** A spec item: check its children (ForgeItem.children) instead of ids or the intake source. */
    parent?: string;
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
/** Fetch `origin/<base>` (read-only) and resolve it; null with a warning when it cannot be read. */
export declare function fetchBase(exec: Exec, root: string, base: string, warnings: string[]): string | null;
export declare function renderCheckTable(items: readonly CheckResult[]): string;
/** Production az entry: resolved outside every root a lane writes (factoryForgeOptions). */
export declare const defaultResolveAz: (root: string) => AzEntry;
/**
 * The read-only check guard for a resolved forge, and the options to build
 * the forge on it. On Azure DevOps the az entry is resolved once: the guard
 * gets the forge repo and that entry (adoGuardContext), and the adapter
 * spawns the same entry. GitHub needs neither. Exported for the board (B1) to reuse.
 */
export declare function forgeReadExec(exec: Exec, config: ResolvedForgeConfig, root: string, resolveAz?: (root: string) => AzEntry, marker?: () => string | undefined): {
    exec: Exec;
    options: AzureDevOpsForgeOptions;
};
/** Run one check; returns the exit code. Errors other than usage / incompatible propagate (exit 1 at the CLI). */
export declare function runFactoryCheck(o: FactoryCheckOptions, deps: FactoryCheckDeps): Promise<number>;
//# sourceMappingURL=cli.d.ts.map