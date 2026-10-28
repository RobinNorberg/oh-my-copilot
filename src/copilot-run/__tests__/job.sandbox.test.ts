import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CopilotRunManager, type CopilotRunDeps } from '../job.js';
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from '../sandbox.js';
import { fakeDeps, gitIn, newCalls, scratchRepo, type FakeBehavior, type FakeCalls, type FakeSandbox } from './fake-sdk.js';

let root: string;
let repo: string;
let calls: FakeCalls;

const settings = (over: Partial<SandboxSettings> = {}): CopilotRunDeps['sandboxSettings'] =>
  () => ({ settings: { ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [], ...over }, warnings: [] });

function manager(behavior: FakeBehavior, sandbox: FakeSandbox, over: Partial<CopilotRunDeps> = {}, env: NodeJS.ProcessEnv = {}): CopilotRunManager {
  return new CopilotRunManager({ ...fakeDeps(root, behavior, calls, { OMG_COPILOT_RUN_ALLOW: '1', ...env }, sandbox), sandboxSettings: settings(), ...over });
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const tools = (i = 0) => calls.sessions[i].availableTools;

beforeEach(() => {
  calls = newCalls();
  ({ root, repo } = scratchRepo('omg-copilot-run-sbx-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('copilot_run sandbox on a supported host', () => {
  it('applies the review policy through options.update and records an enforced sandbox', async () => {
    const m = manager('idle', 'supported');
    const done = await m.wait(m.start({ prompt: 'review', cwd: repo, profile: 'review' }).jobId, 10_000);
    expect(done.status).toBe('completed');
    expect(done.sandbox).toMatchObject({ mode: 'enforced', applied: 'options.update', canary: 'skipped', unsandboxedCalls: 0, sdkVersion: '1.0.16' });
    expect(done.sandbox?.host).toMatchObject({ supported: true, capabilities: { shell: true, denied_paths: false } });
    expect(done.sandbox?.enforcement).toEqual({ required: false, blocked: false });
    const update = calls.optionsUpdates[0] as { sandboxConfig: { addCurrentWorkingDirectory: boolean; allowBypass: boolean; userPolicy: { filesystem: { readonlyPaths: string[] }; network: unknown } }; sandboxConfigSource: string };
    expect(update.sandboxConfigSource).toBe('session_flag');
    expect(update.sandboxConfig).toMatchObject({ enabled: true, addCurrentWorkingDirectory: false, allowBypass: false, auth: { git: false, gh: false } });
    expect(update.sandboxConfig.userPolicy.filesystem.readonlyPaths[0]).toBe((done.worktree as { path: string }).path);
    expect(update.sandboxConfig.userPolicy.network).toEqual({ allowOutbound: false, allowLocalNetwork: false });
    // createSession of SDK 1.0.16 takes no sandboxConfig.
    expect(calls.sessions[0].sandboxConfig).toBeUndefined();
    expect(tools()).toEqual(expect.arrayContaining(['view', 'grep', 'powershell', 'bash']));
    expect(calls.prompts).toEqual(['review']);
  });

  it('a write session keeps every tool and gets the write policy', async () => {
    const m = manager('idle', 'supported');
    const done = await m.wait(m.start({ prompt: 'implement', cwd: repo }).jobId, 10_000);
    expect(done.status).toBe('completed');
    expect(done.sandbox?.mode).toBe('enforced');
    expect(tools()).toBeUndefined();
    const cfg = (calls.optionsUpdates[0] as { sandboxConfig: { addCurrentWorkingDirectory: boolean; userPolicy: { filesystem: { deniedPaths?: string[] } } } }).sandboxConfig;
    expect(cfg.addCurrentWorkingDirectory).toBe(true);
    // The fake host reports no denied_paths capability.
    expect(cfg.userPolicy.filesystem.deniedPaths).toBeUndefined();
  });
});

describe('copilot_run sandbox fail-closed', () => {
  it.each<FakeSandbox>(['unsupported', 'no-rpc'])('host %s: a review runs read-only without a shell tool', async (sandbox) => {
    const m = manager('hang', sandbox);
    const started = m.start({ prompt: 'review', cwd: repo, profile: 'review' });
    await settle();
    expect(tools()).toEqual(expect.arrayContaining(['view', 'grep', 'glob']));
    expect(tools()).not.toContain('powershell');
    expect(tools()).not.toContain('bash');
    const decide = calls.sessions[0].onPermissionRequest;
    expect(await decide({ kind: 'shell', fullCommandText: 'git status' }, { sessionId: 's' })).toMatchObject({ kind: 'reject', feedback: expect.stringContaining('no shell without a confirmed sandbox') });
    const snap = await m.cancel(started.jobId);
    expect(snap.sandbox).toMatchObject({ mode: 'read-only-no-shell', applied: 'none' });
    expect(snap.notes).toEqual(expect.arrayContaining([expect.stringContaining('read-only without a shell')]));
  });

  it.each<FakeSandbox>(['unsupported', 'no-rpc'])('host %s: a write session refuses with sandbox-unavailable and creates no session', async (sandbox) => {
    const m = manager('idle', sandbox);
    const done = await m.wait(m.start({ prompt: 'implement', cwd: repo }).jobId, 10_000);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^sandbox-unavailable: /);
    expect(done.sandbox?.mode).toBe('refused');
    expect(calls.sessions).toHaveLength(0);
    expect(calls.prompts).toHaveLength(0);
  });

  it('a Linux host the runtime calls supported but where the trial launch fails refuses a write with that reason', async () => {
    const m = manager('idle', 'supported', { platform: 'linux', sandboxTrialLaunch: () => 'unprivileged user namespaces are restricted' });
    const done = await m.wait(m.start({ prompt: 'implement', cwd: repo }).jobId, 10_000);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^sandbox-unavailable: .*unprivileged user namespaces are restricted/);
    expect(done.sandbox).toMatchObject({ mode: 'refused', applied: 'none', host: { supported: false, launchFailed: true } });
    expect(calls.sessions).toHaveLength(0);
  });

  it('writeUnsandboxed "detect-only" runs a write session unsandboxed, with a note', async () => {
    const m = manager('idle', 'unsupported', { sandboxSettings: settings({ writeUnsandboxed: 'detect-only' }) });
    const done = await m.wait(m.start({ prompt: 'implement', cwd: repo }).jobId, 10_000);
    expect(done.status).toBe('completed');
    expect(done.sandbox).toMatchObject({ mode: 'detect-only', applied: 'none', reason: 'MXC is not available on this host' });
    expect(done.notes).toEqual(expect.arrayContaining([expect.stringContaining('detect-only')]));
    expect(calls.optionsUpdates).toHaveLength(0);
  });

  it('reviewUnsandboxed "refuse" refuses a review on an unsupported host', async () => {
    const m = manager('idle', 'unsupported', { sandboxSettings: settings({ reviewUnsandboxed: 'refuse' }) });
    const done = await m.wait(m.start({ prompt: 'review', cwd: repo, profile: 'review' }).jobId, 10_000);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^sandbox-unavailable: /);
    expect(calls.sessions).toHaveLength(0);
  });

  it.each<[FakeSandbox, RegExp]>([
    ['blocked', /enforcement is blocked: managed policy/],
    ['update-fails', /options\.update failed: policy conflict/],
  ])('%s: a write session refuses before its first turn', async (sandbox, reason) => {
    const m = manager('idle', sandbox);
    const done = await m.wait(m.start({ prompt: 'implement', cwd: repo }).jobId, 10_000);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(reason);
    expect(done.error).toMatch(/^sandbox-unavailable: /);
    expect(done.sandbox?.mode).toBe('refused');
    expect(calls.sessions).toHaveLength(1);
    expect(calls.prompts).toHaveLength(0);
  });

  it('blocked: a review falls back to no shell and hides the shell tools', async () => {
    const m = manager('hang', 'blocked');
    const started = m.start({ prompt: 'review', cwd: repo, profile: 'review' });
    await settle();
    const decide = calls.sessions[0].onPermissionRequest;
    expect(await decide({ kind: 'shell', fullCommandText: 'git status' }, { sessionId: 's' })).toMatchObject({ kind: 'reject' });
    expect(calls.optionsUpdates.at(-1)).toEqual({ availableTools: expect.not.arrayContaining(['powershell']) });
    const snap = await m.cancel(started.jobId);
    expect(snap.sandbox).toMatchObject({ mode: 'read-only-no-shell', applied: 'options.update', enforcement: { blocked: true } });
  });

  it.each([
    [{ enabled: false } as Partial<SandboxSettings>, {}, 'sandbox.enabled is false'],
    [{}, { OMG_SANDBOX: 'off' }, 'OMG_SANDBOX=off'],
  ])('switched off (%j %j): detect-only, nothing applied', async (over, env, reason) => {
    const m = manager('idle', 'supported', { sandboxSettings: settings(over) }, env);
    const done = await m.wait(m.start({ prompt: 'implement', cwd: repo }).jobId, 10_000);
    expect(done.status).toBe('completed');
    expect(done.sandbox).toMatchObject({ mode: 'detect-only', reason });
    expect(calls.optionsUpdates).toHaveLength(0);
  });

  it('a malformed sandbox config refuses at start and creates nothing', () => {
    const m = manager('idle', 'supported', { sandboxSettings: () => { throw new Error('user config sandbox.writeUnsandboxed must be "refuse" or "detect-only"'); } });
    expect(() => m.start({ prompt: 'x', cwd: repo })).toThrow(/sandbox config: .*writeUnsandboxed/);
    expect(calls.connections).toHaveLength(0);
  });
});

