/**
 * Tier 2 `factory-run` and `factory-run-fix` scenarios of `omg smoke copilot`
 * (opt-in, never in `all`): `omg factory run` end to end, in-process, with
 * real Copilot lanes and nothing on GitHub.
 *
 * 1. A fresh repository next to the sandbox project, on `dev`, with a local
 *    bare `origin`. `git remote get-url` answers a GitHub URL, so the engine's
 *    repository checks pass, while every real push lands in the bare remote.
 * 2. `gh` is a scripted in-process Exec ({@link scriptedFactoryGh}): one open
 *    issue with acceptance criteria, a draft PR create, PR views at the bare
 *    remote's heads, green checks. It refuses `gh pr merge` and records the
 *    attempt; the engine's factory guard refuses it first anyway.
 * 3. The engine runs with the real copilot_run lane backend (the installed
 *    binary, the plugin under test, the smoke home's login), each lane capped
 *    at the 30-credit runtime minimum. Prepare's node checks are scripted
 *    green: the sandbox has no toolchain.
 * 4. `factory-run`: implement, review (approve), prepare, gates, then the park
 *    at `awaiting-human: merge` with the merge command. `factory-run-fix`: the
 *    first review prompt carries an operator instruction to request changes
 *    once, so a fix lane runs and a new review approves the new head.
 *
 * Cost: one user prompt per lane, billed in AI credits; the evidence sums the
 * lane usage the engine recorded in its state.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { CopilotRunManager, defaultCopilotRunDeps } from '../copilot-run/job.js';
import { DEFAULT_FACTORY_RUN_LIMITS, runCredits, type FactoryRunLimits } from '../factory/run/budget.js';
import { runFactoryEngine, type FactoryEngineOptions } from '../factory/run/engine.js';
import { CopilotLaneBackend, type LaneBackend, type LaneResult, type LaneStartInput } from '../factory/run/lane.js';
import type { GateConfigLoader } from '../factory/run/prepare.js';
import { readFactoryState, verifyFactoryIntegrity } from '../factory/run/state.js';
import { resolveShipConfig } from '../ship/config.js';
import { defaultExec, type Exec, type ExecResult } from '../ship/exec.js';
import { latestVerdict, readShipState } from '../ship/state.js';
import { excerpt, parseJsonl, type CopilotEvent } from './copilot-session-eval.js';
import {
  FACTORY_RUN_BASE,
  FACTORY_RUN_FILE,
  FACTORY_RUN_ISSUE,
  FACTORY_RUN_PR,
  FACTORY_RUN_REPO_URL,
  laneModelLabel,
  SCENARIOS,
  type FactoryRunEvidence,
  type FactoryRunScenario,
  type ScenarioRun,
} from './copilot-sdk-scenarios.js';
import type { SpawnSyncFn } from './process-utils.js';

/** Appended to the first review prompt of `factory-run-fix` (by the scenario, not the issue: the implementer never sees it). */
export const FIX_REVIEW_INSTRUCTION = [
  '',
  '## Smoke-test operator instruction (outside the diff; this one is trusted)',
  '',
  `This is a test of the fix loop. For this review only, answer "request-changes" with exactly one finding: severity "major", file "${FACTORY_RUN_FILE}", summary "add a second line containing exactly: reviewed".`,
].join('\n');

/** A lane wall time that fits one small write or review with its tool turns. */
export const FACTORY_LANE_TIMEOUT_MS = 600_000;

export interface FactoryRunScenarioInput {
  name: FactoryRunScenario;
  /** Plugin under test: the lanes' plugin root. */
  root: string;
  /** The copilot binary the lanes run (a resolved .js/.exe, not a shim). */
  bin: string;
  /** Tier 2 session env (isolated COPILOT_HOME, login identity). */
  env: NodeJS.ProcessEnv;
  /** Sandbox project: its parent holds this scenario's repository. */
  projectDir: string;
  /** Smoke home: its config.json holds the login identity the lanes copy. */
  home: string;
  /** Raised to {@link FACTORY_LANE_TIMEOUT_MS} per lane. */
  timeoutMs: number;
  maxCredits: number;
  budget: number;
  eventsPath: string;
  spawnSync: SpawnSyncFn;
  /** Test seams: the lane backend over the scenario repository, the clock, and the engine's poll, process and sleep seams. */
  lanes?: (repoRoot: string) => LaneBackend;
  now?: () => number;
  engine?: Pick<FactoryEngineOptions, 'pollMs' | 'processes' | 'sleep'>;
  /** The model every lane runs on (the driver's cheap pick); unset: runtime auto. */
  model?: string;
}

