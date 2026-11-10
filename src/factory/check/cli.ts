/**
 * `omg factory check [<id>... | --parent <spec> | --source <spec>] [--limit n] [--json] [--mark [--yes]]`
 * (factory forges design §5): bucket intake items as runnable, needs-plan
 * or blocked; `--parent` checks a spec's children (shipyard ↔ factory
 * design §3.1). Read-only unless `--mark`, which adds `factory.intake.marker`
 * (a GitHub label or an ADO tag) to the runnable items only, after a TTY
 * confirmation or `--yes`, through `forge.tracker.addMarker`.
 *
 * Every command passes checkGuardExec: the gh reads the tracker builds, the
 * open-PR lookup on `factory/issue-<n>`, a dependency's merged factory PR
 * into the base, a dependency PR's state, the marker
 * label lookup, the label write only while marking, the git reads of the base
 * and `git ls-remote origin refs/heads/factory/<name>`. az runs through the factory guard's
 * runGuardedAdo (fail closed without an ADO guard context), and while not
 * marking only as a GET or the wit.wiql.POST query.
 *
 * Exit codes: 0 checked (whatever the buckets; a declined `--mark` writes
 * nothing), 1 a tracker read or a marker write failed, 2 usage (bad id,
 * source or limit, no intake source, `--mark` without `--yes` and no TTY),
 * 5 incompatible (forge mismatch, unsupported remote, no adapter for the forge).
 */

