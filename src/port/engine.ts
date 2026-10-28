/**
 * `omg port drive`: the automated upstream port (design
 * .omc/plans/2026-10-27-self-driving-gates-ports-design.md §6). Phases, in order:
 *
 *   preflight  clean tree, `port/upstream-<short>` branch (created or resumed)
 *   apply      scripts/port/upstream-drift.mjs --apply --head <sha>, then --report
 *   junk       unstage known upstream junk (`.gjc/` session dirs) if any slipped in
 *   delta      --package-delta: `version` ignored, every other key needs a human
 *   reconcile  conflicts: write the brief; run a credit-capped write lane only
 *              with `reconcileLane`, else stop `blocked` naming the brief
 *   gates      tsc, eslint src (0 errors), path gate, generator --verify, touched tests
 *   commit     the port commit, then inventory regeneration as the LAST commit
 *   pr         plain push to `port/upstream-<short>`, draft PR to the base; a human merges
 *
 * A human decision stops the run `blocked` with the next command
 * (`--continue` after the human staged their fix). The engine never force
 * pushes, never resets, never merges and never commits unresolved conflicts.
 *
 * Upstream text reaches the reconcile lane and the lane shares the common git
 * dir, so every host git command runs through the port guard (guard.ts:
 * allowlisted shapes, no hooks, fsmonitor, pager, external diff or filter),
 * the shared git state is snapshotted before the lane and compared after its
 * confirmed end (factory review-guard.ts), and the lane's tree may differ from
 * the host-applied index only on the conflicted, non-protected paths.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import { isTerminalLaneState, type LaneBackend, type LaneResult, type LaneUsage } from '../factory/run/lane.js';
import { emptyHooksDir } from '../factory/run/ledger.js';
import { compareSnapshots, snapshotRepo, type RepoSnapshot } from '../factory/run/review-guard.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import type { Exec } from '../ship/exec.js';
import { protectedChanges } from '../ship/merge.js';
import { INVENTORY_COMMIT_MESSAGE, INVENTORY_DIR, INVENTORY_SCRIPT, selectTargetedTests } from '../ship/prepare.js';
import { hardenedScriptEnv, portGuardExec } from './guard.js';

export const DRIFT_SCRIPT = 'scripts/port/upstream-drift.mjs';
const MARKER_PATH = '.github/upstream-port.json';
export const PORT_PHASES = ['preflight', 'apply', 'junk', 'delta', 'reconcile', 'gates', 'commit', 'pr'] as const;
export type PortPhase = (typeof PORT_PHASES)[number];
export type PortProgressStatus = 'start' | 'ok' | 'fail' | 'blocked' | 'heartbeat' | 'done';

/** Upstream junk the port never keeps (the drift script also drops it from the range). */
export const JUNK_PATHS = ['.gjc'];
/** Conflicts here need a human review before any PR, even with a reconcile lane (§6 human-gate table). */
export const HUMAN_REVIEW_PREFIXES = ['src/release/', 'src/ship/', 'src/installer/', 'src/hooks/permission-handler/'];
/**
 * Paths a reconcile lane may never change, even when conflicted, on top of
 * ship's PROTECTED_PATHS: the drift script's EXCLUDED_PATHS and SKIPPED_PATHS,
 * the gate scripts and generators the engine runs on the host, lint and test
 * config, git attributes, and the port engine and its runbook. A rule ending
 * in `*` is a prefix; any other rule names a file or a directory.
 */
export const LANE_FORBIDDEN_PATHS = [
  'dist', 'bridge', 'inventory', 'package-lock.json', 'package.json', 'CHANGELOG.md', 'README.md',
  '.github/release-body.md', '.github/generated-artifact-authorizations.json',
  '.github/workflows', '.github/actions',
  'scripts/ci', 'scripts/port', 'scripts/copilot', 'scripts/generate-*', 'scripts/build-*',
  'eslint.config.*', 'vitest.config.*', 'vitest.workspace.*', '.gitattributes', '.gitmodules',
  'src/port', 'src/cli/commands/port.ts', '.omc/skills/port-upstream.md',
];

/** The paths a reconcile lane may not change (LANE_FORBIDDEN_PATHS, protectedChanges, any `.gitattributes`). */
export function laneForbidden(paths: readonly string[]): string[] {
  const shipHit = new Set(protectedChanges(paths));
  return paths.filter((raw) => {
    const p = raw.replace(/\\/g, '/').toLowerCase();
    if (shipHit.has(raw) || p.split('/').pop() === '.gitattributes') return true;
    return LANE_FORBIDDEN_PATHS.some((r) => {
      const rule = r.toLowerCase();
      return rule.endsWith('*') ? p.startsWith(rule.slice(0, -1)) : p === rule || p.startsWith(`${rule}/`);
    });
  });
}

