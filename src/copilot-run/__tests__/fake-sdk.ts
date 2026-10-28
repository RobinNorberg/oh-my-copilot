/** A fake @github/copilot-sdk and a scratch git repository for copilot_run job tests (no live session). */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CopilotRunDeps } from '../job.js';
import type { LoadedSdk, SdkSessionConfig } from '../../smoke/copilot-sdk-driver.js';

/** `idle`: answers and idles, changes nothing. `commit`: commits a file in the worktree first. `hang`: never idles. */
export type FakeBehavior = 'idle' | 'commit' | 'hang';

/**
 * The fake runtime's sandbox: `supported` (default) confirms it; `unsupported`
 * reports no host support; `blocked` reports enforcement blocked;
 * `update-fails` rejects options.update; `no-rpc` has no sandbox RPCs (an old SDK).
 */
export type FakeSandbox = 'supported' | 'unsupported' | 'blocked' | 'update-fails' | 'no-rpc';

export interface FakeCalls {
  connections: Array<{ path?: string; args?: string[]; env?: NodeJS.ProcessEnv }>;
  sessions: SdkSessionConfig[];
  prompts: string[];
  /** Every session.rpc.options.update payload. */
  optionsUpdates: Array<Record<string, unknown>>;
}

export const newCalls = (): FakeCalls => ({ connections: [], sessions: [], prompts: [], optionsUpdates: [] });

/** The server `rpc` of a fake client with sandbox support `sandbox`. */
export function fakeClientRpc(sandbox: FakeSandbox): unknown {
  if (sandbox === 'no-rpc') return undefined;
  const supported = sandbox !== 'unsupported';
  return {
    sandbox: {
      getHostSupport: async () => ({
        supported,
        ...(supported ? {} : { reason: 'MXC is not available on this host' }),
        capabilities: [{ name: 'shell', supported }, { name: 'network', supported }, { name: 'denied_paths', supported: false }],
      }),
    },
  };
}

/** The session `rpc` of a fake session with sandbox support `sandbox`. */
export function fakeSessionRpc(sandbox: FakeSandbox, calls: { optionsUpdates: Array<Record<string, unknown>> }): never {
  if (sandbox === 'no-rpc') return {} as never;
  return {
    options: {
      update: async (params: Record<string, unknown>) => {
        calls.optionsUpdates.push(params);
        if (sandbox === 'update-fails') throw new Error('policy conflict');
        return { success: true };
      },
    },
    sandbox: { getEnforcementStatus: async () => ({ required: false, blocked: sandbox === 'blocked', ...(sandbox === 'blocked' ? { reason: 'managed policy' } : {}) }) },
  } as never;
}

export const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();

export function fakeSdk(behavior: FakeBehavior, calls: FakeCalls, sandbox: FakeSandbox = 'supported'): LoadedSdk {
  class Session {
    sessionId = `sess-${calls.sessions.length}`;
    rpc = fakeSessionRpc(sandbox, calls);
    constructor(private readonly cfg: SdkSessionConfig) {}
    private emit(type: string, data: Record<string, unknown> = {}) { this.cfg.onEvent?.({ type, data }); }
    async send({ prompt }: { prompt: string }) {
      calls.prompts.push(prompt);
      setTimeout(() => {
        if (behavior === 'hang') return;
        if (behavior === 'commit') {
          writeFileSync(join(this.cfg.workingDirectory, 'lane.txt'), 'lane work\n');
          gitIn(this.cfg.workingDirectory, 'add', 'lane.txt');
          gitIn(this.cfg.workingDirectory, 'commit', '-q', '-m', 'lane commit');
        }
        this.emit('assistant.usage', { initiator: 'user', model: 'gpt-test', copilotUsage: { totalNanoAiu: 1e9 } });
        this.emit('assistant.message', { content: 'Done.' });
        this.emit('session.idle');
      }, 5);
    }
    async abort() { setTimeout(() => this.emit('session.idle'), 1); }
    async disconnect() { this.emit('session.shutdown', { totalPremiumRequests: 1, totalNanoAiu: 2e9, currentModel: 'gpt-test' }); }
  }
  class Client {
    cliProcess = null;
    rpc = fakeClientRpc(sandbox);
    constructor(_opts: unknown) {}
    async start() {}
    async stop() { return []; }
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

export function fakeDeps(root: string, behavior: FakeBehavior, calls: FakeCalls, env: NodeJS.ProcessEnv, sandbox: FakeSandbox = 'supported'): CopilotRunDeps {
  return {
    env: { PATH: process.env.PATH ?? '', ...env },
    platform: 'linux',
    loadSdk: async () => fakeSdk(behavior, calls, sandbox),
    resolveBin: () => '/usr/bin/copilot',
    pluginRoot: () => '/plugin',
    userConfigDir: () => join(root, 'user-copilot'),
    isAlive: () => false,
    killTree: () => {},
    sandboxTrialLaunch: () => null,
  };
}

/** A temp root with a logged-in user config and a one-commit repository at `<root>/repo` (branch main). */
export function scratchRepo(prefix: string): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  mkdirSync(join(root, 'user-copilot'));
  writeFileSync(join(root, 'user-copilot', 'config.json'), JSON.stringify({ loggedInUsers: [{ login: 'me' }], lastLoggedInUser: { login: 'me' } }));
  gitIn(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  writeFileSync(join(repo, '.gitignore'), '.omg/\n');
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  return { root, repo };
}
