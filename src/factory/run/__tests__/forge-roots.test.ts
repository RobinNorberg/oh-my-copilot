import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveAzEntry, type AzBinaryDeps } from '../../../forge/ado/az-binary.js';
import { getOmcRoot } from '../../../lib/worktree-paths.js';
import { defaultExec, type Exec } from '../../../ship/exec.js';
import { factoryGuardExec } from '../exec.js';
import { factoryErrorLine } from '../../check/cli.js';
import { EXIT_FORGE_UNAVAILABLE, FactoryForgeUnavailableError, factoryForgeOptions, loadFactoryForgeConfig, syncLocalMirror } from '../forge-roots.js';

const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'omg-forge-roots-')));
// A real checkout, so its omg root is <repo>/.omg (outside a repository it falls back to the user's).
execFileSync('git', ['init', '-q', repo]);
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('factoryForgeOptions', () => {
  it('names the repository, its omg root, the lane worktrees, the copilot_run job dirs and the team job root', () => {
    const omc = getOmcRoot(repo);
    const { untrustedRoots, stateDir } = factoryForgeOptions(repo, { OMC_JOBS_DIR: join(repo, 'jobs') });
    expect(untrustedRoots).toEqual([repo, omc, join(omc, 'team'), join(omc, 'state', 'copilot-run'), join(repo, 'jobs')]);
    expect(stateDir).toBeTruthy();
    expect(untrustedRoots.some((r) => stateDir!.toLowerCase().startsWith(r.toLowerCase()))).toBe(false);
  });

  it('a PATH entry under a lane root is skipped when resolving az', () => {
    const { untrustedRoots } = factoryForgeOptions(repo, {});
    const lane = join(getOmcRoot(repo), 'team', 'factory-run', 'worktrees', 'issue-1');
    const trusted = join(tmpdir(), 'omg-forge-roots-trusted-cli');
    mkdirSync(lane, { recursive: true });
    const win = process.platform === 'win32';
    // On Windows: an MSI layout in both places; on POSIX: an `az` in both places.
    const layout = (root: string) => (win ? [join(root, 'wbin', 'az.cmd'), join(root, 'python.exe'), join(root, 'Lib', 'site-packages', 'azure', 'cli', '__main__.py')] : [join(root, 'bin', 'az')]);
    const files = new Set([...layout(lane), ...layout(trusted)].map((p) => p.toLowerCase()));
    const bin = (root: string) => join(root, win ? 'wbin' : 'bin');
    const deps: AzBinaryDeps = {
      platform: process.platform,
      env: { PATH: [bin(lane), bin(trusted)].join(win ? ';' : ':') },
      isFile: (p) => files.has(p.toLowerCase()),
      realpath: (p) => p,
      untrustedRoots,
    };
    const entry = resolveAzEntry(deps);
    expect(entry.command).toBe(win ? join(trusted, 'python.exe') : join(trusted, 'bin', 'az'));
    expect(() => resolveAzEntry({ ...deps, env: { PATH: bin(lane) } })).toThrow(/Azure CLI not found/);
  });
});

