import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Lets one test make prepare.ts's unlinkSync throw for one path (a read-only or busy file); every other call goes to the real one.
const unlinkFault = vi.hoisted(() => ({ name: undefined }));
vi.mock('fs', async (importOriginal) => {
    const real = await importOriginal();
    const unlinkSync = (p) => {
        if (unlinkFault.name !== undefined && String(p).endsWith(unlinkFault.name))
            throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${String(p)}'`), { code: 'EPERM' });
        return real.unlinkSync(p);
    };
    return { ...real, default: { ...real, unlinkSync }, unlinkSync };
});
// Lets a test make the async copy (fs/promises copyFile) fail for one source path (a busy file), and hold a copy in
// flight: `hold` holds the first copy whose source includes it until `release` settles (then it really copies and its
// destination goes to `landed`); `faultNext` fails the first copy started after the held one; `holdFault` makes the
// failing copy itself wait for `release` before it rejects; `onFault` runs as a copy fails.
const copyFault = vi.hoisted(() => ({
    name: undefined,
    hold: undefined,
    faultNext: false,
    holdFault: false,
    release: Promise.resolve(),
    onFault: undefined,
    holding: false,
    landed: [],
}));
vi.mock('fs/promises', async (importOriginal) => {
    const real = await importOriginal();
    const copyFile = async (src, dest, mode) => {
        const f = copyFault;
        if (f.hold !== undefined && !f.holding && String(src).includes(f.hold)) {
            f.holding = true;
            await f.release;
            await real.copyFile(src, dest, mode);
            f.landed.push(String(dest));
            return;
        }
        if ((f.name !== undefined && String(src).endsWith(f.name)) || (f.faultNext && f.holding)) {
            f.faultNext = false;
            f.name = undefined;
            f.onFault?.();
            if (f.holdFault)
                await f.release;
            throw Object.assign(new Error(`EBUSY: resource busy or locked, copyfile '${String(src)}'`), { code: 'EBUSY' });
        }
        return real.copyFile(src, dest, mode);
    };
    return { ...real, default: { ...real, copyFile }, copyFile };
});
import { GATE_TREE_COMPLETE, GATE_TREE_MARKER, nestedTreeDirs, prepareLaneNodeModules, prepareLaneNodeModulesAsync, settleLaneNodeModules, unlinkNodeModules } from '../prepare.js';
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
const dirs = [];
/** Unlink every link under `dir` (never followed), then remove it: a test dir never empties a link target. */
function removeDir(dir) {
    const walk = (p) => {
        let st;
        try {
            st = lstatSync(p);
        }
        catch {
            return;
        }
        if (st.isSymbolicLink()) {
            try {
                unlinkSync(p);
            }
            catch {
                rmdirSync(p);
            }
            return;
        }
        if (st.isDirectory())
            for (const name of readdirSync(p))
                walk(join(p, name));
    };
    walk(dir);
    rmSync(dir, { recursive: true, force: true });
}
afterEach(() => {
    Object.assign(copyFault, { name: undefined, hold: undefined, faultNext: false, holdFault: false, release: Promise.resolve(), onFault: undefined, holding: false, landed: [] });
    for (const d of dirs.splice(0))
        removeDir(d);
});
/** Every entry under `dir` (links by their target, never followed) with file contents hashed: a fingerprint of the tree. */
function fingerprint(dir) {
    const out = [];
    const walk = (p, rel) => {
        for (const name of readdirSync(p).sort()) {
            const full = join(p, name);
            const r = `${rel}${name}`;
            const st = lstatSync(full);
            if (st.isSymbolicLink())
                out.push(`L ${r} -> ${readlinkSync(full)}`);
            else if (st.isDirectory()) {
                out.push(`D ${r}`);
                walk(full, `${r}/`);
            }
            else
                out.push(`F ${r} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
        }
    };
    walk(dir, '');
    return out;
}
/**
 * `root` (your checkout) whose node_modules is a junction to `store` (the
 * bench fixture's shape) holding a package, a scope and `.bin`, and an empty
 * lane worktree.
 */
function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'omg-lane-nm-'));
    dirs.push(dir);
    const root = join(dir, 'root');
    const store = join(dir, 'store');
    const worktree = join(dir, 'lane');
    for (const d of ['vitest/dist', '@scope/pkg', '.bin'])
        mkdirSync(join(store, d), { recursive: true });
    writeFileSync(join(store, 'vitest', 'package.json'), '{"name":"vitest"}\n');
    writeFileSync(join(store, 'vitest', 'dist', 'index.js'), 'export {};\n');
    writeFileSync(join(store, '@scope', 'pkg', 'index.js'), 'scoped\n');
    writeFileSync(join(store, '.bin', 'vitest'), 'shim\n');
    mkdirSync(root);
    symlinkSync(store, join(root, 'node_modules'), linkType);
    mkdirSync(worktree);
    return { root, worktree, store };
}
const ignoredAll = () => true;
describe('prepareLaneNodeModules (the lane worktree in the Windows OS sandbox)', () => {
    it('builds a real copied tree (package dirs copied, .bin a link), and the junction target (your node_modules) is untouched', () => {
        const { root, worktree, store } = setup();
        const before = fingerprint(store);
        const asked = [];
        expect(prepareLaneNodeModules(root, worktree, { ignored: (p) => { asked.push(p); return true; } })).toBeNull();
        const nm = join(worktree, 'node_modules');
        expect(lstatSync(nm).isSymbolicLink()).toBe(false);
        expect(lstatSync(nm).isDirectory()).toBe(true);
        for (const name of ['vitest', '@scope'])
            expect(lstatSync(join(nm, name)).isSymbolicLink()).toBe(false);
        expect(lstatSync(join(nm, '.bin')).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(nm, 'vitest', 'dist', 'index.js'), 'utf-8')).toBe('export {};\n');
        expect(asked).toEqual([['node_modules']]);
        // A write in the lane's copy never reaches yours.
        writeFileSync(join(nm, 'vitest', 'dist', 'index.js'), 'changed\n');
        expect(fingerprint(store)).toEqual(before);
        // The removal leaves yours too.
        unlinkNodeModules(root, worktree);
        expect(existsSync(nm)).toBe(false);
        expect(fingerprint(store)).toEqual(before);
        expect(lstatSync(join(root, 'node_modules')).isSymbolicLink()).toBe(true);
    });
    it('once per worktree: a complete tree already there is reused, not rebuilt', () => {
        const { root, worktree } = setup();
        expect(prepareLaneNodeModules(root, worktree, { ignored: ignoredAll })).toBeNull();
        const kept = join(worktree, 'node_modules', 'vitest', 'kept.txt');
        writeFileSync(kept, 'kept\n');
        expect(prepareLaneNodeModules(root, worktree, { ignored: ignoredAll })).toBeNull();
        expect(readFileSync(kept, 'utf-8')).toBe('kept\n');
    });
    it('a node_modules link to yours in the worktree: only the link goes (never followed), and a copy replaces it', () => {
        const { root, worktree, store } = setup();
        const before = fingerprint(store);
        symlinkSync(join(root, 'node_modules'), join(worktree, 'node_modules'), linkType);
        expect(prepareLaneNodeModules(root, worktree, { ignored: ignoredAll })).toBeNull();
        expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(false);
        expect(existsSync(join(worktree, 'node_modules', GATE_TREE_MARKER))).toBe(true);
        expect(fingerprint(store)).toEqual(before);
    });
    it('a node_modules link elsewhere refuses and is left as it is', () => {
        const { root, worktree, store } = setup();
        const elsewhere = join(worktree, '..', 'elsewhere');
        mkdirSync(elsewhere);
        writeFileSync(join(elsewhere, 'x.txt'), 'x\n');
        symlinkSync(elsewhere, join(worktree, 'node_modules'), linkType);
        const before = fingerprint(store);
        expect(prepareLaneNodeModules(root, worktree, { ignored: ignoredAll })).toMatch(/is a link the engine did not make/);
        expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(elsewhere, 'x.txt'), 'utf-8')).toBe('x\n');
        expect(fingerprint(store)).toEqual(before);
    });
    it('a copy over its bounds returns why (the lane does not start), with nothing left in the worktree and yours untouched', () => {
        const { root, worktree, store } = setup();
        const before = fingerprint(store);
        const why = prepareLaneNodeModules(root, worktree, { ignored: ignoredAll, copy: { maxFiles: 2 } });
        expect(why).toMatch(/the copied node_modules tree of the lane worktree .* could not be built \(.*over 2 entries/);
        expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
        expect(fingerprint(store)).toEqual(before);
    });
    it('a tree git would not ignore is never built (asked before any copy), with a warning, and the lane still starts', () => {
        const { root, worktree, store } = setup();
        const before = fingerprint(store);
        const notes = [];
        let copiedWhenAsked = true;
        expect(prepareLaneNodeModules(root, worktree, { ignored: () => { copiedWhenAsked = existsSync(join(worktree, 'node_modules')); return false; }, warn: (m) => notes.push(m) })).toBeNull();
        expect(copiedWhenAsked).toBe(false);
        expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
        expect(notes.join('\n')).toMatch(/git does not ignore node_modules .*add node_modules to \.gitignore/);
        expect(fingerprint(store)).toEqual(before);
    });
    it('a cut-off copy (marker without the completion line) is removed and built again; links in it are unlinked, never followed', () => {
        const { root, worktree, store } = setup();
        const before = fingerprint(store);
        expect(prepareLaneNodeModules(root, worktree, { ignored: ignoredAll })).toBeNull();
        const nm = join(worktree, 'node_modules');
        // A crash mid-copy: the completion line is missing and a package is half there.
        writeFileSync(join(nm, GATE_TREE_MARKER), '');
        rmSync(join(nm, 'vitest', 'dist'), { recursive: true });
        expect(prepareLaneNodeModules(root, worktree, { ignored: ignoredAll })).toBeNull();
        expect(readFileSync(join(nm, 'vitest', 'dist', 'index.js'), 'utf-8')).toBe('export {};\n');
        expect(readFileSync(join(nm, GATE_TREE_MARKER), 'utf-8').split('\n')).toContain(GATE_TREE_COMPLETE);
        expect(lstatSync(join(nm, '.bin')).isSymbolicLink()).toBe(true);
        expect(fingerprint(store)).toEqual(before);
    });
    it('workspaces: each package with a node_modules of yours gets its own copy; every tree is asked about first, and none is kept in the in-process record', () => {
        const { root, worktree } = setup();
        for (const base of [root, worktree]) {
            mkdirSync(join(base, 'packages', 'a'), { recursive: true });
            writeFileSync(join(base, 'packages', 'a', 'package.json'), '{"name":"a"}\n');
        }
        mkdirSync(join(root, 'packages', 'a', 'node_modules', 'dep'), { recursive: true });
        writeFileSync(join(root, 'packages', 'a', 'node_modules', 'dep', 'index.js'), 'dep\n');
        const asked = [];
        expect(prepareLaneNodeModules(root, worktree, { workspaces: ['packages/*'], ignored: (p) => { asked.push(p); return true; } })).toBeNull();
        expect(asked).toEqual([['node_modules', 'packages/a/node_modules']]);
        const nested = join(worktree, 'packages', 'a', 'node_modules');
        expect(lstatSync(join(nested, 'dep')).isSymbolicLink()).toBe(false);
        expect(readFileSync(join(nested, 'dep', 'index.js'), 'utf-8')).toBe('dep\n');
        // The marker names the nested tree; without it nothing in this process remembers the lane worktree's trees.
        expect(nestedTreeDirs(worktree)).toEqual([nested]);
        const marker = readFileSync(join(worktree, 'node_modules', GATE_TREE_MARKER), 'utf-8');
        writeFileSync(join(worktree, 'node_modules', GATE_TREE_MARKER), '');
        expect(nestedTreeDirs(worktree)).toEqual([]);
        writeFileSync(join(worktree, 'node_modules', GATE_TREE_MARKER), marker);
        // A nested tree git would not ignore: nothing is built.
        const other = setup();
        for (const base of [other.root, other.worktree]) {
            mkdirSync(join(base, 'packages', 'a'), { recursive: true });
            writeFileSync(join(base, 'packages', 'a', 'package.json'), '{"name":"a"}\n');
        }
        mkdirSync(join(other.root, 'packages', 'a', 'node_modules'), { recursive: true });
        expect(prepareLaneNodeModules(other.root, other.worktree, { workspaces: ['packages/*'], ignored: (p) => !p.includes('packages/a/node_modules') })).toBeNull();
        expect(existsSync(join(other.worktree, 'node_modules'))).toBe(false);
    });
    it('nothing to do without your node_modules; a node_modules the repository has itself is left alone', () => {
        const { root, worktree } = setup();
        unlinkSync(join(root, 'node_modules'));
        expect(prepareLaneNodeModules(root, worktree, { ignored: ignoredAll })).toBeNull();
        expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
        const other = setup();
        mkdirSync(join(other.worktree, 'node_modules'));
        writeFileSync(join(other.worktree, 'node_modules', 'own.js'), 'own\n');
        expect(prepareLaneNodeModules(other.root, other.worktree, { ignored: () => false })).toBeNull();
        expect(readFileSync(join(other.worktree, 'node_modules', 'own.js'), 'utf-8')).toBe('own\n');
    });
});
describe('prepareLaneNodeModules reuseFrom (one copy per work item)', () => {
    /** setup() plus a top-level file in yours, a built tree in the earlier lane worktree, and an empty next lane worktree. */
    function built() {
        const s = setup();
        writeFileSync(join(s.store, '.package-lock.json'), '{"lockfileVersion":3}\n');
        expect(prepareLaneNodeModules(s.root, s.worktree, { ignored: ignoredAll })).toBeNull();
        const next = join(s.worktree, '..', 'lane-2');
        mkdirSync(next);
        const outside = join(s.worktree, '..', 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'secret.txt'), 'secret\n');
        return { ...s, next, outside };
    }
    it('moves the earlier lane\'s complete tree (no new copy), the earlier worktree loses it, and yours is untouched', () => {
        const { root, worktree, store, next } = built();
        const before = fingerprint(store);
        const tree = fingerprint(join(worktree, 'node_modules'));
        // A write the earlier lane left in its copy goes along: the same item's lanes share it.
        writeFileSync(join(worktree, 'node_modules', 'vitest', 'left.txt'), 'left\n');
        expect(prepareLaneNodeModules(root, next, { ignored: ignoredAll, reuseFrom: [worktree], copy: { maxFiles: 1 } })).toBeNull();
        expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
        expect(readFileSync(join(next, 'node_modules', 'vitest', 'left.txt'), 'utf-8')).toBe('left\n');
        expect(fingerprint(join(next, 'node_modules')).filter((l) => !l.includes('left.txt'))).toEqual(tree);
        expect(lstatSync(join(next, 'node_modules', '.bin')).isSymbolicLink()).toBe(true);
        expect(fingerprint(store)).toEqual(before);
    });
    it('a link the earlier lane planted anywhere in its tree: not reused; the moved tree is removed with the link unlinked (never followed), and a fresh copy is built', () => {
        const { root, worktree, store, next, outside } = built();
        const before = fingerprint(store);
        const outsideBefore = fingerprint(outside);
        symlinkSync(outside, join(worktree, 'node_modules', 'vitest', 'dist', 'evil'), linkType);
        const notes = [];
        expect(prepareLaneNodeModules(root, next, { ignored: ignoredAll, reuseFrom: [worktree], warn: (m) => notes.push(m) })).toBeNull();
        expect(notes.join('\n')).toMatch(/is not reused \(node_modules\/vitest\/dist\/evil is a link to somewhere other than/);
        expect(existsSync(join(next, 'node_modules', 'vitest', 'dist', 'evil'))).toBe(false);
        expect(readFileSync(join(next, 'node_modules', GATE_TREE_MARKER), 'utf-8').split('\n')).toContain(GATE_TREE_COMPLETE);
        expect(fingerprint(outside)).toEqual(outsideBefore);
        expect(fingerprint(store)).toEqual(before);
    });
    it('a top-level link re-pointed elsewhere, or a top-level file that differs from yours (an npm install, yours changed): a fresh copy', () => {
        for (const tamper of ['bin', 'lock']) {
            const { root, worktree, store, next, outside } = built();
            const before = fingerprint(store);
            const nm = join(worktree, 'node_modules');
            if (tamper === 'bin') {
                unlinkSync(join(nm, '.bin'));
                symlinkSync(outside, join(nm, '.bin'), linkType);
            }
            else
                writeFileSync(join(nm, '.package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
            const notes = [];
            expect(prepareLaneNodeModules(root, next, { ignored: ignoredAll, reuseFrom: [worktree], warn: (m) => notes.push(m) })).toBeNull();
            expect(notes.join('\n'), tamper).toMatch(tamper === 'bin' ? /node_modules\/\.bin is a link/ : /node_modules\/\.package-lock\.json differs from yours/);
            expect(readFileSync(join(next, 'node_modules', '.package-lock.json'), 'utf-8')).toBe('{"lockfileVersion":3}\n');
            expect(sameTarget(join(next, 'node_modules', '.bin'), join(store, '.bin'))).toBe(true);
            expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('secret\n');
            expect(fingerprint(store)).toEqual(before);
        }
    });
    it('a rejected tree that cannot be removed (a planted file the removal cannot delete): the lane fails with the reason, nothing is built over the leftovers', () => {
        const { root, worktree, store, next, outside } = built();
        const before = fingerprint(store);
        symlinkSync(outside, join(worktree, 'node_modules', 'vitest', 'dist', 'evil'), linkType);
        writeFileSync(join(worktree, 'node_modules', 'vitest', 'planted-read-only.txt'), 'x\n');
        const notes = [];
        unlinkFault.name = 'planted-read-only.txt';
        let problem;
        try {
            problem = prepareLaneNodeModules(root, next, { ignored: ignoredAll, reuseFrom: [worktree], warn: (m) => notes.push(m) });
        }
        finally {
            unlinkFault.name = undefined;
        }
        expect(problem).toMatch(/is not reused \(node_modules\/vitest\/dist\/evil is a link .*\), and it could not be removed from .* \(EPERM: operation not permitted/);
        expect(notes.join('\n')).not.toMatch(/a fresh copy is built/);
        // The leftovers are not taken as a tree: no completion marker was written over them, the planted link went first.
        expect(readFileSync(join(next, 'node_modules', 'vitest', 'planted-read-only.txt'), 'utf-8')).toBe('x\n');
        expect(existsSync(join(next, 'node_modules', GATE_TREE_MARKER))).toBe(false);
        expect(existsSync(join(next, 'node_modules', 'vitest', 'dist', 'evil'))).toBe(false);
        expect(fingerprint(outside)).toEqual([`F secret.txt ${createHash('sha256').update('secret\n').digest('hex')}`]);
        expect(fingerprint(store)).toEqual(before);
    });
    it('never takes a link to yours, a cut-off tree or one that names nested workspace trees; each stays where it was', () => {
        const { root, worktree, store, next } = built();
        const before = fingerprint(store);
        const nm = join(worktree, 'node_modules');
        writeFileSync(join(nm, GATE_TREE_MARKER), `packages/a\n${GATE_TREE_COMPLETE}\n`);
        expect(prepareLaneNodeModules(root, next, { ignored: ignoredAll, reuseFrom: [worktree] })).toBeNull();
        expect(existsSync(join(nm, 'vitest'))).toBe(true);
        unlinkNodeModules(root, next);
        writeFileSync(join(nm, GATE_TREE_MARKER), '');
        expect(prepareLaneNodeModules(root, next, { ignored: ignoredAll, reuseFrom: [worktree] })).toBeNull();
        expect(existsSync(join(nm, 'vitest'))).toBe(true);
        unlinkNodeModules(root, next);
        removeDir(nm);
        symlinkSync(join(root, 'node_modules'), nm, linkType);
        expect(prepareLaneNodeModules(root, next, { ignored: ignoredAll, reuseFrom: [worktree] })).toBeNull();
        expect(lstatSync(nm).isSymbolicLink()).toBe(true);
        expect(lstatSync(join(next, 'node_modules')).isSymbolicLink()).toBe(false);
        expect(fingerprint(store)).toEqual(before);
    });
});
/** Both paths resolve to the same dir (a link followed for the comparison only). */
function sameTarget(a, b) {
    const fold = (p) => (process.platform === 'win32' ? realpathSync.native(p).toLowerCase() : realpathSync.native(p));
    return fold(a) === fold(b);
}
describe('settleLaneNodeModules (before the lane commit)', () => {
    it('the copy still ignored: kept; no longer ignored: removed, links unlinked first, yours untouched', () => {
        const { root, worktree, store } = setup();
        const before = fingerprint(store);
        expect(prepareLaneNodeModules(root, worktree, { ignored: ignoredAll })).toBeNull();
        const asked = [];
        expect(settleLaneNodeModules(root, worktree, (p) => { asked.push(p); return true; })).toBeNull();
        expect(asked).toEqual([['node_modules']]);
        expect(existsSync(join(worktree, 'node_modules', GATE_TREE_MARKER))).toBe(true);
        expect(settleLaneNodeModules(root, worktree, () => false)).toMatch(/git no longer ignores node_modules .* removed its copied node_modules/);
        expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
        expect(fingerprint(store)).toEqual(before);
    });
    it('leaves alone what the engine did not finish building: no node_modules, a link, a dir without the completion line', () => {
        const { root, worktree } = setup();
        const never = () => { throw new Error('not asked'); };
        expect(settleLaneNodeModules(root, worktree, never)).toBeNull();
        symlinkSync(join(root, 'node_modules'), join(worktree, 'node_modules'), linkType);
        expect(settleLaneNodeModules(root, worktree, never)).toBeNull();
        expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true);
        const other = setup();
        mkdirSync(join(other.worktree, 'node_modules'));
        writeFileSync(join(other.worktree, 'node_modules', 'own.js'), 'own\n');
        expect(settleLaneNodeModules(other.root, other.worktree, never)).toBeNull();
        expect(readFileSync(join(other.worktree, 'node_modules', 'own.js'), 'utf-8')).toBe('own\n');
    });
});
describe('prepareLaneNodeModulesAsync (the copy without blocking the event loop)', () => {
    /** setup() plus `packages` generated packages of 2 dirs and 20 files each in yours, and a second empty lane worktree. */
    function generated(packages = 60) {
        const s = setup();
        for (let p = 0; p < packages; p += 1) {
            for (const sub of ['lib', 'lib/inner']) {
                mkdirSync(join(s.store, `pkg-${p}`, sub), { recursive: true });
                for (let f = 0; f < 10; f += 1)
                    writeFileSync(join(s.store, `pkg-${p}`, sub, `f${f}.js`), `module.exports = ${p * 100 + f};\n`);
            }
        }
        const other = join(s.worktree, '..', 'lane-other');
        mkdirSync(other);
        return { ...s, other };
    }
    it('the same tree as the synchronous build, and timers fire while it is copied (the event loop is never held for the whole copy)', async () => {
        const { root, worktree, store, other } = generated();
        const before = fingerprint(store);
        expect(prepareLaneNodeModules(root, other, { ignored: ignoredAll })).toBeNull();
        const nm = join(worktree, 'node_modules');
        // A timer callback that finds the tree begun but not complete ran in the middle of the copy.
        const seen = [];
        const tick = setInterval(() => {
            if (!existsSync(join(nm, GATE_TREE_MARKER)))
                return seen.push('before');
            seen.push(readFileSync(join(nm, GATE_TREE_MARKER), 'utf-8').includes(GATE_TREE_COMPLETE) ? 'complete' : 'copying');
        }, 1);
        let result;
        try {
            result = await prepareLaneNodeModulesAsync(root, worktree, { ignored: ignoredAll });
        }
        finally {
            clearInterval(tick);
        }
        expect(result).toBeNull();
        expect(seen).toContain('copying');
        expect(fingerprint(nm)).toEqual(fingerprint(join(other, 'node_modules')));
        expect(readFileSync(join(nm, GATE_TREE_MARKER), 'utf-8').split('\n')).toContain(GATE_TREE_COMPLETE);
        expect(lstatSync(join(nm, '.bin')).isSymbolicLink()).toBe(true);
        expect(fingerprint(store)).toEqual(before);
    });
    it('a file copy that fails mid-tree: every copy settles, the cut-off tree is removed, the reason is returned (the lane does not start), yours untouched', async () => {
        const { root, worktree, store } = generated(20);
        const before = fingerprint(store);
        copyFault.name = join('pkg-7', 'lib', 'f3.js');
        const why = await prepareLaneNodeModulesAsync(root, worktree, { ignored: ignoredAll });
        expect(why).toMatch(/the copied node_modules tree of the lane worktree .* could not be built \(EBUSY: resource busy or locked/);
        expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
        expect(fingerprint(store)).toEqual(before);
        // The next preparation builds it whole.
        copyFault.name = undefined;
        expect(await prepareLaneNodeModulesAsync(root, worktree, { ignored: ignoredAll })).toBeNull();
        expect(readFileSync(join(worktree, 'node_modules', 'pkg-7', 'lib', 'f3.js'), 'utf-8')).toBe('module.exports = 703;\n');
    });
    it('a copy fails while another is still in flight: the cut-off tree is removed only after that copy has landed (no copy writes into a removed tree)', async () => {
        const { root, worktree, store } = generated(20);
        const before = fingerprint(store);
        let releasedAt = 0;
        let release;
        copyFault.release = new Promise((r) => { release = r; });
        // The first package file copied is held; the next copy started fails at once, mid-walk.
        copyFault.hold = 'pkg-';
        copyFault.faultNext = true;
        copyFault.onFault = () => { setTimeout(() => { releasedAt = Date.now(); release(); }, 200); };
        const why = await prepareLaneNodeModulesAsync(root, worktree, { ignored: ignoredAll });
        const returnedAt = Date.now();
        expect(why).toMatch(/the copied node_modules tree of the lane worktree .* could not be built \(EBUSY: resource busy or locked/);
        expect(releasedAt).toBeGreaterThan(0);
        expect(returnedAt).toBeGreaterThanOrEqual(releasedAt);
        // The held copy landed in the tree (it was still there), and the removal took it afterwards.
        expect(copyFault.landed).toHaveLength(1);
        expect(existsSync(copyFault.landed[0])).toBe(false);
        expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
        expect(fingerprint(store)).toEqual(before);
    });
    it('the last copy to settle fails (seen when the build drains): the same reason, and nothing is left', async () => {
        const { root, worktree, store } = generated(5);
        const before = fingerprint(store);
        let release;
        copyFault.release = new Promise((r) => { release = r; });
        // The failing copy rejects only after the walk is long done, so the body learns of it at its drain.
        copyFault.name = join('pkg-3', 'lib', 'f3.js');
        copyFault.holdFault = true;
        const timer = setTimeout(() => release(), 300);
        try {
            const why = await prepareLaneNodeModulesAsync(root, worktree, { ignored: ignoredAll });
            expect(why).toMatch(/the copied node_modules tree of the lane worktree .* could not be built \(EBUSY: resource busy or locked/);
        }
        finally {
            clearTimeout(timer);
        }
        expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
        expect(fingerprint(store)).toEqual(before);
    });
    it('a cut-off tree the git ignore check refuses is removed without holding the event loop (timers fire mid-removal); yours untouched', async () => {
        const { root, worktree, store } = generated(60);
        const before = fingerprint(store);
        expect(prepareLaneNodeModules(root, worktree, { ignored: ignoredAll })).toBeNull();
        const nm = join(worktree, 'node_modules');
        writeFileSync(join(nm, GATE_TREE_MARKER), '');
        const total = readdirSync(nm).filter((n) => n.startsWith('pkg-')).length;
        const seen = [];
        const tick = setInterval(() => {
            try {
                seen.push(readdirSync(nm).filter((n) => n.startsWith('pkg-')).length);
            }
            catch { /* gone */ }
        }, 1);
        let result;
        const warned = [];
        try {
            result = await prepareLaneNodeModulesAsync(root, worktree, { ignored: () => false, warn: (m) => warned.push(m) });
        }
        finally {
            clearInterval(tick);
        }
        expect(result).toBeNull();
        expect(warned.join('\n')).toMatch(/git does not ignore node_modules/);
        // A timer ran while some, not all, package dirs were gone.
        expect(seen.some((n) => n > 0 && n < total)).toBe(true);
        expect(existsSync(nm)).toBe(false);
        expect(fingerprint(store)).toEqual(before);
    });
    it('over its bounds: the dry walk refuses before anything is copied, nothing is left, yours untouched', async () => {
        const { root, worktree, store } = generated(5);
        const before = fingerprint(store);
        const why = await prepareLaneNodeModulesAsync(root, worktree, { ignored: ignoredAll, copy: { maxFiles: 20 } });
        expect(why).toMatch(/could not be built \(.*over 20 entries/);
        expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
        expect(fingerprint(store)).toEqual(before);
    });
    it('a cut-off copy is removed and built again; the earlier lane\'s tree is moved (reuseFrom), as in the synchronous build', async () => {
        const { root, worktree, store, other } = generated(5);
        const before = fingerprint(store);
        expect(await prepareLaneNodeModulesAsync(root, worktree, { ignored: ignoredAll })).toBeNull();
        const nm = join(worktree, 'node_modules');
        writeFileSync(join(nm, GATE_TREE_MARKER), '');
        rmSync(join(nm, 'pkg-2', 'lib'), { recursive: true });
        expect(await prepareLaneNodeModulesAsync(root, worktree, { ignored: ignoredAll })).toBeNull();
        expect(readFileSync(join(nm, 'pkg-2', 'lib', 'f1.js'), 'utf-8')).toBe('module.exports = 201;\n');
        const tree = fingerprint(nm);
        expect(await prepareLaneNodeModulesAsync(root, other, { ignored: ignoredAll, reuseFrom: [worktree], copy: { maxFiles: 1 } })).toBeNull();
        expect(existsSync(nm)).toBe(false);
        expect(fingerprint(join(other, 'node_modules'))).toEqual(tree);
        expect(fingerprint(store)).toEqual(before);
    });
    it('one preparation at a time: the second starts (its ignore check) only after the first tree is complete', async () => {
        const { root, worktree, other } = generated(10);
        const firstDone = [];
        const a = prepareLaneNodeModulesAsync(root, worktree, { ignored: ignoredAll });
        const b = prepareLaneNodeModulesAsync(root, other, { ignored: () => {
                firstDone.push(readFileSync(join(worktree, 'node_modules', GATE_TREE_MARKER), 'utf-8').includes(GATE_TREE_COMPLETE));
                return true;
            } });
        expect(await Promise.all([a, b])).toEqual([null, null]);
        expect(firstDone).toEqual([true]);
    });
});
//# sourceMappingURL=lane-node-modules.test.js.map