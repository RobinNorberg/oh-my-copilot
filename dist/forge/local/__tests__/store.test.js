import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { appendNoFollow, engineOwnedDir, isUnder, noLinkPath, readPrStore, updatePrStore, withFileLock, writeAtomic } from '../store.js';
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const dirs = [];
const temp = () => {
    const d = mkdtempSync(join(tmpdir(), 'omg-local-store-'));
    dirs.push(d);
    return d;
};
afterEach(() => {
    for (const d of dirs.splice(0))
        rmSync(d, { recursive: true, force: true });
});
describe('engineOwnedDir', () => {
    it('refuses a relative path, a file, and a directory under an untrusted root; creates nothing', () => {
        const t = temp();
        expect(() => engineOwnedDir('rel/dir', [])).toThrow(/not absolute/);
        writeFileSync(join(t, 'f'), '');
        expect(() => engineOwnedDir(join(t, 'f'), [])).toThrow(/not a directory/);
        expect(() => engineOwnedDir(join(t, 'repo', '.omg', 'forge'), [join(t, 'repo')])).toThrow(/untrusted root/);
        const ok = join(t, 'state', 'local', 'x');
        expect(engineOwnedDir(ok, [join(t, 'repo'), ''])).toBe(resolve(ok));
        expect(existsSync(ok)).toBe(false);
    });
    it('isUnder: the root itself and children, not siblings with a shared prefix', () => {
        const t = temp();
        expect(isUnder(join(t, 'a'), join(t, 'a'))).toBe(true);
        expect(isUnder(join(t, 'a', 'b'), join(t, 'a'))).toBe(true);
        expect(isUnder(join(t, 'ab'), join(t, 'a'))).toBe(false);
    });
});
describe('noLinkPath, writeAtomic and appendNoFollow with an anchor', () => {
    it('creates missing parents and writes below the anchor', () => {
        const t = temp();
        writeAtomic(join(t, 'a', 'b', 'f.json'), '{}', t);
        appendNoFollow(t, join(t, 'a', 'c', 'log.md'), 'one\n');
        appendNoFollow(t, join(t, 'a', 'c', 'log.md'), 'two\n');
        expect(readFileSync(join(t, 'a', 'b', 'f.json'), 'utf8')).toBe('{}');
        expect(readFileSync(join(t, 'a', 'c', 'log.md'), 'utf8')).toBe('one\ntwo\n');
        expect(noLinkPath(t, join(t, 'x', 'y', 'z'), false)).toBe(false);
        expect(existsSync(join(t, 'x'))).toBe(false);
    });
    it('refuses a linked component at any level, a path outside the anchor, and a file as a parent', () => {
        const t = temp();
        const outside = join(t, 'outside');
        const anchor = join(t, 'root');
        mkdirSync(outside);
        mkdirSync(join(anchor, 'factory'), { recursive: true });
        symlinkSync(outside, join(anchor, 'factory', 'local'), 'junction');
        expect(() => appendNoFollow(anchor, join(anchor, 'factory', 'local', 'items', '1', 'comments.md'), 'x')).toThrow(/symbolic link/);
        expect(() => writeAtomic(join(anchor, 'factory', 'local', 'p.json'), 'x', anchor)).toThrow(/symbolic link/);
        expect(readdirSync(outside)).toEqual([]);
        expect(() => noLinkPath(anchor, join(t, 'elsewhere'))).toThrow(/not under/);
        writeFileSync(join(anchor, 'file'), '');
        expect(() => noLinkPath(anchor, join(anchor, 'file', 'x'))).toThrow(/not a directory/);
    });
});
describe('the PR store', () => {
    it('starts empty, allocates numbers monotonically and persists', () => {
        const path = join(temp(), 'x', 'prs.json');
        expect(readPrStore(path)).toEqual({ version: 1, next: 1, prs: [] });
        const add = () => updatePrStore(path, (s) => {
            const n = s.next++;
            s.prs.push({ number: n, head: `h${n}`, base: 'main', title: 't', state: 'OPEN', isDraft: true, createdAt: 'now' });
            return n;
        });
        expect([add(), add(), add()]).toEqual([1, 2, 3]);
        expect(readPrStore(path).prs.map((p) => p.number)).toEqual([1, 2, 3]);
        expect(existsSync(`${path}.lock`)).toBe(false);
    });
    it('never reuses a number even when next is behind', () => {
        const path = join(temp(), 'prs.json');
        writeFileSync(path, JSON.stringify({ version: 1, next: 1, prs: [{ number: 5, head: 'h', base: 'main', title: 't', state: 'CLOSED', isDraft: false, createdAt: 'x' }] }));
        expect(readPrStore(path).next).toBe(6);
    });
    it.each([
        ['not JSON', '{', 'not valid JSON'],
        ['a wrong version', '{"version":2,"next":1,"prs":[]}', 'malformed'],
        ['a bad PR', '{"version":1,"next":1,"prs":[{"number":"1"}]}', 'malformed'],
    ])('refuses %s', (_n, text, msg) => {
        const path = join(temp(), 'prs.json');
        writeFileSync(path, text);
        expect(() => readPrStore(path)).toThrow(msg);
    });
    it('releases the lock when the update throws, and writes nothing', () => {
        const path = join(temp(), 'prs.json');
        expect(() => updatePrStore(path, () => {
            throw new Error('boom');
        })).toThrow('boom');
        expect(existsSync(`${path}.lock`)).toBe(false);
        expect(existsSync(path)).toBe(false);
    });
    it('waits for a held lock, times out, and breaks a stale one', () => {
        const path = join(temp(), 'prs.json');
        mkdirSync(`${path}.lock`);
        expect(() => withFileLock(path, () => 1, { timeoutMs: 50 })).toThrow(/timed out/);
        const old = new Date(Date.now() - 120_000);
        utimesSync(`${path}.lock`, old, old);
        expect(withFileLock(path, () => 2, { timeoutMs: 50 })).toBe(2);
    });
    it('releases only a lock it owns', () => {
        const path = join(temp(), 'prs.json');
        const lock = `${path}.lock`;
        withFileLock(path, () => {
            expect(readFileSync(join(lock, 'owner'), 'utf8')).toMatch(/^\d+-/);
            rmSync(lock, { recursive: true, force: true });
            mkdirSync(lock);
            writeFileSync(join(lock, 'owner'), 'someone-else');
        });
        expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe('someone-else');
    });
    it.each([
        ['a free start', false],
        ['a stale lock every writer races to break', true],
    ])('survives concurrent read-modify-write from several processes from %s (no lost update, no reused number)', async (_n, stale) => {
        const t = temp();
        const path = join(t, 'prs.json');
        const script = join(t, 'writer.mts');
        writeFileSync(script, [
            `import { updatePrStore } from ${JSON.stringify(pathToFileURL(join(HERE, '..', 'store.ts')).href)};`,
            'const [path, tag] = process.argv.slice(2);',
            'for (let i = 0; i < 15; i++) updatePrStore(path, (s) => { const n = s.next++; s.prs.push({ number: n, head: `${tag}-${i}`, base: "main", title: "t", state: "OPEN", isDraft: true, createdAt: "x" }); });',
        ].join('\n'));
        if (stale) {
            mkdirSync(`${path}.lock`);
            writeFileSync(join(`${path}.lock`, 'owner'), 'crashed');
            const old = new Date(Date.now() - 120_000);
            utimesSync(`${path}.lock`, old, old);
        }
        const tsx = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
        const run = (tag) => new Promise((done) => {
            const child = spawn(process.execPath, [tsx, script, path, tag], { cwd: REPO, stdio: 'ignore' });
            child.on('exit', (code) => done(code ?? 1));
        });
        expect(await Promise.all(['a', 'b', 'c', 'd'].map(run))).toEqual([0, 0, 0, 0]);
        const store = JSON.parse(readFileSync(path, 'utf8'));
        expect(store.prs).toHaveLength(60);
        expect(new Set(store.prs.map((p) => p.number)).size).toBe(60);
        expect(store.next).toBe(61);
        expect(readdirSync(t).filter((n) => n.includes('.lock'))).toEqual([]);
    }, 60_000);
});
//# sourceMappingURL=store.test.js.map