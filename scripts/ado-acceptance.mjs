#!/usr/bin/env node
/**
 * Live acceptance of the factory on Azure DevOps (ADO parity design §6). One
 * throwaway Agile project per run, named `omg-acc-<yyyymmddHHMM>` (UTC):
 *
 *   node scripts/ado-acceptance.mjs --org https://dev.azure.com/<org> --source C:/Code/ExcavatorTrek
 *     [--phase preflight|create|exercise|heal-drill|capture|cleanup|all] [--run <runId>]
 *     [--pool <self-hosted pool> | --hosted] [--with-lanes] [--project-id <guid>] [--dry-run]
 *
 * - `all` runs preflight, create, exercise and capture. `heal-drill` (it
 *   needs a working agent and design PR C3) and `cleanup` run only by name.
 * - Later phases use `--run <runId>`, or the newest manifest.
 * - The manifest `~/.omg/acceptance/<runId>.json` records every created id
 *   and is written before each create. The clone, the progress file, the OMC
 *   recording (`OMG_ADO_RECORD_DIR`) and the capture live in
 *   `~/.omg/acceptance/<runId>/`.
 * - `--dry-run` prints the exact argv of every command and every file it
 *   would write, and runs and writes nothing (not even read-only commands).
 * - Nothing spends Copilot credits without `--with-lanes`.
 * - `cleanup` needs `--org` equal to the manifest's org and deletes only the
 *   project id in this run's manifest, after `az devops project show`
 *   (JSON) confirms its `omg-acc-` name. The project is
 *   soft-deleted and restorable for 28 days.
 * - The agent pool defaults to the self-hosted pool `Default` (free, one
 *   job); `--hosted` uses Microsoft-hosted `ubuntu-latest`, which needs the org
 *   linked to an Azure subscription.
 *
 * Needs a build (`npm run build`): az is spawned through resolveAzEntry
 * (python `-IBm azure.cli` on Windows, never cmd.exe, so the work item HTML
 * reaches az unmangled) and omg runs from bin/. Every az command used is
 * verified against learn.microsoft.com in design §7; the one this script adds
 * carries its doc URL where it is used.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { backlogToWorkItems } from './lib/backlog-to-workitems.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RUN_PREFIX = 'omg-acc-';
const RUN_ID = /^omg-acc-\d{12}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PHASES = ['preflight', 'create', 'exercise', 'heal-drill', 'capture', 'cleanup'];
export const ALL_PHASES = ['preflight', 'create', 'exercise', 'capture'];
export const DEFAULT_POOL = 'Default';
/** The heal drill's failing test, removed again by a revert commit. */
export const DRILL_TEST = 'src/omg-acceptance-drill.test.ts';
const DRILL_SOURCE = "import { expect, it } from 'vitest';\n\n// omg live acceptance heal drill: fails on purpose; reverted by the next commit.\nit('omg acceptance heal drill', () => {\n  expect(1 + 1).toBe(3);\n});\n";

/** Agile states for the progress mapping (setup validates them against the project). */
export const AGILE_PROGRESS = Object.freeze({ enabled: true, stages: { building: { state: 'Active' }, 'ready-to-merge': { state: 'Resolved' }, done: { state: 'Closed' } } });

export function runIdAt(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${RUN_PREFIX}${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
}

/** `https://dev.azure.com/<org>` → `<org>`; anything else throws. */
export function orgNameOf(orgUrl) {
  const m = /^https:\/\/dev\.azure\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,49})\/?$/.exec(orgUrl ?? '');
  if (!m) throw new Error('--org must be https://dev.azure.com/<org>');
  return m[1];
}

export function parseAcceptanceArgs(argv, home = join(homedir(), '.omg', 'acceptance')) {
  const o = { phase: 'all', withLanes: false, dryRun: false, home, pool: { kind: 'self-hosted', name: DEFAULT_POOL } };
  let poolName, hosted = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === '--org') o.org = value().replace(/\/+$/, '');
    else if (flag === '--source') o.source = resolve(value());
    else if (flag === '--phase') o.phase = value();
    else if (flag === '--run') o.run = value();
    else if (flag === '--pool') poolName = value();
    else if (flag === '--hosted') hosted = true;
    else if (flag === '--with-lanes') o.withLanes = true;
    else if (flag === '--project-id') o.projectId = value();
    else if (flag === '--home') o.home = resolve(value());
    else if (flag === '--dry-run') o.dryRun = true;
    else throw new Error(`unknown flag ${flag}`);
  }
  if (o.phase !== 'all' && !PHASES.includes(o.phase)) throw new Error(`--phase must be one of ${[...PHASES, 'all'].join(', ')}`);
  if (o.run !== undefined && !RUN_ID.test(o.run)) throw new Error(`--run must be an ${RUN_PREFIX}<yyyymmddHHMM> run id`);
  if (o.projectId !== undefined && !GUID.test(o.projectId)) throw new Error('--project-id must be a project GUID');
  if (hosted && poolName) throw new Error('--pool names a self-hosted pool; --hosted uses Microsoft-hosted agents; pass one');
  if (hosted) o.pool = { kind: 'microsoft', vmImage: 'ubuntu-latest' };
  else if (poolName) {
    if (!/^[A-Za-z0-9 ._-]{1,64}$/.test(poolName)) throw new Error('--pool must be a plain pool name');
    o.pool = { kind: 'self-hosted', name: poolName };
  }
  const needsSource = ['all', 'preflight', 'create'].includes(o.phase);
  if (o.org !== undefined) o.orgName = orgNameOf(o.org);
  // cleanup never trusts the manifest's org alone: --org must name it too.
  else if (needsSource || o.phase === 'cleanup') throw new Error('--org is required');
  if (needsSource && !o.source) throw new Error('--source is required (a local clone of the test repository)');
  return o;
}

