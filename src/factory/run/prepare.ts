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

import { existsSync, symlinkSync } from 'fs';
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
 * Junction (win32) or symlink the main checkout's node_modules into the
 * prepare checkout, so prepare's tsc / eslint / vitest find their binaries.
 * removeWorkerWorktree unlinks it before the worktree goes, so its target
 * is never emptied.
 */
export function linkNodeModules(root: string, checkout: string): void {
  const source = join(root, 'node_modules');
  const target = join(checkout, 'node_modules');
  if (!existsSync(source) || !existsSync(checkout) || existsSync(target)) return;
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
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
