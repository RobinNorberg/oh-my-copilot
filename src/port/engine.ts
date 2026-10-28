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
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import type { LaneBackend, LaneResult } from '../factory/run/lane.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import type { Exec } from '../ship/exec.js';
import { INVENTORY_COMMIT_MESSAGE, INVENTORY_DIR, INVENTORY_SCRIPT, selectTargetedTests } from '../ship/prepare.js';

export const DRIFT_SCRIPT = 'scripts/port/upstream-drift.mjs';
export const PORT_PHASES = ['preflight', 'apply', 'junk', 'delta', 'reconcile', 'gates', 'commit', 'pr'] as const;
export type PortPhase = (typeof PORT_PHASES)[number];
export type PortProgressStatus = 'start' | 'ok' | 'fail' | 'blocked' | 'heartbeat' | 'done';

/** Upstream junk the port never keeps (the drift script also drops it from the range). */
export const JUNK_PATHS = ['.gjc'];
/** Conflicts here need a human review before any PR, even with a reconcile lane (§6 human-gate table). */
export const HUMAN_REVIEW_PREFIXES = ['src/release/', 'src/ship/', 'src/installer/', 'src/hooks/permission-handler/'];

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
  /** Resume on the port branch after a human resolved a blocked run (skips apply and delta). */
  resume?: boolean;
  date?: string;
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
  next: string | null;
}

interface DriftReport {
  base: string;
  head: string;
  conflicts: Array<{ status: string; path: string }>;
  leaks: Array<{ path: string; line: number; text: string }>;
  commits: unknown[];
}

class PortStop extends Error {
  constructor(readonly status: 'blocked' | 'fail', readonly phase: PortPhase, message: string, readonly next: string | null = null) {
    super(message);
  }
}

