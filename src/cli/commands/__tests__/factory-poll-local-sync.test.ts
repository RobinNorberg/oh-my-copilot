/**
 * `omg factory poll`'s base sync on the local forge (pollLocalBaseSync): the
 * local base is pushed fast-forward only to the engine-owned mirror through
 * the engine's guarded, hardened exec, and the tick reports the synced base.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveForgeConfig } from '../../../forge/config.js';
import { readMirrorRef } from '../../../forge/local/index.js';
import { defaultExec, type Exec } from '../../../ship/exec.js';
import { gitIn } from '../../../factory/run/__tests__/fake-lanes.js';
import { hardenedGitExec, sameFsPath } from '../../../factory/run/exec.js';
import { FactoryForgeUnavailableError, localRemoteMismatch } from '../../../factory/run/forge-roots.js';
import { emptyHooksDir } from '../../../factory/run/ledger.js';
import { pollLocalBaseSync } from '../factory.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('omg factory poll: local forge base sync', () => {
  it('creates and syncs the mirror base, reports it, and pins the pack programs; a rewritten base refuses', () => {
    dir = mkdtempSync(join(tmpdir(), 'omg-poll-local-'));
    const root = join(dir, 'repo');
    mkdirSync(root);
    gitIn(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'README.md'), 'hi\n');
    gitIn(root, 'add', '.');
    gitIn(root, 'commit', '-q', '-m', 'init');
    const { config } = resolveForgeConfig({ factory: { forge: { kind: 'local' } } }, undefined, undefined, undefined, { root, stateDir: join(dir, 'forge') });
    const raw: string[][] = [];
    const exec: Exec = (cmd, args, opts) => { raw.push(args); return defaultExec(cmd, args, opts); };
    const sync = pollLocalBaseSync(exec, join(dir, 'ledger'));

    const head = gitIn(root, 'rev-parse', 'main');
    expect(sync({ root, base: 'main', config })).toBe(`synced main ${head.slice(0, 12)} to the local forge mirror`);
    expect(readMirrorRef(config.repo.url, 'main')).toBe(head);
    const push = raw.find((a) => a.includes('push'))!;
    expect(push).toContain('remote.omg-local.receivepack=git-receive-pack');
    expect(push).toContain('core.fsmonitor=false');

    // A human merge moves the base forward: the next tick fast-forwards the mirror.
    gitIn(root, 'commit', '-q', '--allow-empty', '-m', 'merged');
    const next = gitIn(root, 'rev-parse', 'main');
    expect(sync({ root, base: 'main', config })).toContain(next.slice(0, 12));
    expect(readMirrorRef(config.repo.url, 'main')).toBe(next);

    // A rewritten base is not a fast-forward: the tick refuses instead of overwriting the mirror.
    gitIn(root, 'commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten');
    expect(() => sync({ root, base: 'main', config })).toThrow(/fast-forward only/);
    expect(readMirrorRef(config.repo.url, 'main')).toBe(next);
  });

  function world() {
    dir = mkdtempSync(join(tmpdir(), 'omg-poll-local-'));
    const root = join(dir, 'repo');
    mkdirSync(root);
    gitIn(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'README.md'), 'hi\n');
    gitIn(root, 'add', '.');
    gitIn(root, 'commit', '-q', '-m', 'init');
    const { config } = resolveForgeConfig({ factory: { forge: { kind: 'local' } } }, undefined, undefined, undefined, { root, stateDir: join(dir, 'forge') });
    const raw: string[][] = [];
    const exec: Exec = (cmd, args, opts) => { raw.push(args); return defaultExec(cmd, args, opts); };
    return { root, config, raw, sync: pollLocalBaseSync(exec, join(dir, 'ledger')) };
  }

  it('a planted remote.omg-local.fetch refspec never creates local branches: only the tracking ref moves', () => {
    const w = world();
    gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url);
    gitIn(w.root, 'config', '--replace-all', 'remote.omg-local.fetch', '+refs/heads/*:refs/heads/x/*');
    const head = gitIn(w.root, 'rev-parse', 'main');
    w.sync({ root: w.root, base: 'main', config: w.config });
    expect(gitIn(w.root, 'for-each-ref', '--format=%(refname)', 'refs/heads/x/')).toBe('');
    expect(gitIn(w.root, 'rev-parse', 'refs/remotes/omg-local/main')).toBe(head);
    const fetch = w.raw.find((a) => a.includes('fetch'))!;
    expect(fetch).toContain('--refmap=');
    expect(fetch).toContain('+refs/heads/main:refs/remotes/omg-local/main');
  });

  it.each([
    ['remote.omg-local.vcs', 'ext'],
    ['remote.omg-local.mirror', 'true'],
  ])('%s in the checkout refuses the local forge (exit 5) before any transport', (key, value) => {
    const w = world();
    gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url);
    gitIn(w.root, 'config', key, value);
    let error: unknown;
    try {
      w.sync({ root: w.root, base: 'main', config: w.config });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FactoryForgeUnavailableError);
    expect((error as Error).message).toContain(key);
    expect(w.raw.filter((a) => a.includes('push') || a.includes('fetch'))).toEqual([]);
  });

  it('the vcs backstop: a transport on omg-local refuses even when the sync check is bypassed', () => {
    const w = world();
    gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url);
    gitIn(w.root, 'config', 'remote.omg-local.vcs', 'ext');
    const hardened = hardenedGitExec((cmd, args, opts) => { w.raw.push(args); return defaultExec(cmd, args, opts); }, emptyHooksDir(join(dir, 'ledger')));
    expect(() => hardened('git', ['fetch', 'omg-local', 'main'], { cwd: w.root })).toThrow(/sets remote\.omg-local\.vcs/);
    expect(w.raw.filter((a) => a.includes('fetch'))).toEqual([]);
  });

  it.each([
    ['the mirror path without .git', (m: string) => m.replace(/\.git$/, '')],
    ['another case of the mirror path (case-sensitive file systems only)', (m: string) => m.replace(/local([\\/])/, 'LOCAL$1')],
  ])('a pushurl naming %s refuses the sync (exact mirror path)', (what, alter) => {
    const w = world();
    const other = alter(w.config.repo.url);
    // On Windows and macOS another case is the same directory, so only Linux refuses it.
    if (what.startsWith('another case') && process.platform !== 'linux') {
      expect(sameFsPath(other, w.config.repo.url)).toBe(true);
      return;
    }
    gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url);
    gitIn(w.root, 'config', 'remote.omg-local.pushurl', other);
    expect(() => w.sync({ root: w.root, base: 'main', config: w.config })).toThrow(/pushes to .*not the mirror/);
    expect(w.raw.filter((a) => a.includes('push') && !a.includes('get-url'))).toEqual([]);
    expect(localRemoteMismatch(defaultExec, w.root, w.config.repo.url)).toMatch(/not the mirror/);
  });
});
