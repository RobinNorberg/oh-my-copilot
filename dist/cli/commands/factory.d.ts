/**
 * Factory command (spec: OMC 软件工厂闭环, tracker issue #9).
 *
 * `omg factorylisten` — the resident intake daemon. Transport adapters
 * (smee.io / cloudflared / direct) live outside the OMC boundary: the daemon
 * only receives already-unpacked webhook events as POSTs and does the OMC-side
 * work itself (HMAC verification, repo whitelist, intake label gate, routing
 * through the shared pure function, headless harbor session spawn).
 *
 * `omg factoryinit` — seeds the project route table (`.omg/factory-routes.json`,
 * the single source of truth the SessionEnd chain enqueuer reads) and validates
 * the factory prerequisites. It seeds the narrow starter loop; --no-narrow is
 * retired and refuses. Never overwrites without --force.
 *
 * Liveness: pid file at <omc root>/state/factory-listener.json (SessionStart
 * supervision reads it) plus a GET /status endpoint on the listening port.
 */
import { Command } from 'commander';
import { type ChainStatus } from '../../factory/status.js';
import { type RouteTable } from '../../hooks/session-end/routing.js';
import { type LoadedFactoryRunLimits } from '../../factory/run/budget.js';
import type { LoadedForgeConfig } from '../../forge/config.js';
import { type LaneBackend } from '../../factory/run/lane.js';
import type { GateConfigLoader } from '../../factory/run/prepare.js';
import { type FactoryRunState } from '../../factory/run/state.js';
import { type Exec } from '../../ship/exec.js';
export declare function renderChainStatus(status: ChainStatus): string;
/** Seams for `omg factory run` (tests script gh/git and the lanes; nothing live). */
export interface FactoryRunDeps {
    exec: Exec;
    lanes: (root: string) => LaneBackend;
    /** Limits from `factory.run` (trusted user config; the project config can only tighten). */
    limits: (root: string) => LoadedFactoryRunLimits;
    /** The integration branch: ship.base from the project config, else the user config, else dev. */
    base: (root: string) => string;
    /** Engine ledger directory outside the repo (default: `$OMC_STATE_DIR` or `~/.omg`, then `factory-ledger`). */
    ledgerDir?: string;
    /** Ship's gate config at GitHub's base sha (default: ship's strict safety-key loader). */
    gateConfig?: GateConfigLoader;
    /**
     * The run's forge config (loadFactoryForgeConfig: user, base-branch and
     * project layers plus the origin remote). Omitted = GitHub through the gh
     * calls with no forge config, as before forges (the default deps set it).
     */
    forge?: (root: string, base: string) => LoadedForgeConfig;
}
export declare const defaultFactoryRunDeps: FactoryRunDeps;
export declare function renderFactoryRunState(state: FactoryRunState): string;
/** `omg factory run <issue>`, `run cancel|clean|status <issue>` (experimental; manual trigger only; merge is always human). */
export declare function factoryRunCommand(deps?: FactoryRunDeps): Command;
export declare function factoryCommand(): Command;
/**
 * Narrow starter route table: exactly the listener's INTAKE_ROUTE_TABLE — the
 * single intake -> harbor hop. Everything after a completed harbor session
 * halts (`no-route`) until the project deliberately widens the table.
 */
export declare function buildRouteTableNarrow(): RouteTable;
/**
 * Factory prerequisites, checked loudly before anything is written:
 * harbor needs the OMC state root (`.omg/state/`) and the yard's two day-one
 * faces drydock seeds (`CLAUDE.md` + `GLOSSARY.md`).
 */
export declare function validateFactoryPrerequisites(cwd: string): {
    ok: boolean;
    missing: string[];
};
export interface FactoryInitResult {
    exitCode: number;
    message: string;
}
/**
 * `omg factoryinit`: seed `.omg/factory-routes.json` with the narrow starter
 * table. narrow:false (the retired full template) refuses. Refuses loudly when
 * prerequisites are missing and never overwrites an existing table without
 * force (the SessionEnd chain enqueuer reads that file as the single source
 * of truth).
 */
export declare function runFactoryInit(options?: {
    narrow?: boolean;
    cwd?: string;
    force?: boolean;
}): FactoryInitResult;
//# sourceMappingURL=factory.d.ts.map