import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  planChainEnqueue,
  readChainLedger,
  readProjectRoutes,
  bindChainLink,
  recordChainHandoffFailure,
  resolveChainLink,
  sessionEndOutcome,
  factoryStateDir,
} from '../chain-enqueuer.js';
import { CHAIN_LINK_ENV } from '../spawn-next.js';
import { acquireChainSlot, releaseChainSlot, readChainStopMarker, DAILY_CHAIN_LIMIT, type ChainSlotPermit } from '../guardrails.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-chain-enqueuer-'));
  tempRoots.push(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.length = 0;
});

function writeLedger(directory: string, sessionId: string, ledger: Record<string, unknown>): void {
  const dir = factoryStateDir(directory);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `chain-${sessionId}.json`), JSON.stringify(ledger), 'utf8');
}

function writeProjectRoutes(directory: string, table: Record<string, unknown>): void {
  const omcDir = join(directory, '.omg');
  mkdirSync(omcDir, { recursive: true });
  writeFileSync(join(omcDir, 'factory-routes.json'), JSON.stringify(table), 'utf8');
}

function writeCheckEvidence(directory: string, sessionId: string, checks: Array<{ name: string; passed: boolean }> = [{ name: 'vitest', passed: true }]): void {
  const dir = join(directory, '.omg', 'state', 'runs', 'evidence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}-checks.json`),
    JSON.stringify({ sessionId, checks, completedAt: new Date().toISOString() }),
    'utf8',
  );
}

function readDecisions(directory: string): Array<Record<string, unknown>> {
  const path = join(factoryStateDir(directory), 'chain-decisions.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('sessionEndOutcome', () => {
  it('maps a clean exit or a headless completion to success and everything else to failed', () => {
    expect(sessionEndOutcome('prompt_input_exit')).toBe('success');
    expect(sessionEndOutcome('logout')).toBe('success');
    // Headless runs that complete normally report 'other'.
    expect(sessionEndOutcome('other')).toBe('success');
    expect(sessionEndOutcome('clear')).toBe('failed');
    // Fail-closed: unknown reasons halt the chain.
    expect(sessionEndOutcome('crash')).toBe('failed');
  });
});

describe('readChainLedger / readProjectRoutes', () => {
  it('returns null for a missing, malformed, or traversal session id', () => {
    const dir = tempDir();
    expect(readChainLedger(dir, 'sess-a')).toBeNull();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a' });
    expect(readChainLedger(dir, 'sess-a')).toEqual({ intentId: 'intent-a' });
    writeFileSync(join(factoryStateDir(dir), 'chain-sess-b.json'), '{broken', 'utf8');
    expect(readChainLedger(dir, 'sess-b')).toBeNull();
    expect(readChainLedger(dir, '../evil')).toBeNull();
  });

  it('returns null when the project routes file is missing or malformed', () => {
    const dir = tempDir();
    expect(readProjectRoutes(dir)).toBeNull();
    writeProjectRoutes(dir, { 'success:*': { stage: 'x', skill: 'x' } });
    expect(readProjectRoutes(dir)).toEqual({ 'success:*': { stage: 'x', skill: 'x' } });
    writeProjectRoutes(dir, 'not-an-object' as unknown as Record<string, unknown>);
    expect(readProjectRoutes(dir)).toBeNull();
  });
});