export interface PackageChange {
  key: string;
  before: unknown;
  after: unknown;
  action: 'ignored' | 'human';
}

export interface ReconcileLaneOptions {
  /** Mandatory AI-credit cap of the paid lane. */
  maxCredits: number;
  timeoutMs: number;
  model?: string;
}

export interface PortDriveOptions {
  cwd: string;
  /** Upstream commit (sha or ref) to port up to. */
  head: string;
  exec: Exec;
  /** Node binary for repo scripts (default process.execPath). */
  node?: string;
  /** PR base branch (default dev). */
  base?: string;
  remote?: string;
  /** Push and open the draft PR (default true). */
  push?: boolean;
  /**
   * Resume on the port branch after a human resolved a blocked run: skips
   * apply, and the delta once it ran. After the port commit it resumes at the
   * inventory, push or PR step.
   */
  resume?: boolean;
  date?: string;
  /** The upstream head whose leak-sweep lines the human accepted (recorded in the commit, the PR and accepted-leaks.json). */
  acceptLeaks?: string;
  /** Runs the reconcile brief as a write lane; null = never start a lane. */
  reconcileLane?: ReconcileLaneOptions | null;
  lanes?: () => LaneBackend;
  /** The progress log the brief tells the lane to write to. */
  progressFile?: string;
  progress: (phase: PortPhase | 'report', status: PortProgressStatus, note: string) => void;
  log: (line: string) => void;
}

export interface PortDriveResult {
  status: 'done' | 'blocked' | 'fail';
  /** 0 done, 1 fail, 3 blocked. */
  exitCode: 0 | 1 | 3;
  message: string;
  branch: string | null;
  upstreamHead: string | null;
  blockers: string[];
  brief: string | null;
  packageDelta: PackageChange[];
  gates: string[];
  commits: string[];
  pr: string | null;
  laneCredits: number | null;
  /** Leak-sweep lines accepted with --accept-leaks (`path:line`). */
  acceptedLeaks: string[];
  next: string | null;
}

interface DriftReport {
  base: string;
  head: string;
  conflicts: Array<{ status: string; path: string }>;
  leaks: Array<{ path: string; line: number; text: string }>;
  commits: unknown[];
}

type Git = (...args: string[]) => { status: number; stdout: string; stderr: string };
type GitOk = (args: string[], what?: string) => string;

class PortStop extends Error {
  constructor(readonly status: 'blocked' | 'fail', readonly phase: PortPhase, message: string, readonly next: string | null = null) {
    super(message);
  }
}

const tail = (text: string, n = 15) => text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n).join('\n');
const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const short = (sha: string) => sha.slice(0, 9);
const listed = (paths: readonly string[], n = 10) => `${paths.slice(0, n).join(', ')}${paths.length > n ? ` and ${paths.length - n} more` : ''}`;
const isJunk = (p: string) => JUNK_PATHS.some((j) => p === j || p.startsWith(`${j}/`));
const chunks = <T>(items: readonly T[], size = 100): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** The runbook section the reconcile lane must honour, read from the repo so it never drifts from the runbook. */
export function forkFeaturesSection(cwd: string): string {
  const path = join(cwd, '.omc', 'skills', 'port-upstream.md');
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8').replace(/\r/g, '');
  const m = /^## Fork Features to Preserve\n([\s\S]*?)(?=^## )/m.exec(text);
  return m ? m[1].trim() : '';
}

