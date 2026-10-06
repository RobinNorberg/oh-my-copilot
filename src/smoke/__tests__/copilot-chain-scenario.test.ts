import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { chainLinkSmokeEnv, collectChainEvidence, prepareChainProject, runChainScenario } from '../copilot-chain-scenario.js';
import { CHAIN_INTENT_ID, CHAIN_LINK2_STAGE, CHAIN_SKILL, evaluateScenario } from '../copilot-sdk-scenarios.js';
import { factoryStateDir, readProjectRoutes } from '../../hooks/session-end/chain-enqueuer.js';
import { CHAIN_LINK_ENV } from '../../hooks/session-end/spawn-next.js';
import type { SpawnFn } from '../process-utils.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function sandbox(): { project: string; home: string } {
  const parent = mkdtempSync(join(tmpdir(), 'omg-chain-scn-'));
  dirs.push(parent);
  const project = join(parent, 'project');
  const home = join(parent, 'home');
  mkdirSync(project);
  mkdirSync(home);
  execFileSync('git', ['init', '--quiet'], { cwd: project, stdio: 'ignore' });
  return { project, home };
}

const LINK1 = '11111111-1111-4111-8111-111111111111';
const LINK2 = '22222222-2222-4222-8222-222222222222';
const HOST1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const HOST2 = 'bbbbbbbb-2222-4222-8222-222222222222';

const shutdown = (premium: number) => JSON.stringify({ type: 'session.shutdown', data: { totalPremiumRequests: premium, totalNanoAiu: 1e8 } });

