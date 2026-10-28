/**
 * `factory.heal` config (design §2, §7). Trust follows factory.run: the user
 * config at its default location sets values; the working-tree project config
 * may only lower a numeric limit, and cannot add ignored jobs (that would let
 * a checkout hide a red job).
 */
export interface HealConfig {
    /** PR-policy jobs that never start a heal (matched by exact job name). */
    ignoreJobs: string[];
    /** Heal runs started per UTC day. */
    dailyRuns: number;
    /** Debugger lanes per UTC day. */
    dailyDebugLanes: number;
    /** AI-credit cap of one debugger lane (mandatory; at least the Copilot CLI floor). */
    debugLaneMaxCredits: number;
    /** AI credits one heal run may spend across all its lanes. */
    maxRunCredits: number;
    /** AI credits all heal lanes may spend per UTC day. */
    dailyCredits: number;
    /**
     * Implement a valid diagnosis without `omg factory heal approve` (default
     * false; user config only; never for regression-or-env). The diagnosis is
     * derived from untrusted CI logs, so the default keeps a human between a
     * log and a write lane.
     */
    autoImplement: boolean;
}
export type HealConfigInput = Partial<HealConfig>;
export declare const DEFAULT_HEAL_CONFIG: Readonly<HealConfig>;
/** The workflow the poller reads (fixed: the heal triggers only on CI). */
export declare const HEAL_WORKFLOW = "ci.yml";
export declare function resolveHealConfig(trustedUser: unknown, project: unknown): {
    config: HealConfig;
    warnings: string[];
};
//# sourceMappingURL=config.d.ts.map