/** azure-pipelines.yml for the test repository, mirroring its .github/workflows/ci.yml. */
export function pipelineYaml(pool) {
  const poolBlock = pool.kind === 'microsoft' ? `pool:\n  vmImage: ${pool.vmImage}\n` : `pool:\n  name: ${pool.name}\n`;
  return [
    '# omg live acceptance (scripts/ado-acceptance.mjs): mirrors .github/workflows/ci.yml.',
    '# PR builds come from the build validation policy on main.',
    'trigger:',
    '  branches:',
    '    include: [main]',
    poolBlock.trimEnd(),
    'steps:',
    '  - task: NodeTool@0',
    '    inputs:',
    "      versionSpec: '24.x'",
    '  - script: npm ci',
    '    displayName: npm ci',
    '  - script: npm run check',
    '    displayName: npm run check',
    '',
  ].join('\n');
}

/** What preflight tells Robin about agents (design §6 preflight, §7 "acceptance: cost"). */
export function poolAdvice(pool, pools) {
  const lines = [];
  if (pool.kind === 'self-hosted') {
    lines.push(`Agent pool: self-hosted "${pool.name}" (the default). It is free (1 parallel job) but needs an agent registered on this machine: Organization settings > Agent pools > ${pool.name} > New agent.`);
    lines.push('Pass --hosted for Microsoft-hosted ubuntu-latest instead; that needs the org linked to an Azure subscription (free tier: 1 job, 60 min/job, 1,800 min/month).');
    const names = Array.isArray(pools) ? pools.map((p) => p?.name).filter((n) => typeof n === 'string') : undefined;
    if (names && !names.includes(pool.name)) lines.push(`WARNING: the org has no pool named "${pool.name}" (pools: ${names.join(', ') || 'none'}); pass --pool <name>.`);
  } else {
    lines.push('Agent pool: Microsoft-hosted ubuntu-latest (--hosted). It runs only when the org is linked to an Azure subscription (free tier: 1 job, 60 min/job, 1,800 min/month).');
    lines.push('Without billing, register a free self-hosted agent and drop --hosted.');
  }
  lines.push('Without a working agent, builds stay queued: create and exercise still work (gates stay pending), heal-drill cannot.');
  return lines.join('\n');
}

/**
 * Cleanup's guard: the project id comes from this run's manifest only, the
 * manifest's project name is the run id with the `omg-acc-` prefix, a
 * `--project-id` must equal the recorded id, and `shown` (az devops project
 * show) must name the same project. Returns the id to delete.
 */
export function assertCleanupAllowed(manifest, { requestedId, shown } = {}) {
  if (!manifest || typeof manifest !== 'object') throw new Error('cleanup refused: no manifest for this run');
  const name = manifest.project?.name;
  if (typeof name !== 'string' || !name.startsWith(RUN_PREFIX) || name !== manifest.runId || !RUN_ID.test(name)) {
    throw new Error(`cleanup refused: project name ${JSON.stringify(name)} is not this run's ${RUN_PREFIX}<timestamp> name`);
  }
  const id = manifest.project?.id;
  if (typeof id !== 'string' || !GUID.test(id)) throw new Error(`cleanup refused: the manifest records no project id for ${name}`);
  if (requestedId !== undefined && requestedId.toLowerCase() !== id.toLowerCase()) throw new Error(`cleanup refused: ${requestedId} is not the project id in the manifest of ${name}`);
  if (shown !== undefined) {
    if (!shown || typeof shown !== 'object') throw new Error(`cleanup refused: az devops project show returned no readable project for ${id}`);
    if (String(shown.id).toLowerCase() !== id.toLowerCase()) throw new Error(`cleanup refused: az devops project show returned another project than ${id}`);
    if (shown.name !== name) throw new Error(`cleanup refused: project ${id} is named ${JSON.stringify(shown.name)}, not ${name}`);
  }
  return id;
}