describe('copilot_run sandbox attestation', () => {
  const emitTool = (name: string, sandboxed: boolean | undefined, id = 'call-1') => {
    const onEvent = calls.sessions[0].onEvent!;
    onEvent({ type: 'tool.execution_start', data: { toolCallId: id, toolName: name } });
    onEvent({ type: 'tool.execution_complete', data: { toolCallId: id, success: true, ...(sandboxed === undefined ? {} : { sandboxed }) } });
  };

  it.each([false, undefined])('a shell call with sandboxed %s stops the session with sandbox-escaped', async (sandboxed) => {
    const m = manager('hang', 'supported');
    const started = m.start({ prompt: 'implement', cwd: repo });
    await settle();
    emitTool('view', false, 'call-0');
    expect(m.status(started.jobId).stopRequested).toBeNull();
    emitTool('powershell', sandboxed);
    const done = await m.wait(started.jobId, 10_000);
    expect(done.status).toBe('failed');
    expect(done.stopRequested).toBe('sandbox-escaped');
    expect(done.error).toMatch(/^sandbox-escaped: powershell call call-1 ran outside the sandbox/);
    expect(done.sandbox?.unsandboxedCalls).toBe(1);
  });

  it('a tool the job never saw start that reports sandboxed: false stops the session', async () => {
    const m = manager('hang', 'supported');
    const started = m.start({ prompt: 'implement', cwd: repo });
    await settle();
    calls.sessions[0].onEvent!({ type: 'tool.execution_complete', data: { toolCallId: 'x', success: true, sandboxed: false } });
    expect((await m.wait(started.jobId, 10_000)).stopRequested).toBe('sandbox-escaped');
  });

  it('in an enforced session a call of an unknown tool without the sandboxed field is an escape', async () => {
    const m = manager('hang', 'supported');
    const started = m.start({ prompt: 'implement', cwd: repo });
    await settle();
    expect(m.status(started.jobId).sandbox?.mode).toBe('enforced');
    calls.sessions[0].onEvent!({ type: 'tool.execution_complete', data: { toolCallId: 'y', success: true } });
    const done = await m.wait(started.jobId, 10_000);
    expect(done.stopRequested).toBe('sandbox-escaped');
    expect(done.error).toMatch(/sandboxed: undefined/);
  });

  it('a sandboxed shell call passes; detect-only counts an unsandboxed one without stopping', async () => {
    const m = manager('hang', 'supported');
    const started = m.start({ prompt: 'implement', cwd: repo });
    await settle();
    emitTool('powershell', true);
    expect(m.status(started.jobId).stopRequested).toBeNull();
    await m.cancel(started.jobId);

    const d = manager('hang', 'unsupported', { sandboxSettings: settings({ writeUnsandboxed: 'detect-only' }) });
    const s2 = d.start({ prompt: 'implement', cwd: repo });
    await settle();
    const onEvent = calls.sessions[1].onEvent!;
    onEvent({ type: 'tool.execution_start', data: { toolCallId: 'c', toolName: 'bash' } });
    onEvent({ type: 'tool.execution_complete', data: { toolCallId: 'c', success: true, sandboxed: false } });
    expect(d.status(s2.jobId).stopRequested).toBeNull();
    expect((await d.cancel(s2.jobId)).sandbox?.unsandboxedCalls).toBe(1);
  });
});

