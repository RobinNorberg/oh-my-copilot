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
 * babel-loader, eslint-loader and terser (`.cache`). Your copies are never
 * linked in: a cache the PR's code wrote there would run on your next
 * `vite dev`. They are made whether or not yours has them; any other name
 * your node_modules lacks is simply creatable in the tree.
 */
export declare const GATE_CACHE_DIRS: readonly string[];
/** The engine's own file in a node_modules tree it built (linkNodeModules). */
export declare const GATE_TREE_MARKER = ".omg-gate-tree";
/**
 * Give the prepare checkout (or a calibration dir) your node_modules so
 * prepare's tsc / eslint / vitest find their packages: a real
 * `node_modules` directory holding one junction (win32) or directory
 * symlink per top-level entry of yours (`@scope` dirs and `.bin` linked
 * whole), the GATE_CACHE_DIRS as fresh empty dirs, and top-level files
 * (`.package-lock.json`) copied. In the gate sandbox the checkout is
 * read-write and your node_modules read-only, so tools that write a cache
 * under node_modules (vitest's results cache in `.vite`) write into this
 * per-run tree, never into yours. A single junction from an older release
 * is replaced; anything else already there is left alone. Every link is
 * unlinked (never followed) by unlinkNodeModules before the dir goes.
 */
export declare function linkNodeModules(root: string, checkout: string): void;
/**
 * Remove what linkNodeModules made before the checkout is discarded: on
 * POSIX a symlink named node_modules is untracked for a `node_modules/`
 * gitignore line (directory-only), so removeWorkerWorktree would see a dirty
 * tree. The single link of older releases goes only when it resolves to the
 * root's node_modules; the engine's tree (a real dir with GATE_TREE_MARKER)
 * goes whole, its links unlinked, never followed. Your node_modules is never
 * touched, and anything else is left to the caller's own (link-safe) removal
 * and dirty check.
 */
export declare function unlinkNodeModules(root: string, checkout: string): void;
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