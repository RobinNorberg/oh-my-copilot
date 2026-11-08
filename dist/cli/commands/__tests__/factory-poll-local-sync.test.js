/**
 * `omg factory poll`'s base sync on the local forge (pollLocalBaseSync): the
 * local base is pushed fast-forward only to the engine-owned mirror through
 * the engine's guarded, hardened exec, and the tick reports the synced base.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveForgeConfig } from '../../../forge/config.js';
import { readMirrorRef } from '../../../forge/local/index.js';
import { defaultExec } from '../../../ship/exec.js';
import { gitIn } from '../../../factory/run/__tests__/fake-lanes.js';
import { FactorySafetyError, hardenedGitExec, sameFsPath } from '../../../factory/run/exec.js';
import { FactoryForgeUnavailableError, localRemoteMismatch } from '../../../factory/run/forge-roots.js';
import { emptyHooksDir } from '../../../factory/run/ledger.js';
import { pollLocalBaseSync } from '../factory.js';
let dir;
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
        const raw = [];
        const exec = (cmd, args, opts) => { raw.push(args); return defaultExec(cmd, args, opts); };
        const sync = pollLocalBaseSync(exec, join(dir, 'ledger'));
        const head = gitIn(root, 'rev-parse', 'main');
        expect(sync({ root, base: 'main', config })).toBe(`synced main ${head.slice(0, 12)} to the local forge mirror`);
        expect(readMirrorRef(config.repo.url, 'main')).toBe(head);
        const push = raw.find((a) => a.includes('push'));
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
        const raw = [];
        const exec = (cmd, args, opts) => { raw.push(args); return defaultExec(cmd, args, opts); };
        return { root, config, raw, sync: pollLocalBaseSync(exec, join(dir, 'ledger')) };
    }
    /** The planted refs under refs/heads/x/, and on a failure which command wrote them (reflog), the git version and what ran. */
    const plantedRefs = (w) => {
        const planted = gitIn(w.root, 'for-each-ref', '--format=%(refname)', 'refs/heads/x/');
        const why = planted ? `${gitIn(w.root, 'reflog', 'show', '--format=%gs', planted.split('\n')[0])}\n${gitIn(w.root, 'version')}\n${w.raw.map((a) => a.join(' ')).join('\n')}` : '';
        return { planted, why };
    };
    it('the default omg-local refspec syncs: the fetch takes an explicit tracking refspec and --refmap=', () => {
        const w = world();
        gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url);
        const head = gitIn(w.root, 'rev-parse', 'main');
        w.sync({ root: w.root, base: 'main', config: w.config });
        expect(gitIn(w.root, 'rev-parse', 'refs/remotes/omg-local/main')).toBe(head);
        const fetch = w.raw.find((a) => a.includes('fetch'));
        expect(fetch.slice(fetch.indexOf('fetch'))).toEqual(['fetch', '--no-tags', '--refmap=', 'omg-local', '+refs/heads/main:refs/remotes/omg-local/main']);
    });
    it.each([
        ['replacing the default', ['--replace-all']],
        ['beside the default', ['--add']],
    ])('a planted remote.omg-local.fetch refspec (%s) refuses the sync (exit 5): no local branch is created', (_how, mode) => {
        const w = world();
        gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url);
        gitIn(w.root, 'config', ...mode, 'remote.omg-local.fetch', '+refs/heads/*:refs/heads/x/*');
        expect(() => w.sync({ root: w.root, base: 'main', config: w.config })).toThrow(FactoryForgeUnavailableError);
        const { planted, why } = plantedRefs(w);
        expect(planted, why).toBe('');
        expect(w.raw.filter((a) => a.includes('push') || a.includes('fetch'))).toEqual([]);
    });
    it('the refspec backstop: a push or fetch on omg-local refuses a planted refspec even when the sync check is bypassed', () => {
        const w = world();
        gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url);
        gitIn(w.root, 'init', '-q', '--bare', w.config.repo.url);
        gitIn(w.root, 'config', '--replace-all', 'remote.omg-local.fetch', '+refs/heads/*:refs/heads/x/*');
        const hardened = hardenedGitExec((cmd, args, opts) => { w.raw.push(args); return defaultExec(cmd, args, opts); }, emptyHooksDir(join(dir, 'ledger')), () => w.config.repo.url);
        const head = gitIn(w.root, 'rev-parse', 'main');
        expect(() => hardened('git', ['push', 'omg-local', `${head}:refs/heads/main`], { cwd: w.root })).toThrow(/sets remote\.omg-local\.fetch=\+refs\/heads\/\*:refs\/heads\/x\/\*/);
        expect(() => hardened('git', ['fetch', 'omg-local', 'main'], { cwd: w.root })).toThrow(FactorySafetyError);
        const { planted, why } = plantedRefs(w);
        expect(planted, why).toBe('');
        expect(w.raw.filter((a) => a.includes('push') || a.includes('fetch'))).toEqual([]);
    });
    it.each([
        ['remote.omg-local.vcs', 'ext'],
        ['remote.omg-local.mirror', 'true'],
    ])('%s in the checkout refuses the local forge (exit 5) before any transport', (key, value) => {
        const w = world();
        gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url);
        gitIn(w.root, 'config', key, value);
        let error;
        try {
            w.sync({ root: w.root, base: 'main', config: w.config });
        }
        catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(FactoryForgeUnavailableError);
        expect(error.message).toContain(key);
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
        ['the mirror path without .git', (m) => m.replace(/\.git$/, '')],
        ['another case of the mirror path (case-sensitive file systems only)', (m) => m.replace(/local([\\/])/, 'LOCAL$1')],
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
    /** A bare repository the planted rewrite points at, and whether anything landed in it. */
    const evilRepo = (w) => {
        const evil = join(dir, 'evil.git');
        gitIn(w.root, 'init', '-q', '--bare', evil);
        return { evil, refs: () => gitIn(evil, 'for-each-ref', '--format=%(refname)') };
    };
    it.each([
        ['insteadOf of the literal mirror path, with the remote url spelled with forward slashes', 'insteadOf', (m) => m, (m) => m.replace(/\\/g, '/')],
        ['pushInsteadOf of the mirror\'s parent directory', 'pushInsteadOf', (m) => join(m, '..'), (m) => m],
        ['insteadOf of the mirror path in the other slash form', 'insteadOf', (m) => m.replace(/\\/g, '/'), (m) => m],
    ])('a planted url %s refuses the sync (exit 5): nothing is pushed to the rewrite target', (_what, kind, value, remoteUrl) => {
        const w = world();
        const { evil, refs } = evilRepo(w);
        gitIn(w.root, 'remote', 'add', 'omg-local', remoteUrl(w.config.repo.url));
        gitIn(w.root, 'config', `url.${evil}.${kind}`, value(w.config.repo.url));
        let error;
        try {
            w.sync({ root: w.root, base: 'main', config: w.config });
        }
        catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(FactoryForgeUnavailableError);
        expect(error.message).toMatch(new RegExp(`url\\..*\\.${kind.toLowerCase()}=`));
        expect(w.raw.filter((a) => a.includes('push') && !a.includes('get-url'))).toEqual([]);
        expect(refs()).toBe('');
    });
    it('the rewrite backstop: a push to the mirror path refuses a planted insteadOf even when the sync check is bypassed', () => {
        const w = world();
        const { evil, refs } = evilRepo(w);
        gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url);
        gitIn(w.root, 'init', '-q', '--bare', w.config.repo.url);
        gitIn(w.root, 'config', `url.${evil}.insteadOf`, w.config.repo.url);
        const hardened = hardenedGitExec((cmd, args, opts) => { w.raw.push(args); return defaultExec(cmd, args, opts); }, emptyHooksDir(join(dir, 'ledger')), () => w.config.repo.url);
        const head = gitIn(w.root, 'rev-parse', 'main');
        expect(() => hardened('git', ['push', 'omg-local', `${head}:refs/heads/main`], { cwd: w.root })).toThrow(/rewrites the local forge mirror/);
        expect(w.raw.filter((a) => a.includes('push'))).toEqual([]);
        expect(refs()).toBe('');
    });
    /**
     * A remote NAMED after the mirror path: Windows git looks that name up when
     * the engine pushes to the path, so its url redirects the push and its
     * receivepack runs. Planted: `url` -> evil repo, or `receivepack` -> a
     * command that writes a marker file.
     */
    const plantMirrorNamedRemote = (w, variable) => {
        const { evil, refs } = evilRepo(w);
        const marker = join(dir, 'planted.txt');
        const value = variable === 'url' ? evil : `echo PLANTED > "${marker.replace(/\\/g, '/')}"; false`;
        gitIn(w.root, 'config', `remote.${w.config.repo.url}.${variable}`, value);
        // The plant is live on Windows: a plain push to the mirror path goes through it (control, outside the engine).
        const control = () => {
            const head = gitIn(w.root, 'rev-parse', 'main');
            spawnSync('git', ['push', w.config.repo.url, `${head}:refs/heads/control`], { cwd: w.root, stdio: 'pipe' });
            return variable === 'url' ? refs() !== '' : existsSync(marker);
        };
        return { refs, ran: () => existsSync(marker), control };
    };
    it.each(['url', 'receivepack'])('a remote named after the mirror path with a planted %s refuses the sync (exit 5): nothing pushed, nothing run', (variable) => {
        const w = world();
        const plant = plantMirrorNamedRemote(w, variable);
        let error;
        try {
            w.sync({ root: w.root, base: 'main', config: w.config });
        }
        catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(FactoryForgeUnavailableError);
        expect(error.message).toContain(`.${variable}=`);
        expect(w.raw.filter((a) => a.includes('push') && !a.includes('get-url'))).toEqual([]);
        expect(plant.refs()).toBe('');
        expect(plant.ran()).toBe(false);
        if (process.platform === 'win32') {
            gitIn(w.root, 'init', '-q', '--bare', w.config.repo.url);
            expect(plant.control()).toBe(true);
        }
    });
    it.each(['url', 'receivepack'])('the named-remote backstop: a push to the mirror path refuses a remote named after it (%s) even when the sync check is bypassed', (variable) => {
        const w = world();
        const plant = plantMirrorNamedRemote(w, variable);
        gitIn(w.root, 'remote', 'add', 'omg-local', w.config.repo.url);
        gitIn(w.root, 'init', '-q', '--bare', w.config.repo.url);
        const hardened = hardenedGitExec((cmd, args, opts) => { w.raw.push(args); return defaultExec(cmd, args, opts); }, emptyHooksDir(join(dir, 'ledger')), () => w.config.repo.url);
        const head = gitIn(w.root, 'rev-parse', 'main');
        expect(() => hardened('git', ['push', 'omg-local', `${head}:refs/heads/main`], { cwd: w.root })).toThrow(/remote named after the local forge mirror/);
        expect(w.raw.filter((a) => a.includes('push'))).toEqual([]);
        expect(plant.refs()).toBe('');
        expect(plant.ran()).toBe(false);
        expect(readMirrorRef(w.config.repo.url, 'main')).toBeUndefined();
    });
    it('an unrelated url rewrite (a forge host) does not refuse the sync', () => {
        const w = world();
        gitIn(w.root, 'config', 'url.git@github.com:.insteadOf', 'https://github.com/');
        const head = gitIn(w.root, 'rev-parse', 'main');
        w.sync({ root: w.root, base: 'main', config: w.config });
        expect(readMirrorRef(w.config.repo.url, 'main')).toBe(head);
    });
    it('a remote url that is another spelling of the mirror path refuses the sync (exact mirror string, exit 5, set-url hint)', () => {
        const w = world();
        const other = process.platform === 'win32' ? w.config.repo.url.replace(/\\/g, '/') : `${w.config.repo.url}/`;
        gitIn(w.root, 'remote', 'add', 'omg-local', other);
        expect(() => w.sync({ root: w.root, base: 'main', config: w.config })).toThrow(/points at .*not the mirror.*git remote set-url omg-local/);
        expect(() => w.sync({ root: w.root, base: 'main', config: w.config })).toThrow(FactoryForgeUnavailableError);
        expect(w.raw.filter((a) => a.includes('push') && !a.includes('get-url'))).toEqual([]);
    });
});
//# sourceMappingURL=factory-poll-local-sync.test.js.map