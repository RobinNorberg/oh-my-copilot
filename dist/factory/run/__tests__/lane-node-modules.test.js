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
import { GATE_TREE_COMPLETE, GATE_TREE_MARKER, nestedTreeDirs, prepareLaneNodeModules, settleLaneNodeModules, unlinkNodeModules } from '../prepare.js';
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
//# sourceMappingURL=lane-node-modules.test.js.map