import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CopilotRunManager,
  REVIEW_SHELL_DENY_PATTERNS,
  STOP_CONTINUATION_SKIP_TOKEN,
  reviewProfileDenial,
} from '../job.js';
import { copilotRunStartTool, setCopilotRunManagerForTests } from '../../tools/copilot-run-tools.js';
import { fakeDeps, gitIn, newCalls, scratchRepo, type FakeBehavior, type FakeCalls } from './fake-sdk.js';

let root: string;
let repo: string;
let calls: FakeCalls;

const manager = (behavior: FakeBehavior = 'idle', env: NodeJS.ProcessEnv = { OMG_COPILOT_RUN_ALLOW: '1' }) =>
  new CopilotRunManager(fakeDeps(root, behavior, calls, env));
const worktreesDir = () => join(repo, '.omg', 'team', 'copilot-run', 'worktrees');

beforeEach(() => {
  calls = newCalls();
  ({ root, repo } = scratchRepo('omg-copilot-run-job-'));
});

afterEach(() => {
  setCopilotRunManagerForTests(null);
  rmSync(root, { recursive: true, force: true });
});

describe('copilot_run startRef', () => {
  it('creates the worktree at a branch and reports its commit as the base', async () => {
    gitIn(repo, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    gitIn(repo, 'add', 'feature.txt');
    gitIn(repo, 'commit', '-q', '-m', 'feature');
    const featureSha = gitIn(repo, 'rev-parse', 'HEAD');
    gitIn(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'README.md'), 'dirty leader\n');

    const m = manager();
    const started = m.start({ prompt: 'review', cwd: repo, startRef: 'feature' });
    expect(started.startRef).toBe('feature');
    const done = await m.wait(started.jobId as string, 10_000);
    const wt = done.worktree as { path: string; baseCommit: string };
    expect(done.status).toBe('completed');
    expect(wt.baseCommit).toBe(featureSha);
    expect(gitIn(wt.path, 'rev-parse', 'HEAD')).toBe(featureSha);
    expect(readFileSync(join(wt.path, 'feature.txt'), 'utf8').trim()).toBe('feature');
    // The leader's uncommitted edits are irrelevant to a job that does not start at HEAD.
    expect(done.notes ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining('uncommitted changes')]));
    // Nothing committed beyond startRef: cleanup is allowed although main lacks the feature commit.
    expect(m.cleanup(started.jobId as string).cleanup).toContain('removed worktree');
  });

  it('accepts a full sha', async () => {
    const sha = gitIn(repo, 'rev-parse', 'HEAD');
    const m = manager();
    const done = await m.wait(m.start({ prompt: 'x', cwd: repo, startRef: sha }).jobId as string, 10_000);
    expect((done.worktree as { baseCommit: string }).baseCommit).toBe(sha);
  });

  it.each([
    ['-b', 'not a valid ref'],
    ['--output=/tmp/x', 'not a valid ref'],
    ['main branch', 'not a valid ref'],
    ['main\nHEAD', 'not a valid ref'],
    ['', 'non-empty string'],
    ['no-such-branch', 'does not resolve to a commit'],
    ['HEAD^{tree}', 'does not resolve to a commit'],
  ])('refuses startRef %j and creates nothing', (ref, message) => {
    const m = manager();
    expect(() => m.start({ prompt: 'x', cwd: repo, startRef: ref })).toThrow(message);
    expect(existsSync(worktreesDir())).toBe(false);
    expect(calls.connections).toHaveLength(0);
  });

  it('refuses startRef with isolation "none"', () => {
    expect(() => manager().start({ prompt: 'x', cwd: repo, isolation: 'none', startRef: 'main' })).toThrow('needs isolation "worktree"');
  });
});

