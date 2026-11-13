/**
 * The engine-owned prepare checkout and the trusted gate config for
 * `omg factory run` (design §3 prepare, §6, §10 hygiene).
 *
 * The checkout is a team worktree (src/team/git-worktree.ts) of the team
 * FACTORY_CHECKOUT_TEAM, `.omg/team/factory-run/worktrees/issue-<n>` on the
 * local branch `omc-team/factory-run/issue-<n>`, so its removal goes through
 * removeWorkerWorktree, which unlinks junctions (node_modules) before
 * `git worktree remove` and refuses dirty trees and commits nothing else
 * holds. The engine creates it with the hardened, guarded git
 * (`git worktree add -B <branch> <path> <sha>`); ship's runPrepare then runs
 * in it with push off, and the engine pushes the result itself.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, statfsSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { loadBaseKnownFlaky, loadTrustedShipConfig, userConfigLayers } from '../../ship/config.js';
import { getBranchName, getWorktreePath } from '../../team/git-worktree.js';
import { runSlug } from './state.js';
import { expandWorkspaceDirs, plainDirUnder, workspaceLinkTarget } from './workspace-tree.js';
export const FACTORY_CHECKOUT_TEAM = 'factory-run';
/** `issue-<n>`, or `heal-<sig8>` for a ci-heal run. */
export const checkoutWorker = (issue) => runSlug(issue);
export function checkoutPath(root, issue) {
    return getWorktreePath(root, FACTORY_CHECKOUT_TEAM, checkoutWorker(issue));
}
export function checkoutBranch(issue) {
    return getBranchName(FACTORY_CHECKOUT_TEAM, checkoutWorker(issue));
}
/**
 * The tool-cache dirs a gate's node_modules gets fresh and empty per run,
 * even when your node_modules has them: vite and vitest (`.vite`, the
 * bundled-config `.vite-temp`, `.vitest`) and find-cache-dir users such as
 * babel-loader, eslint-loader and terser (`.cache`), and `.tmp`, where the
 * create-vite TypeScript templates put tsc's `tsBuildInfoFile` (a pure
 * incremental cache: fresh only means a full build). Your copies are never
 * linked in: a cache the PR's code wrote there would run on your next
 * `vite dev`. They are made whether or not yours has them; any other name
 * your node_modules lacks is simply creatable in the tree.
 */
export const GATE_CACHE_DIRS = ['.cache', '.tmp', '.vite', '.vite-temp', '.vitest'];
/** The engine's own file in a node_modules tree it built (linkNodeModules). */
export const GATE_TREE_MARKER = '.omg-gate-tree';
/** L3 (review-490): the largest top-level node_modules file copied into a tree (npm's `.package-lock.json` of a big monorepo is a few MB). */
export const GATE_TREE_FILE_MAX_BYTES = 16 * 1024 * 1024;
function unlinkLink(p) {
    // A junction or directory symlink on win32: rmdir removes the link itself.
    try {
        unlinkSync(p);
    }
    catch {
        rmdirSync(p);
    }
}
/**
 * Give the prepare checkout (or a calibration dir) your node_modules so
 * prepare's tsc / eslint / vitest find their packages: a real
 * `node_modules` directory holding one junction (win32) or directory
 * symlink per top-level entry of yours (`@scope` dirs and `.bin` linked
 * whole), the GATE_CACHE_DIRS as fresh empty dirs, and top-level files
 * (`.package-lock.json`) copied up to GATE_TREE_FILE_MAX_BYTES (a larger one
 * is skipped with a `warn` note). In the gate sandbox the checkout is
 * read-write and your node_modules read-only, so tools that write a cache
 * under node_modules (vitest's results cache in `.vite`) write into this
 * per-run tree, never into yours. A single junction from an older release
 * is replaced; anything else already there is left alone. Every link is
 * unlinked (never followed) by unlinkNodeModules before the dir goes.
 *
 * Workspaces: `workspaces` are the TRUSTED BASE's globs (never the PR
 * head's). Each matched package dir whose node_modules exists in your
 * checkout gets the same kind of tree in that package dir of the gate
 * checkout, and a workspace self-link (`node_modules/@scope/pkg ->
 * packages/pkg`) resolves to the gate checkout's package, never your
 * working tree. Returns why the layout is not supported (Yarn PnP, a nested
 * git repository, over the bounds; the folder named), else null; the trees
 * that can be built still are.
 *
 * `copy` (GATE_TREE_COPY_WHY): each package dir is a copy of yours instead
 * of a link (`.bin` and workspace self-links stay links), so a tool that
 * opens a package dir itself (esbuild) never opens a junction. It throws,
 * before anything is copied, when the copy would pass a GATE_TREE_COPY_*
 * bound or the checkout's volume lacks the space (copyPreflight), and at a
 * bound while copying (copyGateDir; the partial tree is removed first).
 */
