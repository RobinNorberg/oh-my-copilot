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
import { type KnownFlakyTest, type ShipConfig } from '../../ship/config.js';
import type { Exec } from '../../ship/exec.js';
import { type FactoryRunKey } from './state.js';
export declare const FACTORY_CHECKOUT_TEAM = "factory-run";
/** `issue-<n>`, or `heal-<sig8>` for a ci-heal run. */
export declare const checkoutWorker: (issue: FactoryRunKey) => string;
export declare function checkoutPath(root: string, issue: FactoryRunKey): string;
export declare function checkoutBranch(issue: FactoryRunKey): string;
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
export declare const GATE_CACHE_DIRS: readonly string[];
/** The engine's own file in a node_modules tree it built (linkNodeModules). */
export declare const GATE_TREE_MARKER = ".omg-gate-tree";
/** L3 (review-490): the largest top-level node_modules file copied into a tree (npm's `.package-lock.json` of a big monorepo is a few MB). */
export declare const GATE_TREE_FILE_MAX_BYTES: number;
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
 * opens a package dir itself (esbuild) never opens a junction.
 */
export declare function linkNodeModules(root: string, checkout: string, warn?: (message: string) => void, workspaces?: readonly string[], copy?: boolean): string | null;
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
export declare const GATE_TREE_COPY_WHY = "the OS sandbox on Windows denies opening a package dir through the gate tree's junction with generic read access, which esbuild needs";
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
export declare function unlinkNodeModules(root: string, checkout: string): void;
/**
 * True when `<checkout>/node_modules` is, or still holds, a link at any
 * depth (or cannot be fully read): removing that dir recursively could go
 * through a link into your node_modules. False when it is absent or link-free.
 */
export declare function gateTreeHasLinks(checkout: string): boolean;
/**
 * The nested workspace trees of `checkout` that are there as real dirs: the
 * ones linkNodeModules built in this process and the ones the root tree's
 * marker lists (PR-writable, so every line must be an exact relative path
 * whose every segment is a plain dir in the checkout; another is ignored).
 */
export declare function nestedTreeDirs(checkout: string): string[];
/**
 * The nested workspace trees of `checkout` the engine vouches for, as
 * relative package dirs: the ones linkNodeModules built in this process, or
 * (after a restart) the base's workspace globs expanded in your checkout ∩
 * the marker's lines. The marker is PR-writable, so on its own it never
 * widens anything: the sandbox grant (nestedNodeModulesTargets) and the
 * dirty check use only this list (review-501 M1, L2); the removal may still
 * follow the marker (it never follows a link).
 */
export declare function trustedNestedRels(root: string, checkout: string, workspaces: readonly string[]): string[];
export interface GateConfig {
    config: ShipConfig;
    known: KnownFlakyTest[];
}
export interface GateConfigInput {
    exec: Exec;
    root: string;
    base: string;
    /** GitHub's base sha (baseRefOid). */
    baseSha: string;
    /** The PR's repository URL. */
    repoUrl: string;
    warn: (message: string) => void;
}
export type GateConfigLoader = (input: GateConfigInput) => GateConfig;
/**
 * Ship's safety-key loader in strict mode: requiredChecks, advisoryChecks
 * and the known-flaky list come from the user config at its default
 * location or the base branch committed at GitHub's base sha, never from the
 * working tree or the PR head. A base that cannot be verified throws.
 */
export declare const defaultGateConfigLoader: GateConfigLoader;
//# sourceMappingURL=prepare.d.ts.map