describe('loadFactoryForgeConfig: origin parsed before any fetch (F8, F9)', () => {
  const made: string[] = [];
  afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

  /** A checkout on `main` with one commit; `origin` set to `url` when given (never reachable). */
  function checkout(url?: string): { root: string; calls: string[]; exec: Exec } {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'omg-forge-load-')));
    made.push(root);
    const g = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'README.md'), 'hi\n');
    g('add', '.');
    g('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'init');
    if (url) g('remote', 'add', 'origin', url);
    const calls: string[] = [];
    const exec: Exec = (cmd, args, opts) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return defaultExec(cmd, args, opts);
    };
    return { root, calls, exec: factoryGuardExec(exec) };
  }
  const fetches = (calls: string[]) => calls.filter((c) => /^git (?:.* )?fetch\b/.test(c));

  it('--dry-run on a GitHub origin never fetches; the base layer is left out with a warning', () => {
    const c = checkout('https://github.com/o/r.git');
    const loaded = loadFactoryForgeConfig(c.exec, c.root, 'main', undefined, undefined, { dryRun: true });
    expect(loaded.config.kind).toBe('github');
    expect(fetches(c.calls)).toEqual([]);
    expect(loaded.warnings.join('\n')).toMatch(/--dry-run does not fetch/);
  });

  it('an origin that is neither GitHub nor Azure DevOps: FactoryForgeUnavailableError (exit 5) and no fetch', () => {
    const c = checkout('https://gitlab.example.com/o/r.git');
    expect(() => loadFactoryForgeConfig(c.exec, c.root, 'main', undefined, undefined)).toThrow(FactoryForgeUnavailableError);
    expect(fetches(c.calls)).toEqual([]);
    expect(EXIT_FORGE_UNAVAILABLE).toBe(5);
  });

  it('no origin and no local forge configured: FactoryForgeUnavailableError and no fetch', () => {
    const c = checkout();
    expect(() => loadFactoryForgeConfig(c.exec, c.root, 'main', undefined, undefined)).toThrow(FactoryForgeUnavailableError);
    expect(fetches(c.calls)).toEqual([]);
  });

  it('no origin with factory.forge.kind "local": the local forge, its mirror under the forge state dir, nothing fetched', () => {
    const c = checkout();
    const loaded = loadFactoryForgeConfig(c.exec, c.root, 'main', { factory: { forge: { kind: 'local' } } }, undefined);
    expect(loaded.config.kind).toBe('local');
    expect(loaded.config.repo.url).toMatch(/[\\/]local[\\/][^\\/]+\.git$/);
    expect(fetches(c.calls)).toEqual([]);
  });

  it('F28: no origin and no local forge config: unsupported forge with the setup --forge local hint, like check', () => {
    const c = checkout();
    expect(() => loadFactoryForgeConfig(c.exec, c.root, 'main', undefined, undefined)).toThrow(FactoryForgeUnavailableError);
    expect(() => loadFactoryForgeConfig(c.exec, c.root, 'main', undefined, undefined))
      .toThrow(/^unsupported forge: no origin remote: .*; for the offline \(local\) forge run `omg factory setup --forge local`$/);
    expect(factoryErrorLine('unsupported forge: x')).toBe('unsupported forge: x');
    expect(factoryErrorLine('boom')).toBe('Error: boom');
  });

  it('a missing base names ship.base and the branches that exist', () => {
    const c = checkout();
    expect(() => loadFactoryForgeConfig(c.exec, c.root, 'dev', { factory: { forge: { kind: 'local' } } }, undefined))
      .toThrow("base branch 'dev' not found; set ship.base in .copilot/omg.jsonc (branches here: main)");
  });
});

describe('syncLocalMirror: the refusal names the fix for its cause', () => {
  const setup = (...configs: string[][]): { root: string; mirror: string; refusal: () => string } => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'omg-sync-refusal-')));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    for (const c of configs) execFileSync('git', ['config', ...c], { cwd: root });
    const mirror = join(root, '..', `${root.split(/[\\/]/).pop()}-mirror.git`);
    return {
      root,
      mirror,
      refusal: () => {
        try {
          syncLocalMirror(defaultExec, root, mirror, 'main');
        } catch (err) {
          expect(err).toBeInstanceOf(FactoryForgeUnavailableError);
          return (err as Error).message;
        }
        throw new Error('syncLocalMirror did not refuse');
      },
    };
  };

  it('a planted pushurl: unset the pushurl, and the url is left alone', () => {
    const s = setup();
    execFileSync('git', ['remote', 'add', 'omg-local', s.mirror], { cwd: s.root });
    execFileSync('git', ['config', 'remote.omg-local.pushurl', '/evil/x.git'], { cwd: s.root });
    const m = s.refusal();
    expect(m).toContain('pushes to /evil/x.git');
    expect(m).toContain('git config --unset-all remote.omg-local.pushurl');
    expect(m).not.toContain('set-url');
    expect(m).not.toContain('pushinsteadof');
  });

  it('a pushInsteadOf rewriting another url: set the url and unset that rewrite, no pushurl command', () => {
    const s = setup(['url./evil/.pushInsteadOf', '/other/']);
    execFileSync('git', ['remote', 'add', 'omg-local', '/other/x.git'], { cwd: s.root });
    const m = s.refusal();
    expect(m).toContain('pushes to /evil/x.git');
    expect(m).toContain(`git remote set-url omg-local ${s.mirror}`);
    expect(m).toContain('git config --unset-all url./evil/.pushinsteadof');
    expect(m).not.toContain('--unset-all remote.omg-local.pushurl');
  });

  it('a remote with no url says so (not "points at omg-local") and sets the url', () => {
    const s = setup(['remote.omg-local.fetch', '+refs/heads/*:refs/remotes/omg-local/*']);
    const m = s.refusal();
    expect(m).toContain('remote omg-local has no url');
    expect(m).not.toContain('points at omg-local');
    expect(m).toContain(`git config remote.omg-local.url ${s.mirror}`);
  });
});