export function linkNodeModules(root, checkout, warn, workspaces = [], copy = false) {
    const source = join(root, 'node_modules');
    const target = join(checkout, 'node_modules');
    if (!existsSync(checkout))
        return null;
    // Workspaces (monorepos): the base's globs, expanded in your checkout (workspace-tree.ts).
    const ws = workspaces.length > 0 ? expandWorkspaceDirs(root, workspaces, warn) : { dirs: [], problem: null };
    if (!existsSync(source))
        return ws.problem;
    let present = true;
    try {
        present = !lstatSync(target).isSymbolicLink() || !unlinkOwnLink(root, target);
    }
    catch {
        present = false;
    }
    if (present)
        return ws.problem;
    const built = [];
    let budget;
    if (copy) {
        // L1 (review-546): over the bounds or the volume's free space, nothing is copied; the caller parks with this text.
        const nested = ws.dirs.map((rel) => plainDirUnder(root, rel)).flatMap((d) => (d && !isLink(join(d, 'node_modules')) && existsSync(join(d, 'node_modules')) ? [join(d, 'node_modules')] : []));
        const limits = { ...DEFAULT_COPY_LIMITS, ...(copy === true ? {} : copy) };
        const over = copyPreflight([source, ...nested], checkout, limits);
        if (over)
            throw new Error(over);
        budget = { bytes: 0, files: 0, inside: [source, ...nested].map((d) => realpathSync.native(d)), limits };
    }
    try {
        buildGateTree(source, target, root, checkout, '', warn, budget);
        // A nested tree for each workspace package whose node_modules exists in your checkout (npm puts version conflicts
        // there, pnpm every package's direct deps), in the same package dir of the gate checkout.
        for (const rel of ws.dirs) {
            const yours = plainDirUnder(root, rel);
            const src = yours ? join(yours, 'node_modules') : null;
            const dir = plainDirUnder(checkout, rel);
            if (!src || !dir || isLink(src) || !existsSync(src) || !statSync(src).isDirectory())
                continue;
            const nested = join(dir, 'node_modules');
            if (existsSync(nested) || isLink(nested))
                continue;
            built.push(rel);
            buildGateTree(src, nested, root, checkout, `${rel}/`, warn, budget);
        }
        // The marker lists the nested trees for the removal and the sandbox's grant check (both re-validate every line).
        writeFileSync(join(target, GATE_TREE_MARKER), built.map((r) => `${r}\n`).join(''));
        const moved = treeMoved(target, checkout, '');
        if (moved)
            throw new Error(moved);
    }
    catch (error) {
        for (const rel of built) {
            const dir = plainDirUnder(checkout, rel);
            if (dir)
                try {
                    if (lstatSync(join(dir, 'node_modules')).isDirectory())
                        removeGateTree(join(dir, 'node_modules'));
                }
                catch { /* the caller's link-safe removal */ }
        }
        // Only a real dir (L3: the tree may be gone, or a link someone swapped in, which is never walked).
        try {
            if (lstatSync(target).isDirectory())
                removeGateTree(target);
        }
        catch { /* gone */ }
        throw error;
    }
    nestedTrees.set(checkout, built);
    return ws.problem;
}
/** The nested trees linkNodeModules built in this process, per checkout (the marker may be gone; review-490 M3). */
const nestedTrees = new Map();
function isLink(p) {
    try {
        return lstatSync(p).isSymbolicLink();
    }
    catch {
        return false;
    }
}
const linkType = () => (process.platform === 'win32' ? 'junction' : 'dir');
/**
 * One tree: `target` a real dir with the marker, the GATE_CACHE_DIRS fresh,
 * top-level files of `source` copied (bounded), every dir linked to
 * `<source>/<name>` read-only, except a link into your working tree outside
 * any node_modules (a workspace self-link, workspaceLinkTarget), which goes
 * to the same dir of the gate checkout. A `@scope` dir holding such a link is
 * a real dir with one link per package; any other is linked whole. `copy`
 * (a budget): every dir but `.bin` and the workspace self-links is copied
 * (copyGateDir).
 */
