/**
 * `factory.forge`, `factory.intake`, `factory.check` and `factory.progress`
 * (factory forges design §3). Trust follows loadTrustedShipConfig: the
 * caller passes the user config at its default location (userConfigLayers
 * `trustedUser`), the `.copilot/omg.jsonc` committed on the verified base
 * (readBaseFile), and the working-tree project config. The resolver is pure
 * (no git, no spawn), like resolveFactoryRunLimits.
 *
 * | Keys                               | Sources (high -> low)                | Working-tree file          |
 * |------------------------------------|--------------------------------------|----------------------------|
 * | forge.* (identity)                 | user -> base -> origin detection     | ignored, warned on a diff  |
 * | forge.azureDevOps.trustedAuthors   | user only                            | ignored, warned            |
 * | progress.* (tracker writes)        | user -> base                         | ignored, warned on a diff  |
 * | heal.pipeline (ADO: which is CI)   | user -> base                         | ignored, warned on a diff  |
 * | intake.*, check.*                  | project -> user -> base -> defaults  | allowed                    |
 *
 * Config can pin the forge, never redirect it: a kind, org, project or repo
 * that disagrees with the origin remote is refused (`forge-mismatch`).
 *
 * Limitation: `forge.azureDevOps.workItemProject` must equal the repo's
 * project (folded like the other names) or be omitted. The invoke guard pins
 * every `project` route parameter to the repo's project (routes.ts), so work
 * items tracked in another project are not supported yet; a different value
 * is refused (`forge-unsupported`) rather than failing later at the guard.
 */

import { ADO_SEGMENT, ambiguousAuthority, parseAzureDevOpsRepoUrl, parseRemoteUrl } from '../providers/remote-url.js';
import {
  PROGRESS_STAGES,
  type AzureDevOpsForgeConfig,
  type ForgeCheckConfig,
  type ForgeIntakeConfig,
  type ForgeKind,
  type ForgeProgressConfig,
  type ForgeRepo,
  type IntakeSource,
  type ProgressMapping,
  type ProgressStage,
  type ResolvedForgeConfig,
} from './types.js';

export type ForgeConfigErrorCode = 'forge-mismatch' | 'forge-unsupported' | 'invalid';

export class ForgeConfigError extends Error {
  constructor(readonly code: ForgeConfigErrorCode, message: string) {
    super(message);
    this.name = 'ForgeConfigError';
  }
}

export const DEFAULT_ADO_API_VERSION = '7.1';
export const DEFAULT_INTAKE_LIMIT = 50;
export const MAX_INTAKE_LIMIT = 200;
export const DEFAULT_INTAKE_MARKER = 'factory-ready';
export const DEFAULT_ADO_ITEM_TYPES: readonly string[] = ['User Story', 'Bug', 'Product Backlog Item'];
export const DEFAULT_CHECK_CONFIG: Readonly<ForgeCheckConfig> = Object.freeze({ maxAcceptanceItems: 12, maxSize: 8, maxBodyChars: 20_000 });

