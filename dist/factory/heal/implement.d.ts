/**
 * The ci-heal run of one signature (design §5-§6, PR 3): `omg factory heal
 * approve <sig8>` runs the factory engine (run/engine.ts) with kind
 * `ci-heal`, keyed `heal-<sig8>`, from the heal record's valid diagnosis.
 * The engine parks at `awaiting-human: heal-approve` until a human approves
 * (factory.heal.autoImplement aside, never for regression-or-env), and from
 * implement on it is the issue pipeline: review, fix rounds, prepare, gates,
 * and the human merge.
 *
 * Trust: the heal record lives in `.omg/`, which a lane's shell can reach,
 * so a run starts only from a record whose out-of-repo seal matches. The
 * engine then keeps its own sealed copy and never re-reads the record.
 *
 * Caps: every engine lane keeps `factory.run.laneMaxCredits`; the run's
 * credits are bounded by what `factory.heal.maxRunCredits` leaves after the
 * debugger lanes; and before each lane start `factory.heal.dailyCredits` is
 * checked against the larger of the heal counters and the budget ledger's
 * `factory-lane:heal-*` records. An engine lane is reserved in the counters
 * at its full cap, then settled to its measured spend after its confirmed
 * end (released when it never started).
 *
 * Known-flaky entries are never written: a diagnosis of class `flaky` gets a
 * printed proposal only (knownFlakyProposal). Nothing in src/factory writes
 * `.github/known-flaky-tests.json`.
 */
import type { KnownFlakyTest } from '../../ship/config.js';
import type { Exec } from '../../ship/exec.js';
import { type LoadedFactoryRunLimits } from '../run/budget.js';
import { type FactoryEngineOptions, type FactoryForgeInput, type FactoryRunOutcome, type HealLaneCapDecision } from '../run/engine.js';
import type { LaneBackend } from '../run/lane.js';
import type { GateConfigLoader } from '../run/prepare.js';
import { type FactoryHealRecord } from '../run/state.js';
import type { HealConfig } from './config.js';
import { type HealSealSubject } from './run.js';
import { type HealSignatureState } from './state.js';
export declare const KNOWN_FLAKY_FILE = ".github/known-flaky-tests.json";
export interface HealEngineDeps {
    exec: Exec;
    lanes: (root: string) => LaneBackend;
    /** `factory.run` limits (trusted user config; the project config can only tighten). */
    limits: (root: string) => LoadedFactoryRunLimits;
    /** The engine ledger directory, outside the repository (also holds the heal counters mirror and seals). */
    ledgerDir: string;
    now: () => Date;
    gateConfig?: GateConfigLoader;
    warn?: (message: string) => void;
    /** Test seams of the engine. */
    engine?: Partial<Pick<FactoryEngineOptions, 'pollMs' | 'owner' | 'processes' | 'sleep' | 'interrupted' | 'progressFile'>>;
    /** The run's forge on Azure DevOps (the config heal read its CI from); omitted = GitHub through the gh calls. */
    forge?: FactoryForgeInput;
}
export interface HealEngineOptions {
    root: string;
    base: string;
    sig8: string;
    config: HealConfig;
    /** `omg factory heal approve`: a human approved the diagnosis. */
    approved: boolean;
    dryRun?: boolean;
}
/**
 * The validated fields a ci-heal run is created from (the record's diagnosis
 * must be valid). The class and the classifier fields come from the sealed
 * snapshot only, never from the record's unsealed class or classification.
 */
export declare function healRecord(s: HealSignatureState, sealed: HealSealSubject): FactoryHealRecord;
/**
 * The daily heal cap on one engine lane: what `factory.heal.dailyCredits`
 * leaves today, reserved in the heal counters at the lane's cap. The engine
 * settles the reservation once: to the measured spend after the lane's
 * confirmed end, or to 0 when the lane never started. A lost or unconfirmed
 * lane is never settled and keeps its cap.
 */
export declare function healLaneCap(root: string, ledgerDir: string, config: HealConfig, now: () => Date): (cap: number) => HealLaneCapDecision;
/**
 * Start or resume the ci-heal run of `sig8` (`heal approve`, `heal cancel`,
 * and `heal run` under factory.heal.autoImplement). A new run needs an open
 * heal run with a valid diagnosis at heal-approve and a matching seal.
 */
export declare function runHealEngine(o: HealEngineOptions, deps: HealEngineDeps): Promise<FactoryRunOutcome>;
export interface KnownFlakyProposal {
    /** The list a human edits by hand, on a reviewed PR (`omg ship merge` refuses an unattended change to it). */
    file: typeof KNOWN_FLAKY_FILE;
    tests: KnownFlakyTest[];
    runs: string[];
}
/** A diagnosis of class `flaky` becomes a printed proposal, never a write and never a heal PR (design §6). */
export declare function knownFlakyProposal(s: HealSignatureState): KnownFlakyProposal | null;
/** The proposal as printed text (the caller makes it terminal-safe). */
export declare function renderKnownFlakyProposal(p: KnownFlakyProposal): string;
//# sourceMappingURL=implement.d.ts.map