function buildGateTree(source, target, root, checkout, label, warn, copy) {
    mkdirSync(target);
    // L3 (review-501): a dir on the way swapped for a junction or link after plainDirUnder (a surviving PR process) would
    // put the tree, its marker and its links outside the checkout: the new dir must be where it was meant to be.
    const moved = treeMoved(target, checkout, label);
    if (moved) {
        try {
            rmdirSync(target);
        }
        catch { /* left for the caller's removal */ }
        throw new Error(moved);
    }
    writeFileSync(join(target, GATE_TREE_MARKER), '');
    for (const name of GATE_CACHE_DIRS)
        mkdirSync(join(target, name));
    const place = (from, to) => {
        const w = workspaceLinkTarget(from, root, checkout);
        if ('skip' in w) {
            warn?.(`omg factory run: ${w.skip}, so it is left out of the gate's node_modules tree ${target}`);
            return;
        }
        if (copy && !('to' in w) && basename(from) !== '.bin')
            copyGateDir(from, to, copy);
        else
            symlinkSync('to' in w ? w.to : from, to, linkType());
    };
    for (const e of readdirSync(source, { withFileTypes: true })) {
        if (e.name === GATE_TREE_MARKER || GATE_CACHE_DIRS.includes(e.name))
            continue;
        const from = join(source, e.name);
        let st;
        try {
            st = statSync(from);
        }
        catch {
            continue;
        }
        if (st.isFile()) {
            if (st.size > GATE_TREE_FILE_MAX_BYTES) {
                warn?.(`omg factory run: ${label}node_modules/${e.name} (${st.size} bytes) is over ${GATE_TREE_FILE_MAX_BYTES} bytes, so it is not copied into the gate's node_modules tree ${target}`);
                continue;
            }
            // A copy, never a link: a hard link would hand the PR's code your file to write.
            copyFileSync(from, join(target, e.name));
            continue;
        }
        if (!st.isDirectory())
            continue;
        if (e.name.startsWith('@') && !isLink(from)) {
            const children = readdirSync(from);
            if (children.some((c) => !('keep' in workspaceLinkTarget(join(from, c), root, checkout)))) {
                mkdirSync(join(target, e.name));
                for (const c of children) {
                    try {
                        if (!statSync(join(from, c)).isDirectory())
                            continue;
                    }
                    catch {
                        continue;
                    }
                    place(join(from, c), join(target, e.name, c));
                }
                continue;
            }
        }
        place(from, join(target, e.name));
    }
    // L3 residual (review-501b): the same check after the last write; a swap during the build fails it (the caller removes, link-safe).
    const after = treeMoved(target, checkout, label);
    if (after)
        throw new Error(after);
}
/**
 * Why a gate tree may be built as copies: in the Copilot OS sandbox on
 * Windows (its low-integrity token) a directory junction whose target the
 * sandbox may only read cannot be opened as a whole with generic read access
 * (CreateFile GENERIC_READ: Access is denied), although listing it, reading
 * files through it and opening the target by its own path all work (live
 * 2026-11-13, Copilot CLI 1.0.105, Windows 11 26300). Node's readdir asks
 * for list access only, so tsc, eslint and vitest work through the links;
 * esbuild (Go's os.Open) asks for generic read on every package dir it lists
 * and fails with `Cannot read directory "node_modules/<pkg>": Access is
 * denied.` Granting the target changes nothing (a dir the sandbox was never
 * granted fails the same way); only a real dir in the checkout works.
 */