describe('copilot_run sandbox permissions and env', () => {
  it('rejects a sandbox bypass request for every kind', async () => {
    const m = manager('hang', 'supported');
    const started = m.start({ prompt: 'implement', cwd: repo });
    await settle();
    const decide = calls.sessions[0].onPermissionRequest;
    const wt = (started.worktree as { path: string }).path;
    for (const req of [
      { kind: 'shell', fullCommandText: 'git status', requestSandboxBypass: true },
      { kind: 'shell', fullCommandText: 'git status', requestSandboxBypass: true, requestSandboxPermissive: true },
      { kind: 'write', path: join(wt, 'a.txt'), requestSandboxBypass: true },
      { kind: 'read', path: join(wt, 'README.md'), requestSandboxBypass: true },
      { kind: 'url', url: 'https://example.com', requestSandboxBypass: true },
    ]) {
      expect(await decide(req, { sessionId: 's' }), JSON.stringify(req)).toMatchObject({ kind: 'reject', feedback: expect.stringContaining('sandbox bypass') });
    }
    expect(await decide({ kind: 'shell', fullCommandText: 'git status' }, { sessionId: 's' })).toEqual({ kind: 'approve-once' });
    await m.cancel(started.jobId);
  });

  it('a review gets no shell when the sandbox is switched off: detect-only is for write sessions only', async () => {
    for (const [over, env] of [[{ enabled: false }, {}], [{}, { OMG_SANDBOX: 'off' }]] as const) {
      calls = newCalls();
      const m = manager('hang', 'supported', { sandboxSettings: settings(over) }, env);
      const started = m.start({ prompt: 'review', cwd: repo, profile: 'review' });
      await settle();
      expect(m.status(started.jobId).sandbox?.mode).toBe('read-only-no-shell');
      expect(tools()).not.toEqual(expect.arrayContaining(['powershell']));
      expect(tools()).not.toEqual(expect.arrayContaining(['bash']));
      const out = await calls.sessions[0].onPermissionRequest({ kind: 'shell', fullCommandText: 'git status' }, { sessionId: 's' });
      expect(out).toMatchObject({ kind: 'reject', feedback: expect.stringContaining('no shell without a confirmed sandbox') });
      await m.cancel(started.jobId);
    }
    // A write session switched off still runs detect-only.
    calls = newCalls();
    const w = manager('hang', 'supported', { sandboxSettings: settings({ enabled: false }) });
    const ws = w.start({ prompt: 'implement', cwd: repo });
    await settle();
    expect(w.status(ws.jobId).sandbox?.mode).toBe('detect-only');
    await w.cancel(ws.jobId);
  });

  it('scrubs GitHub tokens and the caller token from the final text, notes and events', async () => {
    const secret = 'cop-secret-value';
    const leaked = `ghp_${'Z9y8'.repeat(9)}`;
    const m = manager('hang', 'supported', {}, { COPILOT_GITHUB_TOKEN: secret });
    const started = m.start({ prompt: 'implement', cwd: repo });
    await settle();
    calls.sessions[0].onEvent!({ type: 'assistant.message', data: { content: `token ${secret} and ${leaked}` } });
    const done = await m.cancel(started.jobId);
    expect(done.finalText).toBe('token [redacted] and [redacted]');
    const events = readFileSync(done.eventsPath as string, 'utf8');
    expect(events).not.toContain(secret);
    expect(events).not.toContain(leaked);
  });

  it('the write policy leaves config and hooks read-only, so a planted hook or fsmonitor cannot be written', async () => {
    const tools = [join(root, 'nodejs'), join(root, 'Git')];
    const m = manager('hang', 'supported', { toolPaths: (env, platform) => (env.OMG_COPILOT_RUN_ALLOW === '1' && platform === 'linux' ? tools : []) });
    const started = m.start({ prompt: 'implement', cwd: repo });
    await settle();
    const fs = (calls.optionsUpdates[0] as { sandboxConfig: { userPolicy: { filesystem: { readwritePaths: string[]; readonlyPaths: string[] } } } }).sandboxConfig.userPolicy.filesystem;
    const common = gitIn(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const gitDir = gitIn((started.worktree as { path: string }).path, 'rev-parse', '--path-format=absolute', '--git-dir');
    expect(fs.readonlyPaths).toContain(resolve(common));
    // allowDevToolAccess is off: the lane can still start node (hooks, the MCP server) and git, read-only.
    expect(fs.readonlyPaths).toEqual(expect.arrayContaining(tools));
    for (const t of tools) expect(fs.readwritePaths).not.toContain(t);
    expect(fs.readwritePaths).toEqual(expect.arrayContaining([join(resolve(common), 'objects'), resolve(gitDir)]));
    for (const p of ['config', 'hooks', join('hooks', 'post-checkout'), 'info']) {
      const target = join(resolve(common), p);
      expect(fs.readwritePaths.some((rw) => rw.startsWith(resolve(common)) && (target === rw || target.startsWith(`${rw}\\`) || target.startsWith(`${rw}/`))), p).toBe(false);
    }
    await m.cancel(started.jobId);
  });

  it('hostCommits: a write session gets no git-dir write grant and no seeded identity', async () => {
    gitIn(repo, 'config', 'user.name', 'Lane Owner');
    const m = manager('hang', 'supported');
    const started = m.start({ prompt: 'implement', cwd: repo }, { hostCommits: true });
    await settle();
    const fs = (calls.optionsUpdates[0] as { sandboxConfig: { userPolicy: { filesystem: { readwritePaths: string[]; readonlyPaths: string[] } } } }).sandboxConfig.userPolicy.filesystem;
    const common = resolve(gitIn(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    expect(fs.readonlyPaths).toContain(common);
    expect(fs.readwritePaths.filter((rw) => rw.startsWith(common))).toEqual([]);
    const env = calls.connections[0].env!;
    let gitconfig = '';
    try { gitconfig = readFileSync(env.GIT_CONFIG_GLOBAL!, 'utf8'); } catch { /* never written */ }
    expect(gitconfig).not.toContain('Lane Owner');
    await m.cancel(started.jobId);
  });

  it('the review allowlist replaces the denylist in an enforced review', async () => {
    const m = manager('hang', 'supported');
    const started = m.start({ prompt: 'review', cwd: repo, profile: 'review' });
    await settle();
    const decide = calls.sessions[0].onPermissionRequest;
    const ctx = { sessionId: 's' };
    for (const cmd of ['git diff main...HEAD', 'rg -n hello .', 'Get-Content README.md | Select-Object -First 5']) {
      expect(await decide({ kind: 'shell', fullCommandText: cmd }, ctx), cmd).toEqual({ kind: 'approve-once' });
    }
    for (const cmd of ['git fetch origin', 'npm test', 'node -e 1', 'cat ../outside', 'git status', 'iex x']) {
      const extra = cmd === 'git status' ? { commands: [{ identifier: 'Remove-Item' }] } : {};
      expect(await decide({ kind: 'shell', fullCommandText: cmd, ...extra }, ctx), cmd).toMatchObject({ kind: 'reject', feedback: expect.stringContaining('review allowlist') });
    }
    await m.cancel(started.jobId);
  });

  it('passes only allowlisted env, relocates the profile and seeds the git identity', async () => {
    gitIn(repo, 'config', 'user.name', 'Lane Owner');
    gitIn(repo, 'config', 'user.email', 'owner@example.invalid');
    const m = manager('hang', 'supported', {}, {
      GH_TOKEN: 'gh', GITHUB_TOKEN: 'ghs', AWS_SECRET_ACCESS_KEY: 'aws', AWS_PROFILE: 'p', NPM_TOKEN: 'npm', NODE_OPTIONS: '--require x',
      COPILOT_GITHUB_TOKEN: 'cop', LC_ALL: 'C', HOME: '/real/home', USERPROFILE: 'C:\\Users\\real', TEMP: '/tmp',
    });
    const started = m.start({ prompt: 'implement', cwd: repo });
    await settle();
    const env = calls.connections[0].env!;
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'NPM_TOKEN', 'NODE_OPTIONS', 'OMG_COPILOT_RUN_ALLOW']) expect(env[key], key).toBeUndefined();
    // The Copilot token reaches the session over RPC, never the env its shell children inherit.
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(calls.sessions[0].gitHubToken).toBe('cop');
    expect(env).toMatchObject({ LC_ALL: 'C', COPILOT_ALLOW_ALL: 'false', OMC_GIT_GUARDRAILS: '1' });
    expect(env.PATH).toBe(process.env.PATH ?? '');
    const home = env.COPILOT_HOME!;
    // The caller's TEMP never passes (the runtime grants its TEMP read-write): the job's own temp dir, created before the runtime starts.
    expect(env).toMatchObject({ TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), TMPDIR: join(home, 'tmp') });
    expect(existsSync(join(home, 'tmp'))).toBe(true);
    const profile = join(home, 'profile');
    expect(env).toMatchObject({ HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: join(profile, '.config'), GIT_CONFIG_GLOBAL: join(home, 'git', 'config'), NODE_DISABLE_COMPILE_CACHE: '1' });
    const gitconfig = readFileSync(env.GIT_CONFIG_GLOBAL!, 'utf8');
    expect(gitconfig).toContain('Lane Owner');
    expect(gitconfig).toContain('owner@example.invalid');
    await m.cancel(started.jobId);
  });

  it('win32: a host without LOCALAPPDATA refuses at start with the variable named, before any runtime starts', async () => {
    const m = manager('hang', 'supported', { platform: 'win32' }, { SystemRoot: 'C:\\Windows' });
    expect(() => m.start({ prompt: 'implement', cwd: repo })).toThrow(/copilot_run_start: the Windows sandbox needs LOCALAPPDATA in the environment .*sandbox\.enabled false/);
    expect(calls.connections).toHaveLength(0);
    // Switched off, no sandbox launches anything: no refusal.
    const off = manager('hang', 'supported', { platform: 'win32', sandboxSettings: settings({ enabled: false }) }, { SystemRoot: 'C:\\Windows' });
    const started = off.start({ prompt: 'implement', cwd: repo });
    await settle();
    await off.cancel(started.jobId);
  });

  it('win32: the host LOCALAPPDATA and SystemRoot reach the runtime env verbatim', async () => {
    const m = manager('hang', 'supported', { platform: 'win32' }, { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local' });
    const started = m.start({ prompt: 'implement', cwd: repo });
    await settle();
    const env = calls.connections[0].env!;
    expect(env).toMatchObject({ SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local' });
    expect(env.COPILOT_CACHE_HOME).toBe(join(env.COPILOT_HOME!, '.cache', 'copilot'));
    await m.cancel(started.jobId);
  });
});

describe('copilot_run isolation "none": the job dir inside the lane-writable tree', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('refuses a sandboxed write job before any runtime starts', () => {
    const m = manager('hang', 'supported');
    expect(() => m.start({ prompt: 'implement', cwd: repo, isolation: 'none' })).toThrow(/copilot_run_start: a sandboxed write job with isolation "none" .*\.omg.*Use isolation "worktree"/);
    expect(calls.connections).toHaveLength(0);
    expect(existsSync(join(repo, '.omg', 'state', 'copilot-run'))).toBe(false);
  });

  it('a review, a switched-off sandbox and a state root outside the tree still start', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'omg-copilot-run-state-'));
    try {
      const runs: Array<[Partial<CopilotRunDeps>, NodeJS.ProcessEnv, 'write' | 'review']> = [
        [{}, {}, 'review'],
        [{ sandboxSettings: settings({ enabled: false }) }, {}, 'write'],
        [{}, { OMG_SANDBOX: 'off' }, 'write'],
      ];
      for (const [over, env, profile] of runs) {
        calls = newCalls();
        const m = manager('idle', 'supported', over, env);
        const done = await m.wait(m.start({ prompt: 'x', cwd: repo, isolation: 'none', profile }).jobId, 10_000);
        expect(done.status, JSON.stringify([over, env, profile])).toBe('completed');
      }
      vi.stubEnv('OMC_STATE_DIR', outside);
      calls = newCalls();
      const m = manager('idle', 'supported');
      const done = await m.wait(m.start({ prompt: 'x', cwd: repo, isolation: 'none' }).jobId, 10_000);
      expect(done.status).toBe('completed');
      expect(done.sandbox?.mode).toBe('enforced');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('detect-only: the policy refuses structurally and the job runs unsandboxed, as configured', async () => {
    const m = manager('idle', 'supported', { sandboxSettings: settings({ writeUnsandboxed: 'detect-only' }) });
    const done = await m.wait(m.start({ prompt: 'x', cwd: repo, isolation: 'none' }).jobId, 10_000);
    expect(done.status).toBe('completed');
    expect(done.sandbox).toMatchObject({ mode: 'detect-only', applied: 'none', reason: expect.stringContaining('lies inside the lane-writable worktree') });
    expect(calls.optionsUpdates).toHaveLength(0);
  });

  it('the file tools write no part of the job dir but its temp dir', async () => {
    const m = manager('hang', 'supported', { sandboxSettings: settings({ enabled: false }) });
    const started = m.start({ prompt: 'x', cwd: repo, isolation: 'none' });
    await settle();
    const decide = calls.sessions[0].onPermissionRequest;
    const env = calls.connections[0].env!;
    const jobDir = resolve(env.COPILOT_HOME!, '..');
    for (const path of [join(jobDir, 'events.jsonl'), join(env.COPILOT_HOME!, 'config.json'), join(env.COPILOT_HOME!, 'git', 'config'), join(env.COPILOT_HOME!, 'profile', 'x')]) {
      expect(await decide({ kind: 'write', path }, { sessionId: 's' }), path).toMatchObject({ kind: 'reject', feedback: expect.stringContaining("job's state dir") });
    }
    expect(await decide({ kind: 'write', path: join(env.TEMP!, 'scratch.txt') }, { sessionId: 's' })).toEqual({ kind: 'approve-once' });
    expect(await decide({ kind: 'write', path: join(repo, 'README.md') }, { sessionId: 's' })).toEqual({ kind: 'approve-once' });
    await m.cancel(started.jobId);
  });
});
