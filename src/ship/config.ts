/**
 * `omg ship` configuration: defaults, the `ship` config block, and the
 * repo's known-flaky test list.
 *
 * Trust model (see loadTrustedShipConfig): the safety keys
 * (SHIP_SAFETY_KEYS) come only from the user-level config, then the
 * `.copilot/omg.jsonc` committed on the base branch
 * (`git show <remote>/<base>:.copilot/omg.jsonc`), then the defaults. The
 * working-tree project file and the PR head never set them: a lane can drop
 * an untracked file into the checkout, and a PR can commit one.
 */

import { existsSync, readFileSync } from 'fs';
import { parseJsonc } from '../utils/jsonc.js';
import { resolveProjectConfigPath } from '../config/project-config-path.js';
import type { Exec } from './exec.js';

export interface ShipConfig {
  /** Integration branch PRs target and `prepare` merges in. */
  base: string;
  /** Checks that never block a merge (exact names). */
  advisoryChecks: string[];
  /**
   * Checks CI always reports for a PR (exact names). A missing one counts as
   * pending, so a gate read before `needs:`-dependent jobs exist is never green.
   */
  requiredChecks: string[];
  /** Repo-relative JSON file listing known-flaky tests. */
  knownFlakyFile: string;
  /** Fix rounds allowed after the first changes-requested verdict before the run blocks. */
  maxFixRounds: number;
  /**
   * When false, `omg ship merge` prints the admin merge command instead of
   * running it. Owner-only: there is no CLI override, and lanes never edit it.
   */
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
  // No Committed Build Artifacts (ci.yml) and the pull_request_target
  // authorization job report but never block; the Socket Security GitHub App
  // checks are external (no workflow file) and advisory too.
  advisoryChecks: [
    'No Committed Build Artifacts',
    'Authorize generated artifacts from base trust root',
    'Socket Security: Pull Request Alerts',
    'Socket Security: Project Report',
  ],
  // Every check this repo's CI reports on a PR to dev (ci.yml, pr-check.yml,
  // upgrade-test.yml); Build, npm pack and the smoke job start late (`needs:`).
  requiredChecks: [
    'Lint & Type Check',
    'Test',
    'Test (Windows path suite)',
    'better-sqlite3 Node 26 (ubuntu-latest)',
    'better-sqlite3 Node 26 (windows-2022)',
    'PreCompact restore (ubuntu-latest)',
    'PreCompact restore (macos-latest)',
    'PreCompact restore (windows-2022)',
    'Multi-repo Path Gate (AST-grep) (ubuntu-latest)',
    'Multi-repo Path Gate (AST-grep) (windows-2022)',
    'Version Consistency Check',
    'Build',
    'npm pack + install test',
    'Copilot smoke (tier 2)',
    'Base Branch Check',
    'Size Check',
    'Draft PR Check',
    'omg update + session-start hook',
  ],
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

/**
 * Syntactic branch-name check (no git): word characters, `.`, `/`, `-`, never
 * a leading `-` (it would parse as an option). Callers that spawn git also run
 * `git check-ref-format --branch`.
 */
export function isPlainBranchName(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.][\w./-]*$/.test(value) && !value.includes('..');
}

/** Repo-relative forward-slash path: plain segments, no `..`, not absolute or option-shaped. */
export function isRepoPath(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.][\w.-]*(?:\/[\w.][\w.-]*)*$/.test(value) && !value.split('/').includes('..');
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Merge a config block over the defaults; ill-typed fields are rejected, not ignored. */
export function resolveShipConfig(input: unknown): ShipConfig {
  const config: ShipConfig = {
    ...DEFAULT_SHIP_CONFIG,
    advisoryChecks: [...DEFAULT_SHIP_CONFIG.advisoryChecks],
    requiredChecks: [...DEFAULT_SHIP_CONFIG.requiredChecks],
  };
  if (input === undefined || input === null) return config;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('ship config must be an object');
  const raw = input as Record<string, unknown>;
  const bad = (key: string, want: string): never => {
    throw new Error(`ship.${key} must be ${want}`);
  };
  if (raw.base !== undefined) config.base = isPlainBranchName(raw.base) ? raw.base : bad('base', 'a branch name');
  if (raw.advisoryChecks !== undefined) config.advisoryChecks = isStringArray(raw.advisoryChecks) ? raw.advisoryChecks : bad('advisoryChecks', 'a string array');
  if (raw.requiredChecks !== undefined) config.requiredChecks = isStringArray(raw.requiredChecks) ? raw.requiredChecks : bad('requiredChecks', 'a string array');
  if (raw.knownFlakyFile !== undefined) config.knownFlakyFile = isRepoPath(raw.knownFlakyFile) ? raw.knownFlakyFile : bad('knownFlakyFile', 'a repo-relative path (read from the base branch)');
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
  /** Required substring of the full test title (a file-wide entry would also cover collection errors). */
  title: string;
  note?: string;
}

