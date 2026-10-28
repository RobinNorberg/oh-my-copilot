/**
 * `factory.heal` config (design §2, §7). Trust follows factory.run: the user
 * config at its default location sets values; the working-tree project config
 * may only lower a numeric limit, and cannot add ignored jobs (that would let
 * a checkout hide a red job).
 */

import { RUNTIME_MIN_MAX_CREDITS } from '../run/budget.js';

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

export const DEFAULT_HEAL_CONFIG: Readonly<HealConfig> = Object.freeze({
  ignoreJobs: ['No Committed Build Artifacts', 'Version Consistency Check'],
  dailyRuns: 3,
  dailyDebugLanes: 4,
  debugLaneMaxCredits: RUNTIME_MIN_MAX_CREDITS,
  maxRunCredits: 120,
  dailyCredits: 150,
  autoImplement: false,
});

/** The workflow the poller reads (fixed: the heal triggers only on CI). */
export const HEAL_WORKFLOW = 'ci.yml';

const LIMIT_KEYS = ['dailyRuns', 'dailyDebugLanes', 'debugLaneMaxCredits', 'maxRunCredits', 'dailyCredits'] as const;
/** A lane cannot be capped below the CLI floor, so these limits never go under it. */
const MINIMUM: Partial<Record<(typeof LIMIT_KEYS)[number], number>> = {
  debugLaneMaxCredits: RUNTIME_MIN_MAX_CREDITS,
  maxRunCredits: RUNTIME_MIN_MAX_CREDITS,
};

function healBlock(config: unknown, source: string): Record<string, unknown> {
  const factory = (config as { factory?: unknown } | null | undefined)?.factory;
  if (factory === undefined || factory === null) return {};
  if (typeof factory !== 'object' || Array.isArray(factory)) throw new Error(`${source}: factory config must be an object`);
  const heal = (factory as { heal?: unknown }).heal;
  if (heal === undefined || heal === null) return {};
  if (typeof heal !== 'object' || Array.isArray(heal)) throw new Error(`${source}: factory.heal must be an object`);
  return heal as Record<string, unknown>;
}

function count(key: (typeof LIMIT_KEYS)[number], value: unknown, source: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${source}: factory.heal.${key} must be a non-negative integer`);
  const min = MINIMUM[key];
  if (min !== undefined && value < min) throw new Error(`${source}: factory.heal.${key} ${value} is below the Copilot CLI minimum of ${min} AI credits per lane`);
  return value;
}

export function resolveHealConfig(trustedUser: unknown, project: unknown): { config: HealConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config: HealConfig = { ...DEFAULT_HEAL_CONFIG, ignoreJobs: [...DEFAULT_HEAL_CONFIG.ignoreJobs] };
  const user = healBlock(trustedUser, 'user config');
  if (user.ignoreJobs !== undefined) {
    if (!Array.isArray(user.ignoreJobs) || !user.ignoreJobs.every((j) => typeof j === 'string' && j.length > 0 && j.length <= 200)) {
      throw new Error('user config: factory.heal.ignoreJobs must be an array of job names');
    }
    config.ignoreJobs = [...new Set(user.ignoreJobs as string[])];
  }
  for (const key of LIMIT_KEYS) {
    if (user[key] !== undefined) config[key] = count(key, user[key], 'user config');
  }
  if (user.autoImplement !== undefined) {
    if (typeof user.autoImplement !== 'boolean') throw new Error('user config: factory.heal.autoImplement must be true or false');
    config.autoImplement = user.autoImplement;
  }
  const proj = healBlock(project, 'project config');
  if (proj.ignoreJobs !== undefined) warnings.push('omg factory heal: ignoring factory.heal.ignoreJobs from the working-tree project config; only the user config sets it');
  // The project config may only turn it off (a lane can drop a file into the checkout).
  if (proj.autoImplement === false) config.autoImplement = false;
  else if (proj.autoImplement !== undefined) warnings.push('omg factory heal: ignoring factory.heal.autoImplement from the working-tree project config; only the user config turns it on');
  for (const key of LIMIT_KEYS) {
    if (proj[key] === undefined) continue;
    const value = count(key, proj[key], 'project config');
    if (value <= config[key]) config[key] = value;
    else warnings.push(`omg factory heal: ignoring factory.heal.${key} ${value} from the working-tree project config; it can only lower a limit`);
  }
  if (config.maxRunCredits < config.debugLaneMaxCredits) {
    throw new Error(`factory.heal.maxRunCredits ${config.maxRunCredits} is below one debugger lane's cap (factory.heal.debugLaneMaxCredits ${config.debugLaneMaxCredits})`);
  }
  return { config, warnings };
}