describe('planChainEnqueue', () => {
  it('returns null and records nothing when the session has no ledger', () => {
    const dir = tempDir();
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir)).toEqual([]);
  });

  it('enqueues the chain on a clean exit using the project route table', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a' });
    writeProjectRoutes(dir, { 'success:*': { stage: 'spec', skill: 'spec' } });
    const chain = planChainEnqueue(dir, 'sess-a', 'prompt_input_exit');
    expect(chain).toMatchObject({
      outcome: 'success',
      reason: 'prompt_input_exit',
      sessionId: 'sess-a',
      intentId: 'intent-a',
      routeTable: { 'success:*': { stage: 'spec', skill: 'spec' } },
    });
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'enqueued', stage: 'spec', intentId: 'intent-a' });
  });

  it('the project file overrides a ledger copy', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a', routeTable: { 'success:*': { stage: 'ledger', skill: 'ledger' } } });
    writeProjectRoutes(dir, { 'success:*': { stage: 'project', skill: 'project' } });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')?.routeTable).toEqual({ 'success:*': { stage: 'project', skill: 'project' } });
  });

  it('falls back to a well-formed ledger copy when there is no project file', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a', routeTable: { 'success:*': { stage: 'ledger', skill: 'ledger' } } });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')?.routeTable).toEqual({ 'success:*': { stage: 'ledger', skill: 'ledger' } });
  });

  it('a nested ledger copy does not shadow the project file', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a', routeTable: { success: { stage: 'ledger', skill: 'ledger' } } });
    writeProjectRoutes(dir, { 'success:*': { stage: 'project', skill: 'project' } });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')?.routeTable).toEqual({ 'success:*': { stage: 'project', skill: 'project' } });
  });

  it('a nested ledger copy with no project file halts loudly, not silently', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a', routeTable: { success: { stage: 'ledger', skill: 'ledger' } } });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-2)).toMatchObject({ decision: 'malformed-route-table', source: 'ledger' });
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'no-route' });
  });

  it('a nested project file is rejected the same way', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a' });
    writeProjectRoutes(dir, { success: { stage: 'project', skill: 'project' } });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'no-route' });
  });

  it('a stale ledger copy cannot route a stage the project file retired', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a', routeTable: { 'success:*': { stage: 'ledger', skill: 'ledger' } } });
    writeProjectRoutes(dir, {});
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'no-route' });
  });

  it('a headless completion (reason other) routes as success and enqueues the chain', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a' });
    writeProjectRoutes(dir, { 'success:*': { stage: 'spec', skill: 'spec' } });
    const chain = planChainEnqueue(dir, 'sess-a', 'other');
    expect(chain).toMatchObject({ outcome: 'success', reason: 'other', sessionId: 'sess-a', intentId: 'intent-a' });
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'enqueued', stage: 'spec' });
  });

  it('a failed exit with no route halts the chain and leaves a stop marker', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a' });
    expect(planChainEnqueue(dir, 'sess-a', 'clear')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'no-route', outcome: 'failed' });
    expect(readChainStopMarker('intent-a', factoryStateDir(dir))).toMatchObject({ intentId: 'intent-a', reason: 'session-end:clear' });
  });

  it('a clean exit with no route simply ends the chain without a stop marker', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a' });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'no-route', outcome: 'success' });
    expect(readChainStopMarker('intent-a', factoryStateDir(dir))).toBeNull();
  });

  it('a human gate halts the chain and leaves a stop marker', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'success:*': { stage: 'spec', skill: 'spec' } },
      gate: 'intent-accept',
    });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'human-gate', gate: 'intent-accept' });
    expect(readChainStopMarker('intent-a', factoryStateDir(dir))).toMatchObject({ reason: 'human-gate:intent-accept' });
  });

  it('an auto-pass gate with check evidence enqueues and records the signer fact', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'success:*': { stage: 'spec', skill: 'spec' } },
      gate: 'spec-approve',
      gateFacts: { irreversibleOrExternal: false, precedentSetting: false, valueJudgment: false, mechanicalChecksPassed: true },
    });
    writeCheckEvidence(dir, 'sess-a');
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).not.toBeNull();
    expect(readDecisions(dir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'auto-pass', gate: 'spec-approve' }),
      expect.objectContaining({ decision: 'enqueued' }),
    ]));
  });

  it('missing gate facts fail conservative to a human gate', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'success:*': { stage: 'spec', skill: 'spec' } },
      gate: 'spec-approve',
    });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'human-gate' });
  });

  it('a guardrail rejection skips the enqueue and records it', () => {
    const dir = tempDir();
    for (let i = 0; i < DAILY_CHAIN_LIMIT; i++) {
      const permit = acquireChainSlot('intent-cap', factoryStateDir(dir));
      if (permit.allowed) releaseChainSlot(permit as ChainSlotPermit);
    }
    writeLedger(dir, 'sess-a', { intentId: 'intent-cap' });
    writeProjectRoutes(dir, { 'success:*': { stage: 'spec', skill: 'spec' } });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'guardrail', guardrail: 'daily-cap' });
  });

  it('an invalid ledger (bad tracker repo) halts without enqueueing', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'success:*': { stage: 'spec', skill: 'spec' } },
      tracker: { repo: 'bad repo; rm', issue: 1, nextLabel: 'x', failedLabel: 'y' },
    });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'invalid-ledger' });
  });

  it('rejects a ledger whose intentId carries path metacharacters', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: '../../evil' });
    writeProjectRoutes(dir, { 'success:*': { stage: 'spec', skill: 'spec' } });
    expect(planChainEnqueue(dir, 'sess-a', 'other')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'invalid-ledger' });
    // No stop marker may escape the factory dir (or be written at all).
    expect(existsSync(join(factoryStateDir(dir), 'chain-....stopped.json'))).toBe(false);
    expect(existsSync(join(dir, 'evil.stopped.json'))).toBe(false);
  });

  it('rejects a ledger route whose stage or skill carries path metacharacters', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a', routeTable: { 'success:*': { stage: '../evil', skill: 'spec' } } });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'invalid-ledger' });

    const failedDir = tempDir();
    writeLedger(failedDir, 'sess-a', { intentId: 'intent-a', routeTable: { 'failed:clear': { stage: 'spec', skill: 'x".y' } } });
    expect(planChainEnqueue(failedDir, 'sess-a', 'clear')).toBeNull();
    expect(readDecisions(failedDir).at(-1)).toMatchObject({ decision: 'invalid-ledger' });
    // failed outcome leaves a halt marker inside the factory dir only.
    expect(readChainStopMarker('intent-a', factoryStateDir(failedDir))).toMatchObject({ reason: 'invalid-ledger:clear' });
  });

  it('a terminal route (skill stop) halts the chain without enqueueing', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a', routeTable: { 'success:*': { stage: 'harbor', skill: 'stop' } } });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'chain-terminal', stage: 'harbor' });
    expect(readChainStopMarker('intent-a', factoryStateDir(dir))).toMatchObject({ reason: 'terminal:harbor' });
  });

  it('halts with chain-loop-capped when the next stage hit its visit cap', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'failed:clear': { stage: 'spec', skill: 'spec' } },
      visits: { spec: 2 },
    });
    expect(planChainEnqueue(dir, 'sess-a', 'clear')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'chain-loop-capped', stage: 'spec', visits: 2, cap: 2 });
    expect(readChainStopMarker('intent-a', factoryStateDir(dir))).toMatchObject({ reason: 'loop-capped:spec' });
  });

  it('enqueues while visits are under the cap and carries them forward', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'failed:clear': { stage: 'spec', skill: 'spec' } },
      visits: { spec: 1 },
      maxStageVisits: 3,
    });
    const chain = planChainEnqueue(dir, 'sess-a', 'clear');
    expect(chain).not.toBeNull();
    expect(chain?.visits).toEqual({ spec: 1 });
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'enqueued', stage: 'spec' });
  });

  it('an invalid maxStageVisits falls back to the default cap', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'failed:clear': { stage: 'spec', skill: 'spec' } },
      visits: { spec: 2 },
      maxStageVisits: 0,
    });
    expect(planChainEnqueue(dir, 'sess-a', 'clear')).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'chain-loop-capped', cap: 2 });
  });

  it('carries the ledger stage-visit cap into the enqueued chain', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a', maxStageVisits: 1 });
    writeProjectRoutes(dir, { 'success:*': { stage: 'spec', skill: 'spec' } });
    expect(planChainEnqueue(dir, 'sess-a', 'other')).toMatchObject({ maxStageVisits: 1, visits: {} });
  });
});

