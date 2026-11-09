import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { DEFAULT_SANDBOX_SETTINGS, buildSandboxConfig, type SandboxHostRecord, type SandboxPolicyContext } from '../sandbox.js';

let root: string;
let ctx: SandboxPolicyContext;
const host: SandboxHostRecord = { supported: true, capabilities: { shell: true, denied_paths: true } };
const denied = (c: SandboxPolicyContext): string[] => buildSandboxConfig('write', c, host).userPolicy.filesystem.deniedPaths ?? [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-sbx-state-'));
  ctx = {
    worktree: join(root, 'wt'),
    commonGitDir: join(root, 'repo', '.git'),
    pluginRoot: join(root, 'plugin'),
    jobHome: join(root, 'job', 'home'),
    jobDir: join(root, 'job'),
    realHome: join(root, 'me'),
    platform: 'linux',
    settings: { ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [] },
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the OMC global state root is denied to the lane', () => {
  it('denies a state root outside the home on every platform', () => {
    const stateRoot = join(root, 'omc-home', 'state');
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(denied({ ...ctx, platform, omcStateRoot: stateRoot }), platform).toContain(stateRoot);
    }
  });

  it('adds nothing for a root the home deny already covers (~/.omg/state)', () => {
    const before = denied({ ...ctx, omcStateRoot: join(ctx.realHome, '.omg', 'state') });
    expect(before.some((p) => p.endsWith('state'))).toBe(false);
  });

  it('denies only the sensitive children when a grant lives inside the root (the job dir under it)', () => {
    const stateRoot = join(root, 'omc-home', 'state');
    const inside = { ...ctx, omcStateRoot: stateRoot, jobHome: join(stateRoot, 'team-jobs', 'j1', 'home'), jobDir: join(stateRoot, 'team-jobs', 'j1') };
    mkdirSync(join(stateRoot, 'forge'), { recursive: true });
    const list = denied(inside);
    expect(list).not.toContain(stateRoot);
    expect(list).toContain(join(stateRoot, 'forge'));
    expect(list).not.toContain(join(stateRoot, 'factory-ledger'));
    expect(list).not.toContain(join(stateRoot, 'team-jobs'));
  });

  it('a home that holds the state root keeps it denied only when no grant is inside it', () => {
    // realHome is itself a grant: a state root under it is not a parent of a grant, so it is denied whole.
    const stateRoot = join(ctx.realHome, 'state-elsewhere');
    expect(denied({ ...ctx, omcStateRoot: stateRoot })).toContain(stateRoot);
  });

  it('the review profile is unaffected (it has no deny list)', () => {
    expect(buildSandboxConfig('review', { ...ctx, omcStateRoot: join(root, 'x') }, host).userPolicy.filesystem).not.toHaveProperty('deniedPaths');
  });

  it('with OMC_STATE_DIR set, the real factory ledger and budget ledger are denied and the granted job dir stays granted', () => {
    const stateDir = join(root, 'central');
    mkdirSync(join(stateDir, 'factory-ledger'), { recursive: true });
    vi.stubEnv('OMC_STATE_DIR', stateDir);
    try {
      const budget = join(getOmcRoot(join(root, 'repo')), 'state', 'budget-ledger.json');
      mkdirSync(join(budget, '..'), { recursive: true });
      writeFileSync(budget, '{}');
      const jobDir = join(stateDir, 'team-jobs', 'j1');
      const config = buildSandboxConfig('write', { ...ctx, omcStateRoot: join(root, 'omc-home', 'state'), jobDir, jobHome: join(jobDir, 'home') }, host);
      const list = config.userPolicy.filesystem.deniedPaths ?? [];
      expect(list).toContain(join(stateDir, 'factory-ledger'));
      expect(list).toContain(budget);
      expect(list).not.toContain(stateDir);
      expect(list).not.toContain(join(stateDir, 'team-jobs'));
      expect(config.userPolicy.filesystem.readwritePaths.some((p) => p.startsWith(join(jobDir)))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
