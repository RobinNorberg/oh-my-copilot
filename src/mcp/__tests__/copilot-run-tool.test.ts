import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CopilotRunManager, type CopilotRunDeps } from '../../copilot-run/job.js';
import { COPILOT_RUN_TOOL_NAMES } from '../../copilot-run/names.js';
import type { LoadedSdk, SdkSessionConfig } from '../../smoke/copilot-sdk-driver.js';
import {
  copilotRunCleanupTool,
  copilotRunStartTool,
  copilotRunWaitTool,
  setCopilotRunManagerForTests,
} from '../../tools/copilot-run-tools.js';
import { allTools, buildListToolsResponse } from '../tool-registry.js';

type Behavior = 'complete' | 'hang' | 'burn';

interface Calls {
  connections: Array<{ path?: string; args?: string[]; env?: NodeJS.ProcessEnv }>;
  sessions: SdkSessionConfig[];
  prompts: string[];
  aborts: number;
  stops: number;
}

function newCalls(): Calls {
  return { connections: [], sessions: [], prompts: [], aborts: 0, stops: 0 };
}

/** A fake @github/copilot-sdk: `complete` edits README.md and idles, `hang` never idles, `burn` passes the credit cap. */
function fakeSdk(behavior: Behavior, calls: Calls): LoadedSdk {
  class Session {
    sessionId = `sess-${calls.sessions.length}`;
    rpc = {} as never;
    constructor(private readonly cfg: SdkSessionConfig) {}
    private emit(type: string, data: Record<string, unknown> = {}) { this.cfg.onEvent?.({ type, data }); }
    async send({ prompt }: { prompt: string }) {
      calls.prompts.push(prompt);
      setTimeout(() => {
        if (behavior === 'complete') {
          writeFileSync(join(this.cfg.workingDirectory, 'README.md'), 'changed by copilot\n');
          this.emit('assistant.usage', { initiator: 'user', model: 'gpt-test', copilotUsage: { totalNanoAiu: 1e9 } });
          this.emit('assistant.message', { content: 'Done: README updated.' });
          this.emit('session.idle');
        } else if (behavior === 'burn') {
          this.emit('assistant.usage', { initiator: 'user', copilotUsage: { totalNanoAiu: 50e9 } });
        }
      }, 5);
    }
    async abort() {
      calls.aborts += 1;
      setTimeout(() => this.emit('session.idle'), 1);
    }
    async disconnect() {
      this.emit('session.shutdown', { totalPremiumRequests: 1, totalNanoAiu: 2.5e9, currentModel: 'gpt-test' });
    }
  }
  class Client {
    constructor(_opts: unknown) {}
    async start() {}
    async stop() { calls.stops += 1; return []; }
    async getStatus() { return {}; }
    async listModels() { return []; }
    async createSession(cfg: SdkSessionConfig) { calls.sessions.push(cfg); return new Session(cfg); }
    async deleteSession() {}
  }
  return {
    module: {
      CopilotClient: Client as never,
      RuntimeConnection: { forStdio: (opts) => { calls.connections.push(opts); return opts; } },
    },
    version: '1.0.16',
    from: 'test',
  };
}

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

let root: string;
let repo: string;
let calls: Calls;