/** GitHub default label family (design §7); `cancelled` removes the family, so it has no label. */
export function defaultProgressStages(kind: ForgeKind): Partial<Record<ProgressStage, ProgressMapping>> {
  if (kind !== 'github') return {};
  const stages: Partial<Record<ProgressStage, ProgressMapping>> = {};
  for (const stage of PROGRESS_STAGES) if (stage !== 'cancelled') stages[stage] = { label: `factory:${stage}` };
  return stages;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT = ADO_SEGMENT;
/** A GitHub label or ADO tag: no `,` (gh --remove-label lists) or `;` (ADO tag separator), no leading `-` or space. */
const TRACKER_NAME = /^[^\s,;\-\p{Cc}][^,;\p{Cc}]{0,49}$/u;
/** Free text written to config (board column, state, area path, milestone). */
const TEXT = /^[^\p{Cc}]{1,256}$/u;

type Block = Record<string, unknown>;

function object(value: unknown, what: string): Block {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ForgeConfigError('invalid', `${what} must be an object`);
  return value as Block;
}

/** `factory.<name>` of one config layer; {} when absent. */
/** The config has a `factory.<name>` key (an empty section counts). */
const hasFactoryKey = (config: unknown, name: string): boolean => {
  const factory = (config as { factory?: unknown } | null | undefined)?.factory;
  return typeof factory === 'object' && factory !== null && (factory as Block)[name] !== undefined && (factory as Block)[name] !== null;
};

function factoryBlock(config: unknown, name: string, source: string): Block {
  const factory = object((config as { factory?: unknown } | null | undefined)?.factory, `${source}: factory config`);
  return { ...object(factory[name], `${source}: factory.${name}`) };
}

function text(value: unknown, re: RegExp, key: string, source: string): string {
  if (typeof value !== 'string' || !re.test(value) || value.trim() !== value) throw new ForgeConfigError('invalid', `${source}: factory.${key} must be a plain name`);
  return value;
}

function count(value: unknown, key: string, source: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ForgeConfigError('invalid', `${source}: factory.${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** JSON with object keys sorted at every depth, so key order never matters. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Block)[k])]))
      : v;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/** `%20` and friends decoded; a malformed escape keeps the raw segment. */
const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
/** ADO names compare case-insensitively with escapes decoded (design §8.3). */
const fold = (s: string): string => decode(s).toLowerCase();

/** The forge kind and repository the origin remote names. */
export function detectForgeRepo(originUrl: string): ForgeRepo {
  // The forms (legacy visualstudio.com too) and refusals repoIdentity uses, so both name the same repository.
  const ado = parseAzureDevOpsRepoUrl(originUrl);
  if (ado) {
    if (ado === 'invalid') throw new ForgeConfigError('forge-unsupported', `cannot parse the Azure DevOps remote ${JSON.stringify(originUrl)}`);
    const { org: o, project: p, repo: r } = ado;
    return {
      kind: 'azure-devops',
      host: 'dev.azure.com',
      owner: o,
      project: p,
      name: r,
      url: `https://dev.azure.com/${encodeURIComponent(o)}/${encodeURIComponent(p)}/_git/${encodeURIComponent(r)}`,
    };
  }
  const parsed = ambiguousAuthority(originUrl) ? null : parseRemoteUrl(originUrl);
  if (!parsed) throw new ForgeConfigError('forge-unsupported', `cannot parse the origin remote ${JSON.stringify(originUrl)}`);
  if (parsed.provider === 'azure-devops') throw new ForgeConfigError('forge-unsupported', `cannot parse the Azure DevOps remote ${JSON.stringify(originUrl)}`);
  // The host feeds `gh --hostname` (an scp origin `git@evil#@github.com:o/r` would hand evil the token).
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(parsed.host)) throw new ForgeConfigError('forge-unsupported', `the origin remote host ${JSON.stringify(parsed.host)} is not a plain host name`);
  // github.com, or a host detectProvider cannot name (GitHub Enterprise): today's GitHub behaviour.
  if (parsed.provider !== 'github' && parsed.provider !== 'unknown') {
    throw new ForgeConfigError('forge-unsupported', `unsupported forge ${parsed.provider} (${parsed.host}); omg factory supports github and azure-devops`);
  }
  return { kind: 'github', host: parsed.host, owner: parsed.owner, name: parsed.repo, url: `https://${parsed.host}/${parsed.owner}/${parsed.repo}` };
}

function mismatch(key: string, configured: string, remote: string): never {
  throw new ForgeConfigError('forge-mismatch', `factory.forge.${key} is ${JSON.stringify(configured)}, but the origin remote is ${JSON.stringify(remote)}; config can pin the forge, never redirect it`);
}

function intakeSource(value: unknown, kind: ForgeKind, source: string): IntakeSource {
  const s = object(value, `${source}: factory.intake.source`);
  const key = 'intake.source';
  const ado = kind === 'azure-devops';
  const want = (k: ForgeKind) => {
    if (k !== kind) throw new ForgeConfigError('invalid', `${source}: factory.intake.source type ${String(s.type)} is for ${k}, but the forge is ${kind}`);
  };
  switch (s.type) {
    case 'label':
      want('github');
      return { type: 'label', label: text(s.label, TRACKER_NAME, `${key}.label`, source) };
    case 'milestone':
      want('github');
      return { type: 'milestone', milestone: text(s.milestone, TEXT, `${key}.milestone`, source) };
    case 'wiql-query':
      want('azure-devops');
      if (typeof s.queryId !== 'string' || !GUID.test(s.queryId)) throw new ForgeConfigError('invalid', `${source}: factory.${key}.queryId must be a saved-query GUID`);
      return { type: 'wiql-query', queryId: s.queryId.toLowerCase() };
    case 'board-column':
      want('azure-devops');
      return {
        type: 'board-column',
        team: text(s.team, SEGMENT, `${key}.team`, source),
        board: text(s.board, SEGMENT, `${key}.board`, source),
        column: text(s.column, TEXT, `${key}.column`, source),
      };
    case 'area-tag':
      want('azure-devops');
      return { type: 'area-tag', areaPath: text(s.areaPath, TEXT, `${key}.areaPath`, source), tag: text(s.tag, TRACKER_NAME, `${key}.tag`, source) };
    default:
      throw new ForgeConfigError('invalid', `${source}: factory.intake.source.type must be one of ${ado ? 'wiql-query, board-column, area-tag' : 'label, milestone'}`);
  }
}