export const GATE_TREE_COPY_WHY = 'the OS sandbox on Windows denies opening a package dir through the gate tree\'s junction with generic read access, which esbuild needs';
/** L1 (review-546): the most bytes all copied trees of one linkNodeModules call may hold. */
export const GATE_TREE_COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** L1 (review-546): the most files all copied trees of one linkNodeModules call may hold. */
export const GATE_TREE_COPY_MAX_FILES = 200_000;
/** L1 (review-546): free space the destination volume keeps after the estimated copy. */
export const GATE_TREE_COPY_FREE_MARGIN_BYTES = 1024 * 1024 * 1024;
const DEFAULT_COPY_LIMITS = {
    maxBytes: GATE_TREE_COPY_MAX_BYTES,
    maxFiles: GATE_TREE_COPY_MAX_FILES,
    marginBytes: GATE_TREE_COPY_FREE_MARGIN_BYTES,
    freeBytes: (dir) => {
        try {
            const fs = statfsSync(dir);
            return Number(fs.bavail) * Number(fs.bsize);
        }
        catch {
            return null; /* the platform cannot tell: the copy's own ENOSPC is the guard */
        }
    },
};
const foldPath = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const under = (p, dir) => {
    const a = foldPath(p);
    const b = foldPath(dir).replace(/[\\/]+$/, '');
    return a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`);
};
/** The copy would pass a GATE_TREE_COPY_* bound: the run parks with this text (linkNodeModules throws it). */
function copyLimitText(what) {
    return `the copied gate node_modules tree would be over ${what}, so it is not copied (a node_modules that large cannot use the copied tree the Windows sandbox needs for esbuild)`;
}
/**
 * L1 (review-546): before a copied tree is built, the size of the dirs of
 * yours it copies (each source tree without `.bin`, the cache dirs and
 * links: an estimate, as the copy also materialises dir links, L3) must be
 * within the GATE_TREE_COPY_* bounds, and the checkout's volume must have
 * that much free plus GATE_TREE_COPY_FREE_MARGIN_BYTES (statfs; skipped where
 * the platform cannot tell). Why not, else null. A synchronous walk, like the
 * copy itself: it runs once per prepare checkout and calibration dir.
 */
function copyPreflight(sources, checkout, limits) {
    let bytes = 0;
    let files = 0;
    const walk = (dir, top) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (top && (e.name === '.bin' || e.name === GATE_TREE_MARKER || GATE_CACHE_DIRS.includes(e.name)))
                continue;
            if (e.isSymbolicLink())
                continue;
            const p = join(dir, e.name);
            if (e.isDirectory()) {
                const over = walk(p, false);
                if (over)
                    return over;
            }
            else if (e.isFile()) {
                bytes += lstatSync(p).size;
                files += 1;
                if (bytes > limits.maxBytes)
                    return copyLimitText(`${limits.maxBytes} bytes`);
                if (files > limits.maxFiles)
                    return copyLimitText(`${limits.maxFiles} files`);
            }
        }
        return null;
    };
    for (const s of sources) {
        const over = walk(s, true);
        if (over)
            return over;
    }
    const free = limits.freeBytes(checkout);
    if (free !== null && free < bytes + limits.marginBytes)
        return `the copied gate node_modules tree needs about ${bytes} bytes plus a ${limits.marginBytes}-byte margin on the volume of ${checkout}, which has ${free} bytes free, so it is not copied; free disk space`;
    return null;
}
/**
 * A copy of your package dir `from` at `to`: dirs made, files copied (never
 * hard-linked: the PR's code could write your file through one), counted
 * against `budget` (over a GATE_TREE_COPY_* bound it throws). L3
 * (review-546): a dir link that resolves inside one of your node_modules
 * dirs (`budget.inside`: pnpm's `.pnpm/<pkg>/node_modules/<dep>`, npm's
 * nested links) is copied too, so esbuild never opens a junction there; one
 * that resolves to a dir already on the way down (`seen`, a cycle) or
 * outside your node_modules is made again as a link to the same target
 * (never followed). A file link or a dangling one is left out. Nothing of
 * yours is written. Synchronous, like the tree build around it.
 */
function copyGateDir(from, to, budget, seen = [foldPath(realpathSync.native(from))]) {
    mkdirSync(to);
    for (const e of readdirSync(from, { withFileTypes: true })) {
        const s = join(from, e.name);
        const d = join(to, e.name);
        if (e.isSymbolicLink()) {
            let real;
            try {
                if (!statSync(s).isDirectory())
                    continue;
                real = realpathSync.native(s);
            }
            catch {
                continue; /* dangling: left out */
            }
            const r = foldPath(real);
            if (budget.inside.some((i) => under(real, i)) && !seen.includes(r))
                copyGateDir(real, d, budget, [...seen, r]);
            else
                symlinkSync(real, d, linkType());
        }
        else if (e.isDirectory())
            copyGateDir(s, d, budget, [...seen, foldPath(join(seen[seen.length - 1], e.name))]);
        else if (e.isFile()) {
            const size = statSync(s).size;
            if (budget.files + 1 > budget.limits.maxFiles)
                throw new Error(copyLimitText(`${budget.limits.maxFiles} files`));
            if (budget.bytes + size > budget.limits.maxBytes)
                throw new Error(copyLimitText(`${budget.limits.maxBytes} bytes`));
            copyFileSync(s, d);
            budget.files += 1;
            budget.bytes += size;
        }
    }
}
/** Why `target` (the tree for `label` in `checkout`) does not resolve where it was meant to be, or null. */
function treeMoved(target, checkout, label) {
    const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const want = join(realpathSync.native(checkout), ...label.split('/').filter((s) => s !== ''), 'node_modules');
    let got;
    try {
        got = realpathSync.native(target);
    }
    catch {
        got = '';
    }
    return fold(got) === fold(want) ? null : `the gate's node_modules tree ${target} resolves to ${got || 'nothing'}, not ${want}: a dir on its way was replaced by a link`;
}
/** Unlink `link` when it resolves to the root's node_modules (the single link of older releases); true when it went. */
function unlinkOwnLink(root, link) {
    try {
        const real = (p) => (process.platform === 'win32' ? realpathSync(p).toLowerCase() : realpathSync(p));
        if (real(link) !== real(join(root, 'node_modules')))
            return false;
    }
    catch {
        return false;
    }
    unlinkLink(link);
    return true;
}
/**
 * Remove a node_modules tree linkNodeModules built, never through a link:
 * every symlink and junction at any depth is unlinked first (the PR's code
 * may have planted one in a cache dir), then files and dirs bottom up. A
 * dir is read only after an lstat says it is a plain directory.
 */
