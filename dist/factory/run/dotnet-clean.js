/**
 * A dotnet gate's leftover build state, removed INSIDE the OS sandbox
 * (dotnet-clean-step.ts runs this as `node <omg>/dist/factory/run/dotnet-clean-step.js`
 * through the gate's sandbox runner, with the prepare checkout as cwd and no
 * network). The PR's code run in the checkout earlier (a prepare check, a
 * source generator, an earlier gate run) can leave a restore output or a
 * stale build that MSBuild reuses (NuGet's no-op restore keeps
 * obj/*.nuget.g.targets; a newer bin/ skips CoreCompile), or a git repository
 * that hides them from `git ls-files`, and a process it left running can swap
 * a link in while the walk runs. So the deleting process is the sandboxed
 * one: a link swapped in after a check points outside the checkout, where the
 * sandbox denies every write. The engine never deletes here itself; it
 * verifies the result with read-only git calls afterwards (engine.ts
 * ensureLocalGate) and parks when anything is left.
 *
 * Node builtins only: the entry script loads this file and nothing else.
 */
import { lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
/** The directory names (any case) whose untracked content is build output a dotnet gate starts without. */
export const DOTNET_BUILD_DIRS = new Set(['bin', 'obj', 'artifacts']);
/**
 * The two path-segment tests the clean step's walk and the engine's checks
 * (local-gate.ts dotnetBuildDirIndex) share, so both sides fold a name the
 * same way: any case, on every platform. A build dir's untracked content is
 * removed; a package tree (`node_modules`, whoever installed it: the engine,
 * a sandboxed `npm ci`, a trusted prepare build) is never entered, and the
 * engine's checks leave paths under one out the same way.
 */
export const isDotnetBuildDirName = (name) => DOTNET_BUILD_DIRS.has(name.toLowerCase());
export const isPackageTreeName = (name) => name.toLowerCase() === 'node_modules';
/** The most error lines the step prints (the engine shows a few in its park). */
const MAX_ERRORS = 20;
/**
 * Remove every entry under each directory named `bin`, `obj` or `artifacts`
 * (any case, any depth, outside every `node_modules` dir and the checkout's
 * own `.git`) of `checkout`, except the tracked paths in `keep` (repository
 * paths, `/` separated, as git lists them). A `node_modules` dir on the way
 * to a build dir is never entered (isPackageTreeName); one inside a build dir
 * is build output like the rest. A build dir without a kept path under it
 * goes whole. A link (symlink or junction) is unlinked, never followed: at a
 * build dir, under it, or on the way to one (the walk does not descend
 * through a link). A directory outside the build dirs that holds `.git` (a
 * nested repository) is not descended into: the engine's check parks on it.
 * Kept paths compare case-insensitively where the file system usually does
 * (Windows, macOS).
 */
export function cleanDotnetBuildOutput(checkout, keep, platform = process.platform) {
    const fold = (p) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
    const exact = new Set(keep.map((p) => fold(p.replace(/\/+$/, ''))));
    // Every dir above a kept path: it is cleared entry by entry, never removed whole.
    const above = new Set();
    for (const p of exact) {
        const segs = p.split('/');
        for (let i = 1; i < segs.length; i++)
            above.add(segs.slice(0, i).join('/'));
    }
    const result = { removed: 0, errors: [] };
    const fail = (rel, error) => {
        if (result.errors.length < MAX_ERRORS)
            result.errors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
        else if (result.errors.length === MAX_ERRORS)
            result.errors.push('more errors not shown');
    };
    const stat = (abs, rel) => {
        try {
            return lstatSync(abs);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                fail(rel, error);
            return null;
        }
    };
    const list = (abs, rel) => {
        try {
            return readdirSync(abs);
        }
        catch (error) {
            fail(rel, error);
            return [];
        }
    };
    const remove = (abs, rel, st) => {
        try {
            if (st.isSymbolicLink()) {
                // A directory link on Windows (a junction) may need rmdir; neither call follows the link.
                try {
                    unlinkSync(abs);
                }
                catch (error) {
                    if (platform !== 'win32')
                        throw error;
                    rmdirSync(abs);
                }
            }
            else if (st.isDirectory()) {
                // rmSync never follows a link inside the tree: it unlinks it.
                rmSync(abs, { recursive: true, force: true, maxRetries: 2 });
            }
            else {
                unlinkSync(abs);
            }
            result.removed++;
        }
        catch (error) {
            fail(rel, error);
        }
    };
    /** A build dir, or a dir under one with a kept path below it: everything not kept goes. */
    const clear = (abs, rel) => {
        for (const name of list(abs, rel)) {
            const childRel = `${rel}/${name}`;
            const key = fold(childRel);
            if (exact.has(key))
                continue;
            const childAbs = join(abs, name);
            const st = stat(childAbs, childRel);
            if (!st)
                continue;
            if (above.has(key) && st.isDirectory() && !st.isSymbolicLink())
                clear(childAbs, childRel);
            else
                remove(childAbs, childRel, st);
        }
    };
    const walk = (abs, rel) => {
        for (const name of list(abs, rel || '.')) {
            if (isPackageTreeName(name) || (rel === '' && name === '.git'))
                continue;
            const childRel = rel ? `${rel}/${name}` : name;
            const key = fold(childRel);
            const childAbs = join(abs, name);
            const st = stat(childAbs, childRel);
            if (!st)
                continue;
            if (isDotnetBuildDirName(name)) {
                if (exact.has(key))
                    continue;
                if (above.has(key) && st.isDirectory() && !st.isSymbolicLink())
                    clear(childAbs, childRel);
                else
                    remove(childAbs, childRel, st);
                continue;
            }
            if (st.isSymbolicLink() || !st.isDirectory())
                continue;
            // A nested repository outside the build dirs: left for the engine's check (it parks).
            if (list(childAbs, childRel).includes('.git'))
                continue;
            walk(childAbs, childRel);
        }
    };
    walk(checkout, '');
    return result;
}
//# sourceMappingURL=dotnet-clean.js.map