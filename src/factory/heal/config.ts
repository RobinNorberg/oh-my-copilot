/**
 * `factory.heal` config (design §2). Trust follows factory.run: the user
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
}

export type HealConfigInput = Partial<HealConfig>;

export const DEFAULT_HEAL_CONFIG: Readonly<HealConfig> = Object.freeze({
  ignoreJobs: ['No Committed Build Artifacts', 'Version Consistency Check'],
  dailyRuns: 3,
  dailyDebugLanes: 4,
});

/** The workflow the poller reads (fixed: the heal triggers only on CI). */
export const HEAL_WORKFLOW = 'ci.yml';

function healBlock(config: unknown, source: string): Record<string, unknown> {
  const factory = (config as { factory?: unknown } | null | undefined)?.factory;
  if (factory === undefined || factory === null) return {};
  if (typeof factory !== 'object' || Array.isArray(factory)) throw new Error(`${source}: factory config must be an object`);
  const heal = (factory as { heal?: unknown }).heal;
  if (heal === undefined || heal === null) return {};
  if (typeof heal !== 'object' || Array.isArray(heal)) throw new Error(`${source}: factory.heal must be an object`);
  return heal as Record<string, unknown>;
}

function count(key: string, value: unknown, source: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${source}: factory.heal.${key} must be a non-negative integer`);
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
  for (const key of ['dailyRuns', 'dailyDebugLanes'] as const) {
    if (user[key] !== undefined) config[key] = count(key, user[key], 'user config');
  }
  const proj = healBlock(project, 'project config');
  if (proj.ignoreJobs !== undefined) warnings.push('omg factory heal: ignoring factory.heal.ignoreJobs from the working-tree project config; only the user config sets it');
  for (const key of ['dailyRuns', 'dailyDebugLanes'] as const) {
    if (proj[key] === undefined) continue;
    const value = count(key, proj[key], 'project config');
    if (value <= config[key]) config[key] = value;
    else warnings.push(`omg factory heal: ignoring factory.heal.${key} ${value} from the working-tree project config; it can only lower a limit`);
  }
  return { config, warnings };
}
