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
import type { ForgeKind } from '../../forge/types.js';
import { type HealConfig } from './config.js';
import { type HealSignatureState } from './state.js';
import type { LaneBackend } from '../run/lane.js';
import type { LoadedFactoryRunLimits } from '../run/budget.js';
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
    /** The origin's forge kind (originForgeKind); heal reads GitHub Actions only, so Azure DevOps is refused. Omitted = GitHub. */
    forgeKind?: (root: string) => ForgeKind;
}
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
/** `ledgerDir`: the out-of-repository heal ledger directory, where the scan-time class and classification are kept. */
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