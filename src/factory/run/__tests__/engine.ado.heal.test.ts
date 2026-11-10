import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoadedForgeConfig } from '../../../forge/config.js';
import { healCommand, type HealDeps } from '../../heal/cli.js';
import type { HealClassification } from '../../heal/classify.js';
import { DEFAULT_HEAL_CONFIG } from '../../heal/config.js';
import { healSealSubject, writeHealSeal } from '../../heal/run.js';
import { writeHealState, type HealSignatureState } from '../../heal/state.js';
import { adoConfig, POSIX_ENTRY } from '../../../forge/ado/__tests__/world.js';
import { readShipState } from '../../../ship/state.js';
import { defaultExec } from '../../../ship/exec.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { ADO_HEAD_LAG_POLLS, runFactoryEngine } from '../engine.js';
import { readFactoryState } from '../state.js';
import { commitFile, FakeLanes, FakeProcesses, gitIn, ISSUE, remoteHead, review, testGateConfig, attestedSandbox } from './fake-lanes.js';
import { ADO_URL, PR_ID, h, ado, sleeps, useAdoHarness, adoExec, forgeInput, opts, happy, run, expectNoMerge } from './engine-ado-harness.js';

useAdoHarness();

describe('omg factory run on Azure DevOps (fake ADO, real git)', () => {
  it('a lag that outlasts the re-reads stops the step pending (no gate); a rerun once the forge caught up continues', async () => {
    const dev = defaultExec('git', ['ls-remote', h.bare, 'refs/heads/dev']).stdout.split(/\s+/)[0];
    ado.lag = { sha: dev, reads: 10_000 };
    const lanes = new FakeLanes(h.root, happy());
    const first = await runFactoryEngine(opts(lanes));

    expect(first.exitCode).toBe(1);
    expect(first.message).toMatch(/pending: Azure DevOps still reports PR #17 at .{12}, an ancestor of the engine's push/);
    const parked = readFactoryState(h.root, ISSUE)!;
    expect(parked.gate).toBeUndefined();
    expect(parked.phase).toBe('review');
    expect(sleeps.length).toBe(ADO_HEAD_LAG_POLLS);

    ado.lag = undefined;
    const again = await runFactoryEngine(opts(lanes));
    expect(again.exitCode, again.message).toBe(0);
    expect(again.gate?.name).toBe('merge');
  });

  it('refuses forge options without the full untrusted roots', async () => {
    await expect(run(happy(), { forge: forgeInput({ options: { untrustedRoots: [] } }) })).rejects.toThrow(/must list every untrusted root/);
    await expect(run(happy(), { forge: forgeInput({ options: { untrustedRoots: [h.root] } }) })).rejects.toThrow(/missing: /);
    await expect(run(happy(), { dryRun: true, forge: forgeInput({ options: { untrustedRoots: [] } }) })).rejects.toThrow(/must list every untrusted root/);
    expect(readFactoryState(h.root, ISSUE)).toBeNull();
  });

  it('blocked-by: an open predecessor (Dependency-Reverse) parks the run; a rerun proceeds once its factory PR completed into dev', async () => {
    ado.predecessor = 'open';
    const first = await run([]);
    expect(first.gate?.name).toBe('blocked-by');
    expect(first.gate?.reason).toContain('#40');
    expect(ado.calls.some((c) => c.route === 'git.pullRequests.POST')).toBe(false);

    ado.predecessor = 'merged';
    const out = await run(happy());
    expect(out.exitCode, out.message).toBe(0);
    expect(out.gate?.name).toBe('merge');
    expectNoMerge();
  });

  it('a resume on another forge than the run started on is refused (forgeKind)', async () => {
    const out = await run(happy());
    expect(out.gate?.name).toBe('merge');

    const github = await run([], { forge: undefined, exec: h.exec });
    expect(github.exitCode).toBe(1);
    expect(github.message).toMatch(/started on azure-devops, but the forge now resolves to github/);
    const dry = await run([], { forge: undefined, exec: h.exec, dryRun: true });
    expect(dry.exitCode).toBe(1);
  });

  it('--dry-run reads the work item through the tracker, applies the pr-exists gate and names the plan', async () => {
    const out = await run([], { dryRun: true });
    expect(out.exitCode).toBe(0);
    expect(out.plan).toMatchObject({ next: 'implement', planSource: 'omg-plan docs/plan.md' });
    expect(ado.calls.map((c) => c.route)).toEqual(['wit.workItems.GET', 'wit.workItemTypeStates.GET', 'wit.comments.GET', 'git.pullRequests.GET']);
    expect(readFactoryState(h.root, ISSUE)).toBeNull();
  });
});

describe('ci-heal run on Azure DevOps (ADO parity design §3.6)', () => {
  const SIG8 = '0a1b2c3d';
  const KEY = `heal-${SIG8}` as const;
  const NOW = new Date('2026-10-29T12:00:00Z');
  const FIX = commitFile('src/report.ts', 'export const csv = () => "a,b";\n');
  const DIAGNOSIS = {
    class: 'regression' as const,
    rootCause: 'The CSV export drops the header row.',
    evidence: ['failures/1.log:2'],
    reproduced: false,
    fix: { summary: 'Write the header row first.', files: ['src/report.ts'], acceptance: ['src/report.test.ts > exports CSV passes'] },
  };

  beforeEach(() => {
    ado.branch = h.gh.branch = `factory/${KEY}`;
  });

  function classification(): HealClassification {
    const red = gitIn(h.root, 'rev-parse', 'origin/dev');
    return {
      class: 'regression', signature: 'sig', sig8: SIG8, firstRed: { runId: '205', sha: red }, lastGreen: { runId: '204', sha: red }, laneEligible: true,
      jobs: [{
        job: 'Test', class: 'regression', reason: 'test failure', blockers: [], infra: [],
        failingTests: [{ file: 'src/report.test.ts', title: 'exports CSV' }],
        env: { red: {}, green: {}, changed: [] },
      }],
    };
  }

  /** A heal record as `omg factory heal run` leaves it: an open heal run with a sealed valid diagnosis at heal-approve. */
  function seedHeal(): void {
    const c = classification();
    const s: HealSignatureState = {
      version: 1, sig8: SIG8, signature: 'sig', class: 'regression', classification: c, source: 'push',
      firstSeen: { runId: c.firstRed.runId, at: NOW.toISOString() }, lastSeen: { runId: c.firstRed.runId, at: NOW.toISOString() }, count: 1, seenRuns: [c.firstRed.runId],
      healRun: { id: KEY, open: true, startedAt: NOW.toISOString() },
      lanes: [{ id: `${KEY}-debug-1`, kind: 'debug', startSha: c.firstRed.sha, status: 'completed', maxCredits: 30, startedAt: NOW.toISOString(), pid: 1, confinement: 'none', usage: { credits: 3, premiumRequests: 1, source: 'measured' } }],
      diagnosis: { at: NOW.toISOString(), laneId: `${KEY}-debug-1`, outcome: 'valid', diagnosis: DIAGNOSIS as never, evidence: {} },
      next: 'heal-approve', rerunIntents: [], updatedAt: NOW.toISOString(),
    };
    writeHealState(h.root, s);
    writeHealSeal(h.ledgerDir, h.root, s, healSealSubject(s.class, c, s.source));
  }

  /** `omg factory heal approve` on the ADO origin: the forge config names the CI pipeline; the harness git answers rev-parse. */
  function healDeps(lanes: FakeLanes, forge: () => LoadedForgeConfig): HealDeps {
    const exec = adoExec();
    return {
      exec: (cmd, args, o) => (cmd === 'git' && args.join(' ') === 'rev-parse --show-toplevel' ? { status: 0, stdout: `${h.root}\n`, stderr: '' } : exec(cmd, args, o)),
      base: () => 'dev',
      config: () => ({ config: DEFAULT_HEAL_CONFIG, warnings: [] }),
      now: () => NOW,
      lanes: () => lanes,
      ledgerDir: h.ledgerDir,
      runLimits: () => ({ limits: { ...DEFAULT_FACTORY_RUN_LIMITS }, warnings: [] }),
      gateConfig: testGateConfig, gateSandbox: () => attestedSandbox(() => exec),
      engine: { pollMs: 5, owner: { pid: 4242, hostname: 'test-host', isAlive: () => false }, processes: new FakeProcesses(), sleep: async () => {} },
      forgeKind: () => 'azure-devops',
      forge,
      resolveAz: () => POSIX_ENTRY,
    };
  }

  const healPipeline = (): LoadedForgeConfig => ({ config: { ...adoConfig(), heal: { pipeline: { definitionId: 9 } } }, warnings: [] });

  async function approve(deps: HealDeps): Promise<{ code: number | undefined; json: any }> {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await healCommand(deps).parseAsync(['approve', SIG8, '--json'], { from: 'user' });
      return { code: process.exitCode as number | undefined, json: JSON.parse(out.join('\n')) };
    } finally {
      vi.restoreAllMocks();
      process.exitCode = undefined;
    }
  }

  it('heal approve: intake from the forge repo -> implement -> draft PR -> review -> prepare -> gates -> awaiting-human merge with the head-pinned body', async () => {
    // The forge state dir (the merge body) and the team job root stay inside the test directory, never under the real home.
    vi.stubEnv('OMC_HOME', join(h.dir, 'omc-home'));
    vi.stubEnv('OMC_JOBS_DIR', join(h.dir, 'team-jobs'));
    try {
      seedHeal();
      const lanes = new FakeLanes(h.root, [FIX, review('approve')]);
      const { code, json } = await approve(healDeps(lanes, healPipeline));

      expect(code, json.message).toBe(0);
      expect(json.gate?.name).toBe('merge');
      const state = readFactoryState(h.root, KEY)!;
      expect(state).toMatchObject({ kind: 'ci-heal', forgeKind: 'azure-devops', repoUrl: ADO_URL, pr: PR_ID, branch: `factory/${KEY}`, head: remoteHead(h) });
      expect(state.heal?.approved).toMatchObject({ by: 'human' });
      expect(lanes.started.map((s) => s.laneId)).toEqual([`${KEY}-implement-1`, `${KEY}-review-1`]);

      // The draft PR: fixed title, no work item link, the CI runs linked to their Azure Pipelines build pages.
      const created = ado.calls.find((c) => c.route === 'git.pullRequests.POST')!;
      expect(created.body).toMatchObject({ sourceRefName: `refs/heads/factory/${KEY}`, targetRefName: 'refs/heads/dev', isDraft: true, title: `fix(ci): self-heal for CI signature ${SIG8}` });
      expect(created.body.workItemRefs).toBeUndefined();
      expect(created.body.description).toContain(`Self-heal for CI signature ${SIG8}; merge is human.`);
      expect(created.body.description).toContain('[205](https://dev.azure.com/contoso/Web/_build/results?buildId=205)');
      expect(created.body.description).not.toContain('/actions/runs/');
      expect(readShipState(h.root, PR_ID)).toMatchObject({ phase: 'ready', implementer: `factory-impl-${KEY}`, lastGates: { verdict: 'green' } });

      // The merge comment pins the head: the body file, its SHA-256 and the command a human runs.
      const merge = ado.threads().find((t) => t.includes('Merge is a human step'))!;
      const bodyFile = /reads its body from `([^`]+)`/.exec(merge)![1];
      const sha = /SHA-256 `([0-9a-f]{64})`/.exec(merge)![1];
      expect(bodyFile.startsWith(join(h.dir, 'omc-home'))).toBe(true);
      const content = readFileSync(bodyFile, 'utf8');
      expect(createHash('sha256').update(content, 'utf8').digest('hex')).toBe(sha);
      expect(JSON.parse(content)).toEqual({ status: 'completed', lastMergeSourceCommit: { commitId: state.head }, completionOptions: { mergeStrategy: 'noFastForward' } });
      expect(json.mergeCommand).toContain(`--in-file ${bodyFile}`);
      // A ci-heal run has no work item: nothing was read or written on the tracker.
      expect(ado.calls.some((c) => c.route.startsWith('wit.'))).toBe(false);
      // The whole write set: the draft PR, its ready flip and the PR threads; no policy requeue, no tracker write.
      expect(new Set(ado.calls.map((c) => c.route).filter((r) => !r.endsWith('.GET')))).toEqual(new Set(['git.pullRequests.POST', 'git.pullRequests.PATCH', 'git.pullRequestThreads.POST']));
      expectNoMerge();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('heal approve without factory.heal.pipeline is refused before any az call, naming the key', async () => {
    seedHeal();
    const lanes = new FakeLanes(h.root, []);
    const { code, json } = await approve(healDeps(lanes, () => ({ config: adoConfig(), warnings: [] })));
    expect(code).toBe(3);
    expect(json.error).toMatch(/needs factory\.heal\.pipeline/);
    expect(ado.calls).toEqual([]);
    expect(lanes.started).toHaveLength(0);
    expect(readFactoryState(h.root, KEY)).toBeNull();
  });
});