function deps(behavior: Behavior, overrides: Partial<CopilotRunDeps> = {}): CopilotRunDeps {
  return {
    env: { OMG_COPILOT_RUN_ALLOW: '1', PATH: process.env.PATH ?? '' },
    platform: 'linux',
    loadSdk: async () => fakeSdk(behavior, calls),
    resolveBin: () => '/usr/bin/copilot',
    pluginRoot: () => '/plugin',
    userConfigDir: () => join(root, 'user-copilot'),
    isAlive: () => false,
    killTree: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  calls = newCalls();
  root = mkdtempSync(join(tmpdir(), 'omg-copilot-run-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  mkdirSync(join(root, 'user-copilot'));
  writeFileSync(join(root, 'user-copilot', 'config.json'), JSON.stringify({ loggedInUsers: [{ login: 'me' }], lastLoggedInUser: { login: 'me' } }));
  gitIn(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  writeFileSync(join(repo, '.gitignore'), '.omg/\n');
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  setCopilotRunManagerForTests(null);
  rmSync(root, { recursive: true, force: true });
});

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text) as Record<string, any>;

describe('copilot_run tool registration', () => {
  it('lists every copilot_run tool with a JSON schema', () => {
    const names = buildListToolsResponse('').tools.map((t) => t.name);
    for (const name of COPILOT_RUN_TOOL_NAMES) expect(names).toContain(name);
    const start = buildListToolsResponse('').tools.find((t) => t.name === 'copilot_run_start')!;
    expect(start.inputSchema.required).toEqual(['prompt']);
    expect(start.inputSchema.properties).toMatchObject({
      prompt: { type: 'string' },
      cwd: { type: 'string' },
      timeoutMs: { type: 'integer' },
      isolation: { type: 'string', enum: ['worktree', 'none'] },
    });
    expect(allTools.filter((t) => t.name.startsWith('copilot_run_'))).toHaveLength(COPILOT_RUN_TOOL_NAMES.length);
  });

  it('is filtered out by OMC_DISABLE_TOOLS=copilot-run', () => {
    const names = buildListToolsResponse('copilot-run').tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith('copilot_run_'))).toEqual([]);
  });
});

describe('copilot_run_start gate and validation', () => {
  it('refuses without OMG_COPILOT_RUN_ALLOW=1 and spawns nothing', async () => {
    setCopilotRunManagerForTests(new CopilotRunManager(deps('complete', { env: {} })));
    const result = await copilotRunStartTool.handler({ prompt: 'hi', cwd: repo });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/OMG_COPILOT_RUN_ALLOW=1/);
    expect(calls.connections).toHaveLength(0);
    expect(existsSync(join(repo, '.omg'))).toBe(false);
  });

  it('rejects a missing cwd and a non-git cwd in worktree mode', () => {
    const m = new CopilotRunManager(deps('complete'));
    expect(() => m.start({ prompt: 'x', cwd: join(root, 'nope') })).toThrow(/not an existing directory/);
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(() => m.start({ prompt: 'x', cwd: plain })).toThrow(/not inside a git repository/);
    expect(() => m.start({ prompt: '   ', cwd: repo })).toThrow(/prompt is empty/);
    expect(() => m.start({ prompt: 'x', cwd: repo, timeoutMs: 0 })).toThrow(/timeoutMs/);
  });

  it('runs isolation "none" in a non-git directory', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'README.md'), 'x\n');
    const m = new CopilotRunManager(deps('complete'));
    const started = m.start({ prompt: 'x', cwd: plain, isolation: 'none' });
    const done = await m.wait(started.jobId as string, 10_000);
    expect(done.status).toBe('completed');
    expect(done.worktree).toBeUndefined();
    expect(calls.sessions[0].workingDirectory).toBe(resolve(plain));
  });

  it('refuses when the budget governor (enforce mode) is over the hard limit', () => {
    mkdirSync(join(repo, '.copilot'));
    writeFileSync(join(repo, '.copilot', 'omg.jsonc'), JSON.stringify({ budget: { mode: 'enforce', hardLimit: 1 } }));
    mkdirSync(join(repo, '.omg', 'state'), { recursive: true });
    writeFileSync(join(repo, '.omg', 'state', 'budget-ledger.json'), JSON.stringify({
      version: 1,
      since: new Date().toISOString(),
      sessions: { s1: { premiumRequests: 1, credits: 0, source: 'measured', detail: 'test', updatedAt: new Date().toISOString() } },
      teams: {},
      notified: {},
    }));
    const m = new CopilotRunManager(deps('complete'));
    expect(() => m.start({ prompt: 'x', cwd: repo })).toThrow(/refused by the budget governor.*budget\.hardLimit 1/);
    expect(calls.connections).toHaveLength(0);
    expect(existsSync(join(repo, '.omg', 'team'))).toBe(false);
  });

  it('caps concurrent jobs', async () => {
    const m = new CopilotRunManager(deps('hang'));
    const a = m.start({ prompt: 'a', cwd: repo, isolation: 'none' });
    const b = m.start({ prompt: 'b', cwd: repo, isolation: 'none' });
    expect(() => m.start({ prompt: 'c', cwd: repo, isolation: 'none' })).toThrow(/2 job\(s\) already running/);
    await m.cancel(a.jobId as string);
    await m.cancel(b.jobId as string);
  });
});

