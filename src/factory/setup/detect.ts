/**
 * Step 1 of `omg factory setup` (factory forges design §4): the forge comes
 * from the origin remote (detectForgeRepo). Flags may pin it, never redirect
 * it: a `--forge`, `--org`, `--project` or `--repo` that disagrees with the
 * remote is a forge mismatch (exit 5), like resolveForgeConfig's rule.
 * `.omg/config.json` `ado` (the ADO skills' config) and an existing
 * `factory.forge` only prefill answers.
 */

import { getAdoConfig } from '../../config/ado-config.js';
import { detectForgeRepo, ForgeConfigError } from '../../forge/config.js';
import type { ForgeKind, ForgeRepo } from '../../forge/types.js';
import type { Exec } from '../../ship/exec.js';
import { SetupError } from './guard.js';

export interface ForgePins {
  forge?: string;
  org?: string;
  project?: string;
  /** GitHub `owner/name`; ADO repository name. */
  repo?: string;
}

export interface SetupPrefill {
  team?: string;
  areaPath?: string;
  workItemType?: string;
}

export interface DetectedForge {
  repo: ForgeRepo;
  originUrl: string;
  prefill: SetupPrefill;
}

const fold = (s: string): string => {
  try {
    return decodeURIComponent(s).toLowerCase();
  } catch {
    return s.toLowerCase();
  }
};

export function readOrigin(exec: Exec, cwd: string): string | undefined {
  const r = exec('git', ['remote', 'get-url', 'origin'], { cwd });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

function factoryForge(config: unknown): Record<string, unknown> {
  const forge = (config as { factory?: { forge?: unknown } } | null | undefined)?.factory?.forge;
  return forge !== null && typeof forge === 'object' && !Array.isArray(forge) ? (forge as Record<string, unknown>) : {};
}

/**
 * @param configs parsed config layers (user, project) read for prefill only
 */
export function detectSetupForge(exec: Exec, cwd: string, pins: ForgePins, configs: unknown[] = []): DetectedForge {
  if (pins.forge !== undefined && pins.forge !== 'github' && pins.forge !== 'azure-devops') {
    throw new SetupError(2, `--forge must be github or azure-devops, got ${JSON.stringify(pins.forge)}`);
  }
  const originUrl = readOrigin(exec, cwd);
  if (!originUrl) throw new SetupError(5, 'unsupported forge: this repository has no origin remote (git remote get-url origin)');
  let repo: ForgeRepo;
  try {
    repo = detectForgeRepo(originUrl);
  } catch (error) {
    if (error instanceof ForgeConfigError) throw new SetupError(5, `unsupported forge: ${error.message}`);
    throw error;
  }
  const mismatch = (flag: string, value: string, remote: string): never => {
    throw new SetupError(5, `forge mismatch: ${flag} ${JSON.stringify(value)} disagrees with the origin remote (${JSON.stringify(remote)}); flags can pin the forge, never redirect it`);
  };
  if (pins.forge !== undefined && (pins.forge as ForgeKind) !== repo.kind) mismatch('--forge', pins.forge, repo.kind);
  if (repo.kind === 'github') {
    if (pins.org !== undefined || pins.project !== undefined) throw new SetupError(2, '--org and --project are Azure DevOps flags; this repository is on GitHub');
    if (pins.repo !== undefined && pins.repo.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()) mismatch('--repo', pins.repo, `${repo.owner}/${repo.name}`);
  } else {
    if (pins.org !== undefined && fold(pins.org) !== fold(repo.owner)) mismatch('--org', pins.org, repo.owner);
    if (pins.project !== undefined && fold(pins.project) !== fold(repo.project!)) mismatch('--project', pins.project, repo.project!);
    if (pins.repo !== undefined && fold(pins.repo) !== fold(repo.name)) mismatch('--repo', pins.repo, repo.name);
  }

  const prefill: SetupPrefill = {};
  if (repo.kind === 'azure-devops') {
    const ado = getAdoConfig(cwd);
    // The skills' config is for this project only when it names it (or names none).
    if (ado.project === undefined || fold(ado.project) === fold(repo.project!)) {
      if (ado.areaPath) prefill.areaPath = ado.areaPath;
      if (ado.defaultWorkItemType) prefill.workItemType = ado.defaultWorkItemType;
    }
    for (const config of configs) {
      const team = (factoryForge(config).azureDevOps as { team?: unknown } | undefined)?.team;
      if (typeof team === 'string' && team && !prefill.team) prefill.team = team;
    }
  }
  return { repo, originUrl, prefill };
}

/**
 * `omg factory listen` is GitHub-only (critic amendments §A.12): it receives
 * GitHub webhooks. The refusal text when the repository's forge, or the
 * trusted user config's `factory.forge.kind`, is Azure DevOps; undefined otherwise.
 */
export function listenForgeRefusal(exec: Exec, cwd: string, trustedUser: unknown): string | undefined {
  let kind = factoryForge(trustedUser).kind;
  const origin = readOrigin(exec, cwd);
  if (origin) {
    try {
      if (detectForgeRepo(origin).kind === 'azure-devops') kind = 'azure-devops';
    } catch {
      // Not a forge the factory knows: the listener's own repo whitelist decides.
    }
  }
  if (kind !== 'azure-devops') return undefined;
  return 'refused: omg factory listen receives GitHub webhooks only, and this repository\'s forge.kind is azure-devops. On Azure DevOps run `omg factory poll`, which polls the tracker, the PRs and CI instead (service hooks need a public endpoint); start work with `omg factory run`.';
}
