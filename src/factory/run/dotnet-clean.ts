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
import { lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync, type Stats } from 'node:fs';
import { join } from 'node:path';

/** The directory names (any case) whose untracked content is build output a dotnet gate starts without. */
export const DOTNET_BUILD_DIRS: ReadonlySet<string> = new Set(['bin', 'obj', 'artifacts']);

/** The most error lines the step prints (the engine shows a few in its park). */
const MAX_ERRORS = 20;

export interface DotnetCleanResult {
  /** Entries removed (a whole build dir counts once). */
  removed: number;
  /** `<repository path>: <message>` for each entry that could not be removed. */
  errors: string[];
}

/**
 * Remove every entry under each directory named `bin`, `obj` or `artifacts`
 * (any case, any depth, outside the checkout's own `.git` and the package
 * trees in `trees`) of `checkout`, except the tracked paths in `keep`
 * (repository paths, `/` separated, as git lists them). `trees` are the
 * `node_modules` dirs the engine itself links or copies there (the root one
 * and the workspace packages' it vouches for, engine.ts engineTrees); an entry
 * not named `node_modules` is ignored. Any other dir named `node_modules` is
 * walked like the rest. A build dir without a kept path under it
 * goes whole. A link (symlink or junction) is unlinked, never followed: at a
 * build dir, under it, or on the way to one (the walk does not descend
 * through a link). A directory outside the build dirs that holds `.git` (a
 * nested repository) is not descended into: the engine's check parks on it.
 * Names compare case-insensitively on Windows.
 */
export function cleanDotnetBuildOutput(checkout: string, keep: readonly string[], platform: NodeJS.Platform = process.platform, trees: readonly string[] = ['node_modules']): DotnetCleanResult {
  const fold = (p: string): string => (platform === 'win32' ? p.toLowerCase() : p);
  const skip = new Set(trees.map((t) => fold(t.replace(/\/+$/, ''))).filter((t) => (t.split('/').pop() ?? '').toLowerCase() === 'node_modules'));
  // The engine's package trees are kept like tracked paths: never removed, and a build dir above one is cleared entry by entry.
  const exact = new Set([...keep.map((p) => fold(p.replace(/\/+$/, ''))), ...skip]);
  // Every dir above a kept path: it is cleared entry by entry, never removed whole.
  const above = new Set<string>();
  for (const p of exact) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) above.add(segs.slice(0, i).join('/'));
  }
  const result: DotnetCleanResult = { removed: 0, errors: [] };
  const fail = (rel: string, error: unknown): void => {
    if (result.errors.length < MAX_ERRORS) result.errors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    else if (result.errors.length === MAX_ERRORS) result.errors.push('more errors not shown');
  };
  const stat = (abs: string, rel: string): Stats | null => {
    try { return lstatSync(abs); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(rel, error); return null; }
  };
  const list = (abs: string, rel: string): string[] => {
    try { return readdirSync(abs); } catch (error) { fail(rel, error); return []; }
  };
  const remove = (abs: string, rel: string, st: Stats): void => {
    try {
      if (st.isSymbolicLink()) {
        // A directory link on Windows (a junction) may need rmdir; neither call follows the link.
        try { unlinkSync(abs); } catch (error) { if (platform !== 'win32') throw error; rmdirSync(abs); }
      } else if (st.isDirectory()) {
        // rmSync never follows a link inside the tree: it unlinks it.
        rmSync(abs, { recursive: true, force: true, maxRetries: 2 });
      } else {
        unlinkSync(abs);
      }
      result.removed++;
    } catch (error) {
      fail(rel, error);
    }
  };
  /** A build dir, or a dir under one with a kept path below it: everything not kept goes. */
  const clear = (abs: string, rel: string): void => {
    for (const name of list(abs, rel)) {
      const childRel = `${rel}/${name}`;
      const key = fold(childRel);
      if (exact.has(key)) continue;
      const childAbs = join(abs, name);
      const st = stat(childAbs, childRel);
      if (!st) continue;
      if (above.has(key) && st.isDirectory() && !st.isSymbolicLink()) clear(childAbs, childRel);
      else remove(childAbs, childRel, st);
    }
  };
  const walk = (abs: string, rel: string): void => {
    for (const name of list(abs, rel || '.')) {
      const lower = name.toLowerCase();
      if (rel === '' && name === '.git') continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const key = fold(childRel);
      if (skip.has(key)) continue;
      const childAbs = join(abs, name);
      const st = stat(childAbs, childRel);
      if (!st) continue;
      if (DOTNET_BUILD_DIRS.has(lower)) {
        if (exact.has(key)) continue;
        if (above.has(key) && st.isDirectory() && !st.isSymbolicLink()) clear(childAbs, childRel);
        else remove(childAbs, childRel, st);
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      // A nested repository outside the build dirs: left for the engine's check (it parks).
      if (list(childAbs, childRel).includes('.git')) continue;
      walk(childAbs, childRel);
    }
  };
  walk(checkout, '');
  return result;
}

/**
 * The step's arguments (dotnet-clean-step.ts): a first argument of digits only
 * is the count of package trees that follow; the rest are the kept paths
 * (each under a build dir, so it holds a `/` and is never all digits).
 * Without the count only the root `node_modules` is a tree.
 */
export function parseCleanStepArgs(args: readonly string[]): { trees: string[]; keep: string[] } {
  if (!/^\d+$/.test(args[0] ?? '')) return { trees: ['node_modules'], keep: [...args] };
  const n = Number(args[0]);
  return { trees: args.slice(1, 1 + n), keep: args.slice(1 + n) };
}