describe('sessionEndOutcome on Copilot', () => {
  it('treats Copilot CLI "complete" (a finished -p link, CLI 1.0.91) as success', () => {
    expect(sessionEndOutcome('complete')).toBe('success');
    // Copilot failure reasons stay fail-closed.
    expect(sessionEndOutcome('error')).toBe('failed');
    expect(sessionEndOutcome('abort')).toBe('failed');
    expect(sessionEndOutcome('timeout')).toBe('failed');
  });
});

describe('chain-link identity (OMC_CHAIN_LINK)', () => {
  const LINK = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  const HOST = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
  // Bound to HOST, as the link's own SessionStart (bindChainLink) leaves it.
  const copilotLedger = (extra: Record<string, unknown> = {}) => ({ intentId: 'intent-c', stage: 'spec', chainLink: LINK, host: 'copilot', boundSessionId: HOST, ...extra });
  const env = (value?: string): NodeJS.ProcessEnv => (value === undefined ? {} : { [CHAIN_LINK_ENV]: value });

  it('prefers OMC_CHAIN_LINK over the host session id when it names an open copilot ledger', () => {
    const dir = tempDir();
    writeLedger(dir, LINK, copilotLedger());
    expect(resolveChainLink(dir, HOST, env(LINK))).toEqual({ linkId: LINK, source: 'env' });
  });

  it('falls back to the host session id without the env var (Claude path unchanged)', () => {
    const dir = tempDir();
    writeLedger(dir, LINK, copilotLedger());
    expect(resolveChainLink(dir, HOST, env())).toEqual({ linkId: HOST, source: 'session' });
    expect(resolveChainLink(dir, HOST, env('  '))).toEqual({ linkId: HOST, source: 'session' });
  });

  it.each([
    ['a nonexistent ledger', undefined, 'no ledger'],
    ['a claude ledger', { host: 'claude' }, 'ledger host claude'],
    ['a ledger without host', { host: undefined }, 'ledger host unset'],
    ['a ledger naming another link', { chainLink: HOST }, 'ledger chainLink mismatch'],
  ])('ignores OMC_CHAIN_LINK naming %s', (_label, extra, rejected) => {
    const dir = tempDir();
    if (extra !== undefined) writeLedger(dir, LINK, copilotLedger(extra));
    expect(resolveChainLink(dir, HOST, env(LINK))).toEqual({ linkId: HOST, source: 'session', rejected });
  });

  it('ignores a traversal or malformed OMC_CHAIN_LINK', () => {
    const dir = tempDir();
    expect(resolveChainLink(dir, HOST, env('../evil'))).toMatchObject({ linkId: HOST, rejected: 'invalid id' });
  });

  it('ignores OMC_CHAIN_LINK inherited by a Claude session nested in a Copilot link', () => {
    const dir = tempDir();
    writeLedger(dir, LINK, copilotLedger());
    expect(resolveChainLink(dir, HOST, { ...env(LINK), CLAUDE_CODE_ENTRYPOINT: 'cli' })).toEqual({ linkId: HOST, source: 'session', rejected: 'not a copilot session' });
  });

  it('resolves a closed ledger so its replay is recorded as already-closed', () => {
    const dir = tempDir();
    writeLedger(dir, LINK, copilotLedger({ closedAt: '2026-10-06T00:00:00.000Z' }));
    expect(resolveChainLink(dir, HOST, env(LINK))).toEqual({ linkId: LINK, source: 'env' });
  });

  it('corrects a closed ledger when the enqueued chain could not be handed to the worker', () => {
    const dir = tempDir();
    writeLedger(dir, LINK, copilotLedger());
    writeProjectRoutes(dir, { 'success:*': { stage: 'launch', skill: 'launch' } });
    const chain = planChainEnqueue(dir, HOST, 'complete', env(LINK))!;
    recordChainHandoffFailure(dir, chain, 'worker-spawn-failed');
    expect(readChainLedger(dir, LINK)).toMatchObject({ decision: 'worker-spawn-failed', closedAt: expect.any(String) });
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'worker-spawn-failed', sessionId: LINK, intentId: 'intent-c' });
  });

  it('enqueues a Copilot link by its chain-link id and closes the ledger with the host session', () => {
    const dir = tempDir();
    writeLedger(dir, LINK, copilotLedger());
    writeProjectRoutes(dir, { 'success:*': { stage: 'launch', skill: 'launch' } });
    const chain = planChainEnqueue(dir, HOST, 'complete', env(LINK));
    expect(chain).toMatchObject({ sessionId: LINK, intentId: 'intent-c', outcome: 'success', reason: 'complete' });
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'enqueued', sessionId: LINK, hostSessionId: HOST, host: 'copilot' });
    expect(readChainLedger(dir, LINK)).toMatchObject({
      chainLink: LINK,
      host: 'copilot',
      hostSessionId: HOST,
      endReason: 'complete',
      outcome: 'success',
      decision: 'enqueued',
      closedAt: expect.any(String),
    });
  });

  it('consumes a link once: a replayed SessionEnd of the same host session gets the same chain back', () => {
    const dir = tempDir();
    writeLedger(dir, LINK, copilotLedger());
    writeProjectRoutes(dir, { 'success:*': { stage: 'launch', skill: 'launch' } });
    const first = planChainEnqueue(dir, HOST, 'complete', env(LINK));
    expect(first).not.toBeNull();
    // Whichever hook's manifest wins still carries the chain; one job per host session spawns it once.
    expect(planChainEnqueue(dir, HOST, 'complete', env(LINK))).toEqual(first);
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'already-closed', replayed: 'enqueued', sessionId: LINK, hostSessionId: HOST });
    expect(readDecisions(dir).filter((d) => d.decision === 'enqueued')).toHaveLength(1);
    expect(readDecisions(dir).filter((d) => d.decision === 'chain-link-rejected')).toEqual([]);
  });

  it('never replays a chain whose hand-off failed, or a non-enqueued closeout', () => {
    const dir = tempDir();
    writeLedger(dir, LINK, copilotLedger());
    writeProjectRoutes(dir, { 'success:*': { stage: 'launch', skill: 'launch' } });
    const chain = planChainEnqueue(dir, HOST, 'complete', env(LINK))!;
    recordChainHandoffFailure(dir, chain, 'enqueued-failed', { error: 'boom' });
    expect(readChainLedger(dir, LINK)).not.toHaveProperty('enqueuedChain');
    expect(planChainEnqueue(dir, HOST, 'complete', env(LINK))).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'already-closed' });
    expect(readDecisions(dir).find((d) => d.decision === 'enqueued-failed')).toMatchObject({ sessionId: LINK, error: 'boom' });
  });

  it('a concurrent duplicate SessionEnd waits for the deciding one and gives up without deciding twice', () => {
    const dir = tempDir();
    writeLedger(dir, LINK, copilotLedger());
    writeProjectRoutes(dir, { 'success:*': { stage: 'launch', skill: 'launch' } });
    // Another SessionEnd holds the decision claim and never closes (bounded wait).
    writeFileSync(join(factoryStateDir(dir), `chain-${LINK}.json.claim`), '');
    expect(planChainEnqueue(dir, HOST, 'complete', env(LINK))).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'duplicate-session-end', sessionId: LINK });
    expect(readChainLedger(dir, LINK)?.closedAt).toBeUndefined();
  });

  it('rejects an unbound link, and a nested session ending a link bound to its parent', () => {
    const dir = tempDir();
    writeLedger(dir, LINK, copilotLedger({ boundSessionId: undefined }));
    expect(resolveChainLink(dir, HOST, env(LINK))).toMatchObject({ linkId: HOST, rejected: expect.stringMatching(/not bound/) });
    writeLedger(dir, LINK, copilotLedger());
    const NESTED = '9a9a9a9a-1111-4222-8333-444444444444';
    expect(resolveChainLink(dir, NESTED, env(LINK))).toEqual({ linkId: NESTED, source: 'session', rejected: 'ledger bound to another session' });
    writeProjectRoutes(dir, { 'success:*': { stage: 'launch', skill: 'launch' } });
    expect(planChainEnqueue(dir, NESTED, 'complete', env(LINK))).toBeNull();
    expect(readChainLedger(dir, LINK)?.closedAt).toBeUndefined();
  });

  it('carries a large stage-visit cap clamped to 99 instead of falling back to 2', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a', maxStageVisits: 150, visits: { spec: 50 } });
    writeProjectRoutes(dir, { 'success:*': { stage: 'spec', skill: 'spec' } });
    expect(planChainEnqueue(dir, 'sess-a', 'other', env())).toMatchObject({ maxStageVisits: 99 });
  });
  it('does not let OMC_CHAIN_LINK inject a chain: no trusted ledger, no enqueue', () => {
    const dir = tempDir();
    writeProjectRoutes(dir, { 'success:*': { stage: 'launch', skill: 'launch' } });
    expect(planChainEnqueue(dir, HOST, 'complete', env(LINK))).toBeNull();
    expect(readDecisions(dir)).toEqual([expect.objectContaining({ decision: 'chain-link-rejected', error: 'no ledger' })]);
  });

  it('closes a Claude ledger on a terminal decision too (no stalled false positive)', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', { intentId: 'intent-a' });
    writeProjectRoutes(dir, { 'success:*': { stage: 'done', skill: 'stop' } });
    expect(planChainEnqueue(dir, 'sess-a', 'other', env())).toBeNull();
    expect(readChainLedger(dir, 'sess-a')).toMatchObject({ decision: 'chain-terminal', hostSessionId: 'sess-a', closedAt: expect.any(String) });
    expect(planChainEnqueue(dir, 'sess-a', 'other', env())).toBeNull();
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'already-closed', sessionId: 'sess-a' });
  });

});