describe('copilot_run job lifecycle', () => {
  it('runs in a new worktree, reports text, usage and the diff, records the ledger, and cleans up only when clean', async () => {
    setCopilotRunManagerForTests(new CopilotRunManager(deps('complete')));
    const started = parse(await copilotRunStartTool.handler({ prompt: 'Update the README', cwd: repo }));
    expect(started.jobId).toMatch(/^cr-[0-9a-f]{12}$/);
    expect(['starting', 'running']).toContain(started.status);
    const wt = started.worktree;
    expect(wt.branch).toBe(`omc-team/copilot-run/${started.jobId}`);
    expect(resolve(wt.path)).toBe(resolve(repo, '.omg', 'team', 'copilot-run', 'worktrees', started.jobId));

    const done = parse(await copilotRunWaitTool.handler({ jobId: started.jobId, timeoutMs: 10_000 }));
    expect(done.status).toBe('completed');
    expect(done.finalText).toBe('Done: README updated.');
    expect(done.sessionId).toBe('sess-1');
    expect(done.usage).toMatchObject({ premiumRequests: 1, credits: 2.5, source: 'measured' });
    expect(done.changes.changedFiles).toEqual(['README.md']);
    expect(done.changes.diffStat).toMatch(/README\.md/);
    expect(done.changes.protectedChanges).toEqual([]);

    // Copilot worked in the worktree, never in the caller's tree.
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('hello\n');
    expect(readFileSync(join(wt.path, 'README.md'), 'utf8')).toBe('changed by copilot\n');
    expect(calls.prompts).toEqual(['Update the README']);
    const session = calls.sessions[0];
    expect(resolve(session.workingDirectory)).toBe(resolve(wt.path));
    expect(session.excludedTools).toEqual(expect.arrayContaining(COPILOT_RUN_TOOL_NAMES.map((n) => `t-${n}`)));
    expect(session.excludedTools).toContain('t-host_smoke');
    const env = calls.connections[0].env!;
    expect(env.OMG_COPILOT_RUN_ALLOW).toBeUndefined();
    expect(env.OMC_BUDGET_HOST_LEDGER).toBe('1');
    expect(env.COPILOT_HOME).toBe(join(repo, '.omg', 'state', 'copilot-run', started.jobId, 'home'));
    expect(calls.connections[0].args).toEqual(['--max-ai-credits', '30']);

    const ledger = JSON.parse(readFileSync(join(repo, '.omg', 'state', 'budget-ledger.json'), 'utf8'));
    expect(ledger.sessions[`copilot-run:${started.jobId}`]).toMatchObject({ premiumRequests: 1, credits: 2.5, source: 'measured' });

    // Dirty worktree: kept.
    const refused = await copilotRunCleanupTool.handler({ jobId: started.jobId });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/kept .*worktree_dirty/s);
    expect(existsSync(wt.path)).toBe(true);

    // Discarded: removed with its branch.
    gitIn(wt.path, 'checkout', '--', 'README.md');
    const cleaned = parse(await copilotRunCleanupTool.handler({ jobId: started.jobId }));
    expect(cleaned.worktree.removed).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(gitIn(repo, 'branch', '--list', wt.branch)).toBe('');
  });

  it('keeps a worktree whose commits HEAD does not contain', async () => {
    const m = new CopilotRunManager(deps('complete'));
    const started = m.start({ prompt: 'x', cwd: repo });
    await m.wait(started.jobId as string, 10_000);
    const wtPath = (started.worktree as { path: string }).path;
    gitIn(wtPath, 'commit', '-q', '-am', 'copilot work');
    expect(() => m.cleanup(started.jobId as string)).toThrow(/kept .*unmerged/s);
    expect(existsSync(wtPath)).toBe(true);
  });

  it('cancel aborts the session and stops the client', async () => {
    const m = new CopilotRunManager(deps('hang'));
    const started = m.start({ prompt: 'x', cwd: repo });
    await new Promise((r) => setTimeout(r, 50));
    expect(m.status(started.jobId as string).status).toBe('running');
    const cancelled = await m.cancel(started.jobId as string);
    expect(cancelled.status).toBe('cancelled');
    expect(calls.aborts).toBe(1);
    expect(calls.stops).toBe(1);
    expect(cancelled.endedAt).toEqual(expect.any(String));
  });

  it('times out: aborts the turn and reports timeout', async () => {
    const m = new CopilotRunManager(deps('hang'));
    const started = m.start({ prompt: 'x', cwd: repo, isolation: 'none', timeoutMs: 100 });
    const done = await m.wait(started.jobId as string, 10_000);
    expect(done.status).toBe('timeout');
    expect(done.error).toMatch(/timed out after 100 ms/);
    expect(calls.aborts).toBe(1);
  });

  it('wait returns the running status when its own timeout passes first', async () => {
    const m = new CopilotRunManager(deps('hang'));
    const started = m.start({ prompt: 'x', cwd: repo, isolation: 'none' });
    const waited = await m.wait(started.jobId as string, 30);
    expect(['starting', 'running']).toContain(waited.status);
    await m.cancel(started.jobId as string);
  });

  it('aborts at the credit cap', async () => {
    const m = new CopilotRunManager(deps('burn'));
    const started = m.start({ prompt: 'x', cwd: repo, isolation: 'none', maxCredits: 5 });
    const done = await m.wait(started.jobId as string, 10_000);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/credit cap 5 reached/);
    expect(calls.aborts).toBe(1);
  });

  it('fails cleanly when the SDK is not installed', async () => {
    const m = new CopilotRunManager(deps('complete', { loadSdk: async () => null }));
    const started = m.start({ prompt: 'x', cwd: repo, isolation: 'none' });
    const done = await m.wait(started.jobId as string, 10_000);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/copilot-sdk is not installed/);
  });

  it('refuses writes to protected merge-rule paths and outside the worktree', async () => {
    const m = new CopilotRunManager(deps('hang'));
    const started = m.start({ prompt: 'x', cwd: repo });
    await new Promise((r) => setTimeout(r, 50));
    const wtPath = (started.worktree as { path: string }).path;
    const decide = calls.sessions[0].onPermissionRequest;
    const ctx = { sessionId: 's' };
    expect(await decide({ kind: 'write', path: join(wtPath, 'src', 'a.ts') }, ctx)).toEqual({ kind: 'approve-once' });
    expect(await decide({ kind: 'write', path: join(wtPath, '.github', 'workflows', 'ci.yml') }, ctx)).toMatchObject({ kind: 'reject' });
    expect(await decide({ kind: 'write', path: join(wtPath, '.copilot', 'omg.jsonc') }, ctx)).toMatchObject({ kind: 'reject' });
    expect(await decide({ kind: 'write', path: join(repo, 'README.md') }, ctx)).toMatchObject({ kind: 'reject' });
    expect(await decide({ kind: 'shell', fullCommandText: 'git push origin HEAD' }, ctx)).toMatchObject({ kind: 'reject' });
    const cancelled = await m.cancel(started.jobId as string);
    expect(cancelled.deniedPermissions).toHaveLength(4);
  });

  it('rejects unknown and malformed job ids', async () => {
    const m = new CopilotRunManager(deps('complete'));
    expect(() => m.status('cr-000000000000')).toThrow(/No copilot_run job/);
    expect(() => m.status('../etc')).toThrow(/Invalid jobId/);
  });
});