describe('copilot_run review profile', () => {
  it('denies every write and the tree-changing git commands, allows reads and read-only git', async () => {
    const m = manager('hang');
    const started = m.start({ prompt: 'review', cwd: repo, profile: 'review' });
    expect(started.profile).toBe('review');
    await new Promise((r) => setTimeout(r, 50));
    const decide = calls.sessions[0].onPermissionRequest;
    const wt = (started.worktree as { path: string }).path;
    const ctx = { sessionId: 's' };

    expect(await decide({ kind: 'write', path: join(wt, 'README.md') }, ctx)).toMatchObject({ kind: 'reject' });
    expect(await decide({ kind: 'read', path: join(wt, 'README.md') }, ctx)).toEqual({ kind: 'approve-once' });
    for (const cmd of [
      'git commit -am x',
      'git -C . reset --hard HEAD~1',
      'git checkout -b other',
      'git merge main',
      'git rebase main',
      'git stash',
      'npm test && git commit -m x',
      'g=git; $g checkout main',
      'git push origin HEAD',
    ]) {
      expect(await decide({ kind: 'shell', fullCommandText: cmd }, ctx), cmd).toMatchObject({ kind: 'reject' });
    }
    for (const cmd of ['git status', 'git log --oneline -5', 'git diff main...HEAD', 'git merge-base main HEAD', 'npm test']) {
      expect(await decide({ kind: 'shell', fullCommandText: cmd }, ctx), cmd).toEqual({ kind: 'approve-once' });
    }
    await m.cancel(started.jobId as string);
    expect((m.status(started.jobId as string).deniedPermissions as Array<{ reason: string }>)[0].reason).toContain('review profile');
  });

  it('the write profile (default) still allows commits and worktree writes', async () => {
    const m = manager('hang');
    const started = m.start({ prompt: 'implement', cwd: repo });
    expect(started.profile).toBe('write');
    await new Promise((r) => setTimeout(r, 50));
    const decide = calls.sessions[0].onPermissionRequest;
    const wt = (started.worktree as { path: string }).path;
    expect(await decide({ kind: 'shell', fullCommandText: 'git commit -am x' }, { sessionId: 's' })).toEqual({ kind: 'approve-once' });
    expect(await decide({ kind: 'write', path: join(wt, 'README.md') }, { sessionId: 's' })).toEqual({ kind: 'approve-once' });
    await m.cancel(started.jobId as string);
  });

  it('reviewProfileDenial leaves other request kinds to the worker policy', () => {
    expect(reviewProfileDenial({ kind: 'read', path: 'x' })).toBeNull();
    expect(reviewProfileDenial({ kind: 'url', url: 'https://example.com' })).toBeNull();
    expect(REVIEW_SHELL_DENY_PATTERNS.some(({ re }) => re.test('git cherry-pick abc'))).toBe(false);
  });

  it('rejects an unknown profile', () => {
    expect(() => manager().start({ prompt: 'x', cwd: repo, profile: 'admin' as never })).toThrow('profile must be');
  });
});

describe('copilot_run allowLive and session env', () => {
  it('refuses without the env var or allowLive', () => {
    expect(() => manager('idle', {}).start({ prompt: 'x', cwd: repo })).toThrow('OMG_COPILOT_RUN_ALLOW=1');
    expect(() => manager('idle', {}).start({ prompt: 'x', cwd: repo }, { allowLive: false })).toThrow('OMG_COPILOT_RUN_ALLOW=1');
    expect(calls.connections).toHaveLength(0);
  });

  it('starts with an in-process allowLive and no env var', async () => {
    const m = manager('idle', {});
    const done = await m.wait(m.start({ prompt: 'x', cwd: repo }, { allowLive: true }).jobId as string, 10_000);
    expect(done.status).toBe('completed');
  });

  it('the MCP tool cannot pass allowLive', async () => {
    setCopilotRunManagerForTests(manager('idle', {}));
    const result = await copilotRunStartTool.handler({ prompt: 'x', cwd: repo, allowLive: true } as never);
    expect(result.isError).toBe(true);
    expect(calls.connections).toHaveLength(0);
  });

  it('disableStopContinuations sets only the persistent-mode skip; the allow env and caller OMC_* never reach the session', async () => {
    const m = manager('idle', { OMG_COPILOT_RUN_ALLOW: '1', OMC_SKIP_HOOKS: 'pre-tool-use' });
    await m.wait(m.start({ prompt: 'a', cwd: repo }, { allowLive: true, disableStopContinuations: true }).jobId as string, 10_000);
    await m.wait(m.start({ prompt: 'b', cwd: repo }).jobId as string, 10_000);
    const [lane, plain] = calls.connections.map((c) => c.env!);
    expect(STOP_CONTINUATION_SKIP_TOKEN).toBe('persistent-mode');
    expect(lane.OMC_SKIP_HOOKS).toBe('persistent-mode');
    expect(lane.OMG_COPILOT_RUN_ALLOW).toBeUndefined();
    expect(lane.OMC_GIT_GUARDRAILS).toBe('1');
    expect(plain.OMC_SKIP_HOOKS).toBeUndefined();
    expect(plain.OMG_COPILOT_RUN_ALLOW).toBeUndefined();
  });
});
