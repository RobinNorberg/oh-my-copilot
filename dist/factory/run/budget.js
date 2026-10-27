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
import { MAX_TIMEOUT_MS } from '../../copilot-run/job.js';
import { DEFAULT_SHIP_CONFIG } from '../../ship/config.js';
export { RUNTIME_MIN_MAX_CREDITS };
export const DEFAULT_FACTORY_RUN_LIMITS = Object.freeze({
    laneMaxCredits: RUNTIME_MIN_MAX_CREDITS,
    laneTimeoutMs: 30 * 60_000,
    maxRunWallTimeMs: 4 * 60 * 60_000,
    maxRetries: 1,
    maxLostRespawns: 1,
    maxFixRounds: DEFAULT_SHIP_CONFIG.maxFixRounds,
    maxCiFixRounds: 1,
});
/** Keys under `factory.run` and their limit fields; minutes convert to ms. */
const KEYS = {
    laneMaxCredits: { field: 'laneMaxCredits', scale: 1, integer: false },
    maxRunCredits: { field: 'maxRunCredits', scale: 1, integer: false },
    laneTimeoutMinutes: { field: 'laneTimeoutMs', scale: 60_000, integer: false },
    maxRunWallTimeMinutes: { field: 'maxRunWallTimeMs', scale: 60_000, integer: false },
    maxRetries: { field: 'maxRetries', scale: 1, integer: true },
    maxFixRounds: { field: 'maxFixRounds', scale: 1, integer: true },
    maxCiFixRounds: { field: 'maxCiFixRounds', scale: 1, integer: true },
};
function runBlock(config, source) {
    const factory = config?.factory;
    if (factory === undefined || factory === null)
        return {};
    if (typeof factory !== 'object' || Array.isArray(factory))
        throw new Error(`${source}: factory config must be an object`);
    const run = factory.run;
    if (run === undefined || run === null)
        return {};
    if (typeof run !== 'object' || Array.isArray(run))
        throw new Error(`${source}: factory.run must be an object`);
    return run;
}
function shipMaxFixRounds(config) {
    return config?.ship?.maxFixRounds;
}
function checked(key, value, source) {
    const spec = KEYS[key];
    const ok = typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!spec.integer || Number.isInteger(value));
    if (!ok)
        throw new Error(`${source}: factory.run.${key} must be a non-negative ${spec.integer ? 'integer' : 'number'}`);
    return value * spec.scale;
}
/**
 * Resolve the limits: defaults < trusted user config (`factory.run`, and
 * `ship.maxFixRounds`), then the working-tree project config, which may only
 * lower a value (a higher one is ignored with a warning). Throws on an
 * ill-typed value or a lane cap below the runtime floor.
 */
export function resolveFactoryRunLimits(trustedUser, project) {
    const warnings = [];
    const limits = { ...DEFAULT_FACTORY_RUN_LIMITS };
    const set = (field, value) => { limits[field] = value; };
    const user = runBlock(trustedUser, 'user config');
    const userFix = shipMaxFixRounds(trustedUser);
    if (userFix !== undefined)
        set('maxFixRounds', checked('maxFixRounds', userFix, 'user config ship'));
    for (const key of Object.keys(KEYS)) {
        if (user[key] !== undefined)
            set(KEYS[key].field, checked(key, user[key], 'user config'));
    }
    const proj = runBlock(project, 'project config');
    const projFix = shipMaxFixRounds(project);
    const tighten = (key, raw, label = `factory.run.${key}`) => {
        const value = checked(key, raw, 'project config');
        const field = KEYS[key].field;
        const current = limits[field];
        if (current === undefined || value <= current)
            set(field, value);
        else
            warnings.push(`omg factory run: ignoring ${label} ${String(raw)} from the working-tree project config; it can only lower a limit`);
    };
    if (projFix !== undefined)
        tighten('maxFixRounds', projFix, 'ship.maxFixRounds');
    for (const key of Object.keys(KEYS)) {
        if (proj[key] !== undefined)
            tighten(key, proj[key]);
    }
    if (limits.maxCiFixRounds > 1) {
        warnings.push(`omg factory run: factory.run.maxCiFixRounds ${limits.maxCiFixRounds} is above the cap of 1; using 1`);
        limits.maxCiFixRounds = 1;
    }
    if (limits.laneTimeoutMs <= 0 || limits.laneTimeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`factory.run.laneTimeoutMinutes must be above 0 and at most ${MAX_TIMEOUT_MS / 60_000}`);
    }
    assertLaneCreditCap(limits);
    return { limits, warnings };
}
/** The mandatory per-lane cap: refuse a run without a resolved cap at or above the runtime floor. */
export function assertLaneCreditCap(limits) {
    const cap = limits?.laneMaxCredits;
    if (typeof cap !== 'number' || !Number.isFinite(cap)) {
        throw new Error('omg factory run refuses to start: no per-lane AI-credit cap is resolved (factory.run.laneMaxCredits)');
    }
    if (cap < RUNTIME_MIN_MAX_CREDITS) {
        throw new Error(`omg factory run refuses to start: factory.run.laneMaxCredits ${cap} is below the Copilot CLI minimum of ${RUNTIME_MIN_MAX_CREDITS} AI credits`);
    }
    if (limits.maxRunCredits !== undefined && limits.maxRunCredits < cap) {
        throw new Error(`omg factory run refuses to start: factory.run.maxRunCredits ${limits.maxRunCredits} is below one lane's cap (${cap})`);
    }
}
/** Measured AI credits of every lane in the run. */
export function runCredits(state) {
    return state.lanes.reduce((sum, lane) => sum + (lane.usage?.credits ?? 0), 0);
}
/**
 * The cap for the next lane: laneMaxCredits, lowered to what maxRunCredits
 * leaves. Refused when less than the runtime floor is left (a lane cannot be
 * capped lower), so the run stops before it can overrun.
 */
export function nextLaneCap(state, limits) {
    assertLaneCreditCap(limits);
    if (limits.maxRunCredits === undefined)
        return { ok: true, cap: limits.laneMaxCredits };
    const spent = runCredits(state);
    const left = limits.maxRunCredits - spent;
    if (left < RUNTIME_MIN_MAX_CREDITS) {
        return { ok: false, reason: `run spent ${spent.toFixed(2)} of factory.run.maxRunCredits ${limits.maxRunCredits} AI credits; a lane needs at least ${RUNTIME_MIN_MAX_CREDITS} (raise the limit and rerun)` };
    }
    return { ok: true, cap: Math.min(limits.laneMaxCredits, Math.floor(left)) };
}
/** Null while the run is within its credit limit; otherwise why it stops. */
export function runCreditsExceeded(state, limits) {
    if (limits.maxRunCredits === undefined)
        return null;
    const spent = runCredits(state);
    return spent >= limits.maxRunCredits ? `run spent ${spent.toFixed(2)} AI credits, at or above factory.run.maxRunCredits ${limits.maxRunCredits}` : null;
}
//# sourceMappingURL=budget.js.map