function resolveIntake(layer: Block, kind: ForgeKind): ForgeIntakeConfig {
  const source = 'factory config';
  const intake: ForgeIntakeConfig = {
    itemTypes: [...DEFAULT_ADO_ITEM_TYPES],
    limit: DEFAULT_INTAKE_LIMIT,
    marker: DEFAULT_INTAKE_MARKER,
  };
  if (layer.source !== undefined) intake.source = intakeSource(layer.source, kind, source);
  if (layer.itemTypes !== undefined) {
    if (!Array.isArray(layer.itemTypes) || layer.itemTypes.length === 0) throw new ForgeConfigError('invalid', `${source}: factory.intake.itemTypes must be a non-empty array of work item types`);
    intake.itemTypes = [...new Set(layer.itemTypes.map((t) => text(t, TEXT, 'intake.itemTypes', source)))];
  }
  if (layer.limit !== undefined) intake.limit = count(layer.limit, 'intake.limit', source, 1, MAX_INTAKE_LIMIT);
  if (layer.marker !== undefined) intake.marker = text(layer.marker, TRACKER_NAME, 'intake.marker', source);
  return intake;
}

function resolveCheck(layer: Block): ForgeCheckConfig {
  const check: ForgeCheckConfig = { ...DEFAULT_CHECK_CONFIG };
  for (const key of Object.keys(DEFAULT_CHECK_CONFIG) as Array<keyof ForgeCheckConfig>) {
    if (layer[key] !== undefined) check[key] = count(layer[key], `check.${key}`, 'factory config', 1);
  }
  return check;
}

/** Progress sync is opt-in: on only when a trusted layer has a `factory.progress` section (omg factory setup writes one). */
function resolveProgress(layer: Block, configured: boolean, kind: ForgeKind, source: string): ForgeProgressConfig {
  const progress: ForgeProgressConfig = { enabled: configured, stages: defaultProgressStages(kind) };
  if (layer.enabled !== undefined) {
    if (typeof layer.enabled !== 'boolean') throw new ForgeConfigError('invalid', `${source}: factory.progress.enabled must be true or false`);
    progress.enabled = layer.enabled;
  }
  const stages = object(layer.stages, `${source}: factory.progress.stages`);
  for (const [stage, raw] of Object.entries(stages)) {
    if (!(PROGRESS_STAGES as readonly string[]).includes(stage)) throw new ForgeConfigError('invalid', `${source}: factory.progress.stages.${stage} is not a stage (${PROGRESS_STAGES.join(', ')})`);
    const m = object(raw, `${source}: factory.progress.stages.${stage}`);
    const key = `progress.stages.${stage}`;
    const allowed = kind === 'github' ? ['label'] : ['column', 'state'];
    const extra = Object.keys(m).find((k) => !allowed.includes(k));
    if (extra) throw new ForgeConfigError('invalid', `${source}: factory.${key}.${extra} is not used on ${kind} (allowed: ${allowed.join(', ')})`);
    // blocked and cancelled never change the work item state (design §4 step 5).
    if (m.state !== undefined && (stage === 'blocked' || stage === 'cancelled')) {
      throw new ForgeConfigError('invalid', `${source}: factory.${key}.state is not allowed; ${stage} never changes the work item state`);
    }
    const mapping: ProgressMapping = {};
    if (m.label !== undefined) mapping.label = text(m.label, TRACKER_NAME, `${key}.label`, source);
    if (m.column !== undefined) mapping.column = text(m.column, TEXT, `${key}.column`, source);
    if (m.state !== undefined) mapping.state = text(m.state, TEXT, `${key}.state`, source);
    progress.stages[stage as ProgressStage] = mapping;
  }
  return progress;
}

export interface LoadedForgeConfig {
  config: ResolvedForgeConfig;
  warnings: string[];
}

/**
 * Resolve the forge settings of one repository.
 * @param trustedUser the user config at its default location (userConfigLayers().trustedUser)
 * @param base the parsed `.copilot/omg.jsonc` committed on the verified base, or undefined when that layer was skipped
 * @param project the parsed working-tree project config
 * @param originUrl `git remote get-url origin`
 * Throws ForgeConfigError: `forge-mismatch` when config disagrees with the
 * remote, `forge-unsupported` for a remote that is neither GitHub nor Azure
 * DevOps, `invalid` for an ill-typed value.
 */
