/**
 * `omg factory triage [ids... | --parent <spec> | --source <spec>] [--limit n] [--apply] [--json]`:
 * propose the priority and needs-split / needs-plan labels each intake item
 * should carry (rules.ts), from the same reads `omg factory check` makes.
 *
 * Without `--apply` nothing is written: every call goes through check's
 * read-only guard, so a write shape is refused before it reaches gh or az.
 * `--apply` executes exactly the plan that was printed (the rows are computed
 * once and never re-derived). Its writes pass the factory guard with a
 * TrackerWriteContext whose label allowlist is the plan's own label names
 * (GitHub: src/factory/triage/guard.ts; Azure DevOps: the tracker tag and
 * priority PATCH; the local forge edits backlog files in the working tree,
 * which the human then commits on the base). A label the GitHub repository
 * lacks is never created: its rows are skipped in the plan, in both modes.
 *
 * Exit codes: 0 done (whatever the plan), 1 a read failed or a write failed,
 * 2 usage, 5 incompatible (as check).
 */

import chalk from 'chalk';
import type { Forge, ForgeTriageChange } from '../../forge/types.js';
import { factoryForgeOptions } from '../run/forge-roots.js';
import { adoGuardContext } from '../../forge/ado/index.js';
import { isAdoCommand, type AdoGuardContext } from '../../forge/ado/guard.js';
import type { Exec } from '../../ship/exec.js';
import { ghRepoArg } from '../../forge/github/gh.js';
import { triageLabelListGh } from './guard.js';
import {
  checkEnvFor, checkGuardExec, CheckIncompatibleError, CheckUsageError, defaultResolveAz, EXIT_CHECK_FAILED, forgeLimitations, openReadForge, parseItemId, readForgeOptions,
  type FactoryCheckDeps, type FactoryCheckOptions,
} from '../check/cli.js';
import { checkItems, plainText } from '../check/score.js';
import { factoryGuardExec, FactorySafetyError, type TrackerWriteContext } from '../run/exec.js';
import { planItem, resolveTriageConfig, TriageConfigError, type TriageConfig, type TriagePlanRow } from './rules.js';

/** Bumped on any change to the `--json` shape (src/factory/__tests__/triage-github.test.ts pins it). */
export const TRIAGE_JSON_SCHEMA_VERSION = 1;

export interface FactoryTriageOptions extends Pick<FactoryCheckOptions, 'ids' | 'parent' | 'source' | 'limit' | 'json'> {
  apply?: boolean;
}

export interface TriageItemJson extends TriagePlanRow {
  /** `--apply` only: what the tracker answered for a `change` row. */
  result?: { ok: boolean; detail: string };
}

export interface TriageJson {
  schemaVersion: number;
  ok: boolean;
  mode: 'dry-run' | 'apply';
  forge: string;
  repo: string;
  source: Record<string, unknown> | null;
  config: TriageConfig;
  counts: { change: number; unchanged: number; skip: number; applied: number; failed: number };
  items: TriageItemJson[];
  /** Labels GitHub's repository lacks (rows needing them are skipped as `label-missing:<name>`). */
  missingLabels: string[];
  notes: string[];
  warnings: string[];
}

/**
 * triage's Exec: every call is check's read guard; while `writing()` the
 * label-only `gh issue edit` (src/factory/triage/guard.ts) and, on Azure
 * DevOps, the work item PATCH go through the factory guard with the plan's
 * TrackerWriteContext. Nothing else writes.
 */
export function triageGuardExec(exec: Exec, writes: () => TrackerWriteContext | undefined, writing: () => boolean, ado: () => AdoGuardContext | undefined = () => undefined): Exec {
  const reads = checkGuardExec(exec, undefined, ado, 'omg factory triage');
  const tracker = factoryGuardExec(exec, () => [], ado, writes);
  return (cmd, args, opts) => {
    if (!writing()) return reads(cmd, args, opts);
    if (isAdoCommand(cmd)) {
      const flag = (f: string) => { const at = args.indexOf(f); return at >= 0 ? args[at + 1]?.toLowerCase() : undefined; };
      const patch = flag('--area') === 'wit' && flag('--resource') === 'workitems' && flag('--http-method') === 'patch';
      return patch ? tracker(cmd, args, opts) : reads(cmd, args, opts);
    }
    const file = cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
    if (file === 'gh' && args[0] === 'issue' && args[1] === 'edit') return tracker(cmd, args, opts);
    return reads(cmd, args, opts);
  };
}