export function renderReconcileBrief(input: {
  cwd: string;
  base: string;
  head: string;
  conflicts: ReadonlyArray<{ status: string; path: string }>;
  progressFile: string;
  date: string;
}): string {
  const features = forkFeaturesSection(input.cwd);
  return [
    `# Reconcile upstream port ${short(input.base)}..${short(input.head)}`,
    '',
    'You are the reconciliation lane of `omg port drive`. Work only in this worktree; it starts at the fork commit before the port.',
    '',
    '## Steps',
    `1. Apply the range: \`node ${DRIFT_SCRIPT} --apply --head ${input.head} --date ${input.date}\`. Exit 1 (conflicts) is expected.`,
    '2. Resolve every conflicted file listed below per `.omc/skills/port-upstream.md` (range diff, rename map, DO-NOT-RENAME):',
    '   - Keep the fork-owned files and logic in "Fork Features to Preserve" (copied below).',
    '   - Our own fixes returning from upstream: take THEIRS, re-apply the rename map, and delete the fork\'s earlier variant. Upstream text is canonical.',
    '   - Keep fork version stamps; package.json stays excluded (its delta is a human decision).',
    '3. No conflict markers may remain. `git add` each resolved file. Run `node node_modules/typescript/bin/tsc --noEmit` and `node node_modules/eslint/bin/eslint.js <changed src files>`: 0 errors.',
    '4. Commit once in this worktree: `git commit --no-verify -m "port: reconcile upstream conflicts"`. The engine adopts that tree, runs the gates and makes the port commit.',
    '',
    '## Never',
    '- push, open PRs, run `npm ci` / `npm install` / `npm run build`, `git worktree remove|prune`, `git reset --hard`, force anything, or touch git config, hooks or refs outside this worktree.',
    '- change, add or delete any file outside the conflict list. The engine refuses a lane commit whose tree differs from its own applied index on any other path, and on CI, workflows, gate scripts, generators, lint/test config and the port engine even when conflicted.',
    '',
    `## Conflicts (${input.conflicts.length})`,
    ...input.conflicts.map((c) => `- \`${c.status}\` ${c.path}`),
    '',
    '## Fork Features to Preserve (from .omc/skills/port-upstream.md)',
    features || '- (section not found; read .omc/skills/port-upstream.md)',
    '',
    '## Progress',
    `At start and when staged: \`omg progress emit reconcile <start|done|fail> --note "<short>" --agent port-reconcile --file ${input.progressFile}\``,
    '',
  ].join('\n');
}