export function resolveForgeConfig(trustedUser: unknown, base: unknown, project: unknown, originUrl: string): LoadedForgeConfig {
  const warnings: string[] = [];
  const baseSource = 'base-branch .copilot/omg.jsonc';

  // forge.* identity: user -> base; the working tree never sets it.
  const uForge = factoryBlock(trustedUser, 'forge', 'user config');
  const bForge = factoryBlock(base, 'forge', baseSource);
  const pForge = factoryBlock(project, 'forge', 'project config');
  const uAdo = { ...object(uForge.azureDevOps, 'user config: factory.forge.azureDevOps') };
  const bAdo = { ...object(bForge.azureDevOps, `${baseSource}: factory.forge.azureDevOps`) };
  const pAdo = { ...object(pForge.azureDevOps, 'project config: factory.forge.azureDevOps') };
  const trustedAuthors = uAdo.trustedAuthors;
  for (const [layer, source] of [[bAdo, baseSource], [pAdo, 'the working-tree project config']] as const) {
    if (layer.trustedAuthors === undefined) continue;
    warnings.push(`omg factory: ignoring factory.forge.azureDevOps.trustedAuthors from ${source}; it is read only from the user config`);
  }
  delete uAdo.trustedAuthors;
  delete bAdo.trustedAuthors;
  delete pAdo.trustedAuthors;
  const withAdo = (f: Block, ado: Block): Block => {
    const { azureDevOps: _drop, ...rest } = f;
    return Object.keys(ado).length > 0 ? { ...rest, azureDevOps: ado } : rest;
  };
  if (Object.keys(pForge).length > 0 && !same(withAdo(pForge, pAdo), withAdo(bForge, bAdo))) {
    warnings.push(`omg factory: ignoring factory.forge from the working-tree project config; it is read only from the user config or ${baseSource}`);
  }

  const remote = detectForgeRepo(originUrl);
  const kindRaw = uForge.kind ?? bForge.kind;
  if (kindRaw !== undefined && kindRaw !== 'github' && kindRaw !== 'azure-devops') {
    throw new ForgeConfigError('invalid', 'factory.forge.kind must be "github" or "azure-devops"');
  }
  if (kindRaw !== undefined && kindRaw !== remote.kind) mismatch('kind', kindRaw, remote.kind);
  const kind = remote.kind;
  const source = 'factory config';

  let azureDevOps: AzureDevOpsForgeConfig | undefined;
  if (kind === 'github') {
    const gh = { ...object(bForge.github, `${baseSource}: factory.forge.github`), ...object(uForge.github, 'user config: factory.forge.github') };
    if (gh.repo !== undefined) {
      const repo = text(gh.repo, /^[^/\s]+\/[^/\s]+$/, 'forge.github.repo', source);
      if (repo.toLowerCase() !== `${remote.owner}/${remote.name}`.toLowerCase()) mismatch('github.repo', repo, `${remote.owner}/${remote.name}`);
    }
    if (gh.host !== undefined) {
      const host = text(gh.host, SEGMENT, 'forge.github.host', source);
      if (host.toLowerCase() !== remote.host.toLowerCase()) mismatch('github.host', host, remote.host);
    }
  } else {
    const ado: Block = { ...bAdo, ...uAdo };
    const pin = (key: 'org' | 'project' | 'repo', actual: string): void => {
      if (ado[key] === undefined) return;
      const value = text(ado[key], SEGMENT, `forge.azureDevOps.${key}`, source);
      if (fold(value) !== fold(actual)) mismatch(`azureDevOps.${key}`, value, actual);
    };
    pin('org', remote.owner);
    pin('project', remote.project!);
    pin('repo', remote.name);
    if (ado.apiVersion !== undefined && ado.apiVersion !== DEFAULT_ADO_API_VERSION) {
      throw new ForgeConfigError('invalid', `factory.forge.azureDevOps.apiVersion must be "${DEFAULT_ADO_API_VERSION}" (per-route versions are pinned in src/forge/ado/routes.ts)`);
    }
    let authors: string[] = [];
    if (trustedAuthors !== undefined) {
      if (!Array.isArray(trustedAuthors)) throw new ForgeConfigError('invalid', 'user config: factory.forge.azureDevOps.trustedAuthors must be an array of uniqueNames');
      authors = [...new Set(trustedAuthors.map((a) => text(a, TEXT, 'forge.azureDevOps.trustedAuthors', 'user config').toLowerCase()))];
    }
    // A cross-project tracker is refused for now (see the header: the guard pins `project`).
    if (ado.workItemProject !== undefined) {
      const wip = text(ado.workItemProject, SEGMENT, 'forge.azureDevOps.workItemProject', source);
      if (fold(wip) !== fold(remote.project!)) {
        throw new ForgeConfigError(
          'forge-unsupported',
          `factory.forge.azureDevOps.workItemProject ${JSON.stringify(wip)} differs from the repository project ${JSON.stringify(remote.project)}; work items in another project are not supported yet`,
        );
      }
    }
    azureDevOps = {
      org: remote.owner,
      project: remote.project!,
      repo: remote.name,
      workItemProject: remote.project!,
      ...(ado.team === undefined ? {} : { team: text(ado.team, SEGMENT, 'forge.azureDevOps.team', source) }),
      apiVersion: DEFAULT_ADO_API_VERSION,
      trustedAuthors: authors,
    };
  }

  // intake.* and check.*: selection and scoring only (runs stay manual), so the working tree may set them.
  const intake = { ...factoryBlock(base, 'intake', baseSource), ...factoryBlock(trustedUser, 'intake', 'user config'), ...factoryBlock(project, 'intake', 'project config') };
  const check = { ...factoryBlock(base, 'check', baseSource), ...factoryBlock(trustedUser, 'check', 'user config'), ...factoryBlock(project, 'check', 'project config') };

  // progress.* writes to the tracker: user -> base only.
  const bProgress = factoryBlock(base, 'progress', baseSource);
  const uProgress = factoryBlock(trustedUser, 'progress', 'user config');
  const pProgress = factoryBlock(project, 'progress', 'project config');
  if (Object.keys(pProgress).length > 0 && !same(pProgress, bProgress)) {
    warnings.push(`omg factory: ignoring factory.progress from the working-tree project config; it is read only from the user config or ${baseSource}`);
  }

  // heal.pipeline decides which builds heal believes are CI: user -> base only (ADO parity design §3.2).
  const bPipeline = factoryBlock(base, 'heal', baseSource).pipeline;
  const uPipeline = factoryBlock(trustedUser, 'heal', 'user config').pipeline;
  const pHeal = (project as { factory?: { heal?: unknown } } | null | undefined)?.factory?.heal;
  const pPipeline = pHeal !== null && typeof pHeal === 'object' ? (pHeal as Block).pipeline : undefined;
  if (pPipeline !== undefined && !same(pPipeline, bPipeline)) {
    warnings.push(`omg factory: ignoring factory.heal.pipeline from the working-tree project config; it is read only from the user config or ${baseSource}`);
  }
  const pipelineRaw = uPipeline ?? bPipeline;
  let heal: ResolvedForgeConfig['heal'];
  if (pipelineRaw !== undefined && pipelineRaw !== null) {
    if (kind !== 'azure-devops') {
      warnings.push('omg factory: ignoring factory.heal.pipeline; it names an Azure Pipelines build definition and is used on azure-devops only');
    } else {
      const p = object(pipelineRaw, `${source}: factory.heal.pipeline`);
      const extra = Object.keys(p).find((k) => k !== 'definitionId');
      if (extra) throw new ForgeConfigError('invalid', `${source}: factory.heal.pipeline.${extra} is not a key (allowed: definitionId)`);
      heal = { pipeline: { definitionId: count(p.definitionId, 'heal.pipeline.definitionId', source, 1, 2_147_483_647) } };
    }
  }

  return {
    config: {
      kind,
      repo: remote,
      ...(azureDevOps ? { azureDevOps } : {}),
      intake: resolveIntake(intake, kind),
      check: resolveCheck(check),
      progress: resolveProgress({ ...bProgress, ...uProgress }, hasFactoryKey(base, 'progress') || hasFactoryKey(trustedUser, 'progress'), kind, source),
      ...(heal ? { heal } : {}),
    },
    warnings,
  };
}

/**
 * Whether an ADO identity is in trustedAuthors (critic amendments §A.10):
 * `uniqueName` only, case-insensitive; the display name is never consulted
 * (anyone can choose it).
 */
export function isTrustedAdoAuthor(createdBy: unknown, trustedAuthors: readonly string[]): boolean {
  const unique = (createdBy as { uniqueName?: unknown } | null | undefined)?.uniqueName;
  if (typeof unique !== 'string' || !unique.trim()) return false;
  const name = unique.trim().toLowerCase();
  return trustedAuthors.some((a) => a.toLowerCase() === name);
}
