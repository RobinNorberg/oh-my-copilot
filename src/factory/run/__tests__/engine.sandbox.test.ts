/**
 * Sandboxed write lanes (.omc/plans/2026-10-27-sandboxed-lanes-design.md §4.3,
 * §9 PR 2): the lane leaves its changes uncommitted and the engine commits
 * them through hardened host git (lane-commit.ts); the lane's sandbox is
 * recorded in its lane state and a detect-only lane on the PR.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CopilotRunSandboxState } from '../../../copilot-run/sandbox.js';
import { readWorktreeGitLinks, recordWorktreeGitLinks } from '../../../team/git-worktree.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { runFactoryEngine, type FactoryEngineOptions } from '../engine.js';
import { commitLaneWork, ENGINE_COMMIT_IDENTITY, laneCommitMessage } from '../lane-commit.js';
import { readFactoryState } from '../state.js';
import { FakeLanes, FakeProcesses, gitIn, harness, ISSUE, noCommit, remoteHead, review, testGateConfig, type Harness, type LaneScript } from './fake-lanes.js';

let h: Harness;

beforeEach(() => {
  h = harness('omg-factory-sbx-');
});

afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true });
});

function run(scripts: LaneScript[], over: Partial<FactoryEngineOptions> = {}) {
  const lanes = new FakeLanes(h.root, scripts);
  const done = runFactoryEngine({
    root: h.root, issue: ISSUE, exec: h.exec, lanes, limits: { ...DEFAULT_FACTORY_RUN_LIMITS }, base: 'dev', pollMs: 5,
    owner: { pid: 4242, hostname: 'test-host', isAlive: () => false }, ledgerDir: h.ledgerDir, processes: new FakeProcesses(), gateConfig: testGateConfig,
    ...over,
  });
  return { lanes, done };
}

const sandboxOf = (mode: CopilotRunSandboxState['mode']): CopilotRunSandboxState => ({
  mode, host: { supported: mode === 'enforced', capabilities: { shell: mode === 'enforced' } }, applied: mode === 'enforced' ? 'options.update' : 'none',
  canary: 'skipped', unsandboxedCalls: 0, cliVersion: '1.0.104', sdkVersion: '1.0.16', ...(mode === 'enforced' ? {} : { reason: 'MXC is not available' }),
});

/** A write lane that leaves `path` changed in its worktree, uncommitted. */
const edit = (path: string, content: string, sandbox?: CopilotRunSandboxState): LaneScript => ({ worktree }) => {
  mkdirSync(join(worktree, path, '..'), { recursive: true });
  writeFileSync(join(worktree, path), content);
  return { finalText: `Added ${path}.\nTests pass.`, credits: 4, ...(sandbox ? { sandbox } : {}) };
};

