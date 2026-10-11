/**
 * `omg ship prepare`: the mechanical steps between an approved verdict and
 * the CI gate, in a fixed order:
 *   preflight (on the run's PR branch, containing the reviewed sha, clean,
 *   no merge / rebase / cherry-pick / revert in progress) -> fetch ->
 *   merge origin/<base> in (--no-ff, never rebase) -> tsc / lint /
 *   targeted tests -> inventory regeneration as the LAST commit -> optional
 *   plain push.
 * Every command goes through the guarded Exec, so force pushes and rebases
 * are refused before they spawn.
 */

import { existsSync } from 'fs';
import { isAbsolute, join, posix } from 'path';
import { isPlainBranchName } from './config.js';
import type { Exec } from './exec.js';

export type StepStatus = 'ok' | 'skipped' | 'failed';

export interface PrepareStep {
  name: string;
  status: StepStatus;
  detail?: string;
}

export interface PrepareOptions {
  exec: Exec;
  cwd: string;
  base: string;
  /** The ship run's PR branch: HEAD must be on it, and `push` updates exactly it. */
  branch: string;
  /** Latest verdict sha; HEAD must contain it. */
  reviewedSha: string;
  remote?: string;
  /** Run tsc / eslint / targeted vitest (default true). */
  checks?: boolean;
  push?: boolean;
  /** Node binary for repo scripts (default process.execPath). */
  node?: string;
  exists?: (path: string) => boolean;
}

export interface PrepareResult {
  ok: boolean;
  steps: PrepareStep[];
  /** Commits this run created (merge commit, inventory commit). */
  housekeepingCommits: string[];
  conflicts?: string[];
  blockedReason?: string;
}

export const INVENTORY_DIR = 'inventory';
export const INVENTORY_SCRIPT = 'scripts/generate-inventory-graph.mjs';
export const INVENTORY_COMMIT_MESSAGE = 'chore(inventory): regenerate inventory graph baseline';

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Tests to run for a diff: changed test files, plus `X.test.ts` beside or in
 * `__tests__/` next to each changed `src/**\/X.ts`, plus the skills suite when
 * skills/ changed. Only files that exist are returned (sorted, unique).
 */
export function selectTargetedTests(changed: readonly string[], exists: (relPath: string) => boolean): string[] {
  const picked = new Set<string>();
  const add = (p: string) => { if (exists(p)) picked.add(p); };
  for (const raw of changed) {
    const file = raw.replace(/\\/g, '/');
    if (TEST_FILE.test(file) && (file.startsWith('src/') || file.startsWith('tests/'))) { add(file); continue; }
    if (file.startsWith('skills/')) { add('src/__tests__/skills.test.ts'); continue; }
    const m = /^(src\/(?:.*\/)?)([^/]+)\.(ts|tsx|mts)$/.exec(file);
    if (!m || file.endsWith('.d.ts')) continue;
    const [, dir, name] = m;
    add(`${dir}${name}.test.ts`);
    add(`${dir}__tests__/${name}.test.ts`);
  }
  return [...picked].sort();
}

