import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProgressLog } from '../../../lib/agent-progress.js';
import { assertLaneCreditCap, DEFAULT_FACTORY_RUN_LIMITS, nextLaneCap, resolveFactoryRunLimits, runCreditsExceeded } from '../budget.js';
import { findPlanLink, hasAcceptanceCriteria } from '../engine.js';
import { assertFactoryCommand, FactorySafetyError } from '../exec.js';
import { createFactoryProgress } from '../progress.js';
import { parseReviewOutput, reviewComment, verdictNotes } from '../review-output.js';
import {
  acquireFactoryOwner,
  createFactoryState,
  factoryStatePath,
  moveTo,
  readFactoryState,
  requestFactoryCancel,
  setGate,
  updateFactoryState,
  type FactoryLaneRecord,
} from '../state.js';
import { gitIn } from './fake-lanes.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const block = (o: unknown) => `Review done.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\n`;

describe('review output parser and verdict mapping', () => {
  it('accepts one trailing block on the expected sha', () => {
    const r = parseReviewOutput(block({ verdict: 'approve', sha: SHA, findings: [{ severity: 'nit', summary: 'typo', file: 'a.ts', line: 3 }], notes: 'ok' }), SHA);
    expect(r).toMatchObject({ kind: 'valid', verdict: 'approve', downgraded: false, findings: [{ severity: 'nit', file: 'a.ts', line: 3 }] });
  });

  it('maps request-changes to changes-requested', () => {
    expect(parseReviewOutput(block({ verdict: 'request-changes', sha: SHA, findings: [] }), SHA)).toMatchObject({ kind: 'valid', verdict: 'changes-requested' });
  });

  it.each(['blocker', 'major'])('approve with a %s finding counts as changes-requested (fail closed)', (severity) => {
    const r = parseReviewOutput(block({ verdict: 'approve', sha: SHA, findings: [{ severity, summary: 'bad' }] }), SHA);
    expect(r).toMatchObject({ kind: 'valid', verdict: 'changes-requested', downgraded: true });
    if (r.kind === 'valid') expect(verdictNotes(r)).toMatch(/^approve with blocker\/major findings counted as changes-requested; /);
  });

  it.each<[string, string, RegExp]>([
    ['missing block', 'all good, approve', /no fenced json/],
    ['empty message', '', /no final message/],
    ['two blocks', `${block({ verdict: 'approve', sha: SHA, findings: [] })}${block({ verdict: 'approve', sha: SHA, findings: [] })}`, /2 fenced json blocks/],
    ['text after the block', `${block({ verdict: 'approve', sha: SHA, findings: [] })}\nanything else`, /text after/],
    ['bad sha', block({ verdict: 'approve', sha: 'abc', findings: [] }), /full 40-hex/],
    ['wrong sha', block({ verdict: 'approve', sha: 'f'.repeat(40), findings: [] }), /is not the reviewed head/],
    ['bad verdict', block({ verdict: 'lgtm', sha: SHA, findings: [] }), /verdict must be/],
    ['bad JSON', 'x\n```json\n{ nope }\n```\n', /not JSON/],
    ['bad severity', block({ verdict: 'approve', sha: SHA, findings: [{ severity: 'huge', summary: 'x' }] }), /severity/],
    ['missing findings', block({ verdict: 'approve', sha: SHA }), /findings must be an array/],
    ['bad line', block({ verdict: 'approve', sha: SHA, findings: [{ severity: 'nit', summary: 'x', line: 0 }] }), /line must be/],
  ])('rejects %s as invalid', (_name, text, reason) => {
    const r = parseReviewOutput(text, SHA);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.reason).toMatch(reason);
  });

  it('cuts notes at 500 characters and renders a PR comment table', () => {
    const r = parseReviewOutput(block({ verdict: 'request-changes', sha: SHA, findings: [{ severity: 'major', summary: 'a | b', file: 'x.ts' }], notes: 'n'.repeat(900) }), SHA);
    expect(r.kind).toBe('valid');
    if (r.kind !== 'valid') return;
    expect(r.notes).toHaveLength(500);
    expect(reviewComment(r, 'factory-review-7-cr-1')).toContain('| major | `x.ts` | a \\| b |');
  });
});