/** Parse a known-flaky list (`{ "tests": [...] }`); malformed content throws. */
export function parseKnownFlaky(content: string, file: string): KnownFlakyTest[] {
  const parsed: unknown = JSON.parse(content);
  const tests = (parsed as { tests?: unknown })?.tests;
  if (!Array.isArray(tests)) throw new Error(`${file}: expected { "tests": [...] }`);
  return tests.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (typeof e?.file !== 'string' || !e.file) throw new Error(`${file}: tests[${i}].file must be a string`);
    if (typeof e.title !== 'string' || !e.title) throw new Error(`${file}: tests[${i}].title must be a non-empty string`);
    return { file: e.file.replace(/\\/g, '/'), title: e.title, note: typeof e.note === 'string' ? e.note : undefined };
  });
}

/** Ship keys a lane or PR could use to merge a red PR; never read from the working tree or the PR head. */
export const SHIP_SAFETY_KEYS = ['allowAdminMerge', 'advisoryChecks', 'requiredChecks', 'knownFlakyFile'] as const;

/** Project config path inside the repo, read from the base branch for the safety keys. */
export const BASE_CONFIG_PATH = '.copilot/omg.jsonc';

function shipBlock(config: unknown, source: string): Record<string, unknown> {
  const ship = (config as { ship?: unknown } | null | undefined)?.ship;
  if (ship === undefined || ship === null) return {};
  if (typeof ship !== 'object' || Array.isArray(ship)) throw new Error(`${source}: ship config must be an object`);
  return ship as Record<string, unknown>;
}

/** `git show <remote>/<base>:<path>`; null when the ref or the file does not exist there. */
export function readBaseFile(exec: Exec, cwd: string, ref: string, path: string): string | null {
  const shown = exec('git', ['show', `${ref}:${path}`], { cwd });
  return shown.status === 0 ? shown.stdout : null;
}

export interface TrustedShipConfigInput {
  exec: Exec;
  /** Repo root (the checkout being shipped). */
  root: string;
  /** Base branch whose committed config is trusted (the PR's base). */
  base: string;
  remote?: string;
  /** The user-level config's parsed content (`~/.config/claude-omc/config.jsonc`). */
  user: unknown;
  /** Working-tree project config content; default: read `.copilot/omg.jsonc` under `root`. */
  project?: unknown;
  warn?: (message: string) => void;
}

/**
 * Resolve the ship config for a run. Precedence:
 * - safety keys (SHIP_SAFETY_KEYS): user config, then the base branch's
 *   committed `.copilot/omg.jsonc`, then the defaults. A safety key in the
 *   working-tree project file that differs from the base branch is ignored
 *   with a warning.
 * - other keys: defaults < base-branch file < user config < working-tree
 *   project file (the usual project-over-user order).
 * The base ref is fetched first; when it cannot be read the base layer is
 * empty (defaults are the strict setting).
 */
export function loadTrustedShipConfig(input: TrustedShipConfigInput): ShipConfig {
  const { exec, root, base } = input;
  const remote = input.remote ?? 'origin';
  const warn = input.warn ?? ((m: string) => console.error(m));
  if (!isPlainBranchName(base)) throw new Error(`base ${JSON.stringify(base)} is not a branch name`);
  const ref = `${remote}/${base}`;
  exec('git', ['fetch', remote, base], { cwd: root });
  const baseText = readBaseFile(exec, root, ref, BASE_CONFIG_PATH);
  const baseShip = baseText && baseText.trim() ? shipBlock(parseJsonc(baseText), `${ref}:${BASE_CONFIG_PATH}`) : {};
  const userShip = shipBlock(input.user, 'user config');
  let project = input.project;
  if (project === undefined) {
    const path = resolveProjectConfigPath(root);
    project = existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
  }
  const projectShip = { ...shipBlock(project, 'project config') };
  const safety = new Set<string>(SHIP_SAFETY_KEYS);
  for (const key of Object.keys(projectShip)) {
    if (!safety.has(key)) continue;
    if (JSON.stringify(projectShip[key]) !== JSON.stringify(baseShip[key])) {
      warn(`omg ship: ignoring ship.${key} from the working-tree project config; safety keys come only from the user config or ${ref}:${BASE_CONFIG_PATH}`);
    }
    delete projectShip[key];
  }
  const merged: Record<string, unknown> = { ...baseShip, ...userShip, ...projectShip };
  for (const key of SHIP_SAFETY_KEYS) {
    const value = userShip[key] !== undefined ? userShip[key] : baseShip[key];
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return resolveShipConfig(merged);
}

/** The known-flaky list as committed on the base branch (never the PR head); absent = empty. */
export function loadBaseKnownFlaky(exec: Exec, root: string, base: string, file: string, remote = 'origin'): KnownFlakyTest[] {
  if (!isPlainBranchName(base)) throw new Error(`base ${JSON.stringify(base)} is not a branch name`);
  if (!isRepoPath(file)) throw new Error(`knownFlakyFile ${JSON.stringify(file)} is not a repo-relative path`);
  const text = readBaseFile(exec, root, `${remote}/${base}`, file);
  return text && text.trim() ? parseKnownFlaky(text, `${remote}/${base}:${file}`) : [];
}
