/**
 * `omg factory heal scan|status|run|approve|cancel|close` (experimental,
 * design §10 PR 1-3). The scan polls CI runs on the integration branch,
 * computes failure signatures, classifies new red runs deterministically and
 * records them in heal state. It makes no LLM call and no GitHub write: every
 * command goes through healGuardExec, and a rerun probe is recorded as an
 * intent only. `run` starts the read-only debugger lane for one signature
 * (run.ts); `approve` runs the ci-heal run of a valid diagnosis in the
 * factory engine (implement.ts), which parks at the human merge; `cancel`
 * stops it; `close` lets a human close a parked heal run. A `flaky`
 * diagnosis only prints a known-flaky proposal.
 */
import { Command } from 'commander';
import type { Exec } from '../../ship/exec.js';
import type { AzEntry } from '../../forge/ado/az-binary.js';
import type { AdoGuardContext } from '../../forge/ado/guard.js';
import type { LoadedForgeConfig } from '../../forge/config.js';
import type { ForgeCi, ForgeKind, ResolvedForgeConfig } from '../../forge/types.js';
import { type HealConfig } from './config.js';
import { type HealSignatureState } from './state.js';
import type { LaneBackend } from '../run/lane.js';
import type { LoadedFactoryRunLimits } from '../run/budget.js';
import type { FactoryForgeInput } from '../run/engine.js';
import type { GateConfigLoader } from '../run/prepare.js';
import { type HealEngineDeps } from './implement.js';
import { type HealRunDeps } from './run.js';
/** Bounds on one scan's GitHub reads (CI logs run to megabytes each). */
export declare const SCAN_LIMITS: Readonly<{
    runList: 30;
    pushCandidates: 3;
    prRuns: 6;
    historyRuns: 20;
    historyLogs: 5;
    greenLookups: 3;
    prWindowMs: number;
}>;
export interface HealDeps {
    exec: Exec;
    base: (root: string) => string;
    config: (root: string) => {
        config: HealConfig;
        warnings: string[];
    };
    now: () => Date;
    /** The debugger lane backend (`omg factory heal run` without --dry-run is the opt-in to a billed lane). */
    lanes: (root: string) => LaneBackend;
    /** Out-of-repository heal ledger directory (counters mirror, seals). */
    ledgerDir: string;
    /** Test seams for `heal run`. */
    run?: Pick<HealRunDeps, 'clock' | 'pollMs' | 'confinement' | 'delimiter' | 'env' | 'warn'>;
    /** `factory.run` limits of the ci-heal run (`heal approve`, `heal cancel`). */
    runLimits: (root: string) => LoadedFactoryRunLimits;
    gateConfig?: GateConfigLoader;
    /** Test seams of the factory engine. */
    engine?: HealEngineDeps['engine'];
    /** The origin's forge kind (originForgeKind); Azure DevOps heals only with factory.heal.pipeline (capabilities.heal). Omitted = GitHub. */
    forgeKind?: (root: string) => ForgeKind;
    /** Builds the forge's CI reads over the heal-guarded exec (heal scan, heal run evidence). Omitted = GitHub Actions. */
    ci?: (exec: Exec, root: string) => ForgeCi;
    /** The forge config on Azure DevOps (loadFactoryForgeConfig: user, base-branch and project layers); GitHub never reads it. */
    forge?: (root: string, base: string) => LoadedForgeConfig;
    /** The az entry on Azure DevOps (default: resolved outside every root a lane writes). */
    resolveAz?: (root: string) => AzEntry;
}
/** Heal on Azure DevOps: the CI reads, their `read` guard context and the ci-heal run's forge, all from one resolved config. */
export interface AdoHeal {
    ci: (exec: Exec, root: string) => ForgeCi;
    guard: () => AdoGuardContext;
    forge: () => FactoryForgeInput;
}
/**
 * The Azure DevOps heal wiring (ADO parity design §3.5-§3.6). The guard
 * context and the ForgeCi are built from the same trusted `config` and az
 * entry, so the guard lets through only the reads of the repository and
 * pipeline the CI history comes from. The entry is resolved on first use
 * (`heal status`, `close` and `cancel` need no az).
 */
export declare function adoHeal(config: ResolvedForgeConfig, resolveAz: () => AzEntry, root: string): AdoHeal;
export interface ScanEntry {
    runId: string;
    event: string;
    headBranch: string;
    sig8?: string;
    class?: string;
    reason: string;
    next?: string;
    blocked?: boolean;
    rerunIntent?: string;
    recorded?: boolean;
}
export interface ScanResult {
    base: string;
    dryRun: boolean;
    entries: ScanEntry[];
    /** Webhook-queued runs still waiting (not in the listed window yet). */
    queued: number;
}
/**
 * `ledgerDir`: the out-of-repository heal ledger directory, where the scan-time class and classification are kept.
 * `ci`: builds the forge's CI reads over the heal-guarded exec (default GitHub Actions).
 * `ado`: that forge's Azure DevOps guard context (adoHeal); without it every az call is refused.
 */
type ScanOpts = {
    exec: Exec;
    root: string;
    base: string;
    config: HealConfig;
    now: Date;
    dryRun: boolean;
    warn: (m: string) => void;
    ledgerDir: string;
    lockTimeoutMs?: number;
    ci?: (exec: Exec, root: string) => ForgeCi;
    ado?: () => AdoGuardContext;
};
/** One writing scan at a time: the read-fold-write of heal state is held under a lock file. */
export declare function runHealScan(opts: ScanOpts): ScanResult;
/** Text from CI logs, lane output or a state file, safe for the terminal: control and format characters become spaces. */
export declare const termSafe: (v: unknown) => string;
export declare function renderHealState(s: HealSignatureState): string;
/** `omg factory heal scan|status|run` (experimental; no GitHub writes). */
export declare function healCommand(deps: HealDeps): Command;
export {};
//# sourceMappingURL=cli.d.ts.map