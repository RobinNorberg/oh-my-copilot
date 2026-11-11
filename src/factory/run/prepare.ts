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

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadBaseKnownFlaky, loadTrustedShipConfig, userConfigLayers, type KnownFlakyTest, type ShipConfig } from '../../ship/config.js';
import type { Exec } from '../../ship/exec.js';
import { getBranchName, getWorktreePath } from '../../team/git-worktree.js';
import { runSlug, type FactoryRunKey } from './state.js';

export const FACTORY_CHECKOUT_TEAM = 'factory-run';

/** `issue-<n>`, or `heal-<sig8>` for a ci-heal run. */
export const checkoutWorker = (issue: FactoryRunKey): string => runSlug(issue);

export function checkoutPath(root: string, issue: FactoryRunKey): string {
  return getWorktreePath(root, FACTORY_CHECKOUT_TEAM, checkoutWorker(issue));
}

export function checkoutBranch(issue: FactoryRunKey): string {
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
export const GATE_CACHE_DIRS: readonly string[] = ['.cache', '.tmp', '.vite', '.vite-temp', '.vitest'];

/** The engine's own file in a node_modules tree it built (linkNodeModules). */
export const GATE_TREE_MARKER = '.omg-gate-tree';

/** L3 (review-490): the largest top-level node_modules file copied into a tree (npm's `.package-lock.json` of a big monorepo is a few MB). */
export const GATE_TREE_FILE_MAX_BYTES = 16 * 1024 * 1024;

function unlinkLink(p: string): void {
  // A junction or directory symlink on win32: rmdir removes the link itself.
  try { unlinkSync(p); } catch { rmdirSync(p); }
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
 */
export function linkNodeModules(root: string, checkout: string, warn?: (message: string) => void): void {
  const source = join(root, 'node_modules');
  const target = join(checkout, 'node_modules');
  if (!existsSync(source) || !existsSync(checkout)) return;
  let present = true;
  try { present = !lstatSync(target).isSymbolicLink() || !unlinkOwnLink(root, target); } catch { present = false; }
  if (present) return;
  mkdirSync(target);
  try {
    writeFileSync(join(target, GATE_TREE_MARKER), '');
    for (const name of GATE_CACHE_DIRS) mkdirSync(join(target, name));
    for (const e of readdirSync(source, { withFileTypes: true })) {
      if (e.name === GATE_TREE_MARKER || GATE_CACHE_DIRS.includes(e.name)) continue;
      let st;
      try { st = statSync(join(source, e.name)); } catch { continue; }
      if (st.isFile()) {
        if (st.size > GATE_TREE_FILE_MAX_BYTES) {
          warn?.(`omg factory run: node_modules/${e.name} (${st.size} bytes) is over ${GATE_TREE_FILE_MAX_BYTES} bytes, so it is not copied into the gate's node_modules tree ${target}`);
          continue;
        }
        // A copy, never a link: a hard link would hand the PR's code your file to write.
        copyFileSync(join(source, e.name), join(target, e.name));
        continue;
      }
      if (!st.isDirectory()) continue;
      symlinkSync(join(source, e.name), join(target, e.name), process.platform === 'win32' ? 'junction' : 'dir');
    }
  } catch (error) {
    removeGateTree(target);
    throw error;
  }
}

/** Unlink `link` when it resolves to the root's node_modules (the single link of older releases); true when it went. */
function unlinkOwnLink(root: string, link: string): boolean {
  try {
    const real = (p: string) => (process.platform === 'win32' ? realpathSync(p).toLowerCase() : realpathSync(p));
    if (real(link) !== real(join(root, 'node_modules'))) return false;
  } catch {
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
function removeGateTree(dir: string): void {
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) unlinkLink(p);
      else if (st.isDirectory()) walk(p);
      else unlinkSync(p);
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
export function unlinkNodeModules(root: string, checkout: string): void {
  const target = join(checkout, 'node_modules');
  let st;
  try { st = lstatSync(target); } catch { return; }
  if (st.isSymbolicLink()) {
    unlinkOwnLink(root, target);
    return;
  }
  if (!st.isDirectory() || sameDir(target, join(root, 'node_modules'))) return;
  // M3 (review-490): a real node_modules dir in an engine checkout is treated as the engine's tree whether or not the
  // marker is still there (the PR's code can delete it): every link at any depth goes first, never followed. The
  // marker only decides whether the rest goes too; without it the caller's own (link-safe) removal takes the files.
  unlinkTreeLinks(target);
  if (existsSync(join(target, GATE_TREE_MARKER))) removeGateTree(target);
}

/** Unlink every symlink and junction under `dir` at any depth, never following one; files and dirs stay. */
function unlinkTreeLinks(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) unlinkLink(p);
    else if (st.isDirectory()) unlinkTreeLinks(p);
  }
}

/**
 * True when `<checkout>/node_modules` is, or still holds, a link at any
 * depth (or cannot be fully read): removing that dir recursively could go
 * through a link into your node_modules. False when it is absent or link-free.
 */
export function gateTreeHasLinks(checkout: string): boolean {
  const walk = (p: string): boolean => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return true;
    if (!st.isDirectory()) return false;
    return readdirSync(p).some((name) => walk(join(p, name)));
  };
  const target = join(checkout, 'node_modules');
  try { lstatSync(target); } catch { return false; }
  try { return walk(target); } catch { return true; }
}

function sameDir(a: string, b: string): boolean {
  try {
    const ra = realpathSync(a);
    const rb = realpathSync(b);
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch {
    return false;
  }
}

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
export const defaultGateConfigLoader: GateConfigLoader = (i) => {
  const layers = userConfigLayers();
  const config = loadTrustedShipConfig({
    exec: i.exec, root: i.root, base: i.base, baseSha: i.baseSha, repoUrl: i.repoUrl, strict: true,
    user: layers.user, trustedUser: layers.trustedUser, warn: i.warn,
  });
  return { config, known: loadBaseKnownFlaky(i.exec, i.root, config.trustedBaseCommit, config.knownFlakyFile) };
};