const tail = (text: string, n = 15) => text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n).join('\n');
const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const short = (sha: string) => sha.slice(0, 9);

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
}): string {
  const features = forkFeaturesSection(input.cwd);
  return [
    `# Reconcile upstream port ${short(input.base)}..${short(input.head)}`,
    '',
    'You are the reconciliation lane of `omg port drive`. Work only in this worktree; it starts at the fork commit before the port.',
    '',
    '## Steps',
    `1. Apply the range: \`node ${DRIFT_SCRIPT} --apply --head ${input.head}\`. Exit 1 (conflicts) is expected.`,
    '2. Resolve every conflicted file listed below per `.omc/skills/port-upstream.md` (range diff, rename map, DO-NOT-RENAME):',
    '   - Keep the fork-owned files and logic in "Fork Features to Preserve" (copied below).',
    '   - Our own fixes returning from upstream: take THEIRS, re-apply the rename map, and delete the fork\'s earlier variant. Upstream text is canonical.',
    '   - Keep fork version stamps; package.json stays excluded (its delta is a human decision).',
    '3. No conflict markers may remain. `git add` each resolved file. Run `node node_modules/typescript/bin/tsc --noEmit` and `node node_modules/eslint/bin/eslint.js <changed src files>`: 0 errors.',
    '4. Commit once in this worktree: `git commit --no-verify -m "port: reconcile upstream conflicts"`. The engine adopts that tree, runs the gates and makes the port commit.',
    '',
    '## Never',
    '- push, open PRs, run `npm ci` / `npm install` / `npm run build`, `git worktree remove|prune`, `git reset --hard`, force anything, or edit files outside the conflict list unless a gate needs it.',
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
  const { exec, cwd } = opts;
  const node = opts.node ?? process.execPath;
  const remote = opts.remote ?? 'origin';
  const prBase = opts.base ?? 'dev';
  const push = opts.push !== false;
  const git = (...args: string[]) => exec('git', args, { cwd });
  const script = (...args: string[]) => exec(node, args, { cwd });
  const exists = (p: string) => existsSync(isAbsolute(p) ? p : join(cwd, p));
  const result: PortDriveResult = {
    status: 'fail', exitCode: 1, message: '', branch: null, upstreamHead: null, blockers: [], brief: null,
    packageDelta: [], gates: [], commits: [], pr: null, laneCredits: null, next: null,
  };
  let phase: PortPhase = 'preflight';
  const begin = (p: PortPhase, note: string) => { phase = p; opts.progress(p, 'start', note); };
  const ok = (note: string) => { opts.progress(phase, 'ok', note); opts.log(`${phase}: ${note}`); };
  const gitOk = (args: string[], what = `git ${args.join(' ')}`) => {
    const r = git(...args);
    if (r.status !== 0) throw new PortStop('fail', phase, `${what} failed: ${tail(r.stderr || r.stdout, 5)}`);
    return r.stdout;
  };

  try {
    // preflight
    begin('preflight', opts.head);
    const head = git('rev-parse', '--verify', '--quiet', `${opts.head}^{commit}`).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(head)) throw new PortStop('fail', phase, `upstream head ${JSON.stringify(opts.head)} is not a commit here; fetch upstream first (git fetch upstream dev)`);
    result.upstreamHead = head;
    const branch = `port/upstream-${short(head)}`;
    result.branch = branch;
    const portDir = join(getOmcRoot(cwd), 'port', short(head));
    const progressFile = opts.progressFile || process.env.OMG_PROGRESS_FILE || join(getOmcRoot(cwd), 'progress', 'port.log');
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
    const preApply = gitOk(['rev-parse', 'HEAD']).trim();
    ok(`${branch} at ${short(preApply)}`);

    // apply (+ report: conflicts, leaks, the range base)
    begin('apply', short(head));
    if (!opts.resume) {
      const applied = script(DRIFT_SCRIPT, '--apply', '--head', head, ...(opts.date ? ['--date', opts.date] : []));
      if (applied.status !== 0 && applied.status !== 1) throw new PortStop('fail', phase, `${DRIFT_SCRIPT} --apply failed (exit ${applied.status}): ${tail(applied.stderr || applied.stdout, 5)}`);
    }
    const reported = script(DRIFT_SCRIPT, '--report', '--head', head);
    if (reported.status !== 0) throw new PortStop('fail', phase, `${DRIFT_SCRIPT} --report failed: ${tail(reported.stderr, 5)}`);
    const report = JSON.parse(reported.stdout) as DriftReport;
    const rangeBase = report.base;
    ok(`${short(rangeBase)}..${short(head)}: ${report.commits.length} commits, ${report.conflicts.length} conflicts${opts.resume ? ' (resumed, apply skipped)' : ''}`);

    // junk
    begin('junk', JUNK_PATHS.join(','));
    const junk = lines(git('diff', '--cached', '--name-only', '--', ...JUNK_PATHS).stdout);
    if (junk.length > 0) gitOk(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...JUNK_PATHS]);
    ok(junk.length > 0 ? `unstaged ${junk.length} junk file(s): ${junk.slice(0, 5).join(', ')}` : 'none');

    // delta
    begin('delta', 'package.json');
    const blockers: string[] = [];
    if (!opts.resume) {
      const d = script(DRIFT_SCRIPT, '--package-delta', '--head', head, '--json');
      if (d.status !== 0 && d.status !== 1) throw new PortStop('fail', phase, `${DRIFT_SCRIPT} --package-delta failed: ${tail(d.stderr, 5)}`);
      result.packageDelta = (JSON.parse(d.stdout) as { changes: PackageChange[] }).changes;
      const human = result.packageDelta.filter((c) => c.action === 'human');
      if (result.packageDelta.length > 0) {
        mkdirSync(portDir, { recursive: true });
        writeFileSync(join(portDir, 'package-delta.json'), `${JSON.stringify(result.packageDelta, null, 2)}\n`);
      }
      if (human.length > 0) {
        blockers.push(`package.json delta needs a human: ${human.map((c) => c.key).join(', ')} (${join(portDir, 'package-delta.json')}); port it by hand and stage package.json + package-lock.json`);
      }
      ok(`${result.packageDelta.length} change(s), ${human.length} for a human`);
    } else {
      ok('skipped on --continue (the human handled it)');
    }

    // reconcile + the rest of the human-gate table
    begin('reconcile', `${report.conflicts.length} conflicts`);
    if (report.leaks.length > 0) {
      blockers.push(`leak sweep: ${report.leaks.length} new oh-my-claudecode line(s), first ${report.leaks[0].path}:${report.leaks[0].line}`);
    }
    const conflicts = report.conflicts;
    if (conflicts.length > 0) {
      mkdirSync(portDir, { recursive: true });
      const brief = join(portDir, 'brief.md');
      writeFileSync(brief, renderReconcileBrief({ cwd, base: rangeBase, head, conflicts, progressFile }));
      result.brief = brief;
      const sensitive = conflicts.filter((c) => HUMAN_REVIEW_PREFIXES.some((p) => c.path.startsWith(p)));
      if (sensitive.length > 0) {
        blockers.push(`reconcile: ${conflicts.length} files, ${sensitive.length} need human review (${sensitive.slice(0, 3).map((c) => c.path).join(', ')}); brief ${brief}`);
      } else if (!opts.reconcileLane || !opts.lanes) {
        blockers.push(`reconcile: ${conflicts.length} files; brief ${brief} (run it with --reconcile-lane --max-credits <n>, or resolve by hand)`);
      } else if (blockers.length === 0) {
        // Paid lane only when nothing else would stop the run anyway.
        const lane = await runReconcileLane(opts.lanes(), opts.reconcileLane, { cwd, preApply, head, brief, progress: (s, n) => opts.progress('reconcile', s, n) });
        result.laneCredits = lane.usage.credits;
        adoptLaneTree(git, gitOk, preApply, lane.headSha as string, conflicts.map((c) => c.path));
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

    // commit, inventory last
    begin('commit', branch);
    if (staged.length === 0) throw new PortStop('fail', phase, 'nothing staged: the range is already ported');
    gitOk(['commit', '--no-verify', '-q', '-m', `port: upstream ${short(rangeBase)}..${short(head)} (omg port drive)`,
      '-m', `Applied by ${DRIFT_SCRIPT} --apply --head ${head}${result.laneCredits !== null ? '; conflicts reconciled by a lane' : ''}.`]);
    result.commits.push(gitOk(['rev-parse', 'HEAD']).trim());
    if (script(INVENTORY_SCRIPT, '--verify').status !== 0) {
      const written = script(INVENTORY_SCRIPT, '--write');
      if (written.status !== 0) throw new PortStop('fail', phase, `inventory --write failed: ${tail(written.stderr || written.stdout, 5)}`);
      gitOk(['add', '--', INVENTORY_DIR]);
      if (git('diff', '--cached', '--quiet', '--', INVENTORY_DIR).status !== 0) {
        gitOk(['commit', '--no-verify', '-q', '-m', INVENTORY_COMMIT_MESSAGE, '--', INVENTORY_DIR]);
        result.commits.push(gitOk(['rev-parse', 'HEAD']).trim());
      }
      const verified = script(INVENTORY_SCRIPT, '--verify');
      if (verified.status !== 0) throw new PortStop('fail', phase, `inventory still fails --verify: ${tail(verified.stderr || verified.stdout, 5)}`);
    }
    ok(`${result.commits.length} commit(s), inventory last`);

    // push + draft PR; the merge stays human
    begin('pr', push ? `${remote} ${branch}` : 'push skipped');
    if (!push) {
      ok('committed locally; --no-push');
      return finish(result, 'done', `port ${short(rangeBase)}..${short(head)} committed on ${branch} (not pushed)`, `git push ${remote} HEAD:refs/heads/${branch}`, opts);
    }
    gitOk(['push', remote, `HEAD:refs/heads/${branch}`], `git push ${remote} ${branch}`);
    const md = script(DRIFT_SCRIPT, '--report', '--base', rangeBase, '--head', head, '--markdown');
    mkdirSync(portDir, { recursive: true });
    const bodyFile = join(portDir, 'pr-body.md');
    writeFileSync(bodyFile, `${md.status === 0 ? md.stdout : ''}\n### omg port drive\n\n- gates: ${result.gates.join(', ')}\n- reconcile lane: ${result.laneCredits === null ? 'not used' : `${result.laneCredits.toFixed(2)} AI credits`}\n- merge: a human merges this PR\n`);
    const title = `port: upstream ${short(rangeBase)}..${short(head)}`;
    const pr = exec('gh', ['pr', 'create', '--draft', '--base', prBase, '--head', branch, '--title', title, '--body-file', bodyFile], { cwd });
    if (pr.status !== 0) throw new PortStop('fail', phase, `gh pr create failed: ${tail(pr.stderr || pr.stdout, 5)}`, `gh pr create --draft --base ${prBase} --head ${branch} --title "${title}" --body-file ${bodyFile}`);
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

async function runReconcileLane(
  lanes: LaneBackend,
  cap: ReconcileLaneOptions,
  ctx: { cwd: string; preApply: string; head: string; brief: string; progress: (s: PortProgressStatus, note: string) => void },
): Promise<LaneResult> {
  if (!(cap.maxCredits > 0)) throw new PortStop('fail', 'reconcile', 'the reconcile lane needs a positive --max-credits cap');
  ctx.progress('heartbeat', `starting reconcile lane (cap ${cap.maxCredits} AI credits)`);
  const { remoteId } = await lanes.start({
    laneId: `port-${short(ctx.head)}`, cwd: ctx.cwd, baseRef: ctx.preApply, prompt: readFileSync(ctx.brief, 'utf8'),
    profile: 'write', timeoutMs: cap.timeoutMs, maxCredits: cap.maxCredits, ...(cap.model ? { model: cap.model } : {}),
  });
  const lane = await lanes.wait(remoteId, cap.timeoutMs);
  if (lane.state !== 'completed' || !lane.headSha || lane.headSha === ctx.preApply) {
    throw new PortStop('blocked', 'reconcile', `reconcile lane ${remoteId} ended ${lane.state}${lane.error ? `: ${lane.error}` : ''} without a commit; resolve by hand per ${ctx.brief}`, `omg port drive --head ${ctx.head} --continue`);
  }
  return lane;
}

/**
 * Make the index and worktree equal the lane's committed tree on every path
 * the port or the lane touched, without a reset: checkout the lane's version,
 * or remove the path when the lane deleted it. Proven by `git write-tree`.
 */
function adoptLaneTree(
  git: (...args: string[]) => { status: number; stdout: string; stderr: string },
  gitOk: (args: string[], what?: string) => string,
  preApply: string,
  laneHead: string,
  conflicted: string[],
): void {
  if (git('merge-base', '--is-ancestor', preApply, laneHead).status !== 0) {
    throw new PortStop('fail', 'reconcile', `lane head ${short(laneHead)} does not descend from ${short(preApply)}`);
  }
  const markers = git('grep', '-l', '-E', '^(<<<<<<<|>>>>>>>) ', laneHead, '--', ...conflicted);
  if (markers.status === 0) throw new PortStop('blocked', 'reconcile', `lane left conflict markers: ${lines(markers.stdout).map((l) => l.slice(laneHead.length + 1)).join(', ')}`);
  const paths = [...new Set([
    ...lines(gitOk(['diff', '--name-only', '--no-renames', preApply, laneHead])),
    ...lines(gitOk(['diff', '--cached', '--name-only', '--no-renames'])),
    ...conflicted,
  ])].sort();
  const keep: string[] = [];
  for (const p of paths) {
    if (git('cat-file', '-e', `${laneHead}:${p}`).status === 0) keep.push(p);
    else gitOk(['rm', '-q', '-f', '--ignore-unmatch', '--', p]);
  }
  for (let i = 0; i < keep.length; i += 100) gitOk(['checkout', laneHead, '--', ...keep.slice(i, i + 100)]);
  const tree = gitOk(['write-tree']).trim();
  const laneTree = gitOk(['rev-parse', `${laneHead}^{tree}`]).trim();
  if (tree !== laneTree) throw new PortStop('fail', 'reconcile', `adopted index ${short(tree)} differs from the lane tree ${short(laneTree)}`);
}
