/**
 * Root discovery for `--all-repos` (ledger-roots.ts): which repositories a
 * ledger lists, and every way a record is refused. A temp ledger dir only,
 * never the real one.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLedgerDir, EngineLedger, ledgerRepoId } from '../ledger.js';
import { checkPinnedRoot, discoverLedgerRoots, probeRoot } from '../ledger-roots.js';
let dir;
let ledgerDir;
beforeEach(() => {
    // The real path: a short (8.3) or linked temp dir would read as "reached through a link".
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'omg-roots-')));
    ledgerDir = join(dir, 'ledger');
});
afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
});
function repo(name) {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', root]);
    return root;
}
/** A ledger record as the engine writes one (EngineLedger.record persists it). */
function record(root, key = 1) {
    EngineLedger.open(ledgerDir, root, key).record(join(root, '.omg', 'state', 'factory', `run-${key}.json`), null);
}
/** A record written by hand into `id`'s dir (a forged or copied one). */
function forged(id, root, key = 1, extra = {}) {
    mkdirSync(join(ledgerDir, id), { recursive: true });
    writeFileSync(join(ledgerDir, id, `run-${key}.json`), JSON.stringify({ version: 1, root, issue: key, files: {}, baselines: {}, ...extra }));
}
function snapshot(path) {
    const out = [];
    const walk = (p) => {
        const st = statSync(p);
        if (st.isDirectory())
            for (const n of readdirSync(p).sort())
                walk(join(p, n));
        else
            out.push(`${p}:${st.size}:${st.mtimeMs}:${readFileSync(p).toString('base64')}`);
    };
    walk(path);
    return out;
}
describe('discoverLedgerRoots', () => {
    it('lists every recorded repository with its ledger id', async () => {
        const a = repo('alpha');
        const b = repo('beta');
        record(a, 1);
        record(a, 2);
        record(b, 7);
        const got = await discoverLedgerRoots({ ledgerDir });
        expect(got.roots).toEqual([
            { id: ledgerRepoId(a), root: a, source: 'ledger', recorded: true },
            { id: ledgerRepoId(b), root: b, source: 'ledger', recorded: true },
        ]);
        expect(got.skipped).toEqual([]);
        expect(got.warnings).toEqual([]);
    });
    it('refuses a record whose dir name is not the id the engine derives from its root (copied or forged)', async () => {
        const a = repo('alpha');
        record(a);
        forged('0123456789abcdef', a);
        const got = await discoverLedgerRoots({ ledgerDir });
        expect(got.roots.map((r) => r.root)).toEqual([a]);
        expect(got.skipped).toEqual([{ id: '0123456789abcdef', reason: 'id-mismatch', root: a }]);
    });
    it('refuses a subdirectory of a repository, a plain folder and a missing root; a missing one is counted, not an error', async () => {
        const a = repo('alpha');
        const sub = join(a, 'packages', 'x');
        mkdirSync(sub, { recursive: true });
        const plain = join(dir, 'plain');
        mkdirSync(plain);
        const gone = join(dir, 'deleted-fixture');
        for (const r of [sub, plain, gone])
            forged(ledgerRepoId(r), r);
        const file = join(dir, 'a-file');
        writeFileSync(file, 'x');
        forged(ledgerRepoId(file), file);
        const got = await discoverLedgerRoots({ ledgerDir });
        expect(got.roots).toEqual([]);
        const why = Object.fromEntries(got.skipped.map((s) => [s.root, s.reason]));
        expect(why).toEqual({ [sub]: 'not-a-repository', [plain]: 'not-a-repository', [gone]: 'missing', [file]: 'not-a-directory' });
    });
    it('accepts a linked worktree or submodule (.git is a gitdir: file) and refuses a .git file that is not one', async () => {
        const wt = join(dir, 'wt');
        mkdirSync(wt);
        writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
        const fake = join(dir, 'fake');
        mkdirSync(fake);
        writeFileSync(join(fake, '.git'), 'not a pointer');
        forged(ledgerRepoId(wt), wt);
        forged(ledgerRepoId(fake), fake);
        const got = await discoverLedgerRoots({ ledgerDir });
        expect(got.roots.map((r) => r.root)).toEqual([wt]);
        expect(got.skipped).toEqual([{ id: ledgerRepoId(fake), reason: 'not-a-repository', root: fake }]);
    });
    it('refuses a root reached through a junction or symlink (its real path is another directory)', async () => {
        const a = repo('alpha');
        const link = join(dir, 'link-to-alpha');
        symlinkSync(a, link, process.platform === 'win32' ? 'junction' : 'dir');
        forged(ledgerRepoId(link), link);
        const got = await discoverLedgerRoots({ ledgerDir });
        expect(got.roots).toEqual([]);
        expect(got.skipped).toEqual([{ id: ledgerRepoId(link), reason: 'link', root: link }]);
    });
    it('dedupes roots that differ only in case where the filesystem folds case (one ledger id; a claim adds nothing)', async () => {
        const a = repo('Alpha');
        record(a);
        const upper = a.toUpperCase();
        mkdirSync(join(ledgerDir, 'claims', 'aaaaaaaaaaaaaaaa'), { recursive: true });
        writeFileSync(join(ledgerDir, 'claims', 'aaaaaaaaaaaaaaaa', 'run-3.owner'), JSON.stringify({ hostname: 'h', run: '3', root: upper, parkedAt: '2026-11-20T00:00:00.000Z' }));
        const got = await discoverLedgerRoots({ ledgerDir });
        // The engine's id lower-cases the root, so both spellings name one ledger dir on every platform.
        expect(ledgerRepoId(upper)).toBe(ledgerRepoId(a));
        expect(got.roots).toEqual([{ id: ledgerRepoId(a), root: a, source: 'ledger', recorded: true }]);
    });
    it('skips a malformed or unreadable record with a fixed warning, never failing', async () => {
        const a = repo('alpha');
        record(a);
        const bad = join(dir, 'bad');
        mkdirSync(join(ledgerDir, ledgerRepoId(bad)), { recursive: true });
        writeFileSync(join(ledgerDir, ledgerRepoId(bad), 'run-1.json'), '{not json');
        forged(ledgerRepoId(join(dir, 'wrong-issue')), join(dir, 'wrong-issue'), 2, { issue: 9 });
        forged(ledgerRepoId(join(dir, 'v2')), join(dir, 'v2'), 1, { version: 2 });
        const got = await discoverLedgerRoots({ ledgerDir });
        expect(got.roots.map((r) => r.root)).toEqual([a]);
        expect(got.skipped.map((s) => s.reason).sort()).toEqual(['unreadable', 'unreadable', 'unreadable']);
        expect(got.warnings).toHaveLength(3);
        // Fixed text: no parser message and no path.
        for (const w of got.warnings) {
            expect(w).toMatch(/^engine ledger dir [0-9a-f]{16}: none of its first 1 run record\(s\) is a readable engine record; skipped$/);
        }
    });
    it('a dir with heal seals only (no run record) names no root and is not counted', async () => {
        mkdirSync(join(ledgerDir, '00000000000000aa', 'heal'), { recursive: true });
        const got = await discoverLedgerRoots({ ledgerDir });
        expect(got).toEqual({ roots: [], skipped: [], warnings: [] });
    });
    it('caps the repository dirs it reads', async () => {
        for (const n of ['r1', 'r2', 'r3'])
            record(repo(n));
        const got = await discoverLedgerRoots({ ledgerDir, maxRepos: 2 });
        expect(got.roots).toHaveLength(2);
        expect(got.warnings).toEqual(['the engine ledger has 3 repository dirs; only the first 2 were read']);
    });
    it('adds a claim owner\'s root when its ledger dir is gone, validated like the others', async () => {
        const c = repo('gamma');
        const claims = join(ledgerDir, 'claims', 'bbbbbbbbbbbbbbbb');
        mkdirSync(claims, { recursive: true });
        writeFileSync(join(claims, 'run-4.owner'), JSON.stringify({ hostname: 'h', run: '4', root: c, parkedAt: '2026-11-20T00:00:00.000Z' }));
        writeFileSync(join(claims, 'run-5.owner'), JSON.stringify({ hostname: 'h', run: '5', root: join(dir, 'gone'), parkedAt: '2026-11-20T00:00:00.000Z' }));
        writeFileSync(join(claims, 'run-6.owner'), 'garbage');
        const got = await discoverLedgerRoots({ ledgerDir });
        expect(got.roots).toEqual([{ id: ledgerRepoId(c), root: c, source: 'claim', recorded: false }]);
        expect(got.skipped).toEqual([{ id: ledgerRepoId(join(dir, 'gone')), reason: 'missing', root: join(dir, 'gone') }]);
    });
    it('rejects hostile root strings in forged records before any probe; a hostile but real directory keeps its exact name', async () => {
        const hostile = ['C:\\x\n; rm -rf /', '/tmp/a\u0007b', 'relative/path', '\\\\server\\share\\repo', '/tmp/../tmp/x', '', 42, null];
        hostile.forEach((r, i) => forged(`ff00000000000${String(i).padStart(3, '0')}`, r));
        const got = await discoverLedgerRoots({ ledgerDir });
        expect(got.roots).toEqual([]);
        expect(new Set(got.skipped.map((s) => s.reason))).toEqual(new Set(['invalid-root']));
        // A skipped root is kept only as sanitised text (no control character survives).
        for (const s of got.skipped)
            if (s.root !== undefined)
                expect(s.root).not.toMatch(/[\u0000-\u001f]/);
    });
    it('pins the set with --repo: a recorded root keeps its record, an unrecorded one is listed as such', async () => {
        const a = repo('alpha');
        const b = repo('beta');
        const c = repo('gamma');
        record(a);
        record(b);
        const got = await discoverLedgerRoots({ ledgerDir, pinned: [b, c, b] });
        expect(got.roots).toEqual([
            { id: ledgerRepoId(b), root: b, source: 'ledger', recorded: true },
            { id: ledgerRepoId(c), root: c, source: 'pinned', recorded: false },
        ]);
        expect(await checkPinnedRoot(join(a, '.git'))).toEqual({ error: expect.stringMatching(/is not a repository top level/) });
        expect(await checkPinnedRoot(a)).toEqual({ root: a });
    });
    it('honours OMC_STATE_DIR exactly as the engine does', () => {
        vi.stubEnv('OMC_STATE_DIR', join(dir, 'state'));
        expect(defaultLedgerDir()).toBe(join(dir, 'state', 'factory-ledger'));
        vi.stubEnv('OMC_STATE_DIR', '  ');
        expect(defaultLedgerDir().endsWith(join('.omg', 'factory-ledger'))).toBe(true);
    });
    it('probes a root without following it anywhere', async () => {
        const a = repo('alpha');
        expect(await probeRoot(a)).toEqual({ real: expect.any(String) });
        expect(await probeRoot(join(dir, 'nope'))).toEqual({ reason: 'missing' });
    });
    it('writes nothing: the ledger and the repositories are byte- and mtime-identical afterwards', async () => {
        const a = repo('alpha');
        record(a);
        forged('0123456789abcdef', a);
        const before = [...snapshot(ledgerDir), ...snapshot(a)];
        await discoverLedgerRoots({ ledgerDir });
        await discoverLedgerRoots({ ledgerDir, pinned: [a] });
        expect([...snapshot(ledgerDir), ...snapshot(a)]).toEqual(before);
    });
});
//# sourceMappingURL=ledger-roots.test.js.map