/**
 * `omg factory check [<id>...] [--source <spec>] [--limit n] [--json] [--mark [--yes]]`
 * (factory forges design §5): bucket intake items as runnable, needs-plan
 * or blocked. Read-only unless `--mark`, which adds `factory.intake.marker`
 * (a GitHub label or an ADO tag) to the runnable items only, after a TTY
 * confirmation or `--yes`, through `forge.tracker.addMarker`.
 *
 * Every command passes checkGuardExec: the gh reads the tracker builds, the
 * open-PR lookup on `factory/issue-<n>`, a dependency PR's state, the marker
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
import type { Forge, ForgeFactory, ResolvedForgeConfig } from '../../forge/types.js';
import { resolveAzEntry, type AzEntry } from '../../forge/ado/az-binary.js';
import { adoGuardContext, defaultAzBinaryDeps, type AzureDevOpsForgeOptions } from '../../forge/ado/index.js';
import { factoryForgeOptions } from '../run/forge-roots.js';
import { BASE_CONFIG_PATH, isPlainBranchName, readBaseFile, resolveShipConfig } from '../../ship/config.js';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { isAdoCommand, runGuardedAdo, type AdoGuardContext } from '../../forge/ado/guard.js';
import { assertFactoryCommand, FactorySafetyError } from '../run/exec.js';
import { readFactoryState } from '../run/state.js';
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

function checkGh(a: string[], marker: string | undefined): boolean {
  const [group, sub, ...r] = a;
  if (group === 'issue' && sub === 'view') return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--json' && JSON_FIELDS.test(r[2]);
  if (group === 'issue' && sub === 'list') {
    return r.length === 8 && (r[0] === '--label' || r[0] === '--milestone') && VALUE(r[1]) && r[2] === '--state' && r[3] === 'open'
      && r[4] === '--json' && r[5] === 'number' && r[6] === '--limit' && NUMBER.test(r[7]);
  }
  if (group === 'issue' && sub === 'edit') return marker !== undefined && same(r.slice(1), ['--add-label', marker]) && NUMBER.test(r[0] ?? '');
  if (group === 'pr' && sub === 'list') return r.length === 4 && r[0] === '--head' && FACTORY_ISSUE_BRANCH.test(r[1]) && r[2] === '--json' && JSON_FIELDS.test(r[3]);
  // A dependency that is a PR: its state.
  if (group === 'pr' && sub === 'view') return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--json' && JSON_FIELDS.test(r[2]);
  // `--mark` first checks that the marker label exists (check never creates labels).
  if (group === 'label' && sub === 'list') return r.length === 6 && r[0] === '--search' && VALUE(r[1]) && r[2] === '--json' && r[3] === 'name' && r[4] === '--limit' && NUMBER.test(r[5]);
  return false;
}

const CHECK_GIT = new Set(['rev-parse', 'remote', 'fetch', 'cat-file', 'show', 'ls-remote']);

/**
 * The `omg factory check` guard. `marker` is set only after `--mark` was
 * confirmed: then, and only then, `gh issue edit <n> --add-label <marker>`
 * and az writes pass (the wit.wiql.POST query is a read and passes without it).
 */
export function checkGuardExec(exec: Exec, marker?: () => string | undefined, ado: () => AdoGuardContext | undefined = () => undefined): Exec {
  return (cmd, args, opts) => {
    const file = cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
    const refuse = (why: string): never => { throw new FactorySafetyError(`omg factory check refuses \`${file} ${args.join(' ')}\`: ${why}`); };
    const mark = marker?.();
    if (!args.every((x) => typeof x === 'string')) refuse('non-string argument');
    if (file === 'gh') {
      if (opts?.env !== undefined) refuse('gh takes no environment');
      if (!checkGh(args, mark)) refuse('not one of the command shapes omg factory check runs');
    } else if (file === 'git') {
      const read = CHECK_GIT.has(args[0]) && (args[0] !== 'show' || (args.length === 2 && /^[0-9a-f]{40}:/.test(args[1])));
      if (!read) refuse('not one of the read-only git shapes omg factory check runs');
      // The factory guard: ship's read shapes plus `ls-remote origin refs/heads/factory/<name>`.
      assertFactoryCommand(cmd, args, [], opts?.env);
    } else if (isAdoCommand(cmd)) {
      // Reads: a GET, or the WIQL query the area-tag and board-column sources POST (wit.wiql.POST; the guard validates its body).
      const flag = (f: string) => { const at = args.indexOf(f); return at >= 0 ? args[at + 1] : undefined; };
      const method = flag('--http-method')?.toUpperCase();
      const wiql = method === 'POST' && flag('--area')?.toLowerCase() === 'wit' && flag('--resource')?.toLowerCase() === 'wiql';
      if (mark === undefined && method !== undefined && method !== 'GET' && !wiql) refuse('only reads run without a confirmed --mark');
      // The factory guard's path: az gets the guard's own copy of a validated --in-file body, never the caller's file.
      return runGuardedAdo(exec, cmd, args, opts, ado(), 'factory', (why) => new FactorySafetyError(`omg factory check refuses \`${file} ${args.join(' ')}\`: ${why}`));
    } else {
      refuse('not a command omg factory check runs');
    }
    return exec(cmd, args, opts);
  };
}

