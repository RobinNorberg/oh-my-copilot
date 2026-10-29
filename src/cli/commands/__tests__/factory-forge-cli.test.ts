/**
 * `omg factory` forge wiring (factory forges design §9 PR 6): `run` resolves
 * the forge config and hands the engine the full untrusted roots; `listen`
 * and `heal` stay GitHub-only and refuse an Azure DevOps origin.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { factoryCommand, factoryRunCommand, type FactoryRunDeps } from '../factory.js';
import { resolveFactoryRunLimits } from '../../../factory/run/budget.js';
import { loadFactoryForgeConfig, originForgeKind } from '../../../factory/run/forge-roots.js';
import { readFactoryState } from '../../../factory/run/state.js';
import { healCommand } from '../../../factory/heal/cli.js';
import { resolveHealConfig } from '../../../factory/heal/config.js';
import { resolveForgeConfig } from '../../../forge/config.js';
import { BASE_CONFIG_PATH } from '../../../ship/config.js';
import { defaultExec, type Exec, type ExecResult } from '../../../ship/exec.js';
import { commitFile, FakeLanes, gitIn, harness, ISSUE, REPO_URL, review, testGateConfig, type Harness } from '../../../factory/run/__tests__/fake-lanes.js';

const ADO_URL = 'https://dev.azure.com/contoso/Web/_git/web-app';
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });

let out: string[];

beforeEach(() => {
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('omg factory run forge wiring', () => {
  let h: Harness;
  beforeEach(() => { h = harness('omg-factory-forge-cli-'); });
  afterEach(() => { rmSync(h.dir, { recursive: true, force: true }); });

  it('passes the resolved forge with the full untrusted roots; a GitHub run is recorded as forgeKind github and parks at the same merge', async () => {
    const forge = vi.fn((_root: string, _base: string) => ({ ...resolveForgeConfig(undefined, undefined, undefined, `${REPO_URL}.git`), warnings: ['omg factory: a forge warning'] }));
    const exec: Exec = (cmd, args, opts) => (cmd === 'git' && args.join(' ') === 'rev-parse --show-toplevel' ? ok(`${h.root}\n`) : h.exec(cmd, args, opts));
    const lanes = new FakeLanes(h.root, [commitFile('a.ts'), review('approve')]);
    const deps: FactoryRunDeps = {
      exec, lanes: () => lanes, limits: () => resolveFactoryRunLimits(undefined, undefined), base: () => 'dev',
      ledgerDir: h.ledgerDir, gateConfig: testGateConfig, forge,
    };
    await factoryRunCommand(deps).parseAsync([String(ISSUE), '--json'], { from: 'user' });

    expect(process.exitCode ?? 0).toBe(0);
    expect(forge).toHaveBeenCalledWith(h.root, 'dev');
    expect(out.join('\n')).toContain('omg factory: a forge warning');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.forgeKind).toBe('github');
    expect(state.phase).toBe('merge');
    const result = JSON.parse(out.filter((l) => l.startsWith('{')).join('\n')) as { mergeCommand: string };
    expect(result.mergeCommand).toBe(`gh pr merge 42 --admin --merge --match-head-commit ${state.head}`);
  });
});

describe('loadFactoryForgeConfig', () => {
  it('reads the origin, fetches the base and layers the committed .copilot/omg.jsonc with the user config', () => {
    const calls: string[] = [];
    const base = 'b'.repeat(40);
    const committed = JSON.stringify({ factory: { forge: { kind: 'azure-devops', azureDevOps: { team: 'Web Team' } }, progress: { stages: { reviewing: { column: 'Code Review' } } } } });
    const exec: Exec = (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      const a = args.join(' ');
      if (a === 'remote get-url origin') return ok(`${ADO_URL}\n`);
      if (a === 'fetch origin dev') return ok();
      if (a === 'rev-parse --verify refs/remotes/origin/dev') return ok(`${base}\n`);
      if (a === `cat-file -e ${base}^{commit}`) return ok();
      if (a === `show ${base}:${BASE_CONFIG_PATH}`) return ok(committed);
      return { status: 1, stdout: '', stderr: `unscripted ${a}` };
    };
    const user = { factory: { forge: { azureDevOps: { trustedAuthors: ['Owner@Example.com'] } } } };
    const loaded = loadFactoryForgeConfig(exec, '/repo', 'dev', user, undefined);

    expect(loaded.config).toMatchObject({
      kind: 'azure-devops',
      repo: { owner: 'contoso', project: 'Web', name: 'web-app', url: ADO_URL },
      azureDevOps: { team: 'Web Team', trustedAuthors: ['owner@example.com'] },
      progress: { enabled: true, stages: { reviewing: { column: 'Code Review' } } },
    });
    expect(calls).toEqual([
      'git remote get-url origin', 'git fetch origin dev', 'git rev-parse --verify refs/remotes/origin/dev', `git cat-file -e ${base}^{commit}`, `git show ${base}:${BASE_CONFIG_PATH}`,
    ]);
  });

  it('refuses without an origin, or when config would redirect the forge', () => {
    expect(() => loadFactoryForgeConfig(() => ({ status: 2, stdout: '', stderr: 'no such remote' }), '/repo', 'dev', undefined, undefined)).toThrow(/needs an origin remote/);
    const exec: Exec = (_cmd, args) => (args[0] === 'remote' ? ok(`${ADO_URL}\n`) : args[0] === 'rev-parse' ? ok(`${'c'.repeat(40)}\n`) : args[0] === 'show' ? { status: 128, stdout: '', stderr: `fatal: path '${BASE_CONFIG_PATH}' does not exist in 'c'` } : ok());
    const user = { factory: { forge: { azureDevOps: { org: 'fabrikam' } } } };
    expect(() => loadFactoryForgeConfig(exec, '/repo', 'dev', user, undefined)).toThrow(/config can pin the forge, never redirect it/);
  });

  it('never fetches or reads a base outside ship.trustedBases: its progress states are not allowed', () => {
    const calls: string[] = [];
    const sha = 'd'.repeat(40);
    const committed = JSON.stringify({ factory: { progress: { stages: { building: { state: 'Closed' }, done: { state: 'Removed' } } } } });
    const exec: Exec = (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      const a = args.join(' ');
      if (a === 'remote get-url origin') return ok(`${ADO_URL}\n`);
      if (a.startsWith('rev-parse')) return ok(`${sha}\n`);
      if (a.startsWith('show')) return ok(committed);
      return ok();
    };
    // ship.base from the working tree names a lane's branch; the user config trusts only the defaults.
    const loaded = loadFactoryForgeConfig(exec, '/repo', 'lane-branch', undefined, undefined);

    expect(calls).toEqual(['git remote get-url origin']);
    expect(loaded.warnings[0]).toMatch(/base lane-branch is not in ship\.trustedBases \(dev, main, master\)/);
    const states = Object.values(loaded.config.progress.stages).map((m) => m?.state);
    expect(states).not.toContain('Closed');
    expect(states).not.toContain('Removed');

    // The same branch named in the user's trustedBases is read.
    const trusted = loadFactoryForgeConfig(exec, '/repo', 'lane-branch', { ship: { trustedBases: ['lane-branch'] } }, undefined);
    expect(trusted.config.progress.stages.building?.state).toBe('Closed');
  });
});

describe('GitHub-only commands on an Azure DevOps origin', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-factory-ado-origin-'));
    gitIn(dir, 'init', '-q', '-b', 'dev');
    gitIn(dir, 'remote', 'add', 'origin', ADO_URL);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('originForgeKind reads the origin; no origin is GitHub (as before)', () => {
    expect(originForgeKind(defaultExec, dir)).toBe('azure-devops');
    const bare = mkdtempSync(join(tmpdir(), 'omg-factory-no-origin-'));
    try {
      gitIn(bare, 'init', '-q');
      expect(originForgeKind(defaultExec, bare)).toBe('github');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('omg factory listen refuses', async () => {
    const prev = process.env.OMC_FACTORY_HMAC_SECRET;
    process.env.OMC_FACTORY_HMAC_SECRET = 'test-secret';
    try {
      await factoryCommand().parseAsync(['listen', '--repo', 'contoso/web-app', '--cwd', dir, '--port', '0'], { from: 'user' });
    } finally {
      if (prev === undefined) delete process.env.OMC_FACTORY_HMAC_SECRET;
      else process.env.OMC_FACTORY_HMAC_SECRET = prev;
    }
    expect(process.exitCode).toBe(1);
    expect(out.join('\n')).toMatch(/omg factory listen is GitHub-only/);
  });

  it('omg factory heal refuses', async () => {
    const exec: Exec = (cmd, args) => (cmd === 'git' && args.join(' ') === 'rev-parse --show-toplevel' ? ok(`${dir}\n`) : { status: 1, stdout: '', stderr: `unexpected ${cmd} ${args.join(' ')}` });
    const heal = healCommand({
      exec, base: () => 'dev', config: () => resolveHealConfig(undefined, undefined), now: () => new Date(), lanes: () => { throw new Error('no lanes'); },
      ledgerDir: join(dir, 'ledger'), runLimits: () => resolveFactoryRunLimits(undefined, undefined), forgeKind: (root) => originForgeKind(defaultExec, root),
    });
    await heal.parseAsync(['scan', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(3);
    expect(out.join('\n')).toMatch(/omg factory heal is GitHub-only/);
  });
});