function removeGateTree(dir) {
    const walk = (d) => {
        for (const name of readdirSync(d)) {
            const p = join(d, name);
            const st = lstatSync(p);
            if (st.isSymbolicLink())
                unlinkLink(p);
            else if (st.isDirectory())
                walk(p);
            else
                unlinkSync(p);
        }
        rmdirSync(d);
    };
    walk(dir);
}
/**
 * Remove what linkNodeModules made before the checkout is discarded: on
 * POSIX a symlink named node_modules is untracked for a `node_modules/`
 * gitignore line (directory-only), so removeWorkerWorktree would see a dirty
 * tree. The single link of older releases goes only when it resolves to the
 * root's node_modules. In a real node_modules dir every link at any depth is
 * unlinked, never followed, marker or not (M3); the engine's tree (with
 * GATE_TREE_MARKER) then goes whole. Your node_modules is never
 * touched, and anything else is left to the caller's own (link-safe) removal
 * and dirty check.
 */
export function unlinkNodeModules(root, checkout) {
    const target = join(checkout, 'node_modules');
    // The nested workspace trees first (the root's marker names them): every link unlinked, never followed.
    for (const nm of nestedTreeDirs(checkout)) {
        unlinkTreeLinks(nm);
        if (existsSync(join(nm, GATE_TREE_MARKER)))
            removeGateTree(nm);
    }
    nestedTrees.delete(checkout);
    let st;
    try {
        st = lstatSync(target);
    }
    catch {
        return;
    }
    if (st.isSymbolicLink()) {
        unlinkOwnLink(root, target);
        return;
    }
    if (!st.isDirectory() || sameDir(target, join(root, 'node_modules')))
        return;
    // M3 (review-490): a real node_modules dir in an engine checkout is treated as the engine's tree whether or not the
    // marker is still there (the PR's code can delete it): every link at any depth goes first, never followed. The
    // marker only decides whether the rest goes too; without it the caller's own (link-safe) removal takes the files.
    unlinkTreeLinks(target);
    if (existsSync(join(target, GATE_TREE_MARKER)))
        removeGateTree(target);
}
/** Unlink every symlink and junction under `dir` at any depth, never following one; files and dirs stay. */
function unlinkTreeLinks(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = lstatSync(p);
        if (st.isSymbolicLink())
            unlinkLink(p);
        else if (st.isDirectory())
            unlinkTreeLinks(p);
    }
}
/**
 * True when `<checkout>/node_modules` is, or still holds, a link at any
 * depth (or cannot be fully read): removing that dir recursively could go
 * through a link into your node_modules. False when it is absent or link-free.
 */
