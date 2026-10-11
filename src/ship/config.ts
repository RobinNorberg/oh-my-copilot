/**
 * `omg ship` configuration: defaults, the `ship` config block, and the
 * repo's known-flaky test list.
 *
 * Trust model (see loadTrustedShipConfig): the safety keys
 * (SHIP_SAFETY_KEYS) come only from the user-level config at its default
 * location, then the `.copilot/omg.jsonc` committed on a trusted base branch
 * at the sha GitHub reports (`git show <baseRefOid>:.copilot/omg.jsonc`,
 * replace refs off), then the defaults. The working-tree project file and the
 * PR head never set them: a lane can drop an untracked file into the
 * checkout, and a PR can commit one. The legacy `.copilot/omc.jsonc` name is
 * never read from the base branch.
 */

import { existsSync, readFileSync } from 'fs';
import { userInfo } from 'os';
import { basename, join, resolve } from 'path';
import { parseJsonc } from '../utils/jsonc.js';
import { getConfigPaths, loadJsoncFile } from '../config/loader.js';
import { LEGACY_PROJECT_CONFIG_FILE, resolveProjectConfigPath } from '../config/project-config-path.js';
import { TRUSTED_READ_ENV, type Exec } from './exec.js';

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
  /**
   * User config only. Bases whose committed config is read and into which
   * `merge` may admin-merge; for any other base the defaults apply and merge
   * prints the command instead (a lane can create a branch and target it).
   */
  trustedBases: string[];
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
  // ci.yml and upgrade-test.yml run only for PRs to main / dev
  // (`pull_request.branches`): on a PR to another base their checks never
  // report and stay pending, so such a base needs its own requiredChecks in
  // the user config.
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
  trustedBases: ['dev', 'main', 'master'],
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
    trustedBases: [...DEFAULT_SHIP_CONFIG.trustedBases],
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
  if (raw.trustedBases !== undefined) {
    config.trustedBases = Array.isArray(raw.trustedBases) && raw.trustedBases.every(isPlainBranchName) ? raw.trustedBases : bad('trustedBases', 'an array of branch names');
  }
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

/** Keys only the user config (default location) sets: ignored in the base-branch and working-tree files. */
export const SHIP_USER_ONLY_KEYS = ['trustedBases'] as const;

/** Project config path inside the repo, read from the base branch for the safety keys. */
export const BASE_CONFIG_PATH = '.copilot/omg.jsonc';