/** Stands in for link 1 plus everything its SessionEnd sets off, writing what the real chain writes. */
function fakeChain(project: string, home: string, seen: { env?: NodeJS.ProcessEnv; args?: string[] }, opts: { link2: boolean }): SpawnFn {
  return ((_command: string, args: string[], spawnOpts: { env?: NodeJS.ProcessEnv }) => {
    seen.env = spawnOpts.env;
    seen.args = args;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 4242, exitCode: null as number | null, signalCode: null,
    });
    child.stdin.on('finish', () => {
      const dir = factoryStateDir(project);
      const ledger1 = JSON.parse(readFileSync(join(dir, `chain-${LINK1}.json`), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(dir, `chain-${LINK1}.json`), JSON.stringify({ ...ledger1, closedAt: '2026-10-06T01:00:00.000Z', hostSessionId: HOST1, outcome: 'success', decision: opts.link2 ? 'enqueued' : 'no-route' }));
      const decisions = [{ decision: opts.link2 ? 'enqueued' : 'no-route', sessionId: LINK1, hostSessionId: HOST1, host: 'copilot', intentId: CHAIN_INTENT_ID }];
      for (const [host, premium] of [[HOST1, 1], ...(opts.link2 ? [[HOST2, 1]] : [])] as Array<[string, number]>) {
        mkdirSync(join(home, 'session-state', host), { recursive: true });
        writeFileSync(join(home, 'session-state', host, 'events.jsonl'), `${shutdown(premium)}\n`);
      }
      if (opts.link2) {
        writeFileSync(join(dir, `chain-${LINK2}.json`), JSON.stringify({
          intentId: CHAIN_INTENT_ID, stage: CHAIN_LINK2_STAGE, chainLink: LINK2, host: 'copilot', parentLink: LINK1, createdAt: '2026-10-06T01:00:01.000Z',
          routeTable: {}, visits: { [CHAIN_LINK2_STAGE]: 1 }, maxStageVisits: 1,
          closedAt: '2026-10-06T01:01:00.000Z', hostSessionId: HOST2, outcome: 'success', decision: 'chain-loop-capped',
        }));
        decisions.push({ decision: 'chain-loop-capped', sessionId: LINK2, hostSessionId: HOST2, host: 'copilot', intentId: CHAIN_INTENT_ID });
        writeFileSync(join(dir, `chain-${CHAIN_INTENT_ID}.stopped.json`), JSON.stringify({ intentId: CHAIN_INTENT_ID, reason: `loop-capped:${CHAIN_LINK2_STAGE}` }));
      }
      writeFileSync(join(dir, 'chain-decisions.jsonl'), decisions.map((d) => JSON.stringify(d)).join('\n') + '\n');
      child.exitCode = 0;
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  }) as unknown as SpawnFn;
}

describe('prepareChainProject', () => {
  it('seeds factory init, widens it with the link-2 route and a failure stop, and adds the chain-ack skill', () => {
    const { project } = sandbox();
    expect(prepareChainProject(project)).toBeNull();
    expect(readProjectRoutes(project)).toEqual({
      'success:intake': { stage: 'intent', skill: 'intent' },
      'success:*': { stage: CHAIN_LINK2_STAGE, skill: CHAIN_SKILL },
      'failed:*': { stage: 'halt', skill: 'stop' },
    });
    expect(readFileSync(join(project, '.github', 'skills', CHAIN_SKILL, 'SKILL.md'), 'utf8')).toContain(`name: ${CHAIN_SKILL}`);
  });
});

describe('chainLinkSmokeEnv', () => {
  it('puts the copilot dir first on PATH, the plugin root in OMC_PLUGIN_ROOT and the link id in OMC_CHAIN_LINK', () => {
    const dir = join(tmpdir(), 'tools', 'copilot');
    const env = chainLinkSmokeEnv({ PATH: 'existing', COPILOT_ALLOW_ALL: 'true', COPILOT_AGENT_SESSION_ID: 'parent' }, join(dir, 'copilot.exe'), '/plugin', LINK1);
    expect(env.PATH).toBe(`${dir}${delimiter}existing`);
    expect(env.PATH?.split(delimiter)).toEqual([dir, 'existing']);
    expect(env).toMatchObject({ OMC_PLUGIN_ROOT: '/plugin', [CHAIN_LINK_ENV]: LINK1, COPILOT_ALLOW_ALL: 'false' });
    expect(env.COPILOT_AGENT_SESSION_ID).toBeUndefined();
  });

  it('keeps the existing PATH key casing and adds no delimiter when PATH is unset', () => {
    const dir = join(tmpdir(), 'tools', 'copilot');
    const bin = join(dir, 'copilot.exe');
    expect(chainLinkSmokeEnv({ Path: 'existing' }, bin, '/plugin', LINK1)).toMatchObject({ Path: `${dir}${delimiter}existing` });
    expect(chainLinkSmokeEnv({}, bin, '/plugin', LINK1).PATH).toBe(dir);
  });
});

describe('runChainScenario', () => {
  const baseInput = (project: string, home: string, spawn: SpawnFn, ids = [LINK1]) => ({
    bin: join(home, 'copilot.exe'),
    root: home,
    env: { PATH: 'p' },
    projectDir: project,
    home,
    timeoutMs: 5_000,
    maxCredits: 30,
    budget: 30,
    eventsPath: join(home, 'events-chain.jsonl'),
    spawnSync: (() => ({ status: 0 })) as never,
    spawn,
    pollMs: 10,
    randomUUID: () => ids.shift()!,
  });

  it('pre-writes link 1, spawns it as an AFK link with OMC_CHAIN_LINK, and passes once the chain closes out', async () => {
    const { project, home } = sandbox();
    const seen: { env?: NodeJS.ProcessEnv; args?: string[] } = {};
    const run = await runChainScenario(baseInput(project, home, fakeChain(project, home, seen, { link2: true })));

    expect(seen.env?.[CHAIN_LINK_ENV]).toBe(LINK1);
    expect(seen.args).toContain('--no-ask-user');
    expect(seen.args).not.toContain('-p');
    expect(run).toMatchObject({ name: 'chain', idle: true, timedOut: false });
    expect(run.chain?.ledgers.map((l) => l.file)).toEqual([LINK1, LINK2]);
    expect(existsSync(join(home, 'events-chain.jsonl'))).toBe(true);

    const { checks, cost } = evaluateScenario({ ...run, logText: '' });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(cost.premiumRequests).toBe(2);
  });

  it('fails spawned/inherited/closed when link 1 ends without enqueuing a next link', async () => {
    const { project, home } = sandbox();
    const run = await runChainScenario(baseInput(project, home, fakeChain(project, home, {}, { link2: false })));
    const { checks } = evaluateScenario({ ...run, logText: '' });
    const failed = checks.filter((c) => !c.ok).map((c) => c.id);
    expect(failed).toEqual(['scn.chain.link1', 'scn.chain.spawned', 'scn.chain.inherited', 'scn.chain.closed', 'scn.chain.premium']);
  });

  it('on timeout closes the open link ledgers so they cannot enqueue, and reports them', async () => {
    const { project, home } = sandbox();
    // Link 1 exits but its SessionEnd never closes the ledger.
    const silent = ((_c: string, _a: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1, exitCode: null as number | null, signalCode: null });
      child.stdin.on('finish', () => { child.exitCode = 0; setImmediate(() => child.emit('close', 0, null)); });
      return child;
    }) as unknown as SpawnFn;
    const run = await runChainScenario({ ...baseInput(project, home, silent), timeoutMs: 50 });
    expect(run).toMatchObject({ timedOut: true, idle: false, error: expect.stringContaining(LINK1) });
    const ledger = JSON.parse(readFileSync(join(factoryStateDir(project), `chain-${LINK1}.json`), 'utf8')) as Record<string, unknown>;
    expect(ledger).toMatchObject({ decision: 'smoke-timeout', closedAt: expect.any(String) });
    expect(run.chain?.stopped).toMatchObject({ reason: 'smoke-timeout' });
  });

  it('reports the evidence it collected from a factory dir', () => {
    const { project, home } = sandbox();
    mkdirSync(factoryStateDir(project), { recursive: true });
    writeFileSync(join(factoryStateDir(project), `chain-${LINK1}.json`), JSON.stringify({ chainLink: LINK1, hostSessionId: HOST1 }));
    const evidence = collectChainEvidence(project, home, LINK1);
    expect(evidence.sessions).toEqual([{ hostSessionId: HOST1, events: null }]);
    expect(evidence.stopped).toBeNull();
  });
});
