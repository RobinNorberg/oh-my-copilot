/**
 * `omg factory dashboard`: one static HTML page (or --json) of what needs
 * you, the engines running, every factory run of this repository with its
 * timeline, tasks, cost, throughput and bench results. Logic in
 * src/factory/dashboard/ (collect-v2.ts: collect -> JSON; render.ts:
 * JSON -> HTML).
 *
 * LOCAL and READ-ONLY by default: no forge or network read and no write
 * except the --out file. `--forge` opts in to what the dashboard did before:
 * it reads the tracker (the board's read, for the tracker columns) and
 * records the stopped runs whose PR a human merged (human-merged.ts), which
 * writes those runs' states.
 *
 * `--watch [seconds]` (with --out) rewrites the file on an interval, only
 * when the page changed and atomically (temp file + rename), until Ctrl-C;
 * the page then reloads itself (meta refresh). With --forge the forge is
 * read on a slow timer (FORGE_REFRESH_MS), never per tick.
 */
import { Command } from 'commander';
import type { BoardJson } from '../../factory/board/collect.js';
import type { LoadedFactoryRunLimits } from '../../factory/run/budget.js';
import type { OwnerDeps } from '../../factory/run/state.js';
export declare const WATCH_DEFAULT_SECONDS = 10;
export declare const WATCH_MIN_SECONDS = 2;
/** --watch --forge: the forge is read at most this often. */
export declare const FORGE_REFRESH_MS: number;
export interface ForgeRead {
    /** Lines for stderr (human merges recorded, PRs not checked). */
    lines: string[];
    /** The board's JSON (tracker columns); null when the tracker could not be read. */
    board: BoardJson | null;
}
export interface FactoryDashboardDeps {
    root: () => string;
    out: (line: string) => void;
    err: (line: string) => void;
    now?: () => Date;
    ledgerDir?: string;
    /** The run limits as the engine resolves them (cost caps); a throw is a warning and no cap. */
    limits?: (root: string) => LoadedFactoryRunLimits;
    owner?: OwnerDeps;
    /** `--forge` only: read the tracker and record human merges. Never called without --forge. */
    forgeRead?: (root: string) => Promise<ForgeRead>;
    /** --watch: wait `ms`; resolves false when interrupted (Ctrl-C). */
    sleep?: (ms: number) => Promise<boolean>;
    /** Write `content` to `file` so a reader never sees a half-written file. */
    writeFile?: (file: string, content: string) => void;
}
/** Temp file next to the target, then one rename over it. */
export declare function writeFileAtomic(file: string, content: string): void;
/** Resolves true after `ms`, false at the first Ctrl-C (SIGINT) before that. */
export declare function sleepUntilInterrupt(ms: number): Promise<boolean>;
export declare const defaultDashboardDeps: FactoryDashboardDeps;
export declare function factoryDashboardCommand(deps?: FactoryDashboardDeps): Command;
//# sourceMappingURL=factory-dashboard.d.ts.map