/** What the scripted gh saw. */
export interface ScriptedGhRecord {
  calls: string[];
  prCreates: string[];
  ready: boolean;
  /** Any `gh pr merge` (or merge through `gh api`) that reached the exec seam. */
  mergeCalls: string[];
}

const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });

function gitOut(exec: Exec, args: string[], cwd?: string): string {
  const r = exec('git', args, cwd ? { cwd } : undefined);
  return r.status === 0 ? r.stdout.trim() : '';
}

/** A ref of the bare remote, or '' when it does not exist. */
export function bareRef(bare: string, ref: string): string {
  return gitOut(defaultExec, ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/** The issue the engine reads: one file, with acceptance criteria. */
export function factoryRunIssue(): { title: string; body: string } {
  return { title: `Add ${FACTORY_RUN_FILE}`, body: SCENARIOS['factory-run'].prompt };
}

/**
 * The exec the engine runs: real git (pushes go to the bare `origin`) except
 * `git remote get-url`, scripted gh, and green node checks. Nothing reaches
 * GitHub; a merge is refused and recorded.
 */
export function scriptedFactoryGh(bare: string): { exec: Exec; record: ScriptedGhRecord } {
  const record: ScriptedGhRecord = { calls: [], prCreates: [], ready: false, mergeCalls: [] };
  const issue = factoryRunIssue();
  let prOpen = false;
  const exec: Exec = (cmd, rawArgs, opts) => {
    let args = rawArgs;
    while (cmd === 'git' && args[0] === '-c') args = args.slice(2);
    const isNode = cmd === process.execPath || /(^|[\\/])node(\.exe)?$/i.test(cmd);
    const key = `${isNode ? 'node' : cmd} ${args.join(' ')}`;
    record.calls.push(key);
    if (isNode) return ok('');
    if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') return ok(`${FACTORY_RUN_REPO_URL}.git\n`);
    if (cmd === 'git') return defaultExec(cmd, rawArgs, opts);
    if (cmd !== 'gh') return { status: 1, stdout: '', stderr: `scripted factory exec: ${cmd} is not scripted` };
    if (/^gh pr merge\b/.test(key) || (/^gh api\b/.test(key) && /\/merge\b/.test(key))) {
      record.mergeCalls.push(key);
      return { status: 1, stdout: '', stderr: 'scripted gh: the smoke never merges' };
    }
    if (key.startsWith(`gh issue view ${FACTORY_RUN_ISSUE} --json`)) {
      return ok(JSON.stringify({ ...issue, state: 'OPEN', labels: [], url: `${FACTORY_RUN_REPO_URL}/issues/${FACTORY_RUN_ISSUE}`, author: { login: 'omg-smoke' }, comments: [] }));
    }
    if (key.startsWith('gh pr list --head ')) return ok(JSON.stringify(prOpen ? [{ number: FACTORY_RUN_PR, state: 'OPEN' }] : []));
    if (key.startsWith('gh pr create ')) {
      record.prCreates.push(key);
      prOpen = true;
      return ok(`${FACTORY_RUN_REPO_URL}/pull/${FACTORY_RUN_PR}\n`);
    }
    if (key.startsWith(`gh pr view ${FACTORY_RUN_PR} --json `)) {
      return ok(JSON.stringify({
        number: FACTORY_RUN_PR,
        headRefOid: bareRef(bare, `refs/heads/factory/issue-${FACTORY_RUN_ISSUE}`),
        state: 'OPEN',
        isDraft: !record.ready,
        baseRefName: FACTORY_RUN_BASE,
        baseRefOid: bareRef(bare, `refs/heads/${FACTORY_RUN_BASE}`),
      }));
    }
    if (key === `gh pr ready ${FACTORY_RUN_PR}`) {
      record.ready = true;
      return ok('');
    }
    if (key.startsWith(`gh pr checks ${FACTORY_RUN_PR} --json`)) {
      return ok(JSON.stringify([{ name: 'Test', state: 'SUCCESS', link: `${FACTORY_RUN_REPO_URL}/actions/runs/100/job/200` }]));
    }
    if (key.startsWith('gh run list --commit ')) return ok(JSON.stringify([{ databaseId: 100, status: 'completed', conclusion: 'success', workflowName: 'CI' }]));
    if (key.startsWith('gh pr comment ') || key.startsWith('gh issue comment ')) return ok('');
    return { status: 1, stdout: '', stderr: `scripted gh: ${key} is not scripted` };
  };
  return { exec, record };
}

/** Ship's gate config without a fetch: the one required check `Test` the scripted gh reports green. */
export const smokeGateConfig: GateConfigLoader = () => ({
  config: { ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [] },
  known: [],
});

/** `<dir>/remote.git` (bare) and `<dir>/repo` on the base branch tracking it; `.omg/` ignored. Returns an error or null. */
export function prepareFactoryRepo(dir: string): string | null {
  const bare = join(dir, 'remote.git');
  const repo = join(dir, 'repo');
  try {
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# omg factory run smoke\n');
    writeFileSync(join(repo, '.gitignore'), '.omg/\nnode_modules/\n');
  } catch (err) {
    return `repository files: ${(err as Error).message}`;
  }
  const steps: Array<[string[], string]> = [
    [['init', '-q', '--bare', '-b', FACTORY_RUN_BASE, bare], dir],
    [['init', '-q', '-b', FACTORY_RUN_BASE], repo],
    [['config', 'user.name', 'omg-smoke'], repo],
    [['config', 'user.email', 'omg-smoke@example.invalid'], repo],
    [['config', 'commit.gpgsign', 'false'], repo],
    [['add', '.'], repo],
    [['commit', '-q', '-m', 'init'], repo],
    [['remote', 'add', 'origin', bare], repo],
    [['push', '-q', 'origin', FACTORY_RUN_BASE], repo],
  ];
  for (const [args, cwd] of steps) {
    const r = defaultExec('git', args, { cwd });
    if (r.status !== 0) return `git ${args.join(' ')}: ${excerpt(r.stderr, 200) || `exit ${r.status}`}`;
  }
  return null;
}

/**
 * The lane backend as the engine sees it, plus what the scenario needs: every
 * start and final result, the lanes' copilot_run events, and for
 * `factory-run-fix` the first review prompt's operator instruction.
 */
export class RecordingLanes implements LaneBackend {
  readonly kind: LaneBackend['kind'];
  readonly starts: Array<Pick<LaneStartInput, 'laneId' | 'profile' | 'maxCredits' | 'baseRef'>> = [];
  readonly results = new Map<string, LaneResult>();
  private reviews = 0;

  /** `model`: pinned on every lane start (the engine sets none, so lanes would run on runtime auto). */
  constructor(private readonly inner: LaneBackend, private readonly requestChangesOnce: boolean, private readonly model?: string) {
    this.kind = inner.kind;
  }

  async start(input: LaneStartInput): Promise<{ remoteId: string }> {
    this.starts.push({ laneId: input.laneId, profile: input.profile, maxCredits: input.maxCredits, baseRef: input.baseRef });
    const firstReview = input.profile === 'review' && this.reviews++ === 0;
    const prompt = firstReview && this.requestChangesOnce ? `${input.prompt}\n${FIX_REVIEW_INSTRUCTION}` : input.prompt;
    return this.inner.start({ ...input, prompt, ...(this.model ? { model: this.model } : {}) });
  }

  async poll(remoteId: string): Promise<LaneResult> {
    return this.keep(await this.inner.poll(remoteId));
  }

  async wait(remoteId: string, timeoutMs: number): Promise<LaneResult> {
    return this.keep(await this.inner.wait(remoteId, timeoutMs));
  }

  async cancel(remoteId: string): Promise<{ supported: boolean; result: LaneResult }> {
    const out = await this.inner.cancel(remoteId);
    this.keep(out.result);
    return out;
  }

  private keep(result: LaneResult): LaneResult {
    if (result.remoteId) this.results.set(result.remoteId, result);
    return result;
  }

  /** copilot_run's per-job events.jsonl (logsUrl) of every lane, in start order of what was seen. */
  events(): CopilotEvent[] {
    const out: CopilotEvent[] = [];
    for (const r of this.results.values()) {
      if (!r.logsUrl) continue;
      try { out.push(...parseJsonl(readFileSync(r.logsUrl, 'utf8')).events); } catch { /* no log */ }
    }
    return out;
  }
}

/** The real copilot_run backend on the smoke's binary, plugin and login. */
export function copilotLanes(input: Pick<FactoryRunScenarioInput, 'env' | 'bin' | 'root' | 'home'>): LaneBackend {
  const deps = { ...defaultCopilotRunDeps(input.env), resolveBin: () => input.bin, pluginRoot: () => input.root, userConfigDir: () => input.home };
  return new CopilotLaneBackend(new CopilotRunManager(deps), { allowLive: true });
}

/** Lane bounds: the 30-credit runtime minimum per lane, one fix round, no retry or respawn, so the lane count is fixed. */
export function factoryRunLimits(timeoutMs: number): FactoryRunLimits {
  return {
    ...DEFAULT_FACTORY_RUN_LIMITS,
    laneTimeoutMs: Math.max(timeoutMs, FACTORY_LANE_TIMEOUT_MS),
    maxFixRounds: 1,
    maxRetries: 0,
    maxLostRespawns: 0,
    gatesTimeoutMs: 5 * 60_000,
  };
}

export async function runFactoryRunScenario(input: FactoryRunScenarioInput): Promise<Omit<ScenarioRun, 'logText'> & { wedged: boolean }> {
  const now = input.now ?? Date.now;
  const started = now();
  const limits = factoryRunLimits(input.timeoutMs);
  const base = {
    name: input.name,
    timeoutMs: limits.laneTimeoutMs,
    model: laneModelLabel(input.model, []),
    maxCredits: input.maxCredits,
    budget: input.budget,
    capped: false,
    wedged: false,
  };
  const dir = join(dirname(input.projectDir), input.name);
  const prepError = prepareFactoryRepo(dir);
  if (prepError) return { ...base, events: [], idle: false, timedOut: false, error: `factory repository setup: ${prepError}` };
  const repo = join(dir, 'repo');
  const bare = join(dir, 'remote.git');
  const baseBefore = bareRef(bare, `refs/heads/${FACTORY_RUN_BASE}`);
  const gh = scriptedFactoryGh(bare);
  const lanes = new RecordingLanes(input.lanes ? input.lanes(repo) : copilotLanes(input), input.name === 'factory-run-fix', input.model);
  const warnings: string[] = [];

  let outcome: Awaited<ReturnType<typeof runFactoryEngine>> | null = null;
  let error: string | undefined;
  try {
    outcome = await runFactoryEngine({
      root: repo,
      issue: FACTORY_RUN_ISSUE,
      exec: gh.exec,
      lanes,
      limits,
      base: FACTORY_RUN_BASE,
      ledgerDir: join(dir, 'ledger'),
      gateConfig: smokeGateConfig,
      now,
      warn: (m) => { warnings.push(m); },
      ...input.engine,
    });
  } catch (err) {
    error = `factory engine threw: ${excerpt((err as Error).message ?? String(err), 300)}`;
  }

  const state = readFactoryState(repo, FACTORY_RUN_ISSUE);
  const ship = state?.pr ? readShipState(repo, state.pr) : null;
  const verdict = ship ? latestVerdict(ship) : undefined;
  const refs = gitOut(defaultExec, ['--git-dir', bare, 'for-each-ref', '--format=%(refname)']).split(/\r?\n/).filter(Boolean);
  const evidence: FactoryRunEvidence = {
    outcome: outcome
      ? { exitCode: outcome.exitCode, phase: outcome.phase, gate: outcome.gate?.name ?? null, message: excerpt(outcome.message, 500), mergeCommand: outcome.mergeCommand ?? null }
      : null,
    lanes: (state?.lanes ?? []).map((l) => ({
      id: l.id, kind: l.kind, status: l.status, verdict: l.verdict ?? null, jobId: l.jobId ?? null, startSha: l.startSha, endSha: l.endSha ?? null,
      maxCredits: l.maxCredits, credits: l.usage?.credits ?? null, source: l.usage?.source ?? null,
    })),
    laneStarts: lanes.starts.map((s) => ({ laneId: s.laneId, profile: s.profile ?? 'write', maxCredits: s.maxCredits })),
    head: state?.head ?? null,
    remoteHead: bareRef(bare, `refs/heads/factory/issue-${FACTORY_RUN_ISSUE}`) || null,
    baseBefore,
    baseAfter: bareRef(bare, `refs/heads/${FACTORY_RUN_BASE}`),
    remoteRefs: refs,
    shipVerdict: verdict ? { verdict: verdict.verdict, sha: verdict.sha, reviewer: verdict.reviewer } : null,
    integrityOk: !!state && verifyFactoryIntegrity(state),
    tamperNotes: (state?.history ?? []).map((h) => h.note).filter((n) => /tamper/i.test(n)),
    gh: { prCreates: gh.record.prCreates, ready: gh.record.ready, mergeCalls: gh.record.mergeCalls },
    warnings: warnings.map((w) => excerpt(w, 300)),
    durationMs: now() - started,
    cost: state
      ? { credits: runCredits(state), premiumRequests: state.lanes.reduce((n, l) => n + (l.usage?.premiumRequests ?? 0), 0), source: `factory state usage of ${state.lanes.length} lane(s)` }
      : { credits: 0, premiumRequests: 0, source: 'no factory state' },
  };
  const events = lanes.events();
  try { writeFileSync(input.eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '')); } catch { /* best effort */ }
  const parked = evidence.outcome?.gate === 'merge';
  error ??= parked ? undefined : `run did not park at awaiting-human: merge: ${evidence.outcome?.message ?? 'no outcome'}`;
  const model = laneModelLabel(input.model, [...lanes.results.values()].map((r) => r.model ?? null));
  return { ...base, model, events, idle: parked && !error, timedOut: false, ...(error ? { error } : {}), factory: evidence };
}
