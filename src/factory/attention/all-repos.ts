/**
 * `omg factory attention --all-repos`: the attention view of every
 * repository this host's engine ledger knows (run/ledger-roots.ts), one
 * collectAttention per root with that repository's own trust checks (its
 * states against ITS seals and ledger records), grouped by repository.
 * Read-only and local, as the single-repository view: no network, no forge,
 * no write and no lock in any repository or in the ledger.
 *
 * The `omg` commands are repository-relative and `omg` has no global
 * working-directory option, so a row of another repository prints them
 * under "in <root>:" and `--json` gives every command a `cwd`. A root that
 * cannot be shown safely in a command for this host's shell (rootWord) is
 * named in prose only. `git -C <root>` merge commands already carry the root.
 */

import chalk from 'chalk';
import { basename } from 'path';
import { plainText } from '../check/score.js';
import { canonicalPath } from '../run/claims.js';
import type { LedgerRoot, SkippedRoot } from '../run/ledger-roots.js';
import { ATTENTION_GROUPS, GROUP_TITLES, rootWord, type AttentionGroup } from './actions.js';
import { attentionJson, collectAttention, type AttentionData, type CollectAttentionOptions } from './collect.js';
import { itemLines } from './render.js';
import { withKnownOmcRoots } from '../../lib/worktree-paths.js';

/** A root in a header: plain, and cut in the middle to this many characters. */
export const ROOT_HEADER_MAX = 72;

export interface RepoAttention {
  id: string;
  root: string;
  /** The repository the command runs in (its commands need no cwd). */
  current: boolean;
  recorded: boolean;
  data: AttentionData;
  /** Collection time (--verbose). */
  ms: number;
}

export interface AllReposAttention {
  repos: RepoAttention[];
  skipped: SkippedRoot[];
  warnings: string[];
  generatedAt: string;
  byGroup: Record<AttentionGroup, number>;
  readFailed: boolean;
  items: number;
  engines: number;
  /** Discovery time (--verbose). */
  discoveryMs: number;
}

const GROUP_ORDER = new Map(ATTENTION_GROUPS.map((g, i) => [g, i]));

/** A root for a header line: plainText, cut in the middle so both ends stay readable. */
export function rootHeader(root: string, max = ROOT_HEADER_MAX): string {
  const p = [...plainText(root)];
  if (p.length <= max) return p.join('');
  const half = Math.floor((max - 1) / 2);
  return `${p.slice(0, half).join('')}…${p.slice(p.length - (max - 1 - half)).join('')}`;
}

/** A repository taking longer than this to collect gets a note in --verbose (no kill: the command is one-shot). */
export const SLOW_REPO_MS = 1_000;

/**
 * A repository's header line: labelled, its folder name quoted (JSON string
 * escapes) and both name and path plain and cut, so a directory name cannot
 * pass for a command or a run row (the line never starts with `$`, `#` or `==`).
 */
export function repoHeader(root: string, tags = ''): string {
  const name = JSON.stringify(plainText(basename(root)).slice(0, 60));
  return `repository: ${name}  ${rootHeader(root)}${tags ? `  (${tags})` : ''}`;
}

/** Most urgent group first, then oldest item, then by path; a repository with nothing to do goes last. */
function repoRank(r: RepoAttention): [number, number] {
  const first = r.data.items[0];
  return first ? [GROUP_ORDER.get(first.group)!, first.at] : [ATTENTION_GROUPS.length, 0];
}

export interface CollectAllOptions extends Omit<CollectAttentionOptions, 'limits'> {
  /** The cwd's repository top level, or null outside one. */
  current: string | null;
  limits?: (root: string) => CollectAttentionOptions['limits'];
  platform?: NodeJS.Platform;
  clock?: () => number;
}

export function collectAllRepos(roots: readonly LedgerRoot[], skipped: SkippedRoot[], warnings: string[], o: CollectAllOptions, discoveryMs = 0): AllReposAttention {
  const platform = o.platform ?? process.platform;
  const clock = o.clock ?? Date.now;
  const here = o.current === null ? null : canonicalPath(o.current, platform);
  const repos: RepoAttention[] = [];
  for (const r of roots) {
    const t0 = clock();
    let data: AttentionData;
    try {
      // A root discovery validated carries its state root: no git runs in it.
      const collect = (): AttentionData => collectAttention(r.root, { ...o, limits: o.limits?.(r.root) ?? null });
      data = r.stateRoot ? withKnownOmcRoots(new Map([[r.root, r.stateRoot]]), collect) : collect();
    } catch (error) {
      // One repository that cannot be read is a warning and a failed read, never the end of the others.
      data = {
        schemaVersion: 1, repo: r.root, forge: null, generatedAt: new Date((o.now ?? Date.now)()).toISOString(),
        summary: { byGroup: Object.fromEntries(ATTENTION_GROUPS.map((g) => [g, 0])) as Record<AttentionGroup, number>, engines: { live: 0, runs: [] } },
        items: [], warnings: [`the repository's factory state could not be read (${error instanceof Error ? plainText(error.name).slice(0, 40) : 'error'}); run omg factory attention in it for the details`], readFailed: true,
      };
    }
    repos.push({ id: r.id, root: r.root, current: here !== null && canonicalPath(r.root, platform) === here, recorded: r.recorded, data, ms: clock() - t0 });
  }
  repos.sort((a, b) => {
    const [ga, ta] = repoRank(a);
    const [gb, tb] = repoRank(b);
    return ga - gb || ta - tb || a.root.localeCompare(b.root);
  });
  const byGroup = Object.fromEntries(ATTENTION_GROUPS.map((g) => [g, repos.reduce((n, r) => n + r.data.summary.byGroup[g], 0)])) as Record<AttentionGroup, number>;
  return {
    repos, skipped, warnings, generatedAt: new Date((o.now ?? Date.now)()).toISOString(), byGroup,
    readFailed: repos.some((r) => r.data.readFailed),
    items: repos.reduce((n, r) => n + r.data.items.length, 0),
    engines: repos.reduce((n, r) => n + r.data.summary.engines.live, 0),
    discoveryMs,
  };
}