/** `--source` as a config value (resolveForgeConfig validates it): label:x, milestone:x, wiql-query:<guid>, board-column:team/board/column, area-tag:<area path>#<tag>. */
export function parseSourceSpec(spec: string): Record<string, string> {
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
  throw new CheckUsageError(`--source ${JSON.stringify(spec)} is not label:<name>, milestone:<name>, wiql-query:<guid>, board-column:<team>/<board>/<column> or area-tag:<area path>#<tag>`);
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
}

export interface FactoryCheckOptions {
  ids: string[];
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
export function checkEnvFor(exec: Exec, root: string, config: CheckEnv['config'], base: string, baseSha: string | null): CheckEnv {
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

/** Fetch `origin/<base>` (read-only) and resolve it; null with a warning when it cannot be read. */
function fetchBase(exec: Exec, root: string, base: string, warnings: string[]): string | null {
  const fetched = git(exec, root, ['fetch', 'origin', base]);
  if (!fetched.ok) warnings.push(`omg factory check: git fetch origin ${base} failed (${fetched.err}); using the local origin/${base}`);
  const sha = git(exec, root, ['rev-parse', '--verify', `refs/remotes/origin/${base}`]);
  if (sha.ok && /^[0-9a-f]{40}$/.test(sha.out)) return sha.out;
  warnings.push(`omg factory check: origin/${base} is not available; its committed config is not read and omg-plan links cannot be checked`);
  return null;
}

/** The base branch's committed `.copilot/omg.jsonc`, when the base is in ship.trustedBases (as loadTrustedShipConfig). */
function baseLayer(exec: Exec, root: string, base: string, baseSha: string | null, trustedUser: unknown, warnings: string[]): unknown {
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
function withFlags(project: unknown, o: FactoryCheckOptions): unknown {
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
 * spawns the same entry. GitHub needs neither. `omg factory board` reuses it.
 */
export function forgeReadExec(exec: Exec, config: ResolvedForgeConfig, root: string, resolveAz: (root: string) => AzEntry = defaultResolveAz, marker?: () => string | undefined): { exec: Exec; options: AzureDevOpsForgeOptions } {
  const entry = config.kind === 'azure-devops' ? resolveAz(root) : undefined;
  const guard = entry ? adoGuardContext(config, entry) : undefined;
  return { exec: checkGuardExec(exec, marker, () => guard), options: { ...factoryForgeOptions(root), ...(entry ? { entry } : {}) } };
}

/** Run one check; returns the exit code. Errors other than usage / incompatible propagate (exit 1 at the CLI). */
export async function runFactoryCheck(o: FactoryCheckOptions, deps: FactoryCheckDeps): Promise<number> {
  const ids = o.ids.map(parseItemId);
  const warnings: string[] = [];
  let marker: string | undefined;
  // The git reads before the forge config is known; az runs only through forgeReadExec below.
  let exec = checkGuardExec(deps.exec, () => marker);

  const top = git(exec, process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new CheckUsageError('omg factory check must run inside a git repository');
  const root = top.out;
  const origin = git(exec, root, ['remote', 'get-url', 'origin']);
  if (!origin.ok) throw new CheckIncompatibleError(`git remote get-url origin failed: ${origin.err}`);
  const base = deps.base(root);
  if (!isPlainBranchName(base)) throw new CheckUsageError(`base ${JSON.stringify(base)} is not a branch name`);
  const baseSha = fetchBase(exec, root, base, warnings);
  const trustedUser = deps.trustedUser();

  let config: ResolvedForgeConfig;
  try {
    const loaded = resolveForgeConfig(trustedUser, baseLayer(exec, root, base, baseSha, trustedUser, warnings), withFlags(deps.projectConfig(root), o), origin.out);
    config = loaded.config;
    warnings.push(...loaded.warnings);
  } catch (error) {
    if (!(error instanceof ForgeConfigError)) throw error;
    throw error.code === 'invalid' ? new CheckUsageError(error.message) : new CheckIncompatibleError(`${error.code}: ${error.message}`);
  }
  let forge: Forge;
  try {
    const read = forgeReadExec(deps.exec, config, root, deps.resolveAz, () => marker);
    exec = read.exec;
    forge = deps.createForge(exec, root, config, read.options);
  } catch (error) {
    throw new CheckIncompatibleError(error instanceof Error ? error.message : String(error));
  }

  const source = config.intake.source;
  if (ids.length === 0 && !source) throw new CheckUsageError('no item ids and no intake source: pass ids, --source <spec>, or set factory.intake.source');
  if (o.mark && !o.yes && (o.json || !deps.isTTY())) throw new CheckUsageError('--mark needs --yes without an interactive terminal (or with --json)');
  const wanted = ids.length > 0 ? ids : forge.tracker.queryItems(source!, config.intake.limit);
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
  if (o.json) {
    const json: CheckJson = {
      schemaVersion: CHECK_JSON_SCHEMA_VERSION,
      ok,
      forge: config.kind,
      repo: config.repo.url,
      source: ids.length > 0 || !source ? null : { ...source },
      counts: Object.fromEntries(BUCKET_ORDER.map((b) => [b, items.filter((r) => r.bucket === b).length])),
      items,
      mark: m,
      warnings: warnings.map(plainText),
    };
    deps.out(JSON.stringify(json, null, 2));
  } else {
    for (const w of warnings) deps.err(chalk.yellow(plainText(w)));
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
