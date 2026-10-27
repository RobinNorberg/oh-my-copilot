/**
 * `omg factory heal scan|status` (experimental, design §10 PR 1). The scan
 * polls CI runs on the integration branch, computes failure signatures,
 * classifies new red runs deterministically and records them in heal state.
 * It makes no LLM call and no GitHub write: every command goes through
 * healGuardExec, and a rerun probe is recorded as an intent only.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { parseKnownFlaky, type KnownFlakyTest } from '../../ship/config.js';
import type { Exec } from '../../ship/exec.js';
import { classifyRun, type ClassifyJobInput, type HealClassification, type HistoryEntry, type JobSample } from './classify.js';
import { HEAL_WORKFLOW, type HealConfig } from './config.js';
import { healGuardExec, jobLog, listRuns, shaRange, viewRunJobs, type HealJob, type HealRun } from './history.js';
import { parseJob, type ParsedJob } from './logs.js';
import { runSignature } from './signature.js';
import { foldSignature, listHealStates, readDailyCounters, readHealState, SIG8, writeHealState, type HealSignatureState } from './state.js';

/** Bounds on one scan's GitHub reads (CI logs run to megabytes each). */
export const SCAN_LIMITS = Object.freeze({
  runList: 30,
  pushCandidates: 3,
  prRuns: 6,
  historyRuns: 20,
  historyLogs: 5,
  greenLookups: 3,
  prWindowMs: 72 * 3_600_000,
});

export interface HealDeps {
  exec: Exec;
  base: (root: string) => string;
  config: (root: string) => { config: HealConfig; warnings: string[] };
  now: () => Date;
}

export interface ScanEntry {
  runId: string;
  event: string;
  headBranch: string;
  sig8?: string;
  class?: string;
  reason: string;
  next?: string;
  blocked?: boolean;
  rerunIntent?: string;
  recorded?: boolean;
}

export interface ScanResult {
  base: string;
  dryRun: boolean;
  entries: ScanEntry[];
}

class HealUsageError extends Error {}

interface Ctx {
  exec: Exec;
  root: string;
  known: readonly KnownFlakyTest[];
  config: HealConfig;
  jobs: Map<string, HealJob[]>;
  logs: Map<string, ParsedJob>;
}

function runJobs(ctx: Ctx, runId: string): HealJob[] {
  let jobs = ctx.jobs.get(runId);
  if (!jobs) { jobs = viewRunJobs(ctx.exec, runId, ctx.root); ctx.jobs.set(runId, jobs); }
  return jobs;
}

function parsed(ctx: Ctx, job: HealJob): ParsedJob {
  let p = ctx.logs.get(job.jobId);
  if (!p) { p = parseJob(job, jobLog(ctx.exec, job.jobId, ctx.root), ctx.known); ctx.logs.set(job.jobId, p); }
  return p;
}

/** The run's failed jobs, split into the ones that count and the PR-policy jobs that never heal. */
function failedJobs(ctx: Ctx, run: HealRun): { counted: ParsedJob[]; ignored: string[] } {
  const failed = runJobs(ctx, run.id).filter((j) => j.conclusion === 'failure');
  const ignored = failed.filter((j) => ctx.config.ignoreJobs.includes(j.name)).map((j) => j.name);
  return { counted: failed.filter((j) => !ctx.config.ignoreJobs.includes(j.name)).map((j) => parsed(ctx, j)), ignored };
}

/** The same-named successful job in one of `runs` (newest first), parsed for its environment. */
function greenSample(ctx: Ctx, runs: readonly HealRun[], name: string): JobSample | undefined {
  for (const run of runs.slice(0, SCAN_LIMITS.greenLookups)) {
    const job = runJobs(ctx, run.id).find((j) => j.name === name && j.conclusion === 'success');
    if (job) return { runId: run.id, sha: run.headSha, job: parsed(ctx, job) };
  }
  return undefined;
}

/** Dev push history for one job, oldest first; only the newest red runs' logs are read. */
function jobHistory(ctx: Ctx, pushRuns: readonly HealRun[], name: string): HistoryEntry[] {
  const window = pushRuns.filter((r) => r.conclusion === 'success' || r.conclusion === 'failure').slice(0, SCAN_LIMITS.historyRuns);
  let budget = SCAN_LIMITS.historyLogs;
  const out: HistoryEntry[] = window.map((run) => {
    if (run.conclusion === 'success') return { runId: run.id, sha: run.headSha, green: true };
    if (budget <= 0) return { runId: run.id, sha: run.headSha, green: false };
    budget -= 1;
    const job = runJobs(ctx, run.id).find((j) => j.name === name && j.conclusion === 'failure');
    return { runId: run.id, sha: run.headSha, green: false, ...(job ? { failedTests: parsed(ctx, job).failingTests } : { failedTests: [] }) };
  });
  return out.reverse();
}

function classifyRed(ctx: Ctx, red: HealRun, jobs: ParsedJob[], greens: readonly HealRun[], allRuns: readonly HealRun[], pushRuns: readonly HealRun[]): HealClassification {
  const sig = runSignature(jobs);
  const sameShaRuns = allRuns.filter((r) => r.headSha === red.headSha && r.conclusion === 'success');
  let lastGreen: { runId: string; sha: string } | undefined;
  const inputs: ClassifyJobInput[] = jobs.map((job) => {
    const green = greenSample(ctx, greens, job.name);
    if (green && !lastGreen) lastGreen = { runId: green.runId, sha: green.sha };
    const sameShaGreen = sameShaRuns.flatMap((r) => {
      const j = runJobs(ctx, r.id).find((x) => x.name === job.name && x.conclusion === 'success');
      return j ? [{ runId: r.id, sha: r.headSha, job: parsed(ctx, j) }] : [];
    });
    return { red: { runId: red.id, sha: red.headSha, job }, ...(green ? { green } : {}), sameShaGreen, history: jobHistory(ctx, pushRuns, job.name) };
  });
  const range = lastGreen ? shaRange(ctx.exec, ctx.root, lastGreen.sha, red.headSha) : undefined;
  return classifyRun({
    signature: sig.signature,
    sig8: sig.sig8,
    firstRed: { runId: red.id, sha: red.headSha },
    ...(lastGreen ? { lastGreen } : {}),
    ...(range ? { range } : {}),
    jobs: inputs.map((i) => (range ? { ...i, range } : i)),
  });
}

function loadKnownFlaky(exec: Exec, root: string, base: string, warn: (m: string) => void): KnownFlakyTest[] {
  const file = '.github/known-flaky-tests.json';
  const r = exec('git', ['show', `refs/remotes/origin/${base}:${file}`], { cwd: root });
  if (r.status !== 0) { warn(`omg factory heal: no ${file} at origin/${base} (fetch origin first); no test counts as known-flaky`); return []; }
  return parseKnownFlaky(r.stdout, `origin/${base}:${file}`);
}

export function runHealScan(opts: { exec: Exec; root: string; base: string; config: HealConfig; now: Date; dryRun: boolean; warn: (m: string) => void }): ScanResult {
  const exec = healGuardExec(opts.exec);
  const ctx: Ctx = { exec, root: opts.root, known: loadKnownFlaky(exec, opts.root, opts.base, opts.warn), config: opts.config, jobs: new Map(), logs: new Map() };
  const completed = (r: HealRun) => r.status === 'completed';
  const pushRuns = listRuns(exec, { workflow: HEAL_WORKFLOW, event: 'push', branch: opts.base, limit: SCAN_LIMITS.runList, cwd: opts.root }).filter(completed);
  const since = opts.now.getTime() - SCAN_LIMITS.prWindowMs;
  const prRuns = listRuns(exec, { workflow: HEAL_WORKFLOW, event: 'pull_request', limit: SCAN_LIMITS.runList, cwd: opts.root })
    .filter((r) => completed(r) && Date.parse(r.createdAt) >= since);
  const allRuns = [...pushRuns, ...prRuns];
  const states = listHealStates(opts.root);
  const seen = new Set(states.flatMap((s) => s.seenRuns));
  const counters = readDailyCounters(opts.root, opts.now);
  const entries: ScanEntry[] = [];
  const pending = new Map(states.map((s) => [s.sig8, s] as const));

  const record = (run: HealRun, c: HealClassification, source: 'push' | 'pr', prBranches?: string[]) => {
    const prev = pending.get(c.sig8) ?? null;
    const { state, changed, suppressed } = foldSignature(prev, { classification: c, runId: run.id, source, ...(prBranches ? { prBranches } : {}) }, [...pending.values()], counters, opts.config, opts.now);
    if (changed) pending.set(state.sig8, state);
    if (changed && !opts.dryRun) writeHealState(opts.root, state);
    const reasons = [...new Set(c.jobs.map((j) => `${j.job}: ${j.reason}`))].join('; ');
    entries.push({
      runId: run.id, event: run.event, headBranch: run.headBranch, sig8: c.sig8, class: state.class,
      reason: suppressed ? `count only (${state.healRun?.open ? 'heal run open' : "recent won't-fix"}); ${reasons}` : reasons,
      next: state.next, blocked: state.blocked === 'rate-limit',
      ...(state.rerunIntents[0] ? { rerunIntent: `${state.rerunIntents[0].command} (recorded, not issued)` } : {}),
      recorded: changed && !opts.dryRun,
    });
  };
  const skip = (run: HealRun, reason: string) => entries.push({ runId: run.id, event: run.event, headBranch: run.headBranch, reason });

  // Rule 1: a red push run on the base branch (cancelled, skipped and in-progress runs never count).
  const redPush = pushRuns.filter((r) => r.conclusion === 'failure' && !seen.has(r.id)).slice(0, SCAN_LIMITS.pushCandidates);
  for (const run of redPush) {
    const { counted, ignored } = failedJobs(ctx, run);
    if (counted.length === 0) { skip(run, ignored.length ? `ignored: only PR-policy job(s) failed (${ignored.join(', ')})` : 'no failed job'); continue; }
    const older = pushRuns.filter((r) => r.conclusion === 'success' && r.createdAt < run.createdAt);
    record(run, classifyRed(ctx, run, counted, older, allRuns, pushRuns), 'push');
  }

  // Rule 2: one signature on PR runs of two or more head branches; a lone PR signature only adds weight to a known one.
  const bySig = new Map<string, { runs: HealRun[]; jobs: ParsedJob[] }>();
  for (const run of prRuns.filter((r) => r.conclusion === 'failure' && !seen.has(r.id)).slice(0, SCAN_LIMITS.prRuns)) {
    const { counted, ignored } = failedJobs(ctx, run);
    if (counted.length === 0) { skip(run, ignored.length ? `ignored: only PR-policy job(s) failed (${ignored.join(', ')})` : 'no failed job'); continue; }
    const { sig8 } = runSignature(counted);
    const group = bySig.get(sig8) ?? { runs: [], jobs: counted };
    group.runs.push(run);
    bySig.set(sig8, group);
  }
  const greenPush = pushRuns.filter((r) => r.conclusion === 'success');
  for (const [sig8, group] of bySig) {
    const branches = [...new Set(group.runs.map((r) => r.headBranch))].sort();
    const known = pending.has(sig8);
    if (branches.length < 2 && !known) {
      for (const run of group.runs) skip(run, `PR signature ${sig8} seen on one head branch only (${branches.join(', ')}); needs two, or a known signature`);
      continue;
    }
    const oldest = [...group.runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const c = classifyRed(ctx, oldest[0], group.jobs, greenPush, allRuns, pushRuns);
    for (const run of oldest) record(run, c, 'pr', branches);
  }
  return { base: opts.base, dryRun: opts.dryRun, entries };
}

function renderEntry(e: ScanEntry): string {
  if (!e.sig8) return chalk.gray(`  run ${e.runId} (${e.event} ${e.headBranch}): ${e.reason}`);
  const flags = [e.next ? `next=${e.next}` : '', e.blocked ? chalk.yellow('blocked: rate-limit') : ''].filter(Boolean).join(' ');
  const lines = [`  run ${e.runId} (${e.event} ${e.headBranch}) ${chalk.bold(e.sig8)} ${chalk.cyan(e.class)} ${flags}`, `    ${e.reason}`];
  if (e.rerunIntent) lines.push(`    rerun: ${e.rerunIntent}`);
  return lines.join('\n');
}

export function renderHealState(s: HealSignatureState): string {
  const c = s.classification;
  const lines = [
    `${chalk.bold(`heal ${s.sig8}`)}  class=${chalk.cyan(s.class)}  next=${s.next}${s.blocked ? chalk.yellow('  blocked: rate-limit') : ''}  count=${s.count}  source=${s.source}`,
    `first red run ${c.firstRed.runId} @ ${c.firstRed.sha.slice(0, 9)}${c.lastGreen ? `  last green run ${c.lastGreen.runId} @ ${c.lastGreen.sha.slice(0, 9)}` : '  no green run compared'}`,
  ];
  if (c.range) lines.push(`sha range: ${c.range.commits} commit(s), ${c.range.codeFiles} code file(s)`);
  for (const j of c.jobs) {
    lines.push(`  ${j.job}: ${j.class} (${j.reason})`);
    for (const t of j.failingTests) lines.push(`    FAIL ${t.file}${t.title ? ` > ${t.title}` : ''}`);
    for (const ch of j.env.changed) lines.push(`    env ${ch.field}: ${ch.green ?? '?'} -> ${ch.red ?? '?'}`);
  }
  for (const r of s.rerunIntents) lines.push(`rerun intent: ${r.command} (recorded, not issued)`);
  return lines.join('\n');
}

async function guarded(json: boolean, fn: () => number): Promise<void> {
  try {
    process.exitCode = fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(chalk.red(`Error: ${message}`));
    process.exitCode = error instanceof HealUsageError ? 2 : 1;
  }
}

function healRoot(exec: Exec): string {
  const r = healGuardExec(exec)('git', ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) throw new HealUsageError('omg factory heal must run inside a git repository');
  return r.stdout.trim();
}

/** `omg factory heal scan|status` (experimental; no LLM, no GitHub writes). */
export function healCommand(deps: HealDeps): Command {
  const heal = new Command('heal');
  heal.description('Experimental: classify red CI runs on the integration branch (deterministic; no LLM, no GitHub writes)');

  heal
    .command('scan')
    .description('Poll CI runs, compute failure signatures and classify new red runs into heal state')
    .option('--dry-run', 'Classify and print only; write no heal state')
    .option('--json', 'JSON output')
    .action((o: { dryRun?: boolean; json?: boolean }) =>
      guarded(Boolean(o.json), () => {
        const root = healRoot(deps.exec);
        const { config, warnings } = deps.config(root);
        for (const w of warnings) console.error(chalk.yellow(w));
        const result = runHealScan({ exec: deps.exec, root, base: deps.base(root), config, now: deps.now(), dryRun: Boolean(o.dryRun), warn: (m) => console.error(chalk.yellow(m)) });
        if (o.json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        else {
          console.log(`${chalk.bold('factory heal scan')}  base=${result.base}${result.dryRun ? '  (dry run: no state written)' : ''}`);
          if (result.entries.length === 0) console.log(chalk.green('  no new red runs'));
          for (const e of result.entries) console.log(renderEntry(e));
        }
        return 0;
      }));

  heal
    .command('status [sig8]')
    .description('Print recorded heal signatures, or one signature\'s classification (read-only)')
    .option('--json', 'JSON output')
    .action((sig8: string | undefined, _o: unknown, c: Command) =>
      guarded(Boolean(c.optsWithGlobals().json), () => {
        const json = Boolean(c.optsWithGlobals().json);
        const root = healRoot(deps.exec);
        if (sig8 !== undefined) {
          if (!SIG8.test(sig8)) throw new HealUsageError(`signature id must be 8 hex characters, got ${JSON.stringify(sig8)}`);
          const state = readHealState(root, sig8);
          if (!state) throw new HealUsageError(`no heal signature ${sig8}`);
          console.log(json ? JSON.stringify(state, null, 2) : renderHealState(state));
          return 0;
        }
        const states = listHealStates(root);
        if (json) console.log(JSON.stringify({ ok: true, signatures: states }, null, 2));
        else if (states.length === 0) console.log('no heal signatures recorded');
        else for (const s of states) console.log(`${s.sig8}  ${s.class.padEnd(17)} count=${s.count}  next=${s.next}${s.blocked ? '  blocked: rate-limit' : ''}  last run ${s.lastSeen.runId}`);
        return 0;
      }));
  return heal;
}
