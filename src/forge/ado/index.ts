/**
 * The Azure DevOps Forge adapter (factory forges design §6, PR 5). Every
 * call is `az devops invoke` through the caller's guarded Exec (see
 * guard.ts for what the guard allows); the adapter never spawns.
 * Capabilities: no heal, no Projects v2, board columns, no webhook intake
 * (design §10.9).
 */

import { realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Exec } from '../../ship/exec.js';
import type { Forge, ForgeOptions, ResolvedForgeConfig } from '../types.js';
import { resolveAzEntry, type AzBinaryDeps, type AzEntry } from './az-binary.js';
import { adoChecks } from './checks.js';
import type { AdoGuardContext } from './guard.js';
import type { AdoContext } from './invoke.js';
import { adoMerge } from './merge.js';
import { ADO_RECORD_ENV, recordingAdoExec } from './record.js';
import { adoReviews } from './reviews.js';
import { adoTracker } from './tracker.js';

export interface AzureDevOpsForgeOptions extends ForgeOptions {
  /** The resolved az entry; default resolveAzEntry(defaultAzBinaryDeps([cwd, ...untrustedRoots])). */
  entry?: AzEntry;
  /** Default process.env; OMG_ADO_RECORD_DIR there turns on fixture recording (record.ts). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The states the progress mapping may write: the only System.State values the guard lets through (design §7). */
export const progressStates = (config: ResolvedForgeConfig): string[] =>
  [...new Set(Object.values(config.progress.stages).map((m) => m?.state).filter((s): s is string => typeof s === 'string' && s !== ''))];

/** Production az-binary deps: the real PATH, fs and realpathSync.native. */
export function defaultAzBinaryDeps(untrustedRoots: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): AzBinaryDeps {
  return {
    platform: process.platform,
    env,
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    realpath: (p) => realpathSync.native(p),
    untrustedRoots,
  };
}

/** What the ADO guard needs for a run: the forge repo and the az entry the adapter spawns. */
export function adoGuardContext(config: ResolvedForgeConfig, entry: AzEntry): AdoGuardContext {
  if (config.kind !== 'azure-devops' || !config.repo.project) throw new Error('the Azure DevOps guard needs an azure-devops forge config');
  return { repo: config.repo, entry, allowedStates: progressStates(config) };
}

export function createAzureDevOpsForge(exec: Exec, cwd: string, config: ResolvedForgeConfig, options: AzureDevOpsForgeOptions): Forge {
  if (config.kind !== 'azure-devops' || !config.azureDevOps || !config.repo.project) throw new Error('createAzureDevOpsForge needs a resolved azure-devops forge config');
  const env = options.env ?? process.env;
  const untrustedRoots = [cwd, ...options.untrustedRoots];
  const entry = options.entry ?? resolveAzEntry(defaultAzBinaryDeps(untrustedRoots, env));
  const recordDir = env[ADO_RECORD_ENV]?.trim();
  const ctx: AdoContext = {
    exec: recordDir ? recordingAdoExec(exec, recordDir) : exec,
    cwd,
    entry,
    repo: config.repo,
    config: config.azureDevOps,
    intakeItemTypes: config.intake.itemTypes,
  };
  return {
    kind: 'azure-devops',
    provider: 'azure-devops',
    repo: config.repo,
    tracker: adoTracker(ctx, config.intake.source),
    reviews: adoReviews(ctx),
    checks: adoChecks(ctx),
    merge: adoMerge(ctx, { stateDir: options.stateDir ?? join(homedir(), '.omg', 'forge'), untrustedRoots }),
    capabilities: { heal: false, projectsV2: false, boardColumns: true, webhookIntake: false },
  };
}
