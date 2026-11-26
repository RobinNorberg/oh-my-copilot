/** A fake @microsoft/copilot-sdk (v2) and a scratch git repository for copilot_run job tests (no live session). */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CopilotRunDeps } from '../job.js';
import type { LoadedSdk, SdkSessionConfig, SpawnedStdioOptions } from '../../smoke/copilot-sdk-driver.js';

/**
 * `idle`: answers and idles, changes nothing. `commit`: commits a file in the worktree first. `hang`: never idles.
 * `sandbox-off`: reports the session's sandbox opted out (`session.sandbox_state_changed`) mid-turn, then answers and idles.
 */
export type FakeBehavior = 'idle' | 'commit' | 'hang' | 'sandbox-off';

/**
 * The fake runtime's sandbox: `supported` (default) confirms it; `unsupported`
 * reports no host support; `blocked` reports enforcement blocked;
 * `update-fails` rejects options.update and a createSession that carries a sandbox (a v2 policy conflict at create,
 * with Copilot CLI 1.0.116's message); `no-rpc` has no sandbox RPCs. `ignored`: a runtime that silently drops the
 * policy (create and options.update succeed, enforcement reads `{ required: false, blocked: false }`, getState shows
 * no enabled sandbox). `no-state` has no sandbox.getState RPC; `state-throws` / `state-hangs`: getState throws or
 * never answers; `opted-out`: getState reports `disabledForSession: true`. `create-fails`: every createSession
 * fails with an auth error that is not a sandbox error.
 */
export type FakeSandbox = 'supported' | 'unsupported' | 'blocked' | 'update-fails' | 'no-rpc'
  | 'ignored' | 'no-state' | 'state-throws' | 'state-hangs' | 'opted-out' | 'create-fails';

/** The runtime's refusal of a policy that conflicts with managed policy (Copilot CLI 1.0.116). */
export const POLICY_CONFLICT_MESSAGE = 'Sandbox configuration update violates managed policy. Contact your administrator for more information.';

export interface FakeCalls {
  connections: SpawnedStdioOptions[];
  sessions: SdkSessionConfig[];
  prompts: string[];
  /** Every session.rpc.options.update payload. */
  optionsUpdates: Array<Record<string, unknown>>;
  /** Each connection's GIT_CONFIG_GLOBAL content when it started (the job home is gone afterwards), or null. */
  globalGitConfigs: Array<string | null>;
}

export const newCalls = (): FakeCalls => ({ connections: [], sessions: [], prompts: [], optionsUpdates: [], globalGitConfigs: [] });

/** The server `rpc` of a fake client with sandbox support `sandbox` (`deniedPaths`: the host reports denied_paths). */
export function fakeClientRpc(sandbox: FakeSandbox, deniedPaths = false): unknown {
  if (sandbox === 'no-rpc') return undefined;
  const supported = sandbox !== 'unsupported';
  return {
    sandbox: {
      getHostSupport: async () => ({
        supported,
        ...(supported ? {} : { reason: 'MXC is not available on this host' }),
        capabilities: [{ name: 'shell', supported }, { name: 'network', supported }, { name: 'denied_paths', supported: supported && deniedPaths }],
      }),
    },
  };
}

/** The session `rpc` of a fake session with sandbox support `sandbox`; `created`: the sandbox config createSession took. */
export function fakeSessionRpc(sandbox: FakeSandbox, calls: { optionsUpdates: Array<Record<string, unknown>> }, created?: unknown): never {
  if (sandbox === 'no-rpc') return {} as never;
  // The effective config, as getState reports it: what create or options.update applied, unless the runtime drops it.
  let effective: unknown = sandbox === 'ignored' ? undefined : created;
  const state = () => ({
    incarnation: 1,
    revision: 1,
    config: effective ?? { enabled: false },
    configSource: effective ? 'session_flag' : 'never_configured',
    disabledForSession: sandbox === 'opted-out',
    autoApproveBypass: false,
    sessionOverride: null,
  });
  return {
    options: {
      update: async (params: Record<string, unknown>) => {
        calls.optionsUpdates.push(params);
        if (sandbox === 'update-fails') throw new Error(POLICY_CONFLICT_MESSAGE);
        const next = (params.permissions as { sandbox?: unknown } | undefined)?.sandbox;
        if (next !== undefined && sandbox !== 'ignored') effective = next;
        return { success: true };
      },
    },
    sandbox: {
      getEnforcementStatus: async () => ({ required: false, blocked: sandbox === 'blocked', ...(sandbox === 'blocked' ? { reason: 'managed policy' } : {}) }),
      ...(sandbox === 'no-state' ? {} : {
        getState: async () => {
          if (sandbox === 'state-throws') throw new Error('state unavailable');
          if (sandbox === 'state-hangs') return new Promise(() => {});
          return state();
        },
      }),
    },
  } as never;
}

export const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();

export function fakeSdk(behavior: FakeBehavior, calls: FakeCalls, sandbox: FakeSandbox = 'supported', deniedPaths = false): LoadedSdk {
  class Session {
    sessionId = `sess-${calls.sessions.length}`;
    rpc: never;
    constructor(private readonly cfg: SdkSessionConfig) { this.rpc = fakeSessionRpc(sandbox, calls, cfg.permissions.sandbox); }
    private emit(type: string, data: Record<string, unknown> = {}) { this.cfg.events?.onEvent?.({ type, data }); }
    async send({ prompt }: { prompt: string }) {
      calls.prompts.push(prompt);
      setTimeout(() => {
        if (behavior === 'hang') return;
        if (behavior === 'sandbox-off') {
          this.emit('session.sandbox_state_changed', { incarnation: 1, revision: 2, config: this.cfg.permissions.sandbox ?? {}, configSource: 'session_flag', disabledForSession: true, autoApproveBypass: false, sessionOverride: false });
        }
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
    rpc = fakeClientRpc(sandbox, deniedPaths);
    constructor(_opts: unknown) {}
    async start() {}
    async stop() { return []; }
    async getStatus() { return {}; }
    async listModels() { return []; }
    async createSession(cfg: SdkSessionConfig) {
      calls.sessions.push(cfg);
      if (sandbox === 'update-fails' && cfg.permissions.sandbox) throw new Error(POLICY_CONFLICT_MESSAGE);
      if (sandbox === 'create-fails') throw new Error('authentication failed: 401 Unauthorized');
      return new Session(cfg);
    }
    async deleteSession() {}
  }
  return {
    module: {
      CopilotClient: Client as never,
      RuntimeConnection: {
        forSpawnedStdio: (opts) => {
          calls.connections.push(opts);
          const globalConfig = opts.env?.GIT_CONFIG_GLOBAL;
          calls.globalGitConfigs.push(globalConfig && existsSync(globalConfig) ? readFileSync(globalConfig, 'utf8') : null);
          return opts;
        },
      },
    },
    version: '2.0.3',
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
