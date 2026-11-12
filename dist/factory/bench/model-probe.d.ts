/**
 * `omg factory bench run --live`: which Copilot model the lanes will use and
 * its premium multiplier, read before any child starts. Lanes pass no model
 * (engine.ts), so they get the runtime's default for a fresh job home with
 * only the login identity. The probe starts the runtime the same way (no
 * user profile, the session env allowlist), reads `listModels()` and the
 * current model of a new session, and ends: no prompt is ever sent, so no
 * model turn runs. Never throws: what it could not read is `null` with why.
 */
import { type CopilotRunDeps } from '../../copilot-run/job.js';
export interface BenchModelInfo {
    /** The model a lane gets (the new session's current model), or null when the runtime names none. */
    model: string | null;
    /** That model's premium multiplier from listModels() `billing.multiplier`, or null when not exposed. */
    multiplier: number | null;
    /** What was read, or why not. */
    detail: string;
}
export type BenchModelProbe = () => Promise<BenchModelInfo>;
type ModelEntry = {
    id?: unknown;
    billing?: {
        multiplier?: unknown;
    };
};
/** The multiplier of `model` in a listModels() answer; null when absent or not a finite number >= 0. */
export declare function modelMultiplier(models: readonly ModelEntry[], model: string): number | null;
/**
 * Null when the run may start, else why not. A known multiplier above 1
 * needs `--allow-multiplier` at or above it (one lane then costs that many
 * premium requests). An unknown model or multiplier fails closed: it needs
 * `--allow-multiplier`, given after checking the default model by hand.
 */
export declare function multiplierRefusal(info: BenchModelInfo, allow: number | undefined): string | null;
export declare function probeLaneModel(jobRoot: string, deps?: Pick<CopilotRunDeps, 'env' | 'platform' | 'loadSdk' | 'resolveBin' | 'userConfigDir' | 'killTree'>): Promise<BenchModelInfo>;
export {};
//# sourceMappingURL=model-probe.d.ts.map