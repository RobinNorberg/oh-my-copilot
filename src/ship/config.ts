/**
 * `omg ship` configuration: defaults, the `ship` block of the project
 * config (`.copilot/omg.jsonc`), and the repo's known-flaky test list.
 */

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';

export interface ShipConfig {
  /** Integration branch PRs target and `prepare` merges in. */
  base: string;
  /** Checks that never block a merge (exact names). */
  advisoryChecks: string[];
  /** Repo-relative JSON file listing known-flaky tests. */
  knownFlakyFile: string;
  /** Fix rounds allowed after the first changes-requested verdict before the run blocks. */
  maxFixRounds: number;
  /** When false, `omg ship merge` prints the admin merge command instead of running it. */
  allowAdminMerge: boolean;
  /** `gates --watch` reruns a failed run once when every failing test is known-flaky. */
  autoRerunFlaky: boolean;
  pollIntervalSeconds: number;
  /** One `gates --watch` invocation stops after this long (exit 8); 0 = no limit. */
  watchTimeoutMinutes: number;
}

export type ShipConfigInput = Partial<ShipConfig>;

export const DEFAULT_SHIP_CONFIG: Readonly<ShipConfig> = Object.freeze({
  base: 'dev',
  advisoryChecks: ['No Committed Build Artifacts', 'Authorize generated artifacts from base trust root'],
  knownFlakyFile: '.github/known-flaky-tests.json',
  maxFixRounds: 2,
  allowAdminMerge: false,
  autoRerunFlaky: true,
  pollIntervalSeconds: 30,
  // Below the 10-minute cap of background watchers; the caller loops on exit 8.
  watchTimeoutMinutes: 9,
});

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Merge a config block over the defaults; ill-typed fields are rejected, not ignored. */
export function resolveShipConfig(input: unknown): ShipConfig {
  const config: ShipConfig = { ...DEFAULT_SHIP_CONFIG, advisoryChecks: [...DEFAULT_SHIP_CONFIG.advisoryChecks] };
  if (input === undefined || input === null) return config;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('ship config must be an object');
  const raw = input as Record<string, unknown>;
  const bad = (key: string, want: string): never => {
    throw new Error(`ship.${key} must be ${want}`);
  };
  if (raw.base !== undefined) config.base = typeof raw.base === 'string' && raw.base ? raw.base : bad('base', 'a branch name');
  if (raw.advisoryChecks !== undefined) config.advisoryChecks = isStringArray(raw.advisoryChecks) ? raw.advisoryChecks : bad('advisoryChecks', 'a string array');
  if (raw.knownFlakyFile !== undefined) config.knownFlakyFile = typeof raw.knownFlakyFile === 'string' && raw.knownFlakyFile ? raw.knownFlakyFile : bad('knownFlakyFile', 'a path');
  if (raw.maxFixRounds !== undefined) config.maxFixRounds = Number.isInteger(raw.maxFixRounds) && nonNegative(raw.maxFixRounds) ? raw.maxFixRounds : bad('maxFixRounds', 'a non-negative integer');
  if (raw.allowAdminMerge !== undefined) config.allowAdminMerge = typeof raw.allowAdminMerge === 'boolean' ? raw.allowAdminMerge : bad('allowAdminMerge', 'a boolean');
  if (raw.autoRerunFlaky !== undefined) config.autoRerunFlaky = typeof raw.autoRerunFlaky === 'boolean' ? raw.autoRerunFlaky : bad('autoRerunFlaky', 'a boolean');
  if (raw.pollIntervalSeconds !== undefined) config.pollIntervalSeconds = nonNegative(raw.pollIntervalSeconds) && raw.pollIntervalSeconds > 0 ? raw.pollIntervalSeconds : bad('pollIntervalSeconds', 'a positive number');
  if (raw.watchTimeoutMinutes !== undefined) config.watchTimeoutMinutes = nonNegative(raw.watchTimeoutMinutes) ? raw.watchTimeoutMinutes : bad('watchTimeoutMinutes', 'a non-negative number');
  return config;
}

export interface KnownFlakyTest {
  /** Repo-relative test file, forward slashes. */
  file: string;
  /** Optional substring of the full test title; absent = any test in the file. */
  title?: string;
  note?: string;
}

/** Read the known-flaky list; a missing file is an empty list, a malformed one throws. */
export function loadKnownFlaky(repoRoot: string, file: string): KnownFlakyTest[] {
  const path = isAbsolute(file) ? file : join(repoRoot, file);
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const tests = (parsed as { tests?: unknown })?.tests;
  if (!Array.isArray(tests)) throw new Error(`${file}: expected { "tests": [...] }`);
  return tests.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (typeof e?.file !== 'string' || !e.file) throw new Error(`${file}: tests[${i}].file must be a string`);
    if (e.title !== undefined && typeof e.title !== 'string') throw new Error(`${file}: tests[${i}].title must be a string`);
    return { file: e.file.replace(/\\/g, '/'), title: e.title as string | undefined, note: typeof e.note === 'string' ? e.note : undefined };
  });
}