/** The labels of the repository (GitHub), by `gh label list --search` (a read; triage never creates a label). */
function missingGithubLabels(exec: Exec, raw: Exec, root: string, repo: string, names: readonly string[]): string[] {
  const missing: string[] = [];
  for (const name of names) {
    const args = ['label', 'list', '--repo', repo, '--search', name, '--json', 'name', '--limit', '100'];
    // Triage's own exact shape (names the configured repository); anything else goes through check's read guard.
    const res = triageLabelListGh(args, repo) ? raw('gh', args, { cwd: root }) : exec('gh', args, { cwd: root });
    if (res.status !== 0) throw new Error(`gh label list failed (exit ${res.status}): ${res.stderr.trim().split('\n')[0]}`);
    let list: unknown;
    try { list = JSON.parse(res.stdout); } catch { throw new Error('gh label list returned no JSON'); }
    const found = Array.isArray(list) && list.some((l) => typeof (l as { name?: unknown })?.name === 'string' && (l as { name: string }).name.toLowerCase() === name.toLowerCase());
    if (!found) missing.push(name);
  }
  return missing;
}

export function renderTriageTable(items: readonly TriageItemJson[]): string {
  if (items.length === 0) return 'no items to triage';
  const cell = (r: TriageItemJson): string[] => [
    `#${r.id}`, r.action, r.current.labels.join(',') || '-',
    r.add.map((l) => `+${l}`).concat(r.remove.map((l) => `-${l}`), r.priority === null ? [] : [`priority=${r.priority}`]).join(' ') || (r.skipReason ?? '-'),
  ];
  const rows = items.map(cell);
  const head = ['ID', 'ACTION', 'CURRENT', 'PROPOSED'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const pad = (row: string[]) => row.map((c, i) => c.padEnd(widths[i])).join('  ');
  const lines = [chalk.bold(`${pad(head)}  TITLE`)];
  items.forEach((r, i) => {
    const color = r.action === 'change' ? chalk.green : r.action === 'skip' ? chalk.gray : (s: string) => s;
    lines.push(`${color(pad(rows[i]))}  ${r.title.slice(0, 60)}`);
    for (const why of r.why) lines.push(chalk.gray(`${' '.repeat(widths[0] + 2)}${plainText(why)}`));
    if (r.result) lines.push((r.result.ok ? chalk.green : chalk.red)(`${' '.repeat(widths[0] + 2)}${r.result.ok ? 'done' : 'FAILED'}: ${plainText(r.result.detail)}`));
  });
  const n = (a: string) => items.filter((r) => r.action === a).length;
  lines.push(`${n('change')} to change, ${n('unchanged')} unchanged, ${n('skip')} skipped`);
  return lines.join('\n');
}

/** Run one triage; returns the exit code. Usage and incompatible errors propagate (exit 2 / 5 at the CLI). */
export async function runFactoryTriage(o: FactoryTriageOptions, deps: FactoryCheckDeps): Promise<number> {
  const ids = o.ids.map(parseItemId);
  const parent = o.parent === undefined ? undefined : parseItemId(o.parent);
  if (parent !== undefined && ids.length > 0) throw new CheckUsageError('--parent takes no item ids: it triages the spec\'s children');
  if (parent !== undefined && o.source !== undefined) throw new CheckUsageError('--parent and --source are exclusive');
  if (parent !== undefined && o.limit !== undefined) throw new CheckUsageError('--limit applies to an intake source; --parent triages every child of the spec');
  const warnings: string[] = [];
  const command = 'omg factory triage';
  const { root, base, baseSha, config, baseConfig, forge, exec } = openReadForge(o, deps, warnings, command);
  let cfg: TriageConfig;
  try {
    cfg = resolveTriageConfig([deps.trustedUser(), baseConfig]);
  } catch (error) {
    if (error instanceof TriageConfigError) throw new CheckUsageError(error.message);
    throw error;
  }
  const source = config.intake.source;
  if (ids.length === 0 && parent === undefined && !source) throw new CheckUsageError('no item ids and no intake source: pass ids, --parent <spec>, --source <spec>, or set factory.intake.source');
  if (!forge.tracker.setTriage) throw new CheckIncompatibleError(`the ${config.kind} tracker cannot apply triage`);

  const wanted = ids.length > 0 ? ids : parent !== undefined ? forge.tracker.viewItem(parent).children : forge.tracker.queryItems(source!, config.intake.limit);
  const results = checkItems(forge, wanted, checkEnvFor(exec, root, config, base, baseSha)).sort((a, b) => a.id - b.id);
  let rows: TriagePlanRow[] = results.map((r): TriagePlanRow => {
    try {
      return planItem(forge.tracker.viewItem(r.id), r, forge.kind, cfg);
    } catch (error) {
      return { id: r.id, title: r.title, url: r.url, action: 'skip', skipReason: r.reasons[0] ?? 'read-failed', bucket: r.bucket, reasons: r.reasons, current: { labels: [], priority: r.priority }, add: [], remove: [], priority: null, why: [plainText(error instanceof Error ? error.message : String(error))] };
    }
  });

  // GitHub never creates a label: rows that would add a missing one are skipped, in the dry run too (plan === apply).
  let missingLabels: string[] = [];
  if (forge.kind === 'github') {
    const adds = [...new Set(rows.flatMap((r) => (r.action === 'change' ? r.add : [])))];
    try {
      missingLabels = missingGithubLabels(exec, deps.exec, root, ghRepoArg(config.repo), adds);
      for (const name of missingLabels) warnings.push(`label ${name} does not exist in ${config.repo.url}; rows needing it are skipped (omg factory triage never creates labels)`);
    } catch (error) {
      throw new CheckIncompatibleError(error instanceof Error ? error.message : String(error));
    }
    rows = rows.map((r) => {
      const lacks = r.add.find((l) => missingLabels.includes(l));
      return lacks === undefined ? r : { ...r, action: 'skip', skipReason: `label-missing:${lacks}`, add: [], remove: [], priority: null, why: [`label ${lacks} does not exist in ${config.repo.url}; create it (omg factory triage never creates labels)`] };
    });
  }

  const items: TriageItemJson[] = rows.map((r) => ({ ...r }));
  const apply = Boolean(o.apply);
  const notes: string[] = [];
  if (apply) {
    const changing = items.filter((r) => r.action === 'change');
    const names = [...new Set(changing.flatMap((r) => [...r.add, ...r.remove]))];
    const ctx: TrackerWriteContext = { repo: config.kind === 'github' ? ghRepoArg(config.repo) : config.repo.url, bodyDir: '', labels: names, purpose: 'triage' };
    let writing = false;
    const entry = config.kind === 'azure-devops' ? (deps.resolveAz ?? defaultResolveAz)(root) : undefined;
    const adoGuard = entry ? adoGuardContext(config, entry) : undefined;
    const wexec = triageGuardExec(deps.exec, () => ctx, () => writing, () => adoGuard);
    let writer: Forge['tracker'];
    try {
      writer = deps.createForge(wexec, root, config, readForgeOptions(config, root, { ...factoryForgeOptions(root), ...(entry ? { entry } : {}) }, base, baseSha)).tracker;
    } catch (error) {
      throw new CheckIncompatibleError(error instanceof Error ? error.message : String(error));
    }
    if (!writer.setTriage) throw new CheckIncompatibleError(`the ${config.kind} tracker cannot apply triage`);
    writing = true;
    try {
      for (const r of changing) {
        const change: ForgeTriageChange = { add: r.add, remove: r.remove, ...(r.priority === null ? {} : { priority: r.priority }) };
        try {
          r.result = writer.setTriage(r.id, change);
        } catch (error) {
          if (error instanceof FactorySafetyError) throw error;
          r.result = { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
      }
    } finally {
      writing = false;
    }
    if (config.kind === 'local' && changing.some((r) => r.result?.ok)) notes.push(`the local backlog files were edited in the working tree: commit them on ${base} (items are read from the base commit)`);
  }

  warnings.push(...(forge.tracker.warnings?.() ?? []));
  const applied = items.filter((r) => r.result?.ok).length;
  const failed = items.filter((r) => r.result && !r.result.ok).length;
  const ok = failed === 0 && !items.some((r) => r.skipReason === 'read-failed');
  const limitations = forgeLimitations(forge, base);
  if (o.json) {
    const json: TriageJson = {
      schemaVersion: TRIAGE_JSON_SCHEMA_VERSION,
      ok,
      mode: apply ? 'apply' : 'dry-run',
      forge: config.kind,
      repo: config.repo.url,
      source: ids.length > 0 || parent !== undefined || !source ? null : { ...source },
      config: cfg,
      counts: { change: items.filter((r) => r.action === 'change').length, unchanged: items.filter((r) => r.action === 'unchanged').length, skip: items.filter((r) => r.action === 'skip').length, applied, failed },
      items: items.map((r) => ({ ...r, title: plainText(r.title), why: r.why.map(plainText) })),
      missingLabels,
      notes,
      warnings: warnings.map(plainText),
    };
    deps.out(JSON.stringify(json, null, 2));
  } else {
    for (const w of warnings) deps.err(chalk.yellow(plainText(w)));
    for (const l of limitations) deps.out(chalk.gray(l));
    deps.out(chalk.gray(apply ? 'apply: the plan below is written' : 'dry run: nothing is written; --apply recomputes the plan from fresh reads and writes the plan it prints'));
    deps.out(renderTriageTable(items));
    for (const n of notes) deps.out(chalk.yellow(n));
  }
  return ok ? 0 : EXIT_CHECK_FAILED;
}