import chalk from 'chalk';
import { ForgeConfigError, resolveForgeConfig } from '../../forge/config.js';
import { localForgeLimitations, readMirrorRef } from '../../forge/local/index.js';
import { STATE_CHANGE_LOG_FLAGS } from '../../forge/local/mirror.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import type { Forge, ForgeFactory, ResolvedForgeConfig } from '../../forge/types.js';
import { resolveAzEntry, type AzEntry } from '../../forge/ado/az-binary.js';
import { adoGuardContext, defaultAzBinaryDeps, type AzureDevOpsForgeOptions } from '../../forge/ado/index.js';
import { factoryForgeOptions, unsupportedForge } from '../run/forge-roots.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { BASE_CONFIG_PATH, isPlainBranchName, readBaseFile, resolveShipConfig, trustedPrepareChecks } from '../../ship/config.js';
import { baseFileExists, describePrepareChecks } from '../../ship/prepare.js';
import { TRUSTED_FETCH_ENV, TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { isAdoCommand, runGuardedAdo, type AdoGuardContext } from '../../forge/ado/guard.js';
import { assertFactoryCommand, FactorySafetyError, isPlainRepoPath } from '../run/exec.js';
import { ghRepoArg } from '../../forge/github/gh.js';
import { isReviewFeedbackArgs } from '../../forge/github/graphql.js';
import { FactoryBusyError, factoryStateDir, READ_SCAN_WAIT_MS, readFactoryState, tryScanLock, type OwnerDeps } from '../run/state.js';
import { gateDefinitionSources } from '../run/local-gate.js';
import { BUCKET_ORDER, checkItems, plainText, type CheckEnv, type CheckResult } from './score.js';

export const EXIT_CHECK_FAILED = 1;
export const EXIT_CHECK_USAGE = 2;
export const EXIT_CHECK_INCOMPATIBLE = 5;
/** Bumped on any change to the `--json` shape (src/factory/check/__tests__/cli.test.ts pins it). */
export const CHECK_JSON_SCHEMA_VERSION = 1;

export class CheckUsageError extends Error {}
export class CheckIncompatibleError extends Error {}

const NUMBER = /^\d+$/;
const JSON_FIELDS = /^[A-Za-z]+(?:,[A-Za-z]+)*$/;
const FACTORY_ISSUE_BRANCH = /^factory\/issue-\d+$/;
const VALUE = (s: string | undefined): s is string => typeof s === 'string' && s.length > 0 && !s.startsWith('-') && !/[\r\n\0]/.test(s);
const same = (args: string[], shape: string[]) => args.length === shape.length && shape.every((v, i) => args[i] === v);

function checkGh(a: string[], marker: string | undefined, githubRepo: string | undefined): boolean {
  const [group, sub, ...r] = a;
  // The human review read (poll's thread count): the fixed GraphQL query on the configured repository only.
  if (group === 'api') return isReviewFeedbackArgs(a, githubRepo);
  if (group === 'issue' && sub === 'view') return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--json' && JSON_FIELDS.test(r[2]);
  if (group === 'issue' && sub === 'list') {
    return r.length === 8 && (r[0] === '--label' || r[0] === '--milestone') && VALUE(r[1]) && r[2] === '--state' && r[3] === 'open'
      && r[4] === '--json' && r[5] === 'number' && r[6] === '--limit' && NUMBER.test(r[7]);
  }
  if (group === 'issue' && sub === 'edit') return marker !== undefined && same(r.slice(1), ['--add-label', marker]) && NUMBER.test(r[0] ?? '');
  if (group === 'pr' && sub === 'list') {
    if (r.length === 4) return r[0] === '--head' && FACTORY_ISSUE_BRANCH.test(r[1]) && r[2] === '--json' && JSON_FIELDS.test(r[3]);
    // A dependency's merged factory PR into the base (isSatisfied).
    return r.length === 8 && r[0] === '--head' && FACTORY_ISSUE_BRANCH.test(r[1]) && r[2] === '--base' && VALUE(r[3]) && same(r.slice(4), ['--state', 'merged', '--json', 'number']);
  }
  // A dependency that is a PR: its state.
  if (group === 'pr' && sub === 'view') return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--json' && JSON_FIELDS.test(r[2]);
  // `--mark` first checks that the marker label exists (check never creates labels).
  if (group === 'label' && sub === 'list') return r.length === 6 && r[0] === '--search' && VALUE(r[1]) && r[2] === '--json' && r[3] === 'name' && r[4] === '--limit' && NUMBER.test(r[5]);
  return false;
}

const CHECK_GIT = new Set(['rev-parse', 'remote', 'fetch', 'cat-file', 'show', 'ls-remote', 'merge-base']);
/**
 * The local forge's read shapes (src/forge/local): the backlog listing at a
 * commit, and the local base branch (an offline repository has no origin to
 * fetch). The check guard allows them itself, with ship's trusted-read env only.
 * Paths use the engine guard's isPlainRepoPath, so both guards agree.
 */
export function isLocalReadShape(args: readonly string[]): boolean {
  if (args[0] === 'ls-tree') {
    const dir = args[5] ?? '';
    return args.length === 6 && same(args.slice(1, 3), ['-z', '--name-only']) && /^[0-9a-f]{40}$/.test(args[3]) && args[4] === '--'
      && dir.endsWith('/') && isPlainRepoPath(dir.slice(0, -1));
  }
  // F31: the last commit that changed one backlog file's state: line on the base (lastStateChangeArgs: a reopen after a merge).
  if (args[0] === 'log') {
    const n = STATE_CHANGE_LOG_FLAGS.length;
    return args.length === n + 4 && same(args.slice(1, n + 1), [...STATE_CHANGE_LOG_FLAGS]) && /^[0-9a-f]{40}$/.test(args[n + 1]) && args[n + 2] === '--'
      && isPlainRepoPath(args[n + 3]);
  }
  return args.length === 3 && args[0] === 'rev-parse' && args[1] === '--verify' && args[2].startsWith('refs/heads/') && isPlainBranchName(args[2].slice('refs/heads/'.length));
}

/**
 * The `omg factory check` guard. `marker` is set only after `--mark` was
 * confirmed: then, and only then, `gh issue edit <n> --add-label <marker>`
 * and az writes pass (the wit.wiql.POST query is a read and passes without it).
 * `githubRepo` (ghRepoArg of a GitHub forge) allows the review feedback GraphQL read of that repository.
 */
export function checkGuardExec(exec: Exec, marker?: () => string | undefined, ado: () => AdoGuardContext | undefined = () => undefined, command = 'omg factory check', githubRepo: () => string | undefined = () => undefined): Exec {
  return (cmd, args, opts) => {
    const file = cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
    const refuse = (why: string): never => { throw new FactorySafetyError(`${command} refuses \`${file} ${args.join(' ')}\`: ${why}`); };
    const mark = marker?.();
    if (!args.every((x) => typeof x === 'string')) refuse('non-string argument');
    if (file === 'gh') {
      if (opts?.env !== undefined) refuse('gh takes no environment');
      if (!checkGh(args, mark, githubRepo())) refuse(`not one of the command shapes ${command} runs`);
    } else if (file === 'git' && isLocalReadShape(args)) {
      if (opts?.env !== undefined && JSON.stringify(Object.entries(opts.env)) !== JSON.stringify(Object.entries(TRUSTED_READ_ENV))) refuse('git takes only the trusted-read environment');
    } else if (file === 'git') {
      // ls-tree: readBaseFile's "absent" probe only (`ls-tree --full-tree -z <sha> -- <path>`; the factory guard checks the path).
      const read = (CHECK_GIT.has(args[0]) && (args[0] !== 'show' || (args.length === 2 && /^[0-9a-f]{40}:/.test(args[1]))))
        || (args[0] === 'ls-tree' && args.length === 6 && args[1] === '--full-tree' && args[2] === '-z' && /^[0-9a-f]{40}$/.test(args[3]) && args[4] === '--');
      if (!read) refuse(`not one of the read-only git shapes ${command} runs`);
      // The factory guard: ship's read shapes plus `ls-remote origin refs/heads/factory/<name>`.
      assertFactoryCommand(cmd, args, [], opts?.env);
    } else if (isAdoCommand(cmd)) {
      // Reads: a GET, or the WIQL query the area-tag and board-column sources POST (wit.wiql.POST; the guard validates its body).
      const flag = (f: string) => { const at = args.indexOf(f); return at >= 0 ? args[at + 1] : undefined; };
      const method = flag('--http-method')?.toUpperCase();
      const wiql = method === 'POST' && flag('--area')?.toLowerCase() === 'wit' && flag('--resource')?.toLowerCase() === 'wiql';
      if (mark === undefined && method !== undefined && method !== 'GET' && !wiql) refuse('only reads run without a confirmed --mark');
      // The factory guard's path: az gets the guard's own copy of a validated --in-file body, never the caller's file.
      return runGuardedAdo(exec, cmd, args, opts, ado(), 'factory', (why) => new FactorySafetyError(`${command} refuses \`${file} ${args.join(' ')}\`: ${why}`));
    } else {
      refuse(`not a command ${command} runs`);
    }
    return exec(cmd, args, opts);
  };
}

/** `--source` as a config value (resolveForgeConfig validates it): label:x, milestone:x, wiql-query:<guid>, board-column:team/board/column, area-tag:<area path>#<tag>. */
export function parseSourceSpec(spec: string): Record<string, string> {
  // The local forge's backlog directory, optionally only the items with a label.
  if (spec === 'local-backlog') return { type: spec };
  if (spec.startsWith('local-backlog:') && spec.length > 'local-backlog:'.length) return { type: 'local-backlog', label: spec.slice('local-backlog:'.length) };
  const at = spec.indexOf(':');
  const type = at > 0 ? spec.slice(0, at) : '';
  const value = spec.slice(at + 1);
  switch (type) {
    case 'label': return { type, label: value };
    case 'milestone': return { type, milestone: value };
    case 'wiql-query': return { type, queryId: value };
    case 'board-column': {
      const [team, board, ...column] = value.split('/');
      if (!team || !board || column.length === 0) break;
      return { type, team, board, column: column.join('/') };
    }
    case 'area-tag': {
      const hash = value.lastIndexOf('#');
      if (hash <= 0) break;
      return { type, areaPath: value.slice(0, hash), tag: value.slice(hash + 1) };
    }
    default: break;
  }
  throw new CheckUsageError(`--source ${JSON.stringify(spec)} is not label:<name>, milestone:<name>, wiql-query:<guid>, board-column:<team>/<board>/<column>, area-tag:<area path>#<tag> or local-backlog[:<label>]`);
}

export function parseItemId(raw: string): number {
  const n = Number(raw.replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0 || !/^#?\d+$/.test(raw)) throw new CheckUsageError(`item id must be a positive number, got ${JSON.stringify(raw)}`);
  return n;
}

export interface FactoryCheckDeps {
  /** The raw Exec; runFactoryCheck wraps it in checkGuardExec. */
  exec: Exec;
  /** The integration branch (ship.base). */
  base: (root: string) => string;
  /** The user config at its default location (userConfigLayers().trustedUser). */
  trustedUser: () => unknown;
  /** The parsed working-tree project config. */
  projectConfig: (root: string) => unknown;
  /** The forge adapter (src/forge/index.ts createForge; tests inject a fake). */
  createForge: ForgeFactory;
  /** The az entry on Azure DevOps (default defaultResolveAz; tests inject one). */
  resolveAz?: (root: string) => AzEntry;
  isTTY: () => boolean;
  confirm: (question: string) => Promise<boolean>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** This process as an engine-lock contender (default defaultOwnerDeps; tests inject one). */
  owner?: OwnerDeps;
}

export interface FactoryCheckOptions {
  ids: string[];
  /** A spec item: check its children (ForgeItem.children) instead of ids or the intake source. */
  parent?: string;
  source?: string;
  limit?: number;
  json?: boolean;
  mark?: boolean;
  yes?: boolean;
}

export interface CheckJson {
  schemaVersion: number;
  ok: boolean;
  forge: string;
  /** What the forge cannot do (the local forge's offline lines); empty on GitHub and Azure DevOps. */
  limitations: string[];
  /** What a run's prepare step will run in this repository (ship.prepare.checks, else the detected built-ins); [] = none. */
  prepareChecks: string[];
  /** The local forge's gate definition status (`ok`, `unresolved (<why>)` or `not set`); absent on GitHub and Azure DevOps. */
  gate?: string;
  repo: string;
  source: Record<string, unknown> | null;
  counts: Record<string, number>;
  items: CheckResult[];
  mark: { marker: string; requested: boolean; confirmed: boolean; marked: number[]; alreadyMarked: number[]; failed: Array<{ id: number; error: string }> };
  warnings: string[];
}

function git(exec: Exec, root: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = exec('git', args, { cwd: root, env: TRUSTED_READ_ENV });
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim().split('\n')[0] ?? '' };
}

/**
 * The repository side of a check: the run state under `root` and the plan
 * files at `origin/<base>` (null = no base: every omg-plan is plan-missing).
 * The setup wizard builds its preview env with this too.
 */
export function checkEnvFor(exec: Exec, root: string, config: CheckEnv['config'] & { kind?: string; repo?: { url: string } }, base: string, baseSha: string | null): CheckEnv {
  if (config.kind === 'local' && config.repo) {
    // The local forge: the base is the local branch, and the factory branches live in the engine's mirror (read as files, no spawn).
    const mirror = config.repo.url;
    return {
      config,
      runState: (id) => readFactoryState(root, id),
      remoteBranch: (branch) => readMirrorRef(mirror, branch) !== undefined,
      readPlan: (path) => (baseSha ? readBaseFile(exec, root, baseSha, path) : null),
      planBase: baseSha ? `${base} at ${baseSha.slice(0, 12)}` : `${base} (not available)`,
      base,
    };
  }
  return {
    config,
    runState: (id) => readFactoryState(root, id),
    remoteBranch: (branch) => {
      const r = git(exec, root, ['ls-remote', 'origin', `refs/heads/${branch}`]);
      if (!r.ok) throw new Error(`git ls-remote origin refs/heads/${branch} failed: ${r.err}`);
      return r.out.length > 0;
    },
    readPlan: (path) => (baseSha ? readBaseFile(exec, root, baseSha, path) : null),
    planBase: baseSha ? `origin/${base} at ${baseSha.slice(0, 12)}` : `origin/${base} (not available)`,
    base,
  };
}

/** `--mark` on GitHub: the marker label must exist (gh would fail every edit); check never creates it. */
function requireLabel(exec: Exec, root: string, marker: string, repo: string): void {
  const res = exec('gh', ['label', 'list', '--search', marker, '--json', 'name', '--limit', '100'], { cwd: root });
  if (res.status !== 0) throw new Error(`gh label list failed (exit ${res.status}): ${res.stderr.trim().split('\n')[0]}`);
  let names: unknown;
  try { names = JSON.parse(res.stdout); } catch { throw new Error('gh label list returned no JSON'); }
  const found = Array.isArray(names) && names.some((l) => typeof (l as { name?: unknown })?.name === 'string' && (l as { name: string }).name.toLowerCase() === marker.toLowerCase());
  if (!found) throw new CheckIncompatibleError(`label ${marker} does not exist in ${repo}; run \`omg factory setup\` to create it (omg factory check never creates labels)`);
}

/**
 * A read command's fetch never waits longer than this (it may hold the engine lock); then the last fetched base is read.
 * Kept below SCAN_WAIT_MS (run/state.ts): an engine start waiting on this fetch's `scan` lock always outlasts it.
 */
export const FETCH_TIMEOUT_MS = 45_000;

/** Fetch `origin/<base>` (read-only, no credential prompt, bounded) and resolve it; null with a warning when it cannot be read. */
export function fetchBase(exec: Exec, root: string, base: string, warnings: string[]): string | null {
  const f = exec('git', ['fetch', 'origin', base], { cwd: root, env: TRUSTED_FETCH_ENV, timeoutMs: FETCH_TIMEOUT_MS });
  const fetched = { ok: f.status === 0, err: f.stderr.trim().split('\n')[0] ?? '' };
  if (!fetched.ok) {
    const timedOut = /ETIMEDOUT/.test(fetched.err);
    warnings.push(`omg factory check: git fetch origin ${base} ${timedOut ? `timed out after ${FETCH_TIMEOUT_MS / 1000} s` : 'failed'} (${fetched.err}); using the local origin/${base}`
      + (timedOut ? `; if later fetches keep failing, a stale refs/remotes/origin/${base}.lock in .git may need removing` : ''));
  }
  const sha = git(exec, root, ['rev-parse', '--verify', `refs/remotes/origin/${base}`]);
  if (sha.ok && /^[0-9a-f]{40}$/.test(sha.out)) return sha.out;
  warnings.push(`omg factory check: origin/${base} is not available; its committed config is not read and omg-plan links cannot be checked`);
  return null;
}

/**
 * fetchBase for a read command (check, board, poll's start-up, enqueue, pr,
 * triage): a fetch under a live engine reads as lane tampering to it, so it
 * runs under this checkout's engine lock (key `scan`, released in finally).
 * A read command never fails because an engine runs: while one holds the
 * checkout nothing is fetched and the last fetched origin/<base> is read
 * (one warning); FactoryBusyError (exit 6) only when there is none. Another
 * read's fetch (`scan`) is waited out READ_SCAN_WAIT_MS, then this read goes
 * on without fetching (never exit 6 for a read). A checkout without factory
 * state has no engine to disturb: it fetches without the lock and leaves no
 * `.omg/` behind.
 */
export function fetchBaseUnlessBusy(exec: Exec, root: string, base: string, warnings: string[], owner?: OwnerDeps): string | null {
  if (!existsSync(factoryStateDir(root))) return fetchBase(exec, root, base, warnings);
  const held = tryScanLock(root, new Date().toISOString(), owner, READ_SCAN_WAIT_MS);
  if (held instanceof FactoryBusyError) {
    const sha = git(exec, root, ['rev-parse', '--verify', `refs/remotes/origin/${base}`]);
    const fetched = sha.ok && /^[0-9a-f]{40}$/.test(sha.out);
    if (held.holderRun === 'scan') {
      if (fetched) {
        warnings.push(`another factory command is fetching: using the last fetched origin/${base} (${sha.out.slice(0, 12)})`);
        return sha.out;
      }
      warnings.push(`omg factory check: another factory command is fetching and origin/${base} is not available yet; its committed config is not read and omg-plan links cannot be checked`);
      return null;
    }
    if (!fetched) throw new FactoryBusyError(`${held.message}; origin/${base} was never fetched in this checkout, so there is nothing to read until it ends`);
    warnings.push(`engine busy: using the last fetched origin/${base} (${sha.out.slice(0, 12)})`);
    return sha.out;
  }
  try {
    return fetchBase(exec, root, base, warnings);
  } finally {
    held.release();
  }
}

/** The base branch's committed `.copilot/omg.jsonc`, when the base is in ship.trustedBases (as loadTrustedShipConfig). */
export function baseLayer(exec: Exec, root: string, base: string, baseSha: string | null, trustedUser: unknown, warnings: string[]): unknown {
  const trustedBases = resolveShipConfig({ trustedBases: (trustedUser as { ship?: { trustedBases?: unknown } } | null | undefined)?.ship?.trustedBases }).trustedBases;
  if (!trustedBases.includes(base)) {
    warnings.push(`omg factory check: base ${base} is not in ship.trustedBases; its committed config is not read`);
    return undefined;
  }
  if (!baseSha) return undefined;
  const text = readBaseFile(exec, root, baseSha, BASE_CONFIG_PATH);
  return text && text.trim() ? parseJsonc(text) : undefined;
}

/** The project layer with `--source` / `--limit` as working-tree intake keys (the resolver validates them). */
function withFlags(project: unknown, o: Pick<FactoryCheckOptions, 'source' | 'limit'>): unknown {
  if (o.source === undefined && o.limit === undefined) return project;
  const p = (project && typeof project === 'object' ? project : {}) as Record<string, unknown>;
  const factory = (p.factory && typeof p.factory === 'object' ? p.factory : {}) as Record<string, unknown>;
  const intake = (factory.intake && typeof factory.intake === 'object' ? factory.intake : {}) as Record<string, unknown>;
  return {
    ...p,
    factory: {
      ...factory,
      intake: { ...intake, ...(o.source !== undefined ? { source: parseSourceSpec(o.source) } : {}), ...(o.limit !== undefined ? { limit: o.limit } : {}) },
    },
  };
}

export function renderCheckTable(items: readonly CheckResult[]): string {
  if (items.length === 0) return 'no items to check';
  const color = { runnable: chalk.green, 'needs-plan': chalk.yellow, blocked: chalk.red } as const;
  const rows = items.map((r) => [`#${r.id}`, r.bucket, r.priority === null ? '-' : `P${r.priority}`, r.reasons[0] ?? '', r.title.slice(0, 60), r.detail]);
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((row) => row[i].length), ['ID', 'BUCKET', 'PRI', 'REASON'][i].length));
  const pad = (row: string[]) => row.slice(0, 4).map((c, i) => c.padEnd(widths[i])).join('  ');
  const lines = [chalk.bold(`${pad(['ID', 'BUCKET', 'PRI', 'REASON'])}  TITLE`)];
  items.forEach((r, i) => {
    const row = rows[i];
    lines.push(`${color[r.bucket](pad(row))}  ${row[4]}`);
    lines.push(chalk.gray(`${' '.repeat(widths[0] + 2)}${row[5]}`));
  });
  const counts = BUCKET_ORDER.map((b) => `${items.filter((r) => r.bucket === b).length} ${b}`).join(', ');
  lines.push(counts);
  return lines.join('\n');
}