export function gateTreeHasLinks(checkout) {
    const walk = (p) => {
        const st = lstatSync(p);
        if (st.isSymbolicLink())
            return true;
        if (!st.isDirectory())
            return false;
        return readdirSync(p).some((name) => walk(join(p, name)));
    };
    const target = join(checkout, 'node_modules');
    let nested;
    try {
        nested = nestedTreeDirs(checkout);
    }
    catch {
        return true;
    }
    for (const nm of nested) {
        try {
            if (walk(nm))
                return true;
        }
        catch {
            return true;
        }
    }
    try {
        lstatSync(target);
    }
    catch {
        return false;
    }
    try {
        return walk(target);
    }
    catch {
        return true;
    }
}
/**
 * The nested workspace trees of `checkout` that are there as real dirs: the
 * ones linkNodeModules built in this process and the ones the root tree's
 * marker lists (PR-writable, so every line must be an exact relative path
 * whose every segment is a plain dir in the checkout; another is ignored).
 */
export function nestedTreeDirs(checkout) {
    const rels = new Set(nestedTrees.get(checkout) ?? []);
    const marker = join(checkout, 'node_modules', GATE_TREE_MARKER);
    try {
        const st = lstatSync(join(checkout, 'node_modules'));
        const m = lstatSync(marker);
        if (!st.isSymbolicLink() && st.isDirectory() && m.isFile() && m.size <= 64 * 1024) {
            for (const line of readFileSync(marker, 'utf-8').split('\n'))
                if (line)
                    rels.add(line);
        }
    }
    catch { /* no marker list */ }
    const out = [];
    for (const rel of rels) {
        const dir = plainDirUnder(checkout, rel);
        if (!dir)
            continue;
        const nm = join(dir, 'node_modules');
        try {
            const st = lstatSync(nm);
            if (!st.isSymbolicLink() && st.isDirectory())
                out.push(nm);
        }
        catch { /* gone */ }
    }
    return out;
}
/**
 * The nested workspace trees of `checkout` the engine vouches for, as
 * relative package dirs: the ones linkNodeModules built in this process, or
 * (after a restart) the base's workspace globs expanded in your checkout ∩
 * the marker's lines. The marker is PR-writable, so on its own it never
 * widens anything: the sandbox grant (nestedNodeModulesTargets) and the
 * dirty check use only this list (review-501 M1, L2); the removal may still
 * follow the marker (it never follows a link).
 */
export function trustedNestedRels(root, checkout, workspaces) {
    const own = nestedTrees.get(checkout);
    if (own)
        return [...own];
    if (workspaces.length === 0)
        return [];
    const marker = join(checkout, 'node_modules', GATE_TREE_MARKER);
    const listed = new Set();
    try {
        const st = lstatSync(join(checkout, 'node_modules'));
        const m = lstatSync(marker);
        if (!st.isSymbolicLink() && st.isDirectory() && m.isFile() && m.size <= 64 * 1024) {
            for (const line of readFileSync(marker, 'utf-8').split('\n'))
                if (line)
                    listed.add(line);
        }
    }
    catch {
        return [];
    }
    return expandWorkspaceDirs(root, workspaces).dirs.filter((rel) => listed.has(rel));
}
function sameDir(a, b) {
    try {
        const ra = realpathSync(a);
        const rb = realpathSync(b);
        return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
    }
    catch {
        return false;
    }
}
/**
 * Ship's safety-key loader in strict mode: requiredChecks, advisoryChecks
 * and the known-flaky list come from the user config at its default
 * location or the base branch committed at GitHub's base sha, never from the
 * working tree or the PR head. A base that cannot be verified throws.
 */
export const defaultGateConfigLoader = (i) => {
    const layers = userConfigLayers();
    const config = loadTrustedShipConfig({
        exec: i.exec, root: i.root, base: i.base, baseSha: i.baseSha, repoUrl: i.repoUrl, strict: true,
        user: layers.user, trustedUser: layers.trustedUser, warn: i.warn,
    });
    return { config, known: loadBaseKnownFlaky(i.exec, i.root, config.trustedBaseCommit, config.knownFlakyFile) };
};
//# sourceMappingURL=prepare.js.map