/** The predecessor link type's name from `az boards work-item relation list-type`. */
export function predecessorRelation(types) {
  const found = (Array.isArray(types) ? types : []).find((t) => typeof t?.name === 'string' && t.name.toLowerCase() === 'predecessor');
  if (!found) throw new Error('the org has no "Predecessor" work item relation type (az boards work-item relation list-type)');
  return found.name.toLowerCase();
}

/** Deep search: the first value of `key` on an object that passes `pick`. */
function findDeep(value, pick) {
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findDeep(v, pick);
      if (hit !== undefined) return hit;
    }
  } else if (value && typeof value === 'object') {
    const hit = pick(value);
    if (hit !== undefined) return hit;
    for (const v of Object.values(value)) {
      const inner = findDeep(v, pick);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}

export const firstRunnable = (checkJson) => findDeep(checkJson, (o) => (o.bucket === 'runnable' && o.id !== undefined ? String(o.id) : undefined));
export const firstSig8 = (scanJson) => findDeep(scanJson, (o) => (typeof o.sig8 === 'string' && /^[0-9a-f]{8}$/.test(o.sig8) ? o.sig8 : undefined));

/** The design's `exercise` assertions over the OMC recording and the run's output. */
export function exerciseAssertions(recorded, runOutput, itemId) {
  const ok = (f) => f.exitCode === undefined || f.exitCode === 0;
  const of = (route) => recorded.filter((f) => f.route === route && ok(f));
  const prStatuses = of('git.pullRequests.GET').flatMap((f) => (Array.isArray(f.stdout?.value) ? f.stdout.value : [f.stdout])).map((p) => p?.status).filter(Boolean);
  return [
    { what: 'a draft PR exists, linked to the work item', ok: of('git.pullRequests.POST').some((f) => f.requestBody?.isDraft === true && (f.requestBody?.workItemRefs ?? []).some((r) => String(r.id) === String(itemId))) },
    { what: 'gates are computed from policy evaluations', ok: of('policy.evaluations.GET').length > 0 },
    { what: 'the run parks at awaiting-human: merge', ok: /awaiting-human:?\s*merge/i.test(runOutput) },
    { what: 'the PR is still active and never completed', ok: prStatuses.length > 0 && prStatuses.every((s) => s !== 'completed') },
    { what: 'no PR PATCH other than {isDraft:false}', ok: recorded.filter((f) => f.route === 'git.pullRequests.PATCH').every((f) => JSON.stringify(f.requestBody) === '{"isDraft":false}') },
    { what: 'progress moved the work item', ok: of('wit.workItems.PATCH').length > 0 },
  ];
}

const parseMaybe = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const manifestPathOf = (home, runId) => join(home, `${runId}.json`);

/** The newest run id with a manifest under `home`, or undefined. */
export function latestRunId(home) {
  if (!existsSync(home)) return undefined;
  return readdirSync(home).filter((n) => RUN_ID.test(n.replace(/\.json$/, '')) && n.endsWith('.json')).map((n) => n.slice(0, -5)).sort().at(-1);
}

/** The azure-devops extension's command groups: they take `--detect`. */
const DEVOPS_GROUPS = new Set(['devops', 'repos', 'boards', 'pipelines']);

/**
 * Every az call reads JSON whatever the user's `az config` output default,
 * and the extension commands never pick the org up from git config, as
 * src/forge/ado/invoke.ts does. `az --version` prints text only.
 */
export function azArgv(args) {
  if (args[0] === '--version') return args;
  return [...args, ...(DEVOPS_GROUPS.has(args[0]) ? ['--detect', 'false'] : []), '--output', 'json'];
}

/**
 * The side-effect boundary: every spawn and file write goes through here,
 * and in dry-run mode each one is printed, never done. `deps`: spawn
 * (spawnSync's shape), azEntry, log, now, sleep(ms), redact, env, runLimits.
 */
export function createContext(o, deps) {
  const log = deps.log ?? console.log;
  const redact = deps.redact ?? ((s) => s);
  const ctx = { o, log, manifest: undefined, now: deps.now ?? (() => new Date()), sleep: deps.sleep ?? (() => {}), env: deps.env ?? process.env, runLimits: deps.runLimits };
  ctx.exec = (label, cmd, args, { cwd, env, placeholder, allowFail = false } = {}) => {
    const shown = `${label}: ${JSON.stringify([cmd, ...args])}${cwd ? ` (cwd ${cwd})` : ''}${env && Object.keys(env).length ? ` (env ${Object.keys(env).map((k) => `${k}=${env[k]}`).join(' ')})` : ''}`;
    if (o.dryRun) {
      log(`[dry-run] ${shown}`);
      const stdout = placeholder === undefined ? '' : typeof placeholder === 'string' ? placeholder : JSON.stringify(placeholder);
      return { status: 0, stdout, stderr: '', json: typeof placeholder === 'string' ? undefined : placeholder };
    }
    log(`$ ${shown}`);
    const r = deps.spawn(cmd, args, { cwd, env: { ...ctx.env, ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    const res = { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
    res.json = parseMaybe(res.stdout);
    if (res.status !== 0 && !allowFail) throw new Error(`exit ${res.status} from ${shown.slice(0, 300)}\n${redact(res.stderr).trim().slice(0, 2000)}`);
    return res;
  };
  ctx.az = (args, opts = {}) => ctx.exec('az', deps.azEntry.command, [...deps.azEntry.prefix, ...azArgv(args)],{ ...opts, env: { ...deps.azEntry.env, ...opts.env } });
  ctx.git = (args, opts) => ctx.exec('git', 'git', args, opts);
  ctx.node = (script, args, opts) => ctx.exec('node', process.execPath, [join(ROOT, 'scripts', script), ...args], opts);
  ctx.omg = (args, opts = {}) => ctx.exec('omg', process.execPath, [join(ROOT, 'bin', 'oh-my-copilot.js'), ...args], { ...opts, env: { OMG_ADO_RECORD_DIR: join(ctx.manifest.runDir, 'recorded'), ...opts.env } });
  ctx.write = (path, text) => {
    if (o.dryRun) return log(`[dry-run] write ${path} (${Buffer.byteLength(text)} bytes)`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  };
  ctx.read = (path) => readFileSync(path, 'utf8');
  ctx.saveManifest = () => ctx.write(manifestPathOf(o.home, ctx.manifest.runId), `${JSON.stringify(ctx.manifest, null, 2)}\n`);
  ctx.rm = (path) => (o.dryRun ? log(`[dry-run] remove ${path}`) : rmSync(path, { recursive: true, force: true }));
  return ctx;
}

/** The run's manifest: in memory after create, else `--run` or the newest one; a dry run without one gets a placeholder. */
function requireManifest(ctx) {
  if (ctx.manifest) return ctx.manifest;
  const { o } = ctx;
  const runId = o.run ?? latestRunId(o.home);
  const path = runId && manifestPathOf(o.home, runId);
  if (path && existsSync(path)) {
    ctx.manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (ctx.manifest.runId !== runId) throw new Error(`${path} records run ${ctx.manifest.runId}, not ${runId}`);
    if (o.org && ctx.manifest.org !== o.org) throw new Error(`run ${runId} is in ${ctx.manifest.org}, not ${o.org}`);
    return ctx.manifest;
  }
  if (!o.dryRun) throw new Error(runId ? `no manifest ${path}` : `no acceptance run under ${o.home}; run --phase create first`);
  const placeholderId = `${RUN_PREFIX}000000000000`;
  ctx.log(`[dry-run] no manifest; using placeholders for run ${placeholderId}`);
  ctx.manifest = {
    runId: placeholderId, org: o.org ?? 'https://dev.azure.com/<org>', source: o.source ?? '<source>', runDir: join(o.home, placeholderId), pool: o.pool,
    project: { name: placeholderId, id: '00000000-0000-0000-0000-000000000000' }, repo: { name: placeholderId, id: '<repoId>', url: '<repoUrl>' },
    pipeline: { id: '<definitionId>' }, policy: { id: '<policyId>' }, workItems: {}, trustedAuthorsAdded: [],
  };
  return ctx.manifest;
}

const orgOf = (m) => m.org;
const repoDirOf = (m) => join(m.runDir, 'repo');

export function preflight(ctx) {
  const { o } = ctx;
  const problems = [];
  const check = (what, res, fix) => (res.status === 0 ? ctx.log(`ok    ${what}`) : problems.push(`${what}: ${fix}`));
  check('az --version', ctx.az(['--version'], { allowFail: true }), 'install the Azure CLI (the MSI on Windows: https://aka.ms/installazurecliwindows)');
  check('azure-devops extension', ctx.az(['extension', 'show', '--name', 'azure-devops'], { allowFail: true, placeholder: {} }), 'az extension add --name azure-devops');
  if (ctx.env.AZURE_DEVOPS_EXT_PAT) ctx.log('ok    AZURE_DEVOPS_EXT_PAT is set');
  else check('az account show', ctx.az(['account', 'show'], { allowFail: true, placeholder: {} }), 'az login (or set AZURE_DEVOPS_EXT_PAT)');
  check(`org ${o.org}`, ctx.az(['devops', 'project', 'list', '--org', o.org, '--top', '1'], { allowFail: true, placeholder: { value: [] } }), `check --org and your access to ${o.org}`);
  const status = ctx.git(['-C', o.source, 'status', '--porcelain'], { allowFail: true, placeholder: '' });
  if (status.status !== 0) problems.push(`${o.source}: not a git repository`);
  else if (status.stdout.trim()) problems.push(`${o.source}: uncommitted changes; commit or stash them first`);
  else ctx.log(`ok    ${o.source} is clean`);
  if (!existsSync(join(o.source, 'BACKLOG.md'))) problems.push(`${o.source}: no BACKLOG.md`);
  const pools = ctx.az(['pipelines', 'pool', 'list', '--org', o.org], { allowFail: true, placeholder: [] });
  ctx.log(poolAdvice(o.pool, o.dryRun ? undefined : pools.json));
  if (o.withLanes) ctx.log('Copilot: --with-lanes runs one factory run (implement + review, maybe fix/ci-fix lanes) and, in heal-drill, one heal debugger lane and then the approved ci-heal run (implement + review lanes); check your Copilot premium-request quota first.');
  else ctx.log('Copilot: no lane runs without --with-lanes (0 credits).');
  if (!existsSync(join(ROOT, 'dist', 'forge', 'ado', 'az-binary.js'))) problems.push('no OMC build: run npm run build first');
  if (problems.length && o.dryRun) ctx.log(`[dry-run] preflight would fail:\n- ${problems.join('\n- ')}`);
  else if (problems.length) throw new Error(`preflight failed:\n- ${problems.join('\n- ')}`);
}

export function create(ctx) {
  const { o } = ctx;
  const runId = runIdAt(ctx.now());
  if (existsSync(manifestPathOf(o.home, runId))) throw new Error(`run ${runId} already exists; wait a minute and run again`);
  const runDir = join(o.home, runId);
  const repoDir = join(runDir, 'repo');
  const m = (ctx.manifest = {
    schemaVersion: 1, runId, org: o.org, source: o.source, runDir, pool: o.pool, createdAt: ctx.now().toISOString(),
    project: { name: runId }, repo: { name: runId }, pipeline: null, policy: null, workItems: {}, pending: null, trustedAuthorsAdded: [],
  });
  const pending = (what) => {
    m.pending = what;
    ctx.saveManifest();
  };
  const org = ['--org', o.org];
  const scope = ['--project', runId, '--org', o.org];

  pending('project');
  const project = ctx.az(['devops', 'project', 'create', '--name', runId, ...org, '--process', 'Agile', '--visibility', 'private', '--source-control', 'git'], { placeholder: { id: '<projectId>', name: runId } });
  m.project.id = project.json?.id ?? ctx.az(['devops', 'project', 'show', '--project', runId, ...org], { placeholder: { id: '<projectId>' } }).json?.id;
  if (!m.project.id) throw new Error(`created project ${runId} but could not read its id`);
  // https://learn.microsoft.com/en-us/cli/azure/repos?view=azure-cli-latest#az-repos-show
  const repo = ctx.az(['repos', 'show', '--repository', runId, ...scope], { placeholder: { id: '<repoId>', remoteUrl: `https://${o.orgName}@dev.azure.com/${o.orgName}/${runId}/_git/${runId}` } });
  m.repo.id = repo.json?.id;
  m.repo.url = repo.json?.remoteUrl;
  pending(null);

  // The new repository is empty: plain pushes, never a force (no-force-push rule).
  const git = (...args) => ctx.git(['-C', repoDir, ...args]);
  ctx.git(['clone', '--no-local', o.source, repoDir]);
  git('checkout', 'main');
  const branches = git('for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin').stdout.split(/\r?\n/).map((b) => b.trim()).filter((b) => b && b !== 'HEAD' && b !== 'main');
  ctx.write(join(repoDir, 'azure-pipelines.yml'), pipelineYaml(o.pool));
  git('add', 'azure-pipelines.yml');
  git('commit', '-m', 'ci: Azure Pipelines definition for the omg live acceptance run');
  git('remote', 'set-url', 'origin', m.repo.url);
  git('push', 'origin', 'main');
  if (o.dryRun) ctx.log('[dry-run] then one push per branch that for-each-ref lists: git -C <repo> push origin refs/remotes/origin/<branch>:refs/heads/<branch>');
  for (const b of branches) git('push', 'origin', `refs/remotes/origin/${b}:refs/heads/${b}`);

  pending('pipeline');
  const pipeline = ctx.az(['pipelines', 'create', '--name', 'ci', '--repository', runId, '--repository-type', 'tfsgit', '--branch', 'main', '--yml-path', 'azure-pipelines.yml', '--skip-first-run', 'true', ...scope], { placeholder: { id: '<definitionId>' } });
  m.pipeline = { id: pipeline.json?.id };
  pending(null);

  const relation = predecessorRelation(ctx.az(['boards', 'work-item', 'relation', 'list-type', ...org], { placeholder: [{ name: 'Predecessor' }] }).json);
  // A dry run has no clone; it reads the same file from the source (read-only).
  const { items, unknown } = backlogToWorkItems(ctx.read(join(o.dryRun ? o.source : repoDir, 'BACKLOG.md')));
  for (const u of unknown) ctx.log(`note: ${u}`);
  for (const item of items) {
    pending(`work item ${item.key}`);
    const created = ctx.az([
      'boards', 'work-item', 'create', '--type', 'User Story', '--title', item.title, '--description', item.descriptionHtml,
      '--fields', `Microsoft.VSTS.Common.AcceptanceCriteria=${item.acceptanceHtml}`, 'System.Tags=factory', ...scope,
    ], { placeholder: { id: `<wi:${item.key}>` } });
    m.workItems[item.key] = created.json?.id;
    pending(null);
  }
  for (const item of items) {
    const targets = item.dependsOn.map((k) => m.workItems[k]).filter((id) => id !== undefined);
    if (targets.length) ctx.az(['boards', 'work-item', 'relation', 'add', '--id', String(m.workItems[item.key]), '--relation-type', relation, '--target-id', targets.join(','), ...org]);
  }

  const progress = join(runDir, 'progress.json');
  ctx.write(progress, `${JSON.stringify(AGILE_PROGRESS, null, 2)}\n`);
  ctx.omg(['factory', 'setup', '--forge', 'azure-devops', '--org', o.orgName, '--project', runId, '--repo', runId, '--intake', `area-tag:${runId}#factory`, '--progress', progress, '--yes', '--json'], { cwd: repoDir });
  git('add', '.copilot/omg.jsonc');
  git('commit', '-m', 'chore: omg factory config for the live acceptance run');
  git('push', 'origin', 'main');

  // The blocking build policy comes after the last direct push: a branch with
  // required policies refuses direct pushes without bypass permission
  // (https://learn.microsoft.com/en-us/azure/devops/repos/git/branch-policies?view=azure-devops#faq).
  pending('policy');
  const policy = ctx.az([
    'repos', 'policy', 'build', 'create', '--blocking', 'true', '--branch', 'main', '--build-definition-id', String(m.pipeline.id), '--display-name', 'ci', '--enabled', 'true',
    '--manual-queue-only', 'false', '--queue-on-source-update-only', 'true', '--repository-id', String(m.repo.id), '--valid-duration', '720', ...scope,
  ], { placeholder: { id: '<policyId>' } });
  m.policy = { id: policy.json?.id };
  pending(null);
  m.createdDone = true;
  ctx.saveManifest();
  ctx.log(`created ${runId}: project ${m.project.id}, ${items.length} work items, pipeline ${m.pipeline.id}`);
  ctx.log(`trustedAuthors: none added. To accept your omg-plan: comments, add your uniqueName to factory.forge.azureDevOps.trustedAuthors in the user config yourself (omg factory setup --trusted-author <you> --scope user).`);
}

export function exercise(ctx) {
  const { o } = ctx;
  const m = requireManifest(ctx);
  const cwd = repoDirOf(m);
  const results = [];
  const step = (what, res) => results.push({ what, ok: res.status === 0 });
  const check = ctx.omg(['factory', 'check', '--json'], { cwd, allowFail: true, placeholder: { items: [{ id: '<first runnable id>', bucket: 'runnable' }] } });
  step('omg factory check --json', check);
  step('omg factory board --json', ctx.omg(['factory', 'board', '--json'], { cwd, allowFail: true, placeholder: {} }));
  const first = firstRunnable(check.json);
  if (!first) results.push({ what: 'a runnable work item', ok: false });
  else {
    step(`omg factory run ${first} --dry-run`, ctx.omg(['factory', 'run', first, '--dry-run'], { cwd, allowFail: true }));
    if (o.withLanes) {
      const loaded = o.dryRun || !ctx.runLimits ? undefined : ctx.runLimits(cwd);
      ctx.log(`Copilot spend for this run is capped by factory.run: ${loaded ? JSON.stringify(loaded.limits) : '(the limits omg factory run resolves)'}`);
      const run = ctx.omg(['factory', 'run', first], { cwd, allowFail: true });
      step(`omg factory run ${first}`, run);
      step('omg factory poll --once --json', ctx.omg(['factory', 'poll', '--once', '--json'], { cwd, allowFail: true, placeholder: {} }));
      const recordedDir = join(m.runDir, 'recorded');
      const recorded = o.dryRun || !existsSync(recordedDir) ? [] : readdirSync(recordedDir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(recordedDir, n), 'utf8')));
      if (!o.dryRun) results.push(...exerciseAssertions(recorded, `${run.stdout}\n${run.stderr}`, first));
    } else ctx.log('no lanes: pass --with-lanes to run the factory for real (spends Copilot credits)');
  }
  return report(ctx, 'exercise', results);
}

function report(ctx, phase, results) {
  if (ctx.o.dryRun) return results;
  for (const r of results) ctx.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.what}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(`${phase}: ${failed.length} of ${results.length} checks failed`);
  return results;
}

/** Poll `az pipelines runs list` until the build of `sha` completes (every 30 s, at most 20 min). */
function waitForBuild(ctx, m, sha) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const runs = ctx.az(['pipelines', 'runs', 'list', '--branch', 'main', '--top', '1', '--pipeline-ids', String(m.pipeline.id), '--project', m.project.name, '--org', orgOf(m)], {
      placeholder: [{ id: '<buildId>', sourceVersion: sha, status: 'completed', result: 'failed' }],
    }).json;
    const run = Array.isArray(runs) ? runs[0] : undefined;
    if (run && run.sourceVersion === sha && run.status === 'completed') return run;
    ctx.log(`waiting for the CI build of ${sha.slice(0, 12)} (${run ? run.status : 'not queued yet'})`);
    ctx.sleep(30_000);
  }
  throw new Error(`the CI build of ${sha} did not complete in 20 minutes; is an agent online in the pool?`);
}

export function healDrill(ctx) {
  const { o } = ctx;
  const m = requireManifest(ctx);
  const cwd = repoDirOf(m);
  const git = (...args) => ctx.git(['-C', cwd, ...args]);
  // main carries a blocking build policy, which refuses direct pushes without
  // bypass permission; the drill switches it off around each push only.
  // https://learn.microsoft.com/en-us/cli/azure/repos/policy/build?view=azure-cli-latest#az-repos-policy-build-update
  const pushWithPolicyOff = () => {
    const policy = (enabled) => ctx.az(['repos', 'policy', 'build', 'update', '--id', String(m.policy.id), '--enabled', enabled, '--project', m.project.name, '--org', orgOf(m)], { placeholder: { id: m.policy.id } });
    policy('false');
    try {
      git('push', 'origin', 'main');
    } finally {
      policy('true');
    }
  };
  ctx.write(join(cwd, DRILL_TEST), DRILL_SOURCE);
  git('add', DRILL_TEST);
  git('commit', '-m', 'test: heal drill, a failing test on purpose (omg live acceptance)');
  pushWithPolicyOff();
  const sha = ctx.git(['-C', cwd, 'rev-parse', 'HEAD'], { placeholder: '<drill sha>' }).stdout.trim();
  const results = [];
  try {
    const build = waitForBuild(ctx, m, sha);
    results.push({ what: `CI build ${build.id} of the drill commit failed`, ok: build.result === 'failed' });
    const step = (what, res) => results.push({ what, ok: res.status === 0 });
    step('omg factory heal scan --dry-run --json', ctx.omg(['factory', 'heal', 'scan', '--dry-run', '--json'], { cwd, allowFail: true, placeholder: {} }));
    const scan = ctx.omg(['factory', 'heal', 'scan', '--json'], { cwd, allowFail: true, placeholder: { entries: [{ sig8: '<sig8>' }] } });
    step('omg factory heal scan --json', scan);
    const sig8 = o.dryRun ? '<sig8>' : firstSig8(scan.json);
    if (!sig8) results.push({ what: 'heal scan classified the red build', ok: false });
    else {
      step(`omg factory heal run ${sig8} --dry-run`, ctx.omg(['factory', 'heal', 'run', sig8, '--dry-run'], { cwd, allowFail: true }));
      // approve needs the debugger lane's diagnosis, so only a real heal run (Copilot credits) leads to it.
      if (o.withLanes) {
        const run = ctx.omg(['factory', 'heal', 'run', sig8], { cwd, allowFail: true });
        step(`omg factory heal run ${sig8}`, run);
        if (run.status === 0) step(`omg factory heal approve ${sig8}`, ctx.omg(['factory', 'heal', 'approve', sig8], { cwd, allowFail: true }));
      }
    }
  } finally {
    git('revert', '--no-edit', sha);
    pushWithPolicyOff();
  }
  return report(ctx, 'heal-drill', results);
}

export function captureFixtures(ctx) {
  const m = requireManifest(ctx);
  const ids = Object.values(m.workItems ?? {}).filter((id) => /^\d+$/.test(String(id)));
  ctx.node('ado-capture.mjs', [
    '--org', orgOf(m), '--project', m.project.name, '--repo', m.repo.name, '--moment', `acceptance-${runIdAt(ctx.now()).slice(RUN_PREFIX.length)}`,
    '--out', join(m.runDir, 'capture'), ...(ids.length ? ['--work-items', ids.join(',')] : []),
  ]);
  const recorded = join(m.runDir, 'recorded');
  if (!ctx.o.dryRun && !existsSync(recorded)) return ctx.log(`no OMC recording under ${recorded} yet (run exercise first); skipping the drift report`);
  const diff = ctx.node('ado-fixture-diff.mjs', [recorded], { allowFail: true });
  ctx.log(diff.stdout.trim());
}

/**
 * Refuses when `<home>/<runId>` or its `repo/` is a symlink, a junction or
 * any other reparse point: the clone's real path must be the one under the
 * real `home`.
 */
export function assertNoLink(home, runId) {
  const runDir = join(home, runId);
  const repoDir = join(runDir, 'repo');
  for (const p of [runDir, repoDir]) if (lstatSync(p).isSymbolicLink()) throw new Error(`refusing to remove ${repoDir}: ${p} is a link`);
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const expected = join(realpathSync.native(home), runId, 'repo');
  if (fold(realpathSync.native(repoDir)) !== fold(expected)) throw new Error(`refusing to remove ${repoDir}: it resolves to ${realpathSync.native(repoDir)}, not ${expected}`);
}

export function cleanup(ctx) {
  const { o } = ctx;
  // parseAcceptanceArgs requires --org for cleanup and requireManifest refuses a manifest of another org.
  const m = requireManifest(ctx);
  const id = assertCleanupAllowed(m, { requestedId: o.projectId });
  // Only this run's clone, and never through a link: a symlink or junction at <home>/<runId> or its repo/ points at what is not ours.
  const repoDir = repoDirOf(m);
  if (resolve(m.runDir) !== resolve(o.home, m.runId)) throw new Error(`refusing to remove ${repoDir}: the manifest's run directory is not ${join(o.home, m.runId)}`);
  const removeRepo = existsSync(repoDir);
  if (removeRepo) assertNoLink(o.home, m.runId);
  const shown = ctx.az(['devops', 'project', 'show', '--project', id, '--org', orgOf(m)], { placeholder: { id, name: m.project.name } }).json;
  // A show that is not JSON refuses, never skips the check.
  assertCleanupAllowed(m, { requestedId: o.projectId, shown: shown ?? null });
  ctx.az(['devops', 'project', 'delete', '--id', id, '--org', orgOf(m), '--yes']);
  m.deletedAt = ctx.now().toISOString();
  ctx.saveManifest();
  if (removeRepo) ctx.rm(repoDir);
  ctx.log(`deleted project ${m.project.name} (${id}); it is restorable for 28 days (Organization settings > Projects).`);
  ctx.log(m.trustedAuthorsAdded?.length ? `remove these trustedAuthors from your user config: ${m.trustedAuthorsAdded.join(', ')}` : 'no trustedAuthors were added by this run.');
}

const PHASE_FNS = { preflight, create, exercise, 'heal-drill': healDrill, capture: captureFixtures, cleanup };

export function runPhases(ctx) {
  for (const phase of ctx.o.phase === 'all' ? ALL_PHASES : [ctx.o.phase]) {
    ctx.log(`\n== ${phase}${ctx.o.dryRun ? ' (dry run)' : ''}`);
    PHASE_FNS[phase](ctx);
  }
  if (ctx.o.phase === 'all' && ctx.manifest) ctx.log(`\nnext: --phase heal-drill --run ${ctx.manifest.runId} (needs an agent), then --phase cleanup --org ${ctx.manifest.org} --run ${ctx.manifest.runId}`);
}

async function main() {
  let o;
  try {
    o = parseAcceptanceArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ado-acceptance: ${error.message}`);
    console.error('usage: node scripts/ado-acceptance.mjs --org https://dev.azure.com/<org> --source <clone> [--phase preflight|create|exercise|heal-drill|capture|cleanup|all] [--run <runId>] [--pool <name> | --hosted] [--with-lanes] [--dry-run]');
    process.exit(2);
  }
  const dist = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);
  let azEntry, redact, runLimits;
  try {
    const { resolveAzEntry } = await dist('forge/ado/az-binary.js');
    ({ redactAdoSecrets: redact } = await dist('forge/ado/redact.js'));
    azEntry = resolveAzEntry({
      platform: process.platform, env: process.env,
      isFile: (p) => existsSync(p) && statSync(p).isFile(), realpath: (p) => realpathSync.native(p),
      untrustedRoots: [o.home, ...(o.source ? [o.source] : [])],
    });
    const { resolveFactoryRunLimits } = await dist('factory/run/budget.js');
    const { userConfigLayers } = await dist('ship/config.js');
    const { parseJsonc } = await dist('utils/jsonc.js');
    runLimits = (repoDir) => {
      const file = join(repoDir, '.copilot', 'omg.jsonc');
      return resolveFactoryRunLimits(userConfigLayers().trustedUser, existsSync(file) ? parseJsonc(readFileSync(file, 'utf8')) : undefined);
    };
  } catch (error) {
    if (!o.dryRun) {
      console.error(`ado-acceptance: ${error.message}\n(build first: npm run build)`);
      process.exit(1);
    }
    console.log(`[dry-run] az entry unresolved (${error.message}); showing argv as plain az`);
    azEntry = { command: 'az', prefix: [], env: {} };
  }
  const ctx = createContext(o, { spawn: spawnSync, azEntry, redact, runLimits, sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) });
  try {
    runPhases(ctx);
  } catch (error) {
    console.error(`\nado-acceptance: ${error.message}`);
    if (ctx.manifest?.pending) console.error(`the manifest ${manifestPathOf(o.home, ctx.manifest.runId)} records a pending ${ctx.manifest.pending}; check the org before retrying`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
