import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CopilotRunManager,
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
  });

  it('denies the alias, config and quote-splitting bypasses and the wider subcommand list', () => {
    const denied = (cmd: string) => reviewProfileDenial({ kind: 'shell', fullCommandText: cmd });
    for (const cmd of [
      // An alias defined on the command line or in the config renames a denied subcommand.
      'git -c alias.c=commit c -am x',
      'git -c "alias.c=commit" c -am x',
      'git -C . -c alias.c=commit c -am x',
      'git -c core.hooksPath=/tmp/h status',
      'git --config-env=alias.c=CMD c -am x',
      'git --config-env alias.c=CMD c',
      'git config alias.c commit',
      'git config --get user.name',
      'g=git; $g -c alias.c=commit c',
      // Empty quotes split a word the shell joins back together.
      "git c''ommit -am x",
      'git c""ommit -am x',
      `git "c"''ommit -am x`,
      "git re''set --hard HEAD~1",
      // A quoted full path to git.
      '& "C:\\Program Files\\Git\\cmd\\git.exe" commit -am x',
      '"C:/Program Files/Git/cmd/git.exe" push origin HEAD',
      // A long global option with a separate value.
      'git --git-dir .git commit -am x',
      'git --work-tree . reset --hard',
      ...['switch main', 'restore README.md', 'cherry-pick abc', 'revert HEAD', 'apply x.patch', 'am x.patch', 'branch -D x',
        'tag v1', 'update-ref refs/heads/x HEAD', 'symbolic-ref HEAD refs/heads/x', 'worktree add ../x', 'notes add -m x',
        'replace HEAD abc', 'push origin HEAD', 'fetch origin main:main', 'fetch origin +refs/heads/*:refs/remotes/o/*',
        'fetch origin :refs/heads/x', 'pull', 'bisect start', 'remote add x y', 'clean -fd', 'sparse-checkout set x', 'submodule update',
        'read-tree HEAD', 'update-index --assume-unchanged x', 'checkout-index -a', 'filter-branch --all', 'gc --prune=now',
        'reflog expire --all'].map((sub) => `git ${sub}`),
    ]) {
      expect(denied(cmd), cmd).toMatch(/^review profile|alias|environment/);
    }
    for (const cmd of [
      'git status', 'git diff main...HEAD', 'git merge-base main HEAD', 'git log -c -1', 'git grep -c TODO',
      'git fetch origin', 'git fetch https://github.com/o/r main', 'git fetch git@github.com:o/r main',
      'git show HEAD:README.md', 'git commit-graph verify',
    ]) {
      expect(denied(cmd), cmd).toBeNull();
    }
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

  it('disableStopContinuations skips only the blocking Stop hooks; the allow env and caller OMC_* never reach the session', async () => {
    const m = manager('idle', { OMG_COPILOT_RUN_ALLOW: '1', OMC_SKIP_HOOKS: 'pre-tool-use' });
    await m.wait(m.start({ prompt: 'a', cwd: repo }, { allowLive: true, disableStopContinuations: true }).jobId, 10_000);
    await m.wait(m.start({ prompt: 'b', cwd: repo }).jobId, 10_000);
    const [lane, plain] = calls.connections.map((c) => c.env!);
    expect(STOP_CONTINUATION_SKIP_TOKEN).toBe('persistent-mode,workflow-drift-guard,code-simplifier');
    expect(lane.OMC_SKIP_HOOKS).toBe(STOP_CONTINUATION_SKIP_TOKEN);
    expect(lane.OMG_COPILOT_RUN_ALLOW).toBeUndefined();
    expect(lane.OMC_GIT_GUARDRAILS).toBe('1');
    expect(plain.OMC_SKIP_HOOKS).toBeUndefined();
    expect(plain.OMG_COPILOT_RUN_ALLOW).toBeUndefined();
  });
});

describe('copilot_run lane skip token in the Stop hook scripts', () => {
  /** Run a Stop hook script in `repo` with a clean OMC env plus `env`; returns its parsed JSON output. */
  function runStopHook(script: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, unknown> {
    const base = { ...process.env };
    for (const key of ['DISABLE_OMC', 'OMC_SKIP_HOOKS', 'OMC_HOME', 'OMC_STATE_DIR', 'XDG_CONFIG_HOME', 'CLAUDE_PLUGIN_ROOT', 'OMC_JEV']) delete base[key];
    const stdout = execFileSync(process.execPath, [join(process.cwd(), 'scripts', script)], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'lane-skip-test', cwd: repo, ...input }),
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...base, ...env },
    });
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  }

  it('workflow-drift-guard and code-simplifier block without it and let the lane stop with it', () => {
    // A review verdict that quotes a PR's TODO while the tree holds one.
    writeFileSync(join(repo, 'index.ts'), 'export function next() {\n  // TODO: implement follow-up\n  return 1;\n}\n');
    gitIn(repo, 'add', 'index.ts');
    writeFileSync(join(repo, 'index.ts'), 'export function next() {\n  // TODO: implement follow-up\n  return 2;\n}\n');
    const home = join(root, 'home');
    mkdirSync(join(home, '.omg'), { recursive: true });
    writeFileSync(join(home, '.omg', 'config.json'), JSON.stringify({ codeSimplifier: { enabled: true } }));
    const verdict = { last_assistant_message: 'Review complete. Verdict: approve; the TODO in index.ts is fine.' };
    const homeEnv = { HOME: home, USERPROFILE: home };

    expect(runStopHook('workflow-drift-guard.mjs', verdict, homeEnv).decision).toBe('block');
    expect(runStopHook('code-simplifier.mjs', {}, homeEnv).decision).toBe('block');
    rmSync(join(repo, '.omg', 'state', 'code-simplifier-triggered.marker'), { force: true });

    const lane = { ...homeEnv, OMC_SKIP_HOOKS: STOP_CONTINUATION_SKIP_TOKEN };
    expect(runStopHook('workflow-drift-guard.mjs', verdict, lane).decision).toBeUndefined();
    expect(runStopHook('code-simplifier.mjs', {}, lane)).toEqual({ continue: true });
  });
});