describe('bindChainLink (SessionStart)', () => {
  const LINK = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  const PARENT = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
  const NESTED = '9a9a9a9a-1111-4222-8333-444444444444';
  const open = { intentId: 'intent-c', stage: 'spec', chainLink: LINK, host: 'copilot' };
  const env = { [CHAIN_LINK_ENV]: LINK };

  it('binds the first session that starts with the link id; a later nested one cannot rebind', () => {
    const dir = tempDir();
    writeLedger(dir, LINK, open);
    expect(bindChainLink(dir, PARENT, env)).toBe('bound');
    expect(readChainLedger(dir, LINK)).toMatchObject({ boundSessionId: PARENT, boundAt: expect.any(String) });
    expect(bindChainLink(dir, PARENT, env)).toBe('bound');
    expect(bindChainLink(dir, NESTED, env)).toBe('bound to another session');
    expect(resolveChainLink(dir, PARENT, env)).toEqual({ linkId: LINK, source: 'env' });
    expect(readDecisions(dir).filter((d) => d.decision === 'link-bound')).toEqual([expect.objectContaining({ sessionId: LINK, hostSessionId: PARENT })]);
  });

  it('honours the exclusive bind file even when the ledger write was lost', () => {
    const dir = tempDir();
    writeLedger(dir, LINK, open);
    writeFileSync(join(factoryStateDir(dir), `chain-${LINK}.json.bind`), PARENT);
    expect(bindChainLink(dir, NESTED, env)).toBe('bound to another session');
    expect(resolveChainLink(dir, PARENT, env)).toEqual({ linkId: LINK, source: 'env' });
  });

  it.each([
    ['no env var', {}, open, 'no-link'],
    ['a Claude session', { ...env, CLAUDE_CODE_ENTRYPOINT: 'cli' }, open, 'not a copilot session'],
    ['a closed ledger', env, { ...open, closedAt: '2026-10-06T00:00:00.000Z' }, 'ledger already closed'],
    ['a claude ledger', env, { ...open, host: 'claude' }, 'ledger host claude'],
  ])('does not bind with %s', (_label, e, ledger, result) => {
    const dir = tempDir();
    writeLedger(dir, LINK, ledger);
    expect(bindChainLink(dir, PARENT, e as NodeJS.ProcessEnv)).toBe(result);
    expect(readChainLedger(dir, LINK)?.boundSessionId).toBeUndefined();
  });
});