/** Generator verifications to run when their inputs changed. */
export function selectGeneratorChecks(changed: readonly string[]): string[][] {
  const touches = (prefixes: string[]) => changed.some((f) => prefixes.some((p) => f.replace(/\\/g, '/').startsWith(p)));
  const out: string[][] = [];
  if (touches(['skills/', 'agents/', 'docs/CLAUDE.md'])) out.push(['scripts/generate-prompt-projections.mjs', '--verify']);
  if (touches(['agents/'])) out.push(['scripts/copilot/build-agents.mjs', '--verify']);
  if (touches(['hooks/'])) out.push(['scripts/copilot/build-hooks.mjs', '--verify']);
  return out;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function tail(text: string, n = 20): string {
  return lines(text).slice(-n).join('\n');
}

export function runPrepare(opts: PrepareOptions): PrepareResult {
  const { exec, cwd, base } = opts;
  const remote = opts.remote ?? 'origin';
  const node = opts.node ?? process.execPath;
  const exists = opts.exists ?? ((p: string) => existsSync(isAbsolute(p) ? p : join(cwd, p)));
  const upstream = `${remote}/${base}`;
  const steps: PrepareStep[] = [];
  const housekeepingCommits: string[] = [];
  const git = (...args: string[]) => exec('git', args, { cwd });
  const fail = (name: string, detail: string, extra: Partial<PrepareResult> = {}): PrepareResult => {
    steps.push({ name, status: 'failed', detail });
    return { ok: false, steps, housekeepingCommits, blockedReason: `${name}: ${detail.split('\n')[0]}`, ...extra };
  };
  const head = () => git('rev-parse', 'HEAD').stdout.trim();

  // 1. preflight
  for (const [label, name] of [['base', base], ['branch', opts.branch]] as const) {
    if (!isPlainBranchName(name) || git('check-ref-format', '--branch', name).status !== 0) {
      return fail('preflight', `${label} ${JSON.stringify(name)} is not a valid branch name`);
    }
  }
  if (!/^[\w][\w.-]*$/.test(remote)) return fail('preflight', `remote ${JSON.stringify(remote)} is not a valid remote name`);
  if (!/^[0-9a-f]{40}$/.test(opts.reviewedSha)) return fail('preflight', `reviewed sha ${JSON.stringify(opts.reviewedSha)} is not a full commit id`);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  if (!branch || branch === 'HEAD') return fail('preflight', 'detached HEAD; check out the PR branch');
  if (branch === base || branch === 'main' || branch === 'master') return fail('preflight', `refusing to prepare on ${branch}; use the PR branch`);
  if (branch !== opts.branch) return fail('preflight', `checked out ${branch}, but the ship run is for ${opts.branch}; check out the PR branch`);
  if (git('merge-base', '--is-ancestor', opts.reviewedSha, 'HEAD').status !== 0) {
    return fail('preflight', `HEAD does not contain the reviewed commit ${opts.reviewedSha.slice(0, 12)}; pull the PR branch (merge, never rebase) or re-review`);
  }
  for (const [ref, what] of [['MERGE_HEAD', 'a merge'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']] as const) {
    if (git('rev-parse', '-q', '--verify', ref).status === 0) return fail('preflight', `${what} is in progress; commit or abort it first`);
  }
  for (const marker of ['rebase-merge', 'rebase-apply']) {
    const p = git('rev-parse', '--git-path', marker).stdout.trim();
    if (p && exists(isAbsolute(p) ? p : join(cwd, p))) return fail('preflight', 'a rebase is in progress; finish or abort it (ship never rebases)');
  }
  const dirty = git('status', '--porcelain', '--untracked-files=no').stdout.trim();
  if (dirty) return fail('preflight', `working tree has uncommitted changes:\n${dirty}`);
  steps.push({ name: 'preflight', status: 'ok', detail: branch });

  // 2. fetch
  const fetched = git('fetch', remote, base);
  if (fetched.status !== 0) return fail('fetch', tail(fetched.stderr));
  steps.push({ name: 'fetch', status: 'ok', detail: upstream });

  // 3. merge the base in (never rebase)
  if (git('merge-base', '--is-ancestor', upstream, 'HEAD').status === 0) {
    steps.push({ name: 'merge-base', status: 'skipped', detail: `already contains ${upstream}` });
  } else {
    const merged = git('merge', '--no-ff', '--no-edit', upstream);
    if (merged.status !== 0) {
      const conflicts = lines(git('diff', '--name-only', '--diff-filter=U').stdout);
      const inventoryOnly = conflicts.length > 0 && conflicts.every((f) => f.startsWith(`${INVENTORY_DIR}/`));
      if (!inventoryOnly) {
        return fail('merge-base', conflicts.length > 0
          ? `conflicts outside ${INVENTORY_DIR}/ need a human or a fix lane: ${conflicts.join(', ')} (resolve and commit, or git merge --abort)`
          : tail(merged.stderr || merged.stdout), { conflicts });
      }
      // Sibling-PR inventory conflict: take the base's baseline; it is regenerated below.
      for (const args of [['checkout', '--theirs', '--', INVENTORY_DIR], ['add', '--', INVENTORY_DIR], ['commit', '--no-edit']]) {
        const r = git(...args);
        if (r.status !== 0) return fail('merge-base', `git ${args.join(' ')}: ${tail(r.stderr || r.stdout)}`, { conflicts });
      }
      steps.push({ name: 'merge-base', status: 'ok', detail: `merged ${upstream}; inventory conflict resolved with --theirs` });
    } else {
      steps.push({ name: 'merge-base', status: 'ok', detail: `merged ${upstream}` });
    }
    housekeepingCommits.push(head());
  }

  // 4. checks chosen from the diff against the base
  if (opts.checks !== false) {
    const changed = lines(git('diff', '--name-only', `${upstream}...HEAD`).stdout);
    const lintable = changed.filter((f) => /^src\/.*\.(?:ts|tsx|mts)$/.test(f) && !f.endsWith('.d.ts') && exists(f));
    const tests = selectTargetedTests(changed, exists);
    const plan: Array<[string, string[] | null, string]> = [
      ['tsc', ['node_modules/typescript/bin/tsc', '--noEmit'], ''],
      ['lint', lintable.length > 0 ? ['node_modules/eslint/bin/eslint.js', ...lintable] : null, 'no changed src TypeScript'],
      ['tests', tests.length > 0 ? ['node_modules/vitest/vitest.mjs', 'run', ...tests] : null, 'no targeted tests for the diff'],
      ...selectGeneratorChecks(changed).map((args): [string, string[], string] => [posix.basename(args[0]), args, '']),
    ];
    for (const [name, args, skipReason] of plan) {
      if (!args) { steps.push({ name, status: 'skipped', detail: skipReason }); continue; }
      const r = exec(node, args, { cwd });
      if (r.status !== 0) return fail(name, tail(`${r.stdout}\n${r.stderr}`));
      steps.push({ name, status: 'ok', detail: args.slice(1).join(' ').slice(0, 300) });
    }
  } else {
    steps.push({ name: 'checks', status: 'skipped', detail: '--no-checks' });
  }

  // 5. inventory regeneration, always the last commit
  if (exec(node, [INVENTORY_SCRIPT, '--verify'], { cwd }).status === 0) {
    steps.push({ name: 'inventory', status: 'skipped', detail: 'baseline is current' });
  } else {
    const written = exec(node, [INVENTORY_SCRIPT, '--write'], { cwd });
    if (written.status !== 0) return fail('inventory', tail(written.stderr || written.stdout));
    const added = git('add', '--', INVENTORY_DIR);
    if (added.status !== 0) return fail('inventory', `git add -- ${INVENTORY_DIR}: ${tail(added.stderr || added.stdout)}`);
    if (git('diff', '--cached', '--quiet').status !== 0) {
      const committed = git('commit', '-m', INVENTORY_COMMIT_MESSAGE);
      if (committed.status !== 0) return fail('inventory', tail(committed.stderr || committed.stdout));
      housekeepingCommits.push(head());
    }
    const verified = exec(node, [INVENTORY_SCRIPT, '--verify'], { cwd });
    if (verified.status !== 0) return fail('inventory', `regenerated baseline still fails --verify:\n${tail(verified.stderr || verified.stdout)}`);
    steps.push({ name: 'inventory', status: 'ok', detail: 'regenerated as the last commit' });
  }

  // 6. plain push
  if (opts.push) {
    const pushed = git('push', remote, `HEAD:refs/heads/${opts.branch}`);
    if (pushed.status !== 0) return fail('push', tail(pushed.stderr));
    steps.push({ name: 'push', status: 'ok', detail: `${remote} ${opts.branch}` });
  }

  return { ok: true, steps, housekeepingCommits };
}