/** Production az entry: resolved outside every root a lane writes (factoryForgeOptions). */
export const defaultResolveAz = (root: string): AzEntry => resolveAzEntry(defaultAzBinaryDeps([root, ...factoryForgeOptions(root).untrustedRoots]));

/**
 * The read-only check guard for a resolved forge, and the options to build
 * the forge on it. On Azure DevOps the az entry is resolved once: the guard
 * gets the forge repo and that entry (adoGuardContext), and the adapter
 * spawns the same entry. GitHub needs neither. Exported for the board (B1) to reuse.
 */
export function forgeReadExec(exec: Exec, config: ResolvedForgeConfig, root: string, resolveAz: (root: string) => AzEntry = defaultResolveAz, marker?: () => string | undefined, command?: string): { exec: Exec; options: AzureDevOpsForgeOptions } {
  const entry = config.kind === 'azure-devops' ? resolveAz(root) : undefined;
  const guard = entry ? adoGuardContext(config, entry) : undefined;
  const githubRepo = config.kind === 'github' ? ghRepoArg(config.repo) : undefined;
  return { exec: checkGuardExec(exec, marker, () => guard, command, () => githubRepo), options: { ...factoryForgeOptions(root), ...(entry ? { entry } : {}) } };
}

/** What a read-only factory command (check, board) works on: the checkout, its base, the resolved forge config and the forge on the read guard. */
export interface ReadForge {
  root: string;
  base: string;
  /** origin/<base>; null when it cannot be read (fetchBase warned). */
  baseSha: string | null;
  config: ResolvedForgeConfig;
  /** The base branch's committed `.copilot/omg.jsonc` the config was resolved with (baseLayer; undefined when not read). */
  baseConfig: unknown;
  forge: Forge;
  /** The guarded Exec the forge runs on (forgeReadExec). */
  exec: Exec;
}

