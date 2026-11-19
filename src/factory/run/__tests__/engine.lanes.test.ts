import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readShipState } from '../../../ship/state.js';
import { runFactoryEngine } from '../engine.js';
import { factoryStatePath, readFactoryState } from '../state.js';
import { commitFile, FakeLanes, gitIn, ISSUE, noCommit, PR, remoteHead, review, type LaneScript } from './fake-lanes.js';
import { h, useEngineHarness, limits, opts, run } from './engine-harness.js';

useEngineHarness();

describe('omg factory run engine (fake lanes, real git, scripted gh)', () => {
  it('an omg-plan link (optional) is read from the base branch with its blob sha', async () => {
    h.gh.issue.body = 'see plan';
    h.gh.issue.comments = [{ body: 'omg-plan: docs/plan.md', authorAssociation: 'MEMBER' }];
    const { lanes, done } = run([commitFile('a.ts'), review('approve')]);
    await done;
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.plan).toMatchObject({ source: 'link', path: 'docs/plan.md', blob: gitIn(h.root, 'rev-parse', 'origin/dev:docs/plan.md') });
    expect(lanes.started[0].prompt).toContain('Add greet().');
  });

  it('factory.run.laneModel starts every lane kind (implement, review, fix, review) on it and records it per lane; unset passes no model', async () => {
    const finding = { severity: 'major', file: 'src/greet.ts', line: 1, summary: 'greet must return hi' };
    const { lanes, done } = run([commitFile('src/greet.ts', 'x\n'), review('request-changes', [finding]), commitFile('src/greet.ts', 'hi\n'), review('approve')], { limits: limits({ laneModel: 'mai-code-2' }) });
    expect((await done).gate?.name).toBe('merge');
    expect(lanes.started.map((s) => [s.laneId.replace(`issue-${ISSUE}-`, ''), s.model])).toEqual([['implement-1', 'mai-code-2'], ['review-1', 'mai-code-2'], ['fix-1', 'mai-code-2'], ['review-2', 'mai-code-2']]);
    expect(readFactoryState(h.root, ISSUE)!.lanes.map((l) => l.model)).toEqual(['mai-code-2', 'mai-code-2', 'mai-code-2', 'mai-code-2']);
  });

  it('records the first lane\'s model; a resume on another model warns and notes it, and the stored value never picks the model', async () => {
    const first = run([noCommit, noCommit], { limits: limits({ laneModel: 'mai-code-2' }) });
    expect((await first.done).gate?.name).toBe('implement-failed');
    expect(readFactoryState(h.root, ISSUE)!.laneModel).toBe('mai-code-2');
    const warnings: string[] = [];
    const second = run([commitFile('a.ts'), review('approve')], { limits: limits({ laneModel: 'claude-opus-5.5' }), warn: (m) => warnings.push(m) });
    await second.done;
    const note = "lane model changed on resume: the run's first lane used mai-code-2, this invocation starts lanes on claude-opus-5.5";
    expect(warnings).toContain(`omg factory run: ${note}`);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.history.map((x) => x.note)).toContain(note);
    // This invocation's model starts the lanes; the stored first-lane model stays as it was.
    expect(second.lanes.started.every((s) => s.model === 'claude-opus-5.5')).toBe(true);
    expect(state.laneModel).toBe('mai-code-2');
  });

  it('a resume on the default after a lane model warns too; the same model does not', async () => {
    const first = run([noCommit, noCommit], { limits: limits({ laneModel: 'mai-code-2' }) });
    await first.done;
    const warnings: string[] = [];
    const second = run([commitFile('a.ts'), review('approve')], { warn: (m) => warnings.push(m) });
    await second.done;
    expect(warnings.filter((w) => w.includes('lane model changed on resume'))).toEqual(["omg factory run: lane model changed on resume: the run's first lane used mai-code-2, this invocation starts lanes on Copilot's default model"]);
    expect(second.lanes.started.every((s) => !('model' in s))).toBe(true);
  });

  it('a session reporting another model than requested gets a lane note and a history note', async () => {
    const { done } = run([(ctx) => ({ ...commitFile('a.ts')(ctx), model: 'gpt-5.5-mini' }), review('approve')], { limits: limits({ laneModel: 'mai-code-2' }) });
    await done;
    const state = readFactoryState(h.root, ISSUE)!;
    const note = `lane issue-${ISSUE}-implement-1 asked for model mai-code-2, the session reported gpt-5.5-mini`;
    expect(state.lanes[0]).toMatchObject({ model: 'gpt-5.5-mini', note });
    expect(state.history.map((x) => x.note)).toContain(note);
    expect(state.lanes[1].note ?? '').not.toContain('the session reported');
  });

  it('without a lane model no lane start carries a model and no lane record names one', async () => {
    const { lanes, done } = run([commitFile('a.ts'), review('approve')]);
    await done;
    expect(lanes.started.every((s) => !('model' in s))).toBe(true);
    expect(readFactoryState(h.root, ISSUE)!.lanes.every((l) => !('model' in l))).toBe(true);
  });

  it('every write lane start carries beforeSandboxedSession (a review lane none): it copies your node_modules into the lane worktree (git-ignored, its .bin a link), the commit succeeds, yours untouched', async () => {
    mkdirSync(join(h.root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(h.root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(h.root, 'node_modules', 'pkg', 'index.js'), 'yours\n');
    writeFileSync(join(h.root, 'node_modules', '.bin', 'pkg'), 'shim\n');
    const seen: (string | null)[] = [];
    const prepared: LaneScript = (ctx) => {
      seen.push(ctx.input.beforeSandboxedSession!(ctx.worktree));
      const nm = join(ctx.worktree, 'node_modules');
      expect(lstatSync(nm).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(nm, 'pkg')).isSymbolicLink()).toBe(false);
      // A junction (Windows) or dir symlink in the ignored copy: the commit's link check skips the ignored tree.
      expect(lstatSync(join(nm, '.bin')).isSymbolicLink()).toBe(true);
      writeFileSync(join(nm, 'pkg', 'index.js'), 'the lane\'s copy\n');
      return commitFile('a.ts')(ctx);
    };
    const { lanes, done } = run([prepared, review('approve')]);
    expect((await done).gate?.name).toBe('merge');
    expect(seen).toEqual([null]);
    expect(lanes.started.map((s) => [s.profile ?? 'write', typeof s.beforeSandboxedSession])).toEqual([['write', 'function'], ['review', 'undefined']]);
    expect(readFileSync(join(h.root, 'node_modules', 'pkg', 'index.js'), 'utf-8')).toBe('yours\n');
    expect(readFileSync(join(h.root, 'node_modules', '.bin', 'pkg'), 'utf-8')).toBe('shim\n');
    // The tree is not part of the lane's commit.
    expect(gitIn(h.root, 'ls-tree', '-r', '--name-only', readFactoryState(h.root, ISSUE)!.head!)).not.toContain('node_modules');
  });

  it('a lane that stops git ignoring node_modules: the engine removes its copy before the commit (link-safe), the commit has no node_modules and is not refused', async () => {
    mkdirSync(join(h.root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(h.root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(h.root, 'node_modules', 'pkg', 'index.js'), 'yours\n');
    writeFileSync(join(h.root, 'node_modules', '.bin', 'pkg'), 'shim\n');
    let tree = '';
    const unignores: LaneScript = (ctx) => {
      expect(ctx.input.beforeSandboxedSession!(ctx.worktree)).toBeNull();
      tree = join(ctx.worktree, 'node_modules');
      expect(existsSync(join(tree, 'pkg', 'index.js'))).toBe(true);
      writeFileSync(join(ctx.worktree, '.gitignore'), '.omg/\n');
      return commitFile('a.ts')(ctx);
    };
    const warnings: string[] = [];
    const { done } = run([unignores, review('approve')], { warn: (m) => warnings.push(m) });
    expect((await done).gate?.name).toBe('merge');
    expect(existsSync(tree)).toBe(false);
    expect(warnings.join('\n')).toMatch(/git no longer ignores node_modules .* removed its copied node_modules before the lane commit/);
    const files = gitIn(h.root, 'ls-tree', '-r', '--name-only', readFactoryState(h.root, ISSUE)!.head!);
    expect(files).not.toContain('node_modules');
    expect(files).toContain('.gitignore');
    expect(readFileSync(join(h.root, 'node_modules', 'pkg', 'index.js'), 'utf-8')).toBe('yours\n');
    expect(readFileSync(join(h.root, 'node_modules', '.bin', 'pkg'), 'utf-8')).toBe('shim\n');
  });

  it('the write prompts follow the backend\'s sandbox reading: no network on Windows forbids installs and names the copied deps; the review prompt never', async () => {
    const RULE = 'never run `npm install`, `npm ci` or any other package install';
    const READY = 'The dependencies are already installed in node_modules.';
    mkdirSync(join(h.root, 'node_modules'), { recursive: true });
    const lanes = new FakeLanes(h.root, [commitFile('a.ts'), review('approve')]);
    lanes.laneSandbox = () => ({ sandboxed: true, writeNetwork: 'none', windowsCopy: true });
    await runFactoryEngine(opts(lanes));
    const [copied, copiedReview] = lanes.started;
    expect(copied.prompt).toContain(RULE);
    expect(copied.prompt).toContain(READY);
    expect(copiedReview.prompt).not.toContain('package install');
  });

  it('no network without a copy (not Windows): installs forbidden, nothing claimed about node_modules', async () => {
    const RULE = 'never run `npm install`, `npm ci` or any other package install';
    const lanes = new FakeLanes(h.root, [commitFile('a.ts'), review('approve')]);
    lanes.laneSandbox = () => ({ sandboxed: true, writeNetwork: 'none', windowsCopy: false });
    await runFactoryEngine(opts(lanes));
    expect(lanes.started[0].prompt).toContain(RULE);
    expect(lanes.started[0].prompt).not.toContain('already installed');
  });

  it('writeNetwork "registry": no rule in the write prompt', async () => {
    const lanes = new FakeLanes(h.root, [commitFile('a.ts'), review('approve')]);
    lanes.laneSandbox = () => ({ sandboxed: true, writeNetwork: 'registry', windowsCopy: true });
    await runFactoryEngine(opts(lanes));
    expect(lanes.started[0].prompt).not.toContain('package install');
  });

  it('a backend that cannot tell (no laneSandbox): no rule in any prompt', async () => {
    const { lanes, done } = run([commitFile('a.ts'), review('approve')]);
    await done;
    expect(lanes.started.every((s) => !s.prompt.includes('package install'))).toBe(true);
  });

  it('a lane without commits gets one fresh retry, then implement-failed', async () => {
    const { lanes, done } = run([noCommit, noCommit]);
    const out = await done;
    expect(out.gate?.name).toBe('implement-failed');
    expect(lanes.started.map((s) => s.laneId)).toEqual([`issue-${ISSUE}-implement-1`, `issue-${ISSUE}-implement-2`]);
    expect(remoteHead(h)).toBeNull();
  });

  it('a lane writing a merge-rule path parks at protected-paths and pushes nothing', async () => {
    const { done } = run([commitFile('.github/workflows/ci.yml', 'on: push\n')]);
    const out = await done;
    expect(out.gate?.name).toBe('protected-paths');
    expect(remoteHead(h)).toBeNull();
    expect(h.calls.some((c) => c.startsWith('git push'))).toBe(false);
  });

  it('a completed write lane without a change summary parks at protected-paths and commits nothing', async () => {
    const { done } = run([(ctx) => { commitFile('.github/workflows/ci.yml', 'on: push\n')(ctx); return { noChanges: true }; }]);
    const out = await done;
    expect(out.gate?.name).toBe('protected-paths');
    expect(out.gate?.reason).toMatch(/no change summary/);
    expect(remoteHead(h)).toBeNull();
    expect(h.calls.some((c) => c.startsWith('git push'))).toBe(false);
  });

  it.each([
    ['refused', 0, 'sandbox-unavailable: MXC is not available', 'sandbox-unavailable'],
    ['enforced', 1, 'sandbox-escaped: powershell call c1 ran outside the sandbox', 'sandbox-escaped'],
  ] as const)('a write lane whose sandbox is %s parks at %s without a retry or a push', async (mode, unsandboxedCalls, error, gate) => {
    const sandbox = { mode, host: { supported: mode !== 'refused', capabilities: {} }, applied: 'none', canary: 'skipped', unsandboxedCalls, cliVersion: 'x', sdkVersion: 'y' } as const;
    const { lanes, done } = run([() => ({ state: 'failed', error, sandbox })]);
    const out = await done;
    expect(out.gate?.name).toBe(gate);
    expect(out.gate?.reason).toContain(error);
    expect(lanes.started).toHaveLength(1);
    expect(remoteHead(h)).toBeNull();
  });

  it('a review lane that escaped its sandbox parks at sandbox-escaped; its verdict is invalid', async () => {
    const sandbox = { mode: 'enforced', host: { supported: true, capabilities: { shell: true } }, applied: 'options.update', canary: 'skipped', unsandboxedCalls: 1, cliVersion: 'x', sdkVersion: 'y' } as const;
    const { done } = run([commitFile('a.ts'), () => ({ state: 'failed', error: 'sandbox-escaped: bash call c ran outside the sandbox', sandbox })]);
    const out = await done;
    expect(out.gate?.name).toBe('sandbox-escaped');
    expect(readFactoryState(h.root, ISSUE)!.lanes[1].verdict).toBe('invalid');
  });

  it('maxRunCredits stops at a step boundary with a resumable awaiting-human: budget', async () => {
    const first = run([commitFile('a.ts', 'a\n', 15)], { limits: limits({ maxRunCredits: 40 }) });
    const out = await first.done;
    expect(out.gate?.name).toBe('budget');
    expect(out.gate?.reason).toMatch(/15\.00 of factory\.run\.maxRunCredits 40/);
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('review');

    // The owner raises the limit and reruns: the run resumes at review, the lane cap is what is left.
    const second = run([review('approve')], { limits: limits({ maxRunCredits: 50 }) });
    const resumed = await second.done;
    expect(resumed.gate?.name).toBe('merge');
    expect(second.lanes.started[0].maxCredits).toBe(30);
    expect(readFactoryState(h.root, ISSUE)!.history.some((e) => e.note === 'rerun after awaiting-human: budget')).toBe(true);
  });

  it('lowers a lane cap to what maxRunCredits leaves', async () => {
    const { lanes, done } = run([commitFile('a.ts', 'a\n', 40), review('approve')], { limits: limits({ maxRunCredits: 75, laneMaxCredits: 40 }) });
    const out = await done;
    expect(out.gate?.name).toBe('merge');
    expect(lanes.started.map((s) => s.maxCredits)).toEqual([40, 35]);
  });

  it('refuses to start without a resolved per-lane credit cap at or above the CLI minimum', async () => {
    const lanes = new FakeLanes(h.root, []);
    await expect(runFactoryEngine(opts(lanes, { limits: limits({ laneMaxCredits: 10 }) }))).rejects.toThrow(/below the Copilot CLI minimum of 30/);
    await expect(runFactoryEngine(opts(lanes, { limits: { ...limits(), laneMaxCredits: undefined as unknown as number } }))).rejects.toThrow(/no per-lane AI-credit cap/);
    expect(existsSync(factoryStatePath(h.root, ISSUE))).toBe(false);
  });

  it('an invalid review output gets one fresh retry, then review-invalid; no verdict is recorded', async () => {
    const bad: LaneScript = () => ({ finalText: 'looks fine to me' });
    const { lanes, done } = run([commitFile('a.ts'), bad, bad]);
    const out = await done;
    expect(out.gate?.name).toBe('review-invalid');
    expect(lanes.started.filter((s) => s.profile === 'review')).toHaveLength(2);
    expect(readShipState(h.root, PR)!.verdicts).toHaveLength(0);
    expect(readFactoryState(h.root, ISSUE)!.lanes.slice(1).map((l) => l.verdict)).toEqual(['invalid', 'invalid']);
  });

  it.each([
    ['a new ref', (c: { root: string }) => gitIn(c.root, 'branch', 'evil', 'HEAD'), /ref refs\/heads\/evil was created/],
    ['an appended git config line', (c: { root: string }) => appendFileSync(join(c.root, '.git', 'config'), '[alias]\n\tp = push\n'), /common git config changed/],
  ])('a review lane that leaves %s fails as review-tampered and its approve is discarded', async (_name, tamper, problem) => {
    const { done } = run([commitFile('a.ts'), review('approve', [], tamper)]);
    const out = await done;
    expect(out.gate?.name).toBe('review-tampered');
    expect(out.gate?.reason).toMatch(problem);
    expect(readShipState(h.root, PR)!.verdicts).toHaveLength(0);
    expect(readFactoryState(h.root, ISSUE)!.lanes[1].verdict).toBe('invalid');
  });
});
