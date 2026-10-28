/**
 * `omg factory heal scan|status|run|approve|cancel|close` (experimental,
 * design §10 PR 1-3). The scan polls CI runs on the integration branch,
 * computes failure signatures, classifies new red runs deterministically and
 * records them in heal state. It makes no LLM call and no GitHub write: every
 * command goes through healGuardExec, and a rerun probe is recorded as an
 * intent only. `run` starts the read-only debugger lane for one signature
 * (run.ts); `approve` runs the ci-heal run of a valid diagnosis in the
 * factory engine (implement.ts), which parks at the human merge; `cancel`
 * stops it; `close` lets a human close a parked heal run. A `flaky`
 * diagnosis only prints a known-flaky proposal.
 */

import { join } from 'path';
import { Command } from 'commander';
import { withFileLockSync } from '../../lib/file-lock.js';
import chalk from 'chalk';
import { parseKnownFlaky, type KnownFlakyTest } from '../../ship/config.js';
import type { Exec } from '../../ship/exec.js';
import { classifyRun, type ClassifyJobInput, type HealClassification, type HistoryEntry, type JobSample } from './classify.js';
import { HEAL_WORKFLOW, type HealConfig } from './config.js';
import { healGuardExec, jobLog, listRuns, shaRange, viewRunJobs, type HealJob, type HealRun } from './history.js';
import { parseJob, type ParsedJob } from './logs.js';
import { runSignature } from './signature.js';
import { foldSignature, healStateDir, listHealStates, pruneWebhookQueue, readDailyCounters, readHealState, readWebhookQueue, SIG8, writeHealState, type HealSignatureState } from './state.js';
import type { LaneBackend } from '../run/lane.js';
import type { LoadedFactoryRunLimits } from '../run/budget.js';
import type { FactoryRunOutcome } from '../run/engine.js';
import type { GateConfigLoader } from '../run/prepare.js';
import { factoryCancelRequested, healRunKey, readFactoryState, requestFactoryCancel } from '../run/state.js';
import { knownFlakyProposal, renderKnownFlakyProposal, runHealEngine, type HealEngineDeps } from './implement.js';
import { closeHeal, HealRunRefused, EXIT_HEAL_REFUSED, readHealScanRecord, runHeal, verifyHealSeal, writeHealScanRecord, type HealRunDeps } from './run.js';

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
  /** The debugger lane backend (`omg factory heal run` without --dry-run is the opt-in to a billed lane). */
  lanes: (root: string) => LaneBackend;
  /** Out-of-repository heal ledger directory (counters mirror, seals). */
  ledgerDir: string;
  /** Test seams for `heal run`. */
  run?: Pick<HealRunDeps, 'clock' | 'pollMs' | 'confinement' | 'delimiter' | 'env' | 'warn'>;
  /** `factory.run` limits of the ci-heal run (`heal approve`, `heal cancel`). */
  runLimits: (root: string) => LoadedFactoryRunLimits;
  gateConfig?: GateConfigLoader;
  /** Test seams of the factory engine. */
  engine?: HealEngineDeps['engine'];
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
  /** Webhook-queued runs still waiting (not in the listed window yet). */
  queued: number;
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

/** `ledgerDir`: the out-of-repository heal ledger directory, where the scan-time class and classification are kept. */
type ScanOpts = { exec: Exec; root: string; base: string; config: HealConfig; now: Date; dryRun: boolean; warn: (m: string) => void; ledgerDir: string; lockTimeoutMs?: number };

/** One writing scan at a time: the read-fold-write of heal state is held under a lock file. */
export function runHealScan(opts: ScanOpts): ScanResult {
  if (opts.dryRun) return scanOnce(opts);
  return withFileLockSync(join(healStateDir(opts.root), 'scan.lock'), () => scanOnce(opts), { timeoutMs: opts.lockTimeoutMs ?? 60_000 });
}