/**
 * Resolve the checkout, base and forge config (`--source` / `--limit` as
 * working-tree intake keys) and build the forge on the read guard. Every
 * command passes checkGuardExec; `marker` is check's confirmed `--mark`
 * (the board passes none). Throws CheckUsageError / CheckIncompatibleError.
 */
export function openReadForge(o: Pick<FactoryCheckOptions, 'source' | 'limit'>, deps: FactoryCheckDeps, warnings: string[], command: string, marker?: () => string | undefined): ReadForge {
  // The git reads before the forge config is known; az runs only through forgeReadExec below.
  const pre = checkGuardExec(deps.exec, marker, undefined, command);
  const top = git(pre, process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new CheckUsageError(`${command} must run inside a git repository`);
  const root = top.out;
  const origin = git(pre, root, ['remote', 'get-url', 'origin']);
  // No origin: only the local (offline) forge can work; resolveForgeConfig decides once the layers are read.
  const originUrl = origin.ok && origin.out ? origin.out : undefined;
  const base = deps.base(root);
  if (!isPlainBranchName(base)) throw new CheckUsageError(`base ${JSON.stringify(base)} is not a branch name`);
  let baseSha = originUrl ? fetchBaseUnlessBusy(pre, root, base, warnings, deps.owner) : localBase(pre, root, base, warnings);
  const trustedUser = deps.trustedUser();

  let config: ResolvedForgeConfig;
  const baseConfig = baseLayer(pre, root, base, baseSha, trustedUser, warnings);
  const stateDir = factoryForgeOptions(root).stateDir!;
  try {
    const loaded = resolveForgeConfig(trustedUser, baseConfig, withFlags(deps.projectConfig(root), o), originUrl, { root, stateDir });
    config = loaded.config;
    warnings.push(...loaded.warnings);
  } catch (error) {
    if (!(error instanceof ForgeConfigError)) throw error;
    if (error.code === 'invalid') throw new CheckUsageError(error.message);
    throw new CheckIncompatibleError(error.code === 'forge-unsupported' ? unsupportedForge(error.message) : `${error.code}: ${error.message}`);
  }
  // The local forge's base is the local branch (the human merges there; the engine syncs its mirror from it).
  if (config.kind === 'local' && originUrl) baseSha = localBase(pre, root, base, warnings);
  // F20: without its base the local forge reads no committed item or config, so nothing could ever be checked.
  if (config.kind === 'local' && !baseSha) throw new CheckUsageError(missingLocalBase(base));
  try {
    const read = forgeReadExec(deps.exec, config, root, deps.resolveAz, marker, command);
    return { root, base, baseSha, config, baseConfig, forge: deps.createForge(read.exec, root, config, readForgeOptions(config, root, read.options, base, baseSha)), exec: read.exec };
  } catch (error) {
    throw new CheckIncompatibleError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The options a read-only command (check, board, poll, `run --next`) builds
 * its forge with: the local forge also needs the runtime root, reads the
 * working tree (an uncommitted item is listed, never runnable) and reads
 * committed items at `baseSha`, the local base branch `base` (only a local
 * PR into `base` closes an item). `run --next` passes workingTree: false: a
 * working-tree item is never runnable, nor does it satisfy a dependency.
 */
export function readForgeOptions(config: ResolvedForgeConfig, root: string, options: AzureDevOpsForgeOptions, base: string, baseSha: string | null, workingTree = true): AzureDevOpsForgeOptions {
  if (config.kind !== 'local') return options;
  return { ...options, local: { omgRoot: getOmcRoot(root), workingTree, base, baseSha: () => baseSha ?? undefined } };
}

/** F20: the local forge's base branch is missing (exit 2 in check, board, poll and `run --next`). */
export function missingLocalBase(base: string): string {
  return `the base branch ${base} does not exist in this repository, so no committed backlog item or config can be read; set ship.base in .copilot/omg.jsonc to the branch you merge into (omg factory setup --forge local writes it)`;
}

/**
 * The stderr line of a factory command's error: `Error: <message>`, except that "no usable forge" starts with
 * `unsupported forge:` in every command, as `omg factory run` prints it (F28).
 */
export function factoryErrorLine(message: string): string {
  return message.startsWith('unsupported forge:') ? message : `Error: ${message}`;
}

export { unsupportedForge };

/** The local branch `<base>` (the local forge's base; no fetch); null with a warning when it does not exist. */
export function localBase(exec: Exec, root: string, base: string, warnings: string[]): string | null {
  const sha = git(exec, root, ['rev-parse', '--verify', `refs/heads/${base}`]);
  if (sha.ok && /^[0-9a-f]{40}$/.test(sha.out)) return sha.out;
  warnings.push(`omg factory: the base branch ${base} does not exist in this repository; committed backlog items and the committed config cannot be read`);
  return null;
}

/** The forge's limitations (the local forge's offline lines), or none. */
export function forgeLimitations(forge: Forge, base: string): string[] {
  if (forge.kind === 'local') return localForgeLimitations(base);
  return forge.limitations?.() ?? [];
}

/** Run one check; returns the exit code. Errors other than usage / incompatible propagate (exit 1 at the CLI). */
export async function runFactoryCheck(o: FactoryCheckOptions, deps: FactoryCheckDeps): Promise<number> {
  const ids = o.ids.map(parseItemId);
  const parent = o.parent === undefined ? undefined : parseItemId(o.parent);
  if (parent !== undefined && ids.length > 0) throw new CheckUsageError('--parent takes no item ids: it checks the spec\'s children');
  if (parent !== undefined && o.source !== undefined) throw new CheckUsageError('--parent and --source are exclusive');
  if (parent !== undefined && o.limit !== undefined) throw new CheckUsageError('--limit applies to an intake source; --parent checks every child of the spec');
  const warnings: string[] = [];
  let marker: string | undefined;
  const { root, base, baseSha, config, baseConfig, forge, exec } = openReadForge(o, deps, warnings, 'omg factory check', () => marker);
  let prepareChecks: string[];
  try {
    // The same detection prepare runs: repository markers from the base commit, the tool packages from the root's node_modules.
    const baseHas = baseSha ? baseFileExists(exec, root, baseSha) : () => false;
    prepareChecks = describePrepareChecks(trustedPrepareChecks(deps.trustedUser(), baseConfig), baseHas, (p) => existsSync(join(root, p)));
  } catch (error) {
    throw new CheckUsageError(error instanceof Error ? error.message : String(error));
  }

  const source = config.intake.source;
  if (ids.length === 0 && parent === undefined && !source) throw new CheckUsageError('no item ids and no intake source: pass ids, --parent <spec>, --source <spec>, or set factory.intake.source');
  if (o.mark && !o.yes && (o.json || !deps.isTTY())) throw new CheckUsageError('--mark needs --yes without an interactive terminal (or with --json)');
  const wanted = ids.length > 0 ? ids : parent !== undefined ? forge.tracker.viewItem(parent).children : forge.tracker.queryItems(source!, config.intake.limit);
  const items = checkItems(forge, wanted, checkEnvFor(exec, root, config, base, baseSha));

  const m: CheckJson['mark'] = { marker: config.intake.marker, requested: Boolean(o.mark), confirmed: false, marked: [], alreadyMarked: [], failed: [] };
  if (o.mark) {
    const runnable = items.filter((r) => r.bucket === 'runnable');
    // Re-read the labels through the tracker: an item that already carries the marker is left alone.
    const todo: number[] = [];
    // Labels and ADO tags compare case-insensitively, so a differently cased marker is never added twice.
    const marked = (labels: string[]) => labels.some((l) => l.toLowerCase() === m.marker.toLowerCase());
    for (const r of runnable) (marked(forge.tracker.viewItem(r.id).labels) ? m.alreadyMarked : todo).push(r.id);
    if (todo.length > 0 && forge.kind === 'github') requireLabel(exec, root, m.marker, config.repo.url);
    if (todo.length > 0) {
      m.confirmed = Boolean(o.yes) || await deps.confirm(`Add ${forge.kind === 'github' ? 'label' : 'tag'} ${m.marker} to ${todo.length} runnable item${todo.length > 1 ? 's' : ''} (${todo.map((id) => `#${id}`).join(', ')})?`);
      if (m.confirmed) {
        marker = m.marker;
        try {
          for (const id of todo) {
            const res = forge.tracker.addMarker(id, m.marker);
            if (res.ok) m.marked.push(id);
            else m.failed.push({ id, error: plainText(res.stderr.trim()) });
          }
        } finally {
          marker = undefined;
        }
      }
    }
  }

  const ok = m.failed.length === 0 && !items.some((r) => r.reasons[0] === 'read-failed');
  // Skipped backlog files (the local tracker), after every read.
  warnings.push(...(forge.tracker.warnings?.() ?? []));
  const limitations = forgeLimitations(forge, base);
  // The verdict a run parks on before its first lane (gate-definition-unknown).
  let gate: string | undefined;
  if (config.kind === 'local') {
    const argv = config.local?.gate;
    const unresolved = argv && argv.length > 0 ? gateDefinitionSources(argv).unresolved : undefined;
    gate = !argv || argv.length === 0 ? 'not set' : unresolved ? `unresolved (${unresolved})` : 'ok';
  }
  if (o.json) {
    const json: CheckJson = {
      schemaVersion: CHECK_JSON_SCHEMA_VERSION,
      ok,
      forge: config.kind,
      limitations,
      prepareChecks,
      ...(gate ? { gate } : {}),
      repo: config.repo.url,
      source: ids.length > 0 || parent !== undefined || !source ? null : { ...source },
      counts: Object.fromEntries(BUCKET_ORDER.map((b) => [b, items.filter((r) => r.bucket === b).length])),
      items,
      mark: m,
      warnings: warnings.map(plainText),
    };
    deps.out(JSON.stringify(json, null, 2));
  } else {
    for (const w of warnings) deps.err(chalk.yellow(plainText(w)));
    for (const l of limitations) deps.out(chalk.gray(l));
    deps.out(chalk.gray(`prepare checks: ${prepareChecks.length > 0 ? prepareChecks.join('; ') : 'none'}`));
    if (gate) deps.out((gate.startsWith('unresolved') ? chalk.yellow : chalk.gray)(`gate: ${plainText(gate)}`));
    deps.out(renderCheckTable(items));
    if (o.mark) {
      if (m.marked.length > 0) deps.out(chalk.green(`marked ${m.marker}: ${m.marked.map((id) => `#${id}`).join(', ')}`));
      if (m.alreadyMarked.length > 0) deps.out(`already marked: ${m.alreadyMarked.map((id) => `#${id}`).join(', ')}`);
      for (const f of m.failed) deps.err(chalk.red(`#${f.id}: could not add ${m.marker}: ${f.error}`));
      if (m.marked.length === 0 && m.failed.length === 0) deps.out('nothing marked');
    }
  }
  return ok ? 0 : EXIT_CHECK_FAILED;
}