describe('engine-side commit of a write lane', () => {
  it('commits the lane\'s uncommitted changes with the engine identity and the lane\'s summary, and records the lane\'s sandbox', async () => {
    const { lanes, done } = run([edit('src/greet.ts', 'export const greet = () => "hi";\n', sandboxOf('enforced')), review('approve')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(lanes.started.map((s) => s.engineCommits)).toEqual([true, undefined]);
    const state = readFactoryState(h.root, ISSUE)!;
    const lane = state.lanes[0];
    const commit = lane.endSha!;
    expect(commit).not.toBe(lane.startSha);
    expect(gitIn(h.root, 'rev-parse', `${commit}^`)).toBe(lane.startSha);
    expect(gitIn(h.root, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', commit)).toBe(`${ENGINE_COMMIT_IDENTITY.name} <${ENGINE_COMMIT_IDENTITY.email}>|${ENGINE_COMMIT_IDENTITY.name} <${ENGINE_COMMIT_IDENTITY.email}>`);
    expect(gitIn(h.root, 'log', '-1', '--format=%B', commit)).toBe(`implement: Add greet() (#${ISSUE})\n\nAdded src/greet.ts.\nTests pass.`);
    expect(gitIn(h.root, 'show', `${commit}:src/greet.ts`)).toBe('export const greet = () => "hi";');
    // The lane's worktree HEAD and branch moved to the commit; nothing is left uncommitted.
    expect(gitIn(lane.worktree!, 'rev-parse', 'HEAD')).toBe(commit);
    expect(gitIn(h.root, 'rev-parse', `refs/heads/omc-team/copilot-run/${lane.jobId}`)).toBe(commit);
    expect(gitIn(lane.worktree!, 'status', '--porcelain')).toBe('');
    expect(remoteHead(h)).toBe(state.head);
    // The sandbox round-trips through the lane state.
    expect(lane.sandbox).toMatchObject({ mode: 'enforced', applied: 'options.update', unsandboxedCalls: 0 });
    expect(state.lanes[1].sandbox).toBeUndefined();
  });

  it('a lane that left no changes fails (the staged diff is empty) and nothing is pushed', async () => {
    const out = await run([noCommit, noCommit]).done;
    expect(out.gate?.name, out.message).toBe('implement-failed');
    expect(out.gate?.reason).toMatch(/left no changes/);
    expect(remoteHead(h)).toBeNull();
  });

  it('a lane that committed itself fails: write lanes leave their changes uncommitted', async () => {
    const committing: LaneScript = ({ worktree }) => {
      writeFileSync(join(worktree, 'a.ts'), 'a\n');
      gitIn(worktree, 'add', 'a.ts');
      gitIn(worktree, 'commit', '-q', '-m', 'lane commit');
      return { finalText: 'Committed.' };
    };
    const out = await run([committing, committing]).done;
    expect(out.gate?.name, out.message).toBe('implement-failed');
    expect(out.gate?.reason).toMatch(/moved its worktree's HEAD/);
    expect(remoteHead(h)).toBeNull();
  });

  it('a nested repository (a gitlink once staged) parks at sandbox-escaped before any commit', async () => {
    const nesting: LaneScript = ({ worktree }) => {
      const nested = join(worktree, 'vendor', 'x');
      mkdirSync(nested, { recursive: true });
      gitIn(nested, 'init', '-q');
      writeFileSync(join(nested, 'f.txt'), 'f\n');
      gitIn(nested, 'add', 'f.txt');
      gitIn(nested, 'commit', '-q', '-m', 'nested');
      return { finalText: 'Vendored.' };
    };
    const out = await run([nesting]).done;
    expect(out.gate?.name, out.message).toBe('sandbox-escaped');
    expect(out.gate?.reason).toMatch(/vendor\/x/);
    const lane = readFactoryState(h.root, ISSUE)!.lanes[0];
    expect(gitIn(lane.worktree!, 'rev-parse', 'HEAD')).toBe(lane.startSha);
    expect(remoteHead(h)).toBeNull();
  });

  it('a detect-only lane is warned about and recorded on the PR body', async () => {
    const warn = vi.fn();
    const out = await run([edit('a.ts', 'a\n', sandboxOf('detect-only')), review('approve')], { warn }).done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ran without an OS sandbox'));
    const create = h.raw.find((c) => c.cmd === 'gh' && c.args.includes('create'))!;
    const body = readFileSync(create.args[create.args.indexOf('--body-file') + 1], 'utf8');
    expect(body).toContain('Sandbox: detect-only');
    expect(body).toContain(`issue-${ISSUE}-implement-1`);
    expect(readFactoryState(h.root, ISSUE)!.lanes[0].sandbox?.mode).toBe('detect-only');
  });
});

describe('commitLaneWork', () => {
  /** A lane worktree of h.root at HEAD, its git links recorded like copilot_run's. */
  function laneTree(name: string): { worktree: string; start: string; branch: string } {
    const worktree = join(h.dir, name);
    const branch = `omc-team/copilot-run/${name}`;
    const start = gitIn(h.root, 'rev-parse', 'HEAD');
    gitIn(h.root, 'worktree', 'add', '-q', '-b', branch, worktree, start);
    recordWorktreeGitLinks(worktree, readWorktreeGitLinks(worktree)!);
    return { worktree, start, branch };
  }

  it('runs no hook and no filter the repository or the lane planted', () => {
    const { worktree, start, branch } = laneTree('cr-hooks');
    const marker = join(h.dir, 'ran').replace(/\\/g, '/');
    const common = gitIn(h.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    for (const hook of ['pre-commit', 'post-commit', 'commit-msg', 'reference-transaction', 'post-index-change']) {
      writeFileSync(join(common, 'hooks', hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`, { mode: 0o755 });
    }
    gitIn(h.root, 'config', 'filter.evil.clean', `sh -c 'echo planted; echo filter >> "${marker}"'`);
    writeFileSync(join(worktree, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(worktree, 'a.ts'), 'raw bytes\n');
    const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: laneCommitMessage('implement: x', 'y') });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const sha = (res as { sha: string }).sha;
    expect(existsSync(marker)).toBe(false);
    expect(gitIn(h.root, 'show', `${sha}:a.ts`)).toBe('raw bytes');
    expect(gitIn(h.root, 'rev-parse', `refs/heads/${branch}`)).toBe(sha);
    // Control: plain git in the same worktree does run them.
    writeFileSync(join(worktree, 'b.ts'), 'b\n');
    gitIn(worktree, 'add', 'b.ts');
    gitIn(worktree, 'commit', '-q', '-m', 'control');
    expect(readFileSync(marker, 'utf8')).toMatch(/filter[\s\S]*pre-commit/);
  });

  it('refuses a merge-rule path before it commits; HEAD and branch stay', () => {
    const { worktree, start, branch } = laneTree('cr-protected');
    mkdirSync(join(worktree, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(worktree, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch, message: 'x' });
    expect(res).toMatchObject({ ok: false, refusal: 'protected' });
    expect(gitIn(worktree, 'rev-parse', 'HEAD')).toBe(start);
    expect(gitIn(h.root, 'rev-parse', `refs/heads/${branch}`)).toBe(start);
  });

  it('refuses a worktree whose git links were never recorded, and never commits the lane\'s runtime state', () => {
    const unrecorded = join(h.dir, 'cr-unrecorded');
    const start = gitIn(h.root, 'rev-parse', 'HEAD');
    gitIn(h.root, 'worktree', 'add', '-q', '--detach', unrecorded, start);
    writeFileSync(join(unrecorded, 'a.ts'), 'a\n');
    expect(commitLaneWork({ worktree: unrecorded, start, parents: [start], repoRoot: h.root, branch: null, message: 'x' })).toMatchObject({ ok: false, refusal: 'error' });

    const { worktree } = laneTree('cr-state');
    // An untracked .omg/state the lane's hooks wrote, in a repository that does not ignore it.
    writeFileSync(join(worktree, '.gitignore'), '');
    mkdirSync(join(worktree, '.omg', 'state'), { recursive: true });
    writeFileSync(join(worktree, '.omg', 'state', 'session.json'), '{}');
    writeFileSync(join(worktree, 'a.ts'), 'a\n');
    const res = commitLaneWork({ worktree, start, parents: [start], repoRoot: h.root, branch: null, message: 'x' });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect((res as { files: string[] }).files.sort()).toEqual(['.gitignore', 'a.ts']);
  });

  it('laneCommitMessage drops control characters and bounds the text', () => {
    expect(laneCommitMessage('fix:\x1b[31m t\nitle', 'a\r\nb\x00c')).toBe('fix: [31m t itle\n\na\nb c');
    expect(laneCommitMessage('t', 'x'.repeat(10_000)).length).toBeLessThan(4_100);
  });
});