describe('plan resolution', () => {
  it('finds an omg-plan link in the body before comments, and the newest comment otherwise', () => {
    expect(findPlanLink('intro\nomg-plan: docs/a.md\n', [{ body: 'omg-plan: docs/b.md' }])).toBe('docs/a.md');
    expect(findPlanLink('intro', [{ body: 'omg-plan: docs/b.md' }, { body: 'omg-plan: docs/c.md' }])).toBe('docs/c.md');
    expect(findPlanLink('intro', [{ body: 'no link' }])).toBeUndefined();
  });

  it('an Acceptance criteria heading at any level is enough as the plan', () => {
    expect(hasAcceptanceCriteria('## Acceptance criteria\n- x')).toBe(true);
    expect(hasAcceptanceCriteria('### acceptance Criteria')).toBe(true);
    expect(hasAcceptanceCriteria('Acceptance criteria: x')).toBe(false);
  });
});

describe('factory command guard', () => {
  const ok = (cmd: string, args: string[]) => expect(() => assertFactoryCommand(cmd, args, ['dev'])).not.toThrow();
  const refused = (cmd: string, args: string[]) => expect(() => assertFactoryCommand(cmd, args, ['dev'])).toThrow(FactorySafetyError);

  it('accepts the engine shapes', () => {
    ok('git', ['push', 'origin', `${SHA}:refs/heads/factory/issue-7`]);
    ok('git', ['ls-remote', 'origin', 'refs/heads/factory/issue-7']);
    ok('git', ['for-each-ref', '--format=%(refname) %(objectname)']);
    ok('git', ['rev-parse', '--git-common-dir']);
    ok('git', ['rev-parse', '--verify', `${SHA}:docs/plan.md`]);
    ok('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    ok('git', ['diff', `${SHA}...${SHA}`]);
    ok('git', ['fetch', 'origin', 'dev']);
    ok('gh', ['issue', 'view', '7', '--json', 'title,body,labels,state,url,comments']);
    ok('gh', ['issue', 'comment', '7', '--body-file', '/tmp/b.md']);
    ok('gh', ['pr', 'create', '--draft', '--base', 'dev', '--head', 'factory/issue-7', '--title', 'Add greet() (#7)', '--body-file', '/tmp/b.md']);
    ok('gh', ['pr', 'comment', '42', '--body-file', '/tmp/b.md']);
    ok('gh', ['pr', 'list', '--head', 'factory/issue-7', '--json', 'number,state']);
    ok('gh', ['pr', 'view', '42', '--json', 'headRefOid,state']);
  });

  it.each<[string, string, string[]]>([
    ['a force refspec', 'git', ['push', 'origin', `+${SHA}:refs/heads/factory/issue-7`]],
    ['a --force flag', 'git', ['push', '--force', 'origin', `${SHA}:refs/heads/factory/issue-7`]],
    ['a non-factory branch', 'git', ['push', 'origin', `${SHA}:refs/heads/feat/x`]],
    ['a protected branch', 'git', ['push', 'origin', `${SHA}:refs/heads/dev`]],
    ['ship\'s HEAD push shape', 'git', ['push', 'origin', 'HEAD:refs/heads/factory/issue-7']],
    ['a ref-name push source', 'git', ['push', 'origin', 'main:refs/heads/factory/issue-7']],
    ['another remote', 'git', ['push', 'evil', `${SHA}:refs/heads/factory/issue-7`]],
    ['a deleting push', 'git', ['push', 'origin', ':refs/heads/factory/issue-7']],
    ['a global -c option', 'git', ['-c', 'alias.x=!sh', 'status']],
    ['gh api', 'gh', ['api', 'repos/o/r']],
    ['gh -R', 'gh', ['-R', 'o/r', 'pr', 'view', '42', '--json', 'state']],
    ['gh pr merge (merge is human)', 'gh', ['pr', 'merge', '42', '--admin', '--merge', '--match-head-commit', SHA]],
    ['a non-draft PR', 'gh', ['pr', 'create', '--base', 'dev', '--head', 'factory/issue-7', '--title', 't', '--body-file', 'b', '--draft']],
    ['a PR from a non-factory head', 'gh', ['pr', 'create', '--draft', '--base', 'dev', '--head', 'feat/x', '--title', 't', '--body-file', 'b']],
    ['an option-shaped title', 'gh', ['pr', 'create', '--draft', '--base', 'dev', '--head', 'factory/issue-7', '--title', '--web', '--body-file', 'b']],
    ['gh issue close', 'gh', ['issue', 'close', '7']],
    ['npm', 'npm', ['ci']],
  ])('refuses %s', (_name, cmd, args) => refused(cmd, args));

  it('allows only the trusted-read env, and only on git', () => {
    expect(() => assertFactoryCommand('git', ['for-each-ref', '--format=%(refname) %(objectname)'], [], { GIT_NO_REPLACE_OBJECTS: '1' })).not.toThrow();
    expect(() => assertFactoryCommand('git', ['for-each-ref', '--format=%(refname) %(objectname)'], [], { GIT_DIR: '/x' })).toThrow(FactorySafetyError);
    expect(() => assertFactoryCommand('gh', ['pr', 'list', '--head', 'factory/issue-7', '--json', 'number'], [], { GIT_NO_REPLACE_OBJECTS: '1' })).toThrow(FactorySafetyError);
  });
});

describe('per-run limits (no governor)', () => {
  it('defaults: a 30-credit lane cap, no run cap, one retry, one lost respawn, a CI-fix cap of 1', () => {
    const { limits } = resolveFactoryRunLimits(undefined, undefined);
    expect(limits).toEqual(DEFAULT_FACTORY_RUN_LIMITS);
    expect(limits).toMatchObject({ laneMaxCredits: 30, maxRetries: 1, maxLostRespawns: 1, maxCiFixRounds: 1, maxFixRounds: 2 });
    expect(limits.maxRunCredits).toBeUndefined();
  });

  it('reads factory.run from the trusted user config; the project config can only tighten', () => {
    const user = { factory: { run: { laneMaxCredits: 60, maxRunCredits: 200, laneTimeoutMinutes: 20, maxRunWallTimeMinutes: 90 } }, ship: { maxFixRounds: 3 } };
    const project = { factory: { run: { laneMaxCredits: 40, maxRunCredits: 500, maxRetries: 0 } }, ship: { maxFixRounds: 5 } };
    const { limits, warnings } = resolveFactoryRunLimits(user, project);
    expect(limits).toMatchObject({ laneMaxCredits: 40, maxRunCredits: 200, laneTimeoutMs: 20 * 60_000, maxRunWallTimeMs: 90 * 60_000, maxRetries: 0, maxFixRounds: 3 });
    expect(warnings.join('\n')).toMatch(/ignoring factory\.run\.maxRunCredits 500/);
    expect(warnings.join('\n')).toMatch(/ignoring ship\.maxFixRounds 5/);
  });

  it('a project config may add a run cap where the user set none, and maxCiFixRounds stays at most 1', () => {
    const { limits, warnings } = resolveFactoryRunLimits({ factory: { run: { maxCiFixRounds: 3 } } }, { factory: { run: { maxRunCredits: 90 } } });
    expect(limits.maxRunCredits).toBe(90);
    expect(limits.maxCiFixRounds).toBe(1);
    expect(warnings.join('\n')).toMatch(/above the cap of 1/);
  });

  it('refuses a lane cap below the CLI minimum, a missing cap, a run cap below one lane, and ill-typed values', () => {
    expect(() => resolveFactoryRunLimits({ factory: { run: { laneMaxCredits: 29 } } }, undefined)).toThrow(/below the Copilot CLI minimum of 30/);
    expect(() => assertLaneCreditCap(undefined)).toThrow(/no per-lane AI-credit cap/);
    expect(() => resolveFactoryRunLimits({ factory: { run: { maxRunCredits: 20 } } }, undefined)).toThrow(/below one lane's cap/);
    expect(() => resolveFactoryRunLimits({ factory: { run: { maxRetries: 1.5 } } }, undefined)).toThrow(/non-negative integer/);
    expect(() => resolveFactoryRunLimits({ factory: { run: { laneTimeoutMinutes: 90 } } }, undefined)).toThrow(/at most 60/);
  });

  it('caps the next lane at what the run cap leaves, and stops below the runtime floor', () => {
    const lane = (credits: number) => ({ usage: { credits, premiumRequests: 1, source: 'measured' } } as FactoryLaneRecord);
    const limits = { ...DEFAULT_FACTORY_RUN_LIMITS, laneMaxCredits: 40, maxRunCredits: 100 };
    expect(nextLaneCap({ lanes: [] }, limits)).toEqual({ ok: true, cap: 40 });
    expect(nextLaneCap({ lanes: [lane(62.5)] }, limits)).toEqual({ ok: true, cap: 37 });
    expect(nextLaneCap({ lanes: [lane(75)] }, limits)).toMatchObject({ ok: false });
    expect(runCreditsExceeded({ lanes: [lane(99)] }, limits)).toBeNull();
    expect(runCreditsExceeded({ lanes: [lane(60), lane(40)] }, limits)).toMatch(/100\.00 AI credits/);
  });
});

describe('factory run state, owner file and cancel', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-factory-state-'));
    gitIn(dir, 'init', '-q');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const NOW = '2026-10-27T10:00:00.000Z';
  const fresh = () => updateFactoryState(dir, 7, (cur) => cur ?? createFactoryState({ issue: 7, repoUrl: 'https://github.com/o/r', base: 'dev' }, NOW));

  it('seals every write and refuses a hand-edited state', () => {
    fresh();
    const path = factoryStatePath(dir, 7);
    expect(path.replace(/\\/g, '/')).toMatch(/\.omg\/state\/factory\/run-7\.json$/);
    writeFileSync(path, readFileSync(path, 'utf8').replace('"intake"', '"review"'));
    expect(() => updateFactoryState(dir, 7, (s) => s!)).toThrow(/integrity check/);
  });

  it('moves between phases with history, parks at a gate, and never leaves a terminal phase', () => {
    const s = createFactoryState({ issue: 7, repoUrl: '', base: 'dev' }, NOW);
    const gated = setGate(moveTo(s, 'plan', 'ok', NOW), 'needs-plan', 'no criteria', NOW);
    expect(gated).toMatchObject({ phase: 'plan', gate: { name: 'needs-plan' } });
    expect(moveTo(gated, 'implement', 'plan found', NOW).gate).toBeUndefined();
    expect(() => moveTo(moveTo(s, 'cancelled', 'x', NOW), 'plan', 'y', NOW)).toThrow(/is cancelled/);
  });

  it('cancel sets the flag under the lock; a missing run is refused', () => {
    fresh();
    expect(requestFactoryCancel(dir, 7, NOW).cancelRequested).toBe(true);
    expect(readFactoryState(dir, 7)!.cancelRequested).toBe(true);
    expect(() => requestFactoryCancel(dir, 8, NOW)).toThrow(/no factory run/);
  });

  it('owner file: a live owner or another host refuses; a dead pid on this host is taken over; release removes only its own file', () => {
    const live = { pid: 1, hostname: 'h', isAlive: () => true };
    const first = acquireFactoryOwner(dir, 7, NOW, live);
    expect(() => acquireFactoryOwner(dir, 7, NOW, { ...live, pid: 2 })).toThrow(/already running \(pid 1 on h/);
    expect(() => acquireFactoryOwner(dir, 7, NOW, { pid: 2, hostname: 'other', isAlive: () => false })).toThrow(/already running/);
    const second = acquireFactoryOwner(dir, 7, NOW, { pid: 2, hostname: 'h', isAlive: () => false });
    expect(second.tookOver).toMatchObject({ pid: 1, hostname: 'h' });
    first.release(); // not its file any more
    expect(() => acquireFactoryOwner(dir, 7, NOW, { pid: 3, hostname: 'h', isAlive: () => true })).toThrow(/pid 2/);
    second.release();
    expect(acquireFactoryOwner(dir, 7, NOW, { pid: 3, hostname: 'h', isAlive: () => true }).tookOver).toBeUndefined();
  });
});

describe('factory progress events', () => {
  it('writes factory-<issue> events with a 12-char sha and throttles heartbeats to one per 60 s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omg-factory-progress-'));
    try {
      const file = join(dir, 'factory-7.log');
      let t = 0;
      const p = createFactoryProgress({ root: dir, issue: 7, file, now: () => t });
      p.emit('review', 'start', undefined, { pr: 42, sha: SHA, credits: 3.14159 });
      p.heartbeat('lane-review', 'running');
      t = 30_000;
      p.heartbeat('lane-review', 'running');
      t = 61_000;
      p.heartbeat('lane-review', 'running');
      p.emit('prepare', 'blocked', 'prepare:approved');
      const events = parseProgressLog(readFileSync(file, 'utf8'));
      expect(events.map((e) => e.status)).toEqual(['start', 'heartbeat', 'heartbeat', 'blocked']);
      expect(events[0]).toMatchObject({ agent: 'factory-7', fields: { issue: '7', pr: '42', sha: SHA.slice(0, 12), credits: '3.14' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
