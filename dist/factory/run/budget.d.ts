/**
 * Per-run limits for `omg factory run` (owner override of design §7: the
 * plugin budget governor is not consulted). AI Credits is the unit; premium
 * requests are legacy and never limit anything here.
 *
 * - Every lane starts with an AI-credit cap (copilot_run maxCredits, the SDK's
 *   maxAiCredits). The cap is mandatory: a run without a resolved cap of at
 *   least RUNTIME_MIN_MAX_CREDITS (the CLI's floor since 1.0.67) is refused.
 * - `maxRunCredits` (optional) bounds the run's measured credits. It is checked
 *   at step boundaries; a lane's cap is lowered to what is left, and when less
 *   than the runtime floor is left the run parks at `awaiting-human: budget`.
 * - Wall time per lane and per run, retries per phase, one lost-lane respawn,
 *   ship's fix rounds, and a CI-fix cap of 1.
 *
 * Trust: the limits come from `factory.run` in the user config at its default
 * location (trustedUserConfigPath). The working-tree project config can only
 * tighten them (a lane can drop a file into the checkout).
 */
import { RUNTIME_MIN_MAX_CREDITS } from '../../smoke/copilot-sdk-scenarios.js';
import type { FactoryRunState } from './state.js';
export { RUNTIME_MIN_MAX_CREDITS };
export interface FactoryRunLimits {
    /** AI-credit cap passed to every lane start (mandatory, >= RUNTIME_MIN_MAX_CREDITS). */
    laneMaxCredits: number;
    /** Optional cap on the run's measured AI credits. */
    maxRunCredits?: number;
    /** Wall time of one lane (copilot_run timeoutMs; at most MAX_TIMEOUT_MS). */
    laneTimeoutMs: number;
    /** Engine wall time across all invocations of one run. */
    maxRunWallTimeMs: number;
    /** Fresh retries of a failed lane per phase. */
    maxRetries: number;
    /** Fresh respawns after a lane was lost (engine restart). */
    maxLostRespawns: number;
    /** Changes-requested rounds before the run blocks (ship's maxFixRounds). */
    maxFixRounds: number;
    /** CI-fix rounds (PR 3); capped at 1. */
    maxCiFixRounds: number;
}
export declare const DEFAULT_FACTORY_RUN_LIMITS: Readonly<FactoryRunLimits>;
export interface LoadedFactoryRunLimits {
    limits: FactoryRunLimits;
    warnings: string[];
}
/**
 * Resolve the limits: defaults < trusted user config (`factory.run`, and
 * `ship.maxFixRounds`), then the working-tree project config, which may only
 * lower a value (a higher one is ignored with a warning). Throws on an
 * ill-typed value or a lane cap below the runtime floor.
 */
export declare function resolveFactoryRunLimits(trustedUser: unknown, project: unknown): LoadedFactoryRunLimits;
/** The mandatory per-lane cap: refuse a run without a resolved cap at or above the runtime floor. */
export declare function assertLaneCreditCap(limits: Partial<FactoryRunLimits> | undefined): asserts limits is FactoryRunLimits;
/** Measured AI credits of every lane in the run. */
export declare function runCredits(state: Pick<FactoryRunState, 'lanes'>): number;
export type LaneCapDecision = {
    ok: true;
    cap: number;
} | {
    ok: false;
    reason: string;
};
/**
 * The cap for the next lane: laneMaxCredits, lowered to what maxRunCredits
 * leaves. Refused when less than the runtime floor is left (a lane cannot be
 * capped lower), so the run stops before it can overrun.
 */
export declare function nextLaneCap(state: Pick<FactoryRunState, 'lanes'>, limits: FactoryRunLimits): LaneCapDecision;
/** Null while the run is within its credit limit; otherwise why it stops. */
export declare function runCreditsExceeded(state: Pick<FactoryRunState, 'lanes'>, limits: FactoryRunLimits): string | null;
//# sourceMappingURL=budget.d.ts.map