function scanOnce(opts: ScanOpts): ScanResult {
  const exec = healGuardExec(opts.exec);
  const ctx: Ctx = { exec, root: opts.root, known: loadKnownFlaky(exec, opts.root, opts.base, opts.warn), config: opts.config, jobs: new Map(), logs: new Map() };
  const completed = (r: HealRun) => r.status === 'completed';
  const pushRuns = listRuns(exec, { workflow: HEAL_WORKFLOW, event: 'push', branch: opts.base, limit: SCAN_LIMITS.runList, cwd: opts.root }).filter(completed);
  const since = opts.now.getTime() - SCAN_LIMITS.prWindowMs;
  const prRuns = listRuns(exec, { workflow: HEAL_WORKFLOW, event: 'pull_request', limit: SCAN_LIMITS.runList, cwd: opts.root })
    .filter((r) => completed(r) && Date.parse(r.createdAt) >= since);
  const allRuns = [...pushRuns, ...prRuns];
  const states = listHealStates(opts.root);
  // A signature without a valid scan-time record outside the repository has its runs classified again from GitHub.
  const unrecorded = new Set(opts.dryRun ? [] : states.filter((s) => !readHealScanRecord(opts.ledgerDir, opts.root, s.sig8)).map((s) => s.sig8));
  const seen = new Set(states.filter((s) => !unrecorded.has(s.sig8)).flatMap((s) => s.seenRuns));
  const counters = readDailyCounters(opts.root, opts.now);
  const entries: ScanEntry[] = [];
  const pending = new Map(states.map((s) => [s.sig8, s] as const));

  const record = (run: HealRun, c: HealClassification, source: 'push' | 'pr', prBranches?: string[]) => {
    const prev = pending.get(c.sig8) ?? null;
    if (prev?.seenRuns.includes(run.id)) {
      // An already counted run only restores the missing scan-time record (a PR run never replaces a push one).
      const restore = unrecorded.has(c.sig8) && (prev.source !== 'push' || source === 'push');
      if (restore) {
        writeHealScanRecord(opts.ledgerDir, opts.root, { sig8: c.sig8, class: c.class, classification: c });
        unrecorded.delete(c.sig8);
      }
      entries.push({ runId: run.id, event: run.event, headBranch: run.headBranch, sig8: c.sig8, class: c.class, reason: restore ? 'already counted; scan-time classification recorded outside the repository again' : 'already counted', next: prev.next, recorded: restore });
      return;
    }
    const { state, changed, suppressed } = foldSignature(prev, { classification: c, runId: run.id, source, ...(prBranches ? { prBranches } : {}) }, [...pending.values()], counters, opts.config, opts.now);
    if (changed) pending.set(state.sig8, state);
    if (changed && !opts.dryRun) {
      writeHealState(opts.root, state);
      // Only a classification derived from GitHub data in this scan goes to the out-of-repo record.
      if (!suppressed && state.classification === c) {
        writeHealScanRecord(opts.ledgerDir, opts.root, state);
        unrecorded.delete(c.sig8);
      }
    }
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
  // Skipped runs never enter seenRuns, so only runs that reach classification use a candidate slot.
  let pushSlots = SCAN_LIMITS.pushCandidates;
  // Runs the webhook enqueued take the first slots; every other fact about them comes from gh, not the payload.
  const queued = new Set(readWebhookQueue(opts.root).map((q) => q.runId));
  const candidates = pushRuns.filter((r) => r.conclusion === 'failure' && !seen.has(r.id));
  for (const run of [...candidates.filter((r) => queued.has(r.id)), ...candidates.filter((r) => !queued.has(r.id))]) {
    if (pushSlots <= 0) break;
    const { counted, ignored } = failedJobs(ctx, run);
    if (counted.length === 0) { skip(run, ignored.length ? `ignored: only PR-policy job(s) failed (${ignored.join(', ')})` : 'no failed job'); continue; }
    pushSlots -= 1;
    const older = pushRuns.filter((r) => r.conclusion === 'success' && r.createdAt < run.createdAt);
    record(run, classifyRed(ctx, run, counted, older, allRuns, pushRuns), 'push');
  }

  // Rule 2: one signature on PR runs of two or more head branches; a lone PR signature only adds weight to a known one.
  const bySig = new Map<string, { runs: HealRun[]; jobs: ParsedJob[] }>();
  // The cap counts distinct signatures; policy-only runs use none.
  for (const run of prRuns.filter((r) => r.conclusion === 'failure' && !seen.has(r.id))) {
    const { counted, ignored } = failedJobs(ctx, run);
    if (counted.length === 0) { skip(run, ignored.length ? `ignored: only PR-policy job(s) failed (${ignored.join(', ')})` : 'no failed job'); continue; }
    const { sig8 } = runSignature(counted);
    if (!bySig.has(sig8) && bySig.size >= SCAN_LIMITS.prRuns) continue;
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
  // A queued run the scan listed is handled (or skipped by the rules above); one beyond the list window expires.
  const listed = new Set([...seen, ...allRuns.map((r) => r.id)]);
  const left = opts.dryRun ? [...queued].filter((id) => !listed.has(id)).length : pruneWebhookQueue(opts.root, listed, opts.now).length;
  return { base: opts.base, dryRun: opts.dryRun, entries, queued: left };
}

/** Text from CI logs, lane output or a state file, safe for the terminal: control and format characters become spaces. */
export const termSafe = (v: unknown): string => String(v).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');

function renderEntry(e: ScanEntry): string {
  const t = termSafe;
  if (!e.sig8) return chalk.gray(`  run ${t(e.runId)} (${t(e.event)} ${t(e.headBranch)}): ${t(e.reason)}`);
  const flags = [e.next ? `next=${t(e.next)}` : '', e.blocked ? chalk.yellow('blocked: rate-limit') : ''].filter(Boolean).join(' ');
  const lines = [`  run ${t(e.runId)} (${t(e.event)} ${t(e.headBranch)}) ${chalk.bold(t(e.sig8))} ${chalk.cyan(t(e.class))} ${flags}`, `    ${t(e.reason)}`];
  if (e.rerunIntent) lines.push(`    rerun: ${t(e.rerunIntent)}`);
  return lines.join('\n');
}

export function renderHealState(s: HealSignatureState): string {
  const c = s.classification;
  const t = termSafe;
  // Line 0 carries chalk escapes, so its state values are made safe one by one; every later line is plain text.
  const head = `${chalk.bold(`heal ${t(s.sig8)}`)}  class=${chalk.cyan(t(s.class))}  next=${t(s.next)}${s.blocked ? chalk.yellow('  blocked: rate-limit') : ''}  count=${t(s.count)}  source=${t(s.source)}`;
  const lines = [
    `first red run ${c.firstRed.runId} @ ${c.firstRed.sha.slice(0, 9)}${c.lastGreen ? `  last green run ${c.lastGreen.runId} @ ${c.lastGreen.sha.slice(0, 9)}` : '  no green run compared'}`,
  ];
  if (c.range) lines.push(`sha range: ${c.range.commits} commit(s), ${c.range.codeFiles} code file(s)`);
  for (const j of c.jobs) {
    lines.push(`  ${j.job}: ${j.class} (${j.reason})`);
    for (const t of j.failingTests) lines.push(`    FAIL ${t.file}${t.title ? ` > ${t.title}` : ''}`);
    for (const ch of j.env.changed) lines.push(`    env ${ch.field}: ${ch.green ?? '?'} -> ${ch.red ?? '?'}`);
  }
  for (const r of s.rerunIntents) lines.push(`rerun intent: ${r.command} (recorded, not issued)`);
  if (s.healRun) lines.push(`heal run ${s.healRun.id} ${s.healRun.open ? 'open' : 'closed'} since ${s.healRun.startedAt}`);
  for (const l of s.lanes ?? []) {
    lines.push(`  lane ${l.id} ${l.status} cap ${l.maxCredits}${l.usage ? ` spent ${Number(l.usage.credits).toFixed(2)} (${l.usage.source})` : ''} confinement=${l.confinement}${l.unconfinedOptIn ? ' (OMG_HEAL_UNCONFINED=1)' : ''}${l.note ? ` (${l.note})` : ''}`);
  }
  const d = s.diagnosis;
  if (d) {
    lines.push(`diagnosis ${d.outcome}${d.reason ? `: ${d.reason}` : ''} (lane output derived from untrusted CI logs)`);
    if (d.diagnosis) {
      lines.push(`  class ${d.diagnosis.class}  reproduced=${d.diagnosis.reproduced}${d.diagnosis.reproCommand ? `  repro: ${d.diagnosis.reproCommand}` : ''}`);
      lines.push(`  root cause: ${d.diagnosis.rootCause.replace(/\s+/g, ' ').slice(0, 500)}`);
      lines.push(`  evidence: ${d.diagnosis.evidence.join(', ')}`);
      if (d.diagnosis.fix) lines.push(`  fix: ${d.diagnosis.fix.summary.replace(/\s+/g, ' ').slice(0, 300)} [${d.diagnosis.fix.files.join(', ')}]`);
    }
  }
  const proposal = knownFlakyProposal(s);
  if (proposal) lines.push(...renderKnownFlakyProposal(proposal).split('\n'));
  return [head, ...lines.map(t)].join('\n');
}

/** A ci-heal run's engine outcome; the merge command is printed for the human, never run. */
function printEngineOutcome(json: boolean, sig8: string, outcome: FactoryRunOutcome): void {
  if (json) {
    console.log(JSON.stringify({ ok: outcome.exitCode === 0, sig8, ...outcome }, null, 2));
    return;
  }
  const s = outcome.state;
  if (s) console.log(`${chalk.bold(`ci-heal heal-${sig8}`)}  phase=${chalk.cyan(s.phase)}  branch=${s.branch}${s.pr ? `  PR #${s.pr}` : ''}  lanes ${s.lanes.length}`);
  const color = outcome.exitCode === 0 ? chalk.green : outcome.exitCode === 1 ? chalk.red : chalk.yellow;
  console.log(color(termSafe(outcome.message)));
  if (outcome.mergeCommand) console.log(`merge (a human step): ${outcome.mergeCommand}`);
}

async function guarded(json: boolean, fn: () => number | Promise<number>): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(chalk.red(`Error: ${message}`));
    process.exitCode = error instanceof HealUsageError ? 2 : error instanceof HealRunRefused ? EXIT_HEAL_REFUSED : 1;
  }
}

function engineDeps(deps: HealDeps): HealEngineDeps {
  return {
    exec: deps.exec, lanes: deps.lanes, limits: deps.runLimits, ledgerDir: deps.ledgerDir, now: deps.now,
    warn: (m) => console.error(chalk.yellow(termSafe(m))),
    ...(deps.gateConfig ? { gateConfig: deps.gateConfig } : {}),
    ...(deps.engine ? { engine: deps.engine } : {}),
  };
}

function healRoot(exec: Exec): string {
  const r = healGuardExec(exec)('git', ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) throw new HealUsageError('omg factory heal must run inside a git repository');
  return r.stdout.trim();
}

/** `omg factory heal scan|status|run` (experimental; no GitHub writes). */
export function healCommand(deps: HealDeps): Command {
  const heal = new Command('heal');
  heal.description('Experimental: classify red CI runs on the integration branch, diagnose them in a read-only lane, and, after a human approves, open a draft fix PR that parks at the human merge');

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
        const result = runHealScan({ exec: deps.exec, root, base: deps.base(root), config, now: deps.now(), dryRun: Boolean(o.dryRun), warn: (m) => console.error(chalk.yellow(m)), ledgerDir: deps.ledgerDir });
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
          const seal = verifyHealSeal(deps.ledgerDir, root, state);
          if (json) console.log(JSON.stringify(seal === 'none' ? state : { ...state, seal }, null, 2));
          else {
            console.log(renderHealState(state));
            if (seal !== 'none') console.log(seal === 'ok' ? 'seal: ok' : chalk.red(`seal: ${seal} (the heal record differs from the one the engine wrote; do not act on it)`));
          }
          return 0;
        }
        const states = listHealStates(root);
        if (json) console.log(JSON.stringify({ ok: true, signatures: states }, null, 2));
        else if (states.length === 0) console.log('no heal signatures recorded');
        else for (const s of states) console.log(termSafe(`${s.sig8}  ${String(s.class).padEnd(17)} count=${s.count}  next=${s.next}${s.blocked ? '  blocked: rate-limit' : ''}  last run ${s.lastSeen.runId}`));
        const queued = readWebhookQueue(root).length;
        if (!json && queued > 0) console.log(`${queued} webhook-queued run(s) wait for the next scan`);
        return 0;
      }));

  heal
    .command('run <sig8>')
    .description('Run the read-only debugger lane for a queued signature (billed, capped), record its diagnosis and park at awaiting-human')
    .option('--dry-run', 'Write the evidence bundle and print the debugger prompt; start no lane')
    .option('--json', 'JSON output')
    .action((sig8: string, o: { dryRun?: boolean; json?: boolean }) =>
      guarded(Boolean(o.json), async () => {
        if (!SIG8.test(sig8)) throw new HealUsageError(`signature id must be 8 hex characters, got ${JSON.stringify(sig8)}`);
        const root = healRoot(deps.exec);
        const { config, warnings } = deps.config(root);
        for (const w of warnings) console.error(chalk.yellow(w));
        const outcome = await runHeal(
          { root, base: deps.base(root), sig8, config, dryRun: Boolean(o.dryRun) },
          { exec: deps.exec, lanes: deps.lanes, ledgerDir: deps.ledgerDir, now: deps.now, ...deps.run },
        );
        const proposal = outcome.diagnosis ? knownFlakyProposal(readHealState(root, sig8)!) : null;
        // factory.heal.autoImplement (user config only): a valid diagnosis goes on into the ci-heal run (billed write lanes).
        const ciHeal = !o.dryRun && outcome.next === 'heal-approve' && config.autoImplement
          ? await runHealEngine({ root, base: deps.base(root), sig8, config, approved: false }, engineDeps(deps))
          : undefined;
        if (o.json) console.log(JSON.stringify({ ok: true, ...outcome, ...(proposal ? { knownFlakyProposal: proposal } : {}), ...(ciHeal ? { ciHeal } : {}) }, null, 2));
        else {
          if (outcome.prompt) console.log(outcome.prompt);
          console.log(`${chalk.bold(`factory heal run ${sig8}`)}  ${termSafe(outcome.message)}`);
          console.log(`  evidence: ${outcome.bundleDir}`);
          if (outcome.lane) console.log(`  lane ${outcome.lane.id} ${outcome.lane.status}, ${outcome.lane.usage?.credits.toFixed(2) ?? '?'} of ${outcome.lane.maxCredits} AI credits`);
          if (proposal) console.log(renderKnownFlakyProposal(proposal).split('\n').map(termSafe).join('\n'));
          if (ciHeal) printEngineOutcome(false, sig8, ciHeal);
        }
        return ciHeal ? ciHeal.exitCode : outcome.exitCode;
      }));

  heal
    .command('approve <sig8>')
    .description('A human approves a valid diagnosis: run the ci-heal run (implement, draft PR, review, prepare, CI gates) and park at the human merge; also resumes a parked ci-heal run')
    .option('--dry-run', 'Print what the ci-heal run would do next; no state, lanes or pushes')
    .option('--json', 'JSON output')
    .action((sig8: string, o: { dryRun?: boolean; json?: boolean }) =>
      guarded(Boolean(o.json), async () => {
        if (!SIG8.test(sig8)) throw new HealUsageError(`signature id must be 8 hex characters, got ${JSON.stringify(sig8)}`);
        const root = healRoot(deps.exec);
        const { config, warnings } = deps.config(root);
        for (const w of warnings) console.error(chalk.yellow(w));
        const outcome = await runHealEngine({ root, base: deps.base(root), sig8, config, approved: true, dryRun: Boolean(o.dryRun) }, engineDeps(deps));
        printEngineOutcome(Boolean(o.json), sig8, outcome);
        return outcome.exitCode;
      }));

  heal
    .command('cancel <sig8>')
    .description('Cancel the ci-heal run of a signature: a running engine stops its lane; a parked run is cancelled now (the PR, branch and worktrees are kept)')
    .option('--json', 'JSON output')
    .action((sig8: string, o: { json?: boolean }) =>
      guarded(Boolean(o.json), async () => {
        if (!SIG8.test(sig8)) throw new HealUsageError(`signature id must be 8 hex characters, got ${JSON.stringify(sig8)}`);
        const root = healRoot(deps.exec);
        const key = healRunKey(sig8);
        if (!readFactoryState(root, key)) throw new HealRunRefused(`heal ${sig8} has no ci-heal run (omg factory heal close ${sig8} closes a parked heal run)`);
        requestFactoryCancel(root, key, deps.now().toISOString());
        const { config } = deps.config(root);
        let outcome: FactoryRunOutcome;
        try {
          // The engine sees the cancel request file first and only cancels.
          outcome = await runHealEngine({ root, base: deps.base(root), sig8, config, approved: false }, engineDeps(deps));
        } catch (error) {
          if (!/already running/.test(error instanceof Error ? error.message : '') || !factoryCancelRequested(root, key)) throw error;
          if (o.json) console.log(JSON.stringify({ ok: true, sig8, cancelRequested: true }, null, 2));
          else console.log(chalk.green(`cancel requested for ci-heal heal-${sig8}; the running engine stops within seconds`));
          return 0;
        }
        printEngineOutcome(Boolean(o.json), sig8, outcome);
        return outcome.phase === 'cancelled' ? 0 : outcome.exitCode;
      }));

  heal
    .command('close <sig8>')
    .description('Close an open heal run parked at heal-approve or heal-diagnosis (a human decision; frees the open-run slot)')
    .option('--json', 'JSON output')
    .action((sig8: string, o: { json?: boolean }) =>
      guarded(Boolean(o.json), () => {
        if (!SIG8.test(sig8)) throw new HealUsageError(`signature id must be 8 hex characters, got ${JSON.stringify(sig8)}`);
        const root = healRoot(deps.exec);
        const state = closeHeal(root, sig8, { ledgerDir: deps.ledgerDir, now: deps.now });
        if (o.json) console.log(JSON.stringify({ ok: true, sig8, healRun: state.healRun, next: state.next }, null, 2));
        else console.log(`${chalk.bold(`factory heal close ${sig8}`)}  closed heal run ${termSafe(state.healRun!.id)}`);
        return 0;
      }));
  return heal;
}