export async function runPortDrive(opts: PortDriveOptions): Promise<PortDriveResult> {
  const { cwd } = opts;
  const node = opts.node ?? process.execPath;
  const remote = opts.remote ?? 'origin';
  const prBase = opts.base ?? 'dev';
  const push = opts.push !== false;
  // The host and the lane write the same marker date, so their trees agree outside the conflicts.
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const stateRoot = getOmcRoot(cwd);
  const rel = relative(cwd, stateRoot).replace(/\\/g, '/');
  const stateRootRel = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
  const hooksDir = join(stateRoot, 'port', 'empty-hooks');
  const exec = portGuardExec(opts.exec, hooksDir);
  const scriptEnv = hardenedScriptEnv(hooksDir);
  const git: Git = (...args) => exec('git', args, { cwd });
  // Gate scripts run plain (tests spawn git with their own hooks); the drift script and the inventory generator run hardened.
  const script = (...args: string[]) => exec(node, args, { cwd });
  const repoScript = (...args: string[]) => exec(node, args, { cwd, env: scriptEnv });
  const exists = (p: string) => existsSync(isAbsolute(p) ? p : join(cwd, p));
  const result: PortDriveResult = {
    status: 'fail', exitCode: 1, message: '', branch: null, upstreamHead: null, blockers: [], brief: null,
    packageDelta: [], gates: [], commits: [], pr: null, laneCredits: null, acceptedLeaks: [], next: null,
  };
  let phase: PortPhase = 'preflight';
  const begin = (p: PortPhase, note: string) => { phase = p; opts.progress(p, 'start', note); };
  const ok = (note: string) => { opts.progress(phase, 'ok', note); opts.log(`${phase}: ${note}`); };
  const gitOk: GitOk = (args, what = `git ${args.join(' ')}`) => {
    const r = git(...args);
    if (r.status !== 0) throw new PortStop('fail', phase, `${what} failed: ${tail(r.stderr || r.stdout, 5)}`);
    return r.stdout;
  };

  try {
    // preflight
    begin('preflight', opts.head);
    emptyHooksDir(join(stateRoot, 'port'));
    const head = git('rev-parse', '--verify', '--quiet', `${opts.head}^{commit}`).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(head)) throw new PortStop('fail', phase, `upstream head ${JSON.stringify(opts.head)} is not a commit here; fetch upstream first (git fetch upstream dev)`);
    result.upstreamHead = head;
    const accept = opts.acceptLeaks?.trim().toLowerCase();
    if (accept !== undefined && !(accept.length >= 7 && head.startsWith(accept))) {
      throw new PortStop('fail', phase, `--accept-leaks ${opts.acceptLeaks} does not name the upstream head ${head}; it accepts the leak lines of exactly one head`);
    }
    const branch = `port/upstream-${short(head)}`;
    result.branch = branch;
    const portDir = join(stateRoot, 'port', short(head));
    const progressFile = opts.progressFile || process.env.OMG_PROGRESS_FILE || join(stateRoot, 'progress', 'port.log');
    const resumeCmd = `omg port drive --head ${head} --continue`;
    const current = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    if (opts.resume) {
      if (current !== branch) throw new PortStop('fail', phase, `--continue must run on ${branch}, checked out ${current || '(none)'}`);
    } else {
      const dirty = git('status', '--porcelain', '--untracked-files=no').stdout.trim();
      if (dirty) throw new PortStop('fail', phase, `working tree has tracked changes; omg port drive needs a clean checkout (or --continue on ${branch}):\n${dirty}`);
      if (current !== branch) {
        if (git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).status === 0) {
          throw new PortStop('fail', phase, `branch ${branch} already exists; check it out and pass --continue, or pick another head`);
        }
        gitOk(['switch', '-q', '-c', branch]);
      }
    }
    const committed = opts.resume ? findPortCommit(git, head) : null;
    let rangeBase: string;
    if (committed) {
      rangeBase = committed.rangeBase;
      result.commits.push(committed.port, ...(committed.inventory ? [committed.inventory] : []));
      ok(`${branch}: the port commit ${short(committed.port)} exists; resuming after it`);
      begin('commit', `resumed after ${short(committed.port)}`);
    } else {
      const preApply = gitOk(['rev-parse', 'HEAD']).trim();
      ok(`${branch} at ${short(preApply)}`);

      // apply (+ report: conflicts, leaks, the range base)
      begin('apply', short(head));
      if (!opts.resume) {
        const applied = repoScript(DRIFT_SCRIPT, '--apply', '--head', head, '--date', date);
        if (applied.status !== 0 && applied.status !== 1) throw new PortStop('fail', phase, `${DRIFT_SCRIPT} --apply failed (exit ${applied.status}): ${tail(applied.stderr || applied.stdout, 5)}`);
      }
      const reported = repoScript(DRIFT_SCRIPT, '--report', '--head', head);
      if (reported.status !== 0) throw new PortStop('fail', phase, `${DRIFT_SCRIPT} --report failed: ${tail(reported.stderr, 5)}`);
      const report = JSON.parse(reported.stdout) as DriftReport;
      rangeBase = report.base;
      ok(`${short(rangeBase)}..${short(head)}: ${report.commits.length} commits, ${report.conflicts.length} conflicts${opts.resume ? ' (resumed, apply skipped)' : ''}`);

      // junk
      begin('junk', JUNK_PATHS.join(','));
      const junk = lines(git('diff', '--cached', '--name-only', '--', ...JUNK_PATHS).stdout);
      if (junk.length > 0) gitOk(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...JUNK_PATHS]);
      ok(junk.length > 0 ? `unstaged ${junk.length} junk file(s): ${junk.slice(0, 5).join(', ')}` : 'none');

      // delta: recorded in package-delta.json, so --continue skips it only once it ran
      begin('delta', 'package.json');
      const blockers: string[] = [];
      const deltaFile = join(portDir, 'package-delta.json');
      if (opts.resume && existsSync(deltaFile)) {
        result.packageDelta = JSON.parse(readFileSync(deltaFile, 'utf8')) as PackageChange[];
        ok('ran before; skipped on --continue (the human handled it)');
      } else {
        const d = repoScript(DRIFT_SCRIPT, '--package-delta', '--head', head, '--json');
        if (d.status !== 0 && d.status !== 1) throw new PortStop('fail', phase, `${DRIFT_SCRIPT} --package-delta failed: ${tail(d.stderr, 5)}`);
        result.packageDelta = (JSON.parse(d.stdout) as { changes: PackageChange[] }).changes;
        const human = result.packageDelta.filter((c) => c.action === 'human');
        mkdirSync(portDir, { recursive: true });
        writeFileSync(deltaFile, `${JSON.stringify(result.packageDelta, null, 2)}\n`);
        if (human.length > 0) {
          blockers.push(`package.json delta needs a human: ${human.map((c) => c.key).join(', ')} (${deltaFile}); port it by hand and stage package.json + package-lock.json`);
        }
        ok(`${result.packageDelta.length} change(s), ${human.length} for a human`);
      }

      // reconcile + the rest of the human-gate table
      begin('reconcile', `${report.conflicts.length} conflicts`);
      if (report.leaks.length > 0) {
        if (accept !== undefined) {
          result.acceptedLeaks = report.leaks.map((l) => `${l.path}:${l.line}`);
          mkdirSync(portDir, { recursive: true });
          writeFileSync(join(portDir, 'accepted-leaks.json'), `${JSON.stringify({ head, acceptedAt: new Date().toISOString(), leaks: report.leaks }, null, 2)}\n`);
          opts.log(`reconcile: ${report.leaks.length} leak line(s) accepted with --accept-leaks ${short(head)} (${join(portDir, 'accepted-leaks.json')})`);
        } else {
          blockers.push(`leak sweep: ${report.leaks.length} new oh-my-claudecode line(s), first ${report.leaks[0].path}:${report.leaks[0].line}; fix them, or accept them with --accept-leaks ${head}`);
        }
      }
      const conflicts = report.conflicts;
      if (conflicts.length > 0) {
        mkdirSync(portDir, { recursive: true });
        const brief = join(portDir, 'brief.md');
        writeFileSync(brief, renderReconcileBrief({ cwd, base: rangeBase, head, conflicts, progressFile, date }));
        result.brief = brief;
        const sensitive = conflicts.filter((c) => HUMAN_REVIEW_PREFIXES.some((p) => c.path.startsWith(p)) || laneForbidden([c.path]).length > 0);
        if (sensitive.length > 0) {
          blockers.push(`reconcile: ${conflicts.length} files, ${sensitive.length} need human review (${sensitive.slice(0, 3).map((c) => c.path).join(', ')}); brief ${brief}`);
        } else if (!opts.reconcileLane || !opts.lanes) {
          blockers.push(`reconcile: ${conflicts.length} files; brief ${brief} (run it with --reconcile-lane --max-credits <n>, or resolve by hand)`);
        } else if (blockers.length === 0) {
          // Paid lane only when nothing else would stop the run anyway.
          const lanes = opts.lanes();
          let before: RepoSnapshot;
          try {
            before = snapshotRepo(exec, cwd, stateRootRel);
          } catch (error) {
            throw new PortStop('fail', phase, `the pre-lane snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          const lane = await runReconcileLane(lanes, opts.reconcileLane, { cwd, preApply, head, brief, progress: (s, n) => opts.progress('reconcile', s, n) });
          result.laneCredits = lane.usage?.credits ?? null;
          if (!lane.confirmed || !lane.result) {
            throw new PortStop('blocked', phase, `reconcile lane ${lane.remoteId} ${lane.why}; it may still run, so its tamper check cannot be trusted yet (nothing committed or pushed). Stop the job, then resolve by hand per ${brief} and run ${resumeCmd}`, resumeCmd);
          }
          const tampered = laneTamperProblems(exec, cwd, stateRootRel, before, lane.result);
          if (tampered.length > 0) {
            throw new PortStop('blocked', phase, `the reconcile lane changed shared git state, so nothing was adopted, committed or pushed: ${tampered.join('; ')}. Inspect and undo it, then resolve by hand per ${brief} and run ${resumeCmd}`, resumeCmd);
          }
          const laneHead = lane.result.headSha;
          if (lane.result.state !== 'completed' || !laneHead || laneHead === preApply) {
            throw new PortStop('blocked', phase, `reconcile lane ${lane.remoteId} ended ${lane.result.state}${lane.result.error ? `: ${lane.result.error}` : ''} without a commit; resolve by hand per ${brief}`, resumeCmd);
          }
          adoptLaneTree(git, gitOk, preApply, laneHead, conflicts.map((c) => c.path));
        }
      }
      if (blockers.length > 0) {
        result.blockers = blockers;
        throw new PortStop('blocked', phase, blockers.join('; '), resumeCmd);
      }
      ok(conflicts.length > 0 ? `lane resolved ${conflicts.length} files (${result.laneCredits?.toFixed(2)} AI credits)` : 'no conflicts');

      // gates
      begin('gates', 'tsc, eslint, path gate, generators, tests');
      const unmerged = lines(git('diff', '--name-only', '--diff-filter=U').stdout);
      if (unmerged.length > 0) throw new PortStop('blocked', phase, `unresolved conflicts remain: ${unmerged.join(', ')}`, resumeCmd);
      const unstaged = lines(git('diff', '--name-only').stdout);
      if (unstaged.length > 0) throw new PortStop('blocked', phase, `unstaged changes: ${unstaged.slice(0, 10).join(', ')}; stage (or discard) them`, resumeCmd);
      const staged = lines(git('diff', '--cached', '--name-only').stdout);
      const tests = selectTargetedTests(staged, exists);
      const plan: Array<[string, string[]]> = [
        ['tsc', ['node_modules/typescript/bin/tsc', '--noEmit']],
        ['eslint', ['node_modules/eslint/bin/eslint.js', 'src']],
        ['path gate', ['scripts/ci/check-multirepo-paths.mjs']],
        ['prompt projections', ['scripts/generate-prompt-projections.mjs', '--verify']],
        ['copilot hooks', ['scripts/copilot/build-hooks.mjs', '--verify']],
        ['copilot agents', ['scripts/copilot/build-agents.mjs', '--verify']],
        ...(tests.length > 0 ? [['tests', ['node_modules/vitest/vitest.mjs', 'run', ...tests]] as [string, string[]]] : []),
      ];
      for (const [name, args] of plan) {
        opts.log(`  node ${args.join(' ').slice(0, 200)}`);
        const r = script(...args);
        if (r.status !== 0) {
          const out = `${r.stdout}\n${r.stderr}`;
          const errors = name === 'eslint' ? lines(out).filter((l) => /^\d+:\d+\s+error\b/.test(l)).slice(0, 10) : [];
          throw new PortStop('fail', phase, `${name} failed (exit ${r.status}):\n${[...errors, tail(out, 10)].join('\n')}`, `fix, stage, then ${resumeCmd}`);
        }
        result.gates.push(name);
      }
      ok(`${result.gates.length} gates green${tests.length > 0 ? ` (${tests.length} test files)` : ''}`);

      // the port commit
      begin('commit', branch);
      if (staged.length === 0) throw new PortStop('fail', phase, 'nothing staged: the range is already ported');
      gitOk(['commit', '--no-verify', '-q', '-m', `port: upstream ${short(rangeBase)}..${short(head)} (omg port drive)`,
        '-m', `Applied by ${DRIFT_SCRIPT} --apply --head ${head}${result.laneCredits !== null ? '; conflicts reconciled by a lane' : ''}.`,
        ...(result.acceptedLeaks.length > 0 ? ['-m', `Leak sweep: ${result.acceptedLeaks.length} line(s) accepted with --accept-leaks ${head}: ${listed(result.acceptedLeaks)}.`] : [])]);
      result.commits.push(gitOk(['rev-parse', 'HEAD']).trim());
    }

    // inventory last (a --continue after the port commit resumes here)
    if (repoScript(INVENTORY_SCRIPT, '--verify').status !== 0) {
      const written = repoScript(INVENTORY_SCRIPT, '--write');
      if (written.status !== 0) throw new PortStop('fail', phase, `inventory --write failed: ${tail(written.stderr || written.stdout, 5)}`, resumeCmd);
      gitOk(['add', '--', INVENTORY_DIR]);
      if (git('diff', '--cached', '--quiet', '--', INVENTORY_DIR).status !== 0) {
        gitOk(['commit', '--no-verify', '-q', '-m', INVENTORY_COMMIT_MESSAGE, '--', INVENTORY_DIR]);
        result.commits.push(gitOk(['rev-parse', 'HEAD']).trim());
      }
      const verified = repoScript(INVENTORY_SCRIPT, '--verify');
      if (verified.status !== 0) throw new PortStop('fail', phase, `inventory still fails --verify: ${tail(verified.stderr || verified.stdout, 5)}`, resumeCmd);
    }
    ok(`${result.commits.length} commit(s), inventory last`);

    // push + draft PR; the merge stays human
    begin('pr', push ? `${remote} ${branch}` : 'push skipped');
    if (!push) {
      ok('committed locally; --no-push');
      return finish(result, 'done', `port ${short(rangeBase)}..${short(head)} committed on ${branch} (not pushed)`, `git push ${remote} HEAD:refs/heads/${branch}`, opts);
    }
    const pushed = git('push', remote, `HEAD:refs/heads/${branch}`);
    if (pushed.status !== 0) throw new PortStop('fail', phase, `git push ${remote} ${branch} failed: ${tail(pushed.stderr || pushed.stdout, 5)}`, resumeCmd);
    const md = repoScript(DRIFT_SCRIPT, '--report', '--base', rangeBase, '--head', head, '--markdown');
    mkdirSync(portDir, { recursive: true });
    const bodyFile = join(portDir, 'pr-body.md');
    const gates = result.gates.length > 0 ? result.gates.join(', ') : 'green before the port commit (resumed with --continue)';
    const leaks = result.acceptedLeaks.length > 0 ? `\n- leak sweep: ${result.acceptedLeaks.length} line(s) accepted with --accept-leaks: ${listed(result.acceptedLeaks)}` : '';
    writeFileSync(bodyFile, `${md.status === 0 ? md.stdout : ''}\n### omg port drive\n\n- gates: ${gates}\n- reconcile lane: ${result.laneCredits === null ? 'not used' : `${result.laneCredits.toFixed(2)} AI credits`}${leaks}\n- merge: a human merges this PR\n`);
    const title = `port: upstream ${short(rangeBase)}..${short(head)}`;
    const pr = exec('gh', ['pr', 'create', '--draft', '--base', prBase, '--head', branch, '--title', title, '--body-file', bodyFile], { cwd });
    if (pr.status !== 0) throw new PortStop('fail', phase, `gh pr create failed: ${tail(pr.stderr || pr.stdout, 5)}`, resumeCmd);
    result.pr = lines(pr.stdout).pop() ?? null;
    ok(`draft PR ${result.pr}`);
    return finish(result, 'done', `draft PR ${result.pr}; a human merges it`, `omg ship gates ${result.pr ?? ''} --drive`.trim(), opts);
  } catch (err) {
    if (!(err instanceof PortStop)) {
      opts.progress(phase, 'fail', err instanceof Error ? err.message : String(err));
      return finish(result, 'fail', `${phase}: ${err instanceof Error ? err.message : String(err)}`, null, opts);
    }
    opts.progress(err.phase, err.status, err.message.split('\n')[0]);
    return finish(result, err.status, `${err.phase}: ${err.message}`, err.next, opts);
  }
}

function finish(result: PortDriveResult, status: PortDriveResult['status'], message: string, next: string | null, opts: PortDriveOptions): PortDriveResult {
  result.status = status;
  result.exitCode = status === 'done' ? 0 : status === 'blocked' ? 3 : 1;
  result.message = message;
  result.next = next;
  opts.progress('report', status === 'done' ? 'done' : status, `${message.split('\n')[0]}${next ? `; next: ${next}` : ''}`);
  return result;
}

/**
 * On --continue: this head's port commit at HEAD, or under the inventory
 * commit at HEAD, with the range base read from the marker before it.
 */
function findPortCommit(git: Git, head: string): { port: string; inventory: string | null; rangeBase: string } | null {
  const subject = (rev: string) => { const r = git('show', '-s', '--format=%s', rev); return r.status === 0 ? r.stdout.trim() : ''; };
  const isPort = (s: string) => new RegExp(`^port: upstream [0-9a-f]{9}\\.\\.${short(head)} \\(omg port drive\\)$`).test(s);
  let rev = 'HEAD';
  let inventory: string | null = null;
  if (subject(rev) === INVENTORY_COMMIT_MESSAGE) {
    inventory = git('rev-parse', 'HEAD').stdout.trim();
    rev = 'HEAD~1';
  }
  if (!isPort(subject(rev))) return null;
  const port = git('rev-parse', rev).stdout.trim();
  const marker = git('show', `${port}~1:${MARKER_PATH}`);
  let rangeBase: unknown;
  try { rangeBase = (JSON.parse(marker.stdout) as { upstream_sha?: unknown }).upstream_sha; } catch { rangeBase = undefined; }
  if (typeof rangeBase !== 'string' || !/^[0-9a-f]{40}$/.test(rangeBase)) {
    throw new PortStop('fail', 'preflight', `the port commit ${short(port)} has no readable ${MARKER_PATH} before it; finish the port by hand`);
  }
  return { port, inventory, rangeBase };
}

interface LaneEnd {
  remoteId: string;
  /** The lane's end is confirmed (terminal state), so the repository can be read without racing it. */
  confirmed: boolean;
  result: LaneResult | null;
  usage: LaneUsage | null;
  why: string;
}

/**
 * Start the lane and wait for it. A lane still running at the timeout (or
 * lost by the backend) is cancelled, and its end counts only when the cancel
 * reports a terminal state (factory engine's confirmed-end rule). Usage is
 * returned on every path that has any: the cancel's measured usage first.
 */
async function runReconcileLane(
  lanes: LaneBackend,
  cap: ReconcileLaneOptions,
  ctx: { cwd: string; preApply: string; head: string; brief: string; progress: (s: PortProgressStatus, note: string) => void },
): Promise<LaneEnd> {
  if (!(cap.maxCredits > 0)) throw new PortStop('fail', 'reconcile', 'the reconcile lane needs a positive --max-credits cap');
  ctx.progress('heartbeat', `starting reconcile lane (cap ${cap.maxCredits} AI credits)`);
  const { remoteId } = await lanes.start({
    laneId: `port-${short(ctx.head)}`, cwd: ctx.cwd, baseRef: ctx.preApply, prompt: readFileSync(ctx.brief, 'utf8'),
    profile: 'write', timeoutMs: cap.timeoutMs, maxCredits: cap.maxCredits, ...(cap.model ? { model: cap.model } : {}),
  });
  let waited: LaneResult | null = null;
  let waitError = '';
  try {
    waited = await lanes.wait(remoteId, cap.timeoutMs);
  } catch (error) {
    waitError = error instanceof Error ? error.message : String(error);
  }
  if (waited && isTerminalLaneState(waited.state)) return { remoteId, confirmed: true, result: waited, usage: waited.usage, why: '' };
  const stillRunning = waited ? `was still ${waited.state} after ${Math.round(cap.timeoutMs / 60_000)} min` : `could not be awaited (${waitError})`;
  ctx.progress('heartbeat', `reconcile lane ${remoteId} ${stillRunning}; cancelling`);
  try {
    const c = await lanes.cancel(remoteId);
    const usage = c.result.usage.source === 'measured' || !waited ? c.result.usage : waited.usage;
    if (isTerminalLaneState(c.result.state)) {
      return { remoteId, confirmed: true, result: { ...c.result, usage, state: waited ? 'timeout' : c.result.state, error: `the lane ${stillRunning} and was cancelled` }, usage, why: '' };
    }
    return { remoteId, confirmed: false, result: null, usage, why: `${stillRunning} and its cancel was not confirmed (state ${c.result.state})` };
  } catch (error) {
    return { remoteId, confirmed: false, result: null, usage: waited?.usage ?? null, why: `${stillRunning} and its cancel failed (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** The post-lane snapshot against the pre-lane one: only the lane's own branch and worktree entry may appear. */
function laneTamperProblems(exec: Exec, cwd: string, stateRootRel: string | null, before: RepoSnapshot, lane: LaneResult): string[] {
  try {
    const after = snapshotRepo(exec, cwd, stateRootRel, before);
    const allowed = lane.branch ? { [`refs/heads/${lane.branch}`]: lane.headSha ?? '*' } : {};
    const newWorktree = lane.worktree ? { path: lane.worktree } : lane.remoteId ? { id: lane.remoteId } : undefined;
    return compareSnapshots(before, after, allowed, newWorktree ? { newWorktree } : {});
  } catch (error) {
    return [`the post-lane snapshot failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/** `path -> "mode sha"` of the index (unmerged paths: `unmerged`). */
function indexEntries(gitOk: GitOk): Map<string, string> {
  const out = new Map<string, string>();
  for (const rec of gitOk(['ls-files', '-s', '-z']).split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(rec);
    if (m) out.set(m[4], m[3] === '0' ? `${m[1]} ${m[2]}` : 'unmerged');
  }
  return out;
}

/** `path -> "mode sha"` of a commit's tree. */
function treeEntries(gitOk: GitOk, rev: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rec of gitOk(['ls-tree', '-r', '-z', '--full-tree', rev]).split('\0')) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]+)$/.exec(rec);
    if (m) out.set(m[3], `${m[1]} ${m[2]}`);
  }
  return out;
}

/**
 * Take the lane's resolution of the conflicted paths, and nothing else. The
 * lane's tree must equal the host-applied index on every other path (junk
 * aside), and it may not change a forbidden path (laneForbidden) at all. No
 * conflict marker may remain in any file the lane changed. The conflicted
 * paths are checked out from the lane (or removed when it deleted them),
 * without a reset, and the result is proven equal to the lane's tree.
 */
function adoptLaneTree(git: Git, gitOk: GitOk, preApply: string, laneHead: string, conflicted: string[]): void {
  if (git('merge-base', '--is-ancestor', preApply, laneHead).status !== 0) {
    throw new PortStop('fail', 'reconcile', `lane head ${short(laneHead)} does not descend from ${short(preApply)}`);
  }
  const index = indexEntries(gitOk);
  const lane = treeEntries(gitOk, laneHead);
  const conflictSet = new Set(conflicted);
  const differs = [...new Set([...index.keys(), ...lane.keys()])].filter((p) => !isJunk(p) && index.get(p) !== lane.get(p)).sort();
  const outside = differs.filter((p) => !conflictSet.has(p));
  if (outside.length > 0) {
    throw new PortStop('blocked', 'reconcile', `the reconcile lane changed files outside the conflict list, so nothing was adopted: ${listed(outside)}; resolve by hand`);
  }
  const forbidden = laneForbidden(differs);
  if (forbidden.length > 0) {
    throw new PortStop('blocked', 'reconcile', `the reconcile lane changed protected paths, so nothing was adopted: ${listed(forbidden)}; resolve by hand`);
  }
  const changed = lines(gitOk(['diff', '--name-only', '--no-renames', preApply, laneHead]));
  const marked: string[] = [];
  for (const part of chunks(changed)) {
    const m = git('grep', '-l', '-E', '^(<<<<<<< |=======$|>>>>>>> )', laneHead, '--', ...part);
    if (m.status === 0) marked.push(...lines(m.stdout).map((l) => l.slice(laneHead.length + 1)));
  }
  if (marked.length > 0) throw new PortStop('blocked', 'reconcile', `lane left conflict markers: ${listed(marked)}`);
  const gone = conflicted.filter((p) => !lane.has(p));
  const keep = conflicted.filter((p) => lane.has(p));
  for (const part of chunks(gone)) gitOk(['rm', '-q', '-f', '--ignore-unmatch', '--', ...part]);
  for (const part of chunks(keep)) gitOk(['checkout', laneHead, '--', ...part]);
  gitOk(['write-tree']);
  const left = lines(gitOk(['diff', '--cached', '--name-only', '--no-renames', laneHead])).filter((p) => !isJunk(p));
  if (left.length > 0) throw new PortStop('fail', 'reconcile', `the adopted index differs from the lane tree on ${listed(left)}`);
}