/** The `--all-repos --json` shape: each repository's attentionJson body, with a `cwd` on every command. */
export function allReposJson(d: AllReposAttention): Record<string, unknown> {
  return {
    schemaVersion: 1,
    allRepos: true,
    generatedAt: d.generatedAt,
    summary: { byGroup: d.byGroup, repos: d.repos.length, items: d.items, engines: d.engines, skipped: d.skipped.length },
    repos: d.repos.map((r) => {
      const j = attentionJson(r.data) as { forge: unknown; summary: unknown; items: Array<{ next: Array<Record<string, unknown>> }>; warnings: unknown };
      return {
        id: r.id, root: r.root, current: r.current, recorded: r.recorded, forge: j.forge, summary: j.summary,
        items: j.items.map((i) => ({ ...i, next: i.next.map((n) => ({ ...n, cwd: r.root })) })),
        warnings: j.warnings,
      };
    }),
    skipped: d.skipped,
    warnings: d.warnings,
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const groupCounts = (byGroup: Record<AttentionGroup, number>): string =>
  ATTENTION_GROUPS.filter((g) => byGroup[g] > 0).map((g) => `${GROUP_TITLES[g].toLowerCase()} ${byGroup[g]}`).join(', ');

function skippedLine(skipped: readonly SkippedRoot[], verbose: boolean): string[] {
  if (skipped.length === 0) return [];
  const why = new Map<string, number>();
  for (const s of skipped) why.set(s.reason, (why.get(s.reason) ?? 0) + 1);
  const lines = [chalk.gray(`${plural(skipped.length, 'repository record')} skipped: ${[...why].map(([r, n]) => `${n} ${r}`).join(', ')}${verbose ? '' : ' (--verbose lists them)'}`)];
  // Paths of skipped roots are untrusted for display: only here, plain, cut, and never as a command.
  if (verbose) for (const s of skipped) lines.push(chalk.gray(`  ledger ${s.id}: ${s.reason}${s.root ? `  (recorded root: ${rootHeader(s.root)})` : ''}`));
  return lines;
}

export function renderAllRepos(d: AllReposAttention, o: { verbose?: boolean; platform?: NodeJS.Platform } = {}): string {
  const verbose = Boolean(o.verbose);
  const platform = o.platform ?? process.platform;
  const counts = groupCounts(d.byGroup);
  const lines = [
    chalk.bold('factory attention  all repositories on this host  (local state only)'),
    `${d.repos.length} ${d.repos.length === 1 ? 'repository' : 'repositories'}; ${d.items === 0 ? 'nothing needs you' : `${plural(d.items, 'item')} need${d.items === 1 ? 's' : ''} you`}${counts ? `: ${counts}` : ''}; ${d.engines === 0 ? 'no engine running' : `${plural(d.engines, 'engine')} running`}`,
    ...skippedLine(d.skipped, verbose),
  ];
  if (verbose) lines.push(chalk.gray(`discovery ${d.discoveryMs} ms; collection ${d.repos.reduce((n, r) => n + r.ms, 0)} ms`));
  for (const r of d.repos) {
    const rc = groupCounts(r.data.summary.byGroup);
    const tags = [r.current ? 'current' : null, r.data.forge, r.recorded ? null : 'no factory runs recorded on this host'].filter(Boolean).join(', ');
    lines.push('', chalk.bold(repoHeader(r.root, tags)));
    const slow = r.ms > SLOW_REPO_MS ? ` (slow: over ${SLOW_REPO_MS / 1000} s; its state dir may hold many files)` : '';
    lines.push(`   ${r.data.items.length === 0 ? 'nothing needs you' : rc}; ${r.data.summary.engines.live === 0 ? 'no engine running' : `${plural(r.data.summary.engines.live, 'engine')} running`}${verbose ? `; ${r.ms} ms${slow}` : ''}`);
    for (const w of r.data.warnings) lines.push(chalk.yellow(`   warning: ${w}`));
    const where = r.current ? undefined : rootWord(r.root, platform);
    for (const g of ATTENTION_GROUPS) {
      const items = r.data.items.filter((i) => i.group === g);
      if (items.length === 0) continue;
      lines.push(chalk.bold(`  ${GROUP_TITLES[g].toUpperCase()} (${items.length})`));
      for (const i of items) lines.push(...itemLines(i, verbose, where).map((l) => `  ${l}`));
    }
  }
  return lines.join('\n');
}