function shipBlock(config: unknown, source: string): Record<string, unknown> {
  const ship = (config as { ship?: unknown } | null | undefined)?.ship;
  if (ship === undefined || ship === null) return {};
  if (typeof ship !== 'object' || Array.isArray(ship)) throw new Error(`${source}: ship config must be an object`);
  return ship as Record<string, unknown>;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const MISSING_PATH = /does not exist in|exists on disk, but not in/;

/**
 * `git show <commit>:<path>` with replace refs off; null when the file does
 * not exist at that commit. Any other failure throws (fail closed).
 */
export function readBaseFile(exec: Exec, cwd: string, commit: string, path: string): string | null {
  // git reports "path does not exist" for an unknown commit too; check the commit first.
  if (exec('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd, env: TRUSTED_READ_ENV }).status !== 0) {
    throw new Error(`base commit ${commit.slice(0, 12)} is not in the local object store (fetch it first)`);
  }
  const shown = exec('git', ['show', `${commit}:${path}`], { cwd, env: TRUSTED_READ_ENV });
  if (shown.status === 0) return shown.stdout;
  if (MISSING_PATH.test(shown.stderr)) return null;
  throw new Error(`git show ${commit.slice(0, 12)}:${path} failed (exit ${shown.status}): ${shown.stderr.trim()}`);
}

/**
 * Comparable identity of a repository URL: `gh:<host>/<owner>/<repo>` for an
 * https / ssh / scp-style URL (case-insensitive, `.git` and a trailing `/`
 * dropped), `path:<url>` for anything else (a local path), so a local path
 * can never equal a GitHub repository.
 */
function repoIdentity(url: string): string {
  const s = url.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+)$/.exec(s)
    ?? /^(?:[^@/:]+@)?([^/:]{2,}):([^/]+)\/([^/]+)$/.exec(s);
  return m ? `gh:${m[1]}/${m[2]}/${m[3]}` : `path:${s}`;
}

/**
 * Null when `git remote get-url <remote>` (insteadOf rewrites applied, so the
 * URL fetch really uses) names the PR's repository (`repoUrl`, from
 * `gh pr view --json url` without `/pull/<n>`); otherwise why not. Checked
 * before every fetch of the base, so a lane that points the remote at another
 * repository is refused instead of fetched from.
 */
export function remoteRepoMismatch(exec: Exec, cwd: string, remote: string, repoUrl: string | undefined): string | null {
  if (!repoUrl) return 'GitHub reported no repository url for the PR';
  const got = exec('git', ['remote', 'get-url', remote], { cwd, env: TRUSTED_READ_ENV });
  if (got.status !== 0) return `git remote get-url ${remote} failed: ${got.stderr.trim().split('\n')[0]}`;
  const url = got.stdout.trim();
  return repoIdentity(url) === repoIdentity(repoUrl) ? null : `remote ${remote} points at ${url}, but the PR is in ${repoUrl}`;
}

/** The repository URL of a PR URL (`https://github.com/o/r/pull/12` -> `https://github.com/o/r`); undefined when it is not one. */
export function prRepoUrl(prUrl: unknown): string | undefined {
  return typeof prUrl === 'string' && /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(prUrl) ? prUrl.replace(/\/pull\/\d+$/, '') : undefined;
}

/**
 * The user config's default location, derived from the account's home
 * directory as the OS reports it (`os.userInfo()`: passwd / the Windows
 * profile, not HOME / USERPROFILE / APPDATA / XDG_CONFIG_HOME, which a lane
 * can set): `<home>/AppData/Roaming/claude-omc/config.jsonc` on Windows,
 * `<home>/.config/claude-omc/config.jsonc` elsewhere, the layout the normal
 * loader (getConfigPaths) uses when those variables are unset.
 */
export function trustedUserConfigPath(home: string = userInfo().homedir): string {
  const configDir = process.platform === 'win32' ? join(home, 'AppData', 'Roaming') : join(home, '.config');
  return join(configDir, 'claude-omc', 'config.jsonc');
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

/**
 * The user-config layers for loadTrustedShipConfig: `user` is the file the
 * normal loader reads (env-selected), `trustedUser` the file at the default
 * location (trustedUserConfigPath). When the two differ, the safety keys come
 * only from `trustedUser`. No resolvable home directory = no trusted user layer.
 */
export function userConfigLayers(envPath: string = getConfigPaths().user, trustedPath?: string | null): { user: unknown; trustedUser: unknown } {
  let defaultPath = trustedPath;
  if (defaultPath === undefined) {
    try {
      defaultPath = trustedUserConfigPath();
    } catch {
      defaultPath = null;
    }
  }
  const user = loadJsoncFile(envPath);
  if (defaultPath && samePath(envPath, defaultPath)) return { user, trustedUser: user };
  return { user, trustedUser: defaultPath ? loadJsoncFile(defaultPath) : null };
}

export interface TrustedShipConfigInput {
  exec: Exec;
  /** Repo root (the checkout being shipped). */
  root: string;
  /** The PR's base branch on GitHub (baseRefName). */
  base: string;
  /** GitHub's base sha (baseRefOid): the base layer is read at this commit, after the fetched ref is checked against it. */
  baseSha?: string;
  /** merge: a failed fetch or an unknown / mismatched base sha throws instead of skipping the base layer. */
  strict?: boolean;
  remote?: string;
  /** The PR's repository URL on GitHub (prRepoUrl); the remote must point at it before the base is fetched. */
  repoUrl?: string;
  /** The user config the normal loader reads (env-selected location); non-safety keys. */
  user: unknown;
  /** The user config at its default location (userConfigLayers); the only user source of safety keys. Default: `user`. */
  trustedUser?: unknown;
  /** Working-tree project config content; default: read `.copilot/omg.jsonc` (or the legacy name) under `root`. */
  project?: unknown;
  warn?: (message: string) => void;
}

export interface LoadedShipConfig extends ShipConfig {
  /** Base commit whose committed files were read (equal to GitHub's base sha); undefined when the base layer was skipped. */
  trustedBaseCommit?: string;
}

/**
 * Resolve the ship config for a run. Precedence:
 * - safety keys (SHIP_SAFETY_KEYS): the user config at its default location,
 *   then the trusted base's committed `.copilot/omg.jsonc`, then the
 *   defaults. A safety key in the working-tree project file that differs from
 *   the base branch, or in an env-selected user config that differs from the
 *   default location's, is ignored with a warning.
 * - trustedBases (SHIP_USER_ONLY_KEYS): the user config at its default location only.
 * - other keys: defaults < base-branch file < user config < working-tree
 *   project file (the usual project-over-user order).
 * The remote must point at the PR's repository (remoteRepoMismatch), the
 * base is fetched and `refs/remotes/<remote>/<base>` must equal GitHub's
 * base sha; the files are then read at that sha with replace refs off. A base
 * outside trustedBases is never read. When the base cannot be verified the
 * base layer is empty with a warning (defaults are the strict setting), or,
 * with `strict`, the load throws.
 */
export function loadTrustedShipConfig(input: TrustedShipConfigInput): LoadedShipConfig {
  const { exec, root, base } = input;
  const remote = input.remote ?? 'origin';
  const warn = input.warn ?? ((m: string) => console.error(m));
  if (!isPlainBranchName(base)) throw new Error(`base ${JSON.stringify(base)} is not a branch name`);
  if (!/^[\w][\w.-]*$/.test(remote)) throw new Error(`remote ${JSON.stringify(remote)} is not a remote name`);

  const userShip = { ...shipBlock(input.user, 'user config') };
  const trustedUserShip = input.trustedUser === undefined
    ? shipBlock(input.user, 'user config')
    : shipBlock(input.trustedUser, 'user config (default location)');
  const userOnly = new Set<string>([...SHIP_SAFETY_KEYS, ...SHIP_USER_ONLY_KEYS]);
  for (const key of Object.keys(userShip)) {
    if (!userOnly.has(key)) continue;
    if (JSON.stringify(userShip[key]) !== JSON.stringify(trustedUserShip[key])) {
      warn(`omg ship: ignoring ship.${key} from the user config selected by APPDATA / XDG_CONFIG_HOME; safety keys come only from ${trustedUserConfigPathOrDefault()}`);
    }
    delete userShip[key];
  }
  const trustedBases = resolveShipConfig({ trustedBases: trustedUserShip.trustedBases }).trustedBases;

  // Verify the base against GitHub before reading anything committed on it.
  const ref = `refs/remotes/${remote}/${base}`;
  const unverified = (reason: string): undefined => {
    if (input.strict) throw new Error(`omg ship: ${reason}; refusing (fail closed)`);
    warn(`omg ship: ${reason}; the base branch's committed config is not read (defaults apply)`);
    return undefined;
  };
  let commit: string | undefined;
  if (!input.baseSha || !FULL_SHA.test(input.baseSha)) {
    commit = unverified(`GitHub reported no base sha for ${base}`);
  } else {
    const mismatch = remoteRepoMismatch(exec, root, remote, input.repoUrl);
    const fetched = mismatch ? null : exec('git', ['fetch', remote, base], { cwd: root, env: TRUSTED_READ_ENV });
    const local = fetched?.status === 0 ? exec('git', ['rev-parse', '--verify', ref], { cwd: root, env: TRUSTED_READ_ENV }) : null;
    if (mismatch) commit = unverified(mismatch);
    else if (!local) commit = unverified(`git fetch ${remote} ${base} failed: ${fetched!.stderr.trim().split('\n')[0]}`);
    else if (local.status !== 0 || local.stdout.trim() !== input.baseSha) {
      commit = unverified(`${ref} is ${local.stdout.trim() || 'missing'}, but GitHub reports ${base} at ${input.baseSha}`);
    } else commit = input.baseSha;
  }
  const trusted = trustedBases.includes(base);
  if (!trusted) warn(`omg ship: base ${base} is not in ship.trustedBases (${trustedBases.join(', ')}); its committed config is not read and merge never admin-merges into it`);

  let baseShip: Record<string, unknown> = {};
  if (trusted && commit) {
    const source = `${commit.slice(0, 12)}:${BASE_CONFIG_PATH}`;
    const text = readBaseFile(exec, root, commit, BASE_CONFIG_PATH);
    let parsed: unknown;
    try {
      parsed = text && text.trim() ? parseJsonc(text) : undefined;
    } catch (error) {
      throw new Error(`${base} ${source} is not valid JSONC: ${error instanceof Error ? error.message : String(error)}`);
    }
    baseShip = { ...shipBlock(parsed, `${base} ${source}`) };
  }

  let project = input.project;
  let legacyProject = false;
  if (project === undefined) {
    const path = resolveProjectConfigPath(root);
    legacyProject = basename(path) === LEGACY_PROJECT_CONFIG_FILE;
    project = existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
  }
  const projectShip = { ...shipBlock(project, 'project config') };
  const ignored: string[] = [];
  for (const key of SHIP_USER_ONLY_KEYS) {
    for (const [layer, source] of [[baseShip, `${base}:${BASE_CONFIG_PATH}`], [projectShip, 'the working-tree project config']] as const) {
      if (layer[key] === undefined) continue;
      warn(`omg ship: ignoring ship.${key} from ${source}; it is read only from the user config`);
      delete layer[key];
    }
  }
  for (const key of Object.keys(projectShip)) {
    if (!userOnly.has(key)) continue;
    if (JSON.stringify(projectShip[key]) !== JSON.stringify(baseShip[key])) ignored.push(key);
    delete projectShip[key];
  }
  if (ignored.length > 0 && legacyProject) {
    // One line, not one per key: the legacy name is simply not a trusted source.
    warn(`omg ship: .copilot/${LEGACY_PROJECT_CONFIG_FILE} (legacy name) is not read from the base branch; its ship safety keys (${ignored.join(', ')}) are ignored. Rename it to ${BASE_CONFIG_PATH} and commit it to ${base}.`);
  } else {
    for (const key of ignored) {
      warn(`omg ship: ignoring ship.${key} from the working-tree project config; safety keys come only from the user config or ${base}:${BASE_CONFIG_PATH}`);
    }
  }

  const merged: Record<string, unknown> = { ...baseShip, ...userShip, ...projectShip };
  for (const key of SHIP_SAFETY_KEYS) {
    const value = trustedUserShip[key] !== undefined ? trustedUserShip[key] : baseShip[key];
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  merged.trustedBases = trustedBases;
  return { ...resolveShipConfig(merged), trustedBaseCommit: trusted ? commit : undefined };
}

function trustedUserConfigPathOrDefault(): string {
  try {
    return trustedUserConfigPath();
  } catch {
    return 'the default user config location';
  }
}

/**
 * The known-flaky list committed at the verified base commit (never the PR
 * head; LoadedShipConfig.trustedBaseCommit). No commit or no file = empty.
 */
export function loadBaseKnownFlaky(exec: Exec, root: string, commit: string | undefined, file: string): KnownFlakyTest[] {
  if (commit === undefined) return [];
  if (!FULL_SHA.test(commit)) throw new Error(`base commit ${JSON.stringify(commit)} is not a full sha`);
  if (!isRepoPath(file)) throw new Error(`knownFlakyFile ${JSON.stringify(file)} is not a repo-relative path`);
  const text = readBaseFile(exec, root, commit, file);
  return text && text.trim() ? parseKnownFlaky(text, `${commit.slice(0, 12)}:${file}`) : [];
}
