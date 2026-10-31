#!/usr/bin/env node
/**
 * Live acceptance of the factory on Azure DevOps (ADO parity design §6). One
 * throwaway Agile project per run, named `omg-acc-<yyyymmddHHMM>` (UTC):
 *
 *   node scripts/ado-acceptance.mjs --org https://dev.azure.com/<org> --source C:/Code/ExcavatorTrek
 *     [--phase preflight|create|enqueue|exercise|heal-drill|capture|cleanup|all] [--run <runId>]
 *     [--pool <self-hosted pool> | --hosted] [--with-lanes] [--project-id <guid>] [--yes] [--dry-run]
 *
 * - `all` runs preflight, create, enqueue, exercise and capture. `heal-drill`
 *   (it needs a working agent and design PR C3) and `cleanup` run only by name.
 * - The shipyard–factory flow (2026-10-30 integration design §3): `create`
 *   makes the spec work item, `enqueue` adds its creator to the user config's
 *   `factory.forge.azureDevOps.trustedAuthors` (printed, then confirmed) and
 *   hands the BACKLOG.md tickets to `omg factory enqueue` (`--dry-run` first,
 *   then for real once the dry run is signed), and `exercise` runs
 *   `omg factory run --next --parent <spec>`. `--yes` gives both
 *   confirmations without a prompt.
 * - No PR ever reaches `completed`: the factory never merges, and exercise
 *   and heal-drill assert it with `az repos pr list --status completed`.
 * - Later phases use `--run <runId>`, or the newest manifest.
 * - The manifest `~/.omg/acceptance/<runId>.json` records every created id
 *   and is written before each create. The clone, the progress file, the OMC
 *   recording (`OMG_ADO_RECORD_DIR`: `recorded/`, and `recorded-enqueue/` for
 *   the enqueue phase) and the capture live in
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
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isatty } from 'node:tty';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { backlogToTicketFile, inlineHtml } from './lib/backlog-to-workitems.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RUN_PREFIX = 'omg-acc-';
const RUN_ID = /^omg-acc-\d{12}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PHASES = ['preflight', 'create', 'enqueue', 'exercise', 'heal-drill', 'capture', 'cleanup'];
export const ALL_PHASES = ['preflight', 'create', 'enqueue', 'exercise', 'capture'];
/** The spec work item's type: a Feature is never in the intake (check buckets it needs-split). */
export const SPEC_TYPE = 'Feature';
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
  const o = { phase: 'all', withLanes: false, dryRun: false, yes: false, home, pool: { kind: 'self-hosted', name: DEFAULT_POOL } };
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
    else if (flag === '--yes') o.yes = true;
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

export const firstSig8 = (scanJson) => findDeep(scanJson, (o) => (typeof o.sig8 === 'string' && /^[0-9a-f]{8}$/.test(o.sig8) ? o.sig8 : undefined));

/**
 * The design's `exercise` assertions over the OMC recording and the run's output.
 * record.ts keeps one file per route + parameters key, so a repeated call
 * leaves only its last answer: the PR status and PR PATCH checks see the last
 * call of each key and are best-effort. noCompletedPr (az repos pr list) is
 * the authoritative never-merged check.
 */
export function exerciseAssertions(recorded, runOutput, itemId) {
  const ok = (f) => f.exitCode === undefined || f.exitCode === 0;
  const of = (route) => recorded.filter((f) => f.route === route && ok(f));
  const setsState = (f) => Array.isArray(f.requestBody) && f.requestBody.some((op) => op?.path === '/fields/System.State');
  const prStatuses = of('git.pullRequests.GET').flatMap((f) => (Array.isArray(f.stdout?.value) ? f.stdout.value : [f.stdout])).map((p) => p?.status).filter(Boolean);
  return [
    { what: 'a draft PR exists, linked to the work item', ok: of('git.pullRequests.POST').some((f) => f.requestBody?.isDraft === true && (f.requestBody?.workItemRefs ?? []).some((r) => String(r.id) === String(itemId))) },
    { what: 'gates are computed from policy evaluations', ok: of('policy.evaluations.GET').length > 0 },
    { what: 'the run parks at awaiting-human: merge', ok: /awaiting-human:?\s*merge/i.test(runOutput) },
    { what: 'the PR is still active and never completed', ok: prStatuses.length > 0 && prStatuses.every((s) => s !== 'completed') },
    { what: 'no PR PATCH other than {isDraft:false}', ok: recorded.filter((f) => f.route === 'git.pullRequests.PATCH').every((f) => JSON.stringify(f.requestBody) === '{"isDraft":false}') },
    { what: `progress moved #${itemId} (a System.State PATCH)`, ok: of('wit.workItems.PATCH').some((f) => String(f.routeParameters?.id) === String(itemId) && setsState(f)) },
  ];
}

/**
 * `enqueue`'s assertions: the dry run plans every ticket of the file, the
 * real run gives each one an id and marks the runnable ones, and a second
 * dry run finds every ticket unchanged (idempotent by shipyard-key).
 */
export function enqueueAssertions(file, dry, real, again) {
  const keys = file.tickets.map((t) => t.key);
  const rows = (json) => new Map((Array.isArray(json?.items) ? json.items : []).map((r) => [r.key, r]));
  const planned = rows(dry);
  const done = rows(real);
  const rerun = rows(again);
  return [
    { what: `enqueue --dry-run plans all ${keys.length} tickets`, ok: dry?.ok === true && dry?.dryRun === true && keys.every((k) => planned.has(k)) },
    { what: 'enqueue gives every ticket a work item id', ok: real?.ok === true && keys.every((k) => Number.isInteger(done.get(k)?.id) && ['created', 'updated', 'unchanged'].includes(done.get(k)?.action)) },
    { what: 'the mark step marked the runnable tickets', ok: Array.isArray(real?.mark?.marked) && real.mark.marked.length + (real.mark.alreadyMarked?.length ?? 0) > 0 && (real.mark.failed?.length ?? 0) === 0 },
    { what: 'an enqueue re-run (--dry-run) finds every ticket unchanged', ok: keys.every((k) => rerun.get(k)?.action === 'unchanged') },
  ];
}

/**
 * `omg factory check --parent <spec>` against the enqueued tickets
 * (`{ key: { id, blockedBy: [keys] } }`): every ticket is a child of the spec,
 * a ticket with an open predecessor is blocked by exactly that one
 * (`depends-on:#n,...`), and `picked` (run --next) was runnable.
 */
export function orderingAssertions(checkJson, tickets, picked) {
  const rows = new Map((Array.isArray(checkJson?.items) ? checkJson.items : []).map((r) => [String(r.id), r]));
  const all = Object.values(tickets);
  const waiting = all.filter((t) => t.blockedBy.length > 0);
  const blockedBy = (t) => {
    const r = rows.get(String(t.id));
    const named = r?.bucket === 'blocked' && typeof r.reasons?.[0] === 'string' && r.reasons[0].startsWith('depends-on:') ? r.reasons[0].slice('depends-on:'.length).split(',') : [];
    return t.blockedBy.every((k) => tickets[k] && named.includes(`#${tickets[k].id}`));
  };
  const results = [
    { what: `check --parent lists all ${all.length} tickets`, ok: all.length > 0 && all.every((t) => rows.has(String(t.id))) },
    { what: `the ${waiting.length} ticket(s) with a predecessor are blocked by it (depends-on)`, ok: waiting.every(blockedBy) },
  ];
  if (picked !== undefined) {
    const r = rows.get(String(picked));
    results.push({ what: `run --next picked #${picked}, a runnable ticket without an open predecessor`, ok: r?.bucket === 'runnable' && !waiting.some((t) => String(t.id) === String(picked)) });
  }
  return results;
}

/**
 * The tracker write-back of a run parked at the human merge (integration
 * design §3.6): the item's merge gate comment, the spec's rollup line for
 * the item, and no edit of the spec work item.
 */
export function outcomeAssertions(recorded, specId, itemId) {
  const ok = (f) => f.exitCode === undefined || f.exitCode === 0;
  const comments = (id) => recorded.filter((f) => f.route === 'wit.comments.POST' && ok(f) && String(f.routeParameters?.workItemId) === String(id)).map((f) => String(f.requestBody?.text ?? ''));
  return [
    { what: `#${itemId} got the merge gate comment`, ok: comments(itemId).some((t) => t.includes('awaiting a human: **merge**')) },
    { what: `the spec #${specId} got the rollup line "- #${itemId} ready to merge"`, ok: comments(specId).some((t) => t.includes(`- #${itemId} ready to merge:`)) },
    { what: `the spec #${specId} itself is never edited`, ok: !recorded.some((f) => f.route === 'wit.workItems.PATCH' && String(f.routeParameters?.id) === String(specId)) },
  ];
}

/**
 * The factory never merges: no PR of the run's repository is `completed`.
 * https://learn.microsoft.com/en-us/cli/azure/repos/pr?view=azure-cli-latest#az-repos-pr-list
 */
function noCompletedPr(ctx, m) {
  const res = ctx.az(['repos', 'pr', 'list', '--status', 'completed', '--repository', m.repo.name, '--project', m.project.name, '--org', orgOf(m)], { placeholder: [] });
  const completed = Array.isArray(res.json) ? res.json.map((p) => p?.pullRequestId) : undefined;
  return { what: `no PR of the run reached completed (the factory never merges)${completed?.length ? `; completed: ${completed.join(', ')}` : ''}`, ok: Array.isArray(completed) && completed.length === 0 };
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
 * (spawnSync's shape), azEntry, log, now, sleep(ms), redact, env, runLimits,
 * confirm(question) → boolean (`--yes` answers yes; a dry run never asks),
 * userConfig `{ path, trustedAuthors() }` (the user config at its default
 * location, read only).
 */
export function createContext(o, deps) {
  const log = deps.log ?? console.log;
  const redact = deps.redact ?? ((s) => s);
  const userConfig = deps.userConfig ?? { path: '<user config>', trustedAuthors: () => [] };
  const ctx = { o, log, manifest: undefined, now: deps.now ?? (() => new Date()), sleep: deps.sleep ?? (() => {}), env: deps.env ?? process.env, runLimits: deps.runLimits, userConfig };
  ctx.confirm = (question) => {
    if (o.dryRun) return (log(`[dry-run] would ask: ${question}`), true);
    if (o.yes) return (log(`${question} yes (--yes)`), true);
    return Boolean(deps.confirm?.(question));
  };
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
    pipeline: { id: '<definitionId>' }, policy: { id: '<policyId>' }, spec: { id: '<specId>', createdBy: '<spec creator uniqueName>' }, tickets: {}, trustedAuthorsAdded: [],
  };
  return ctx.manifest;
}

const orgOf = (m) => m.org;
const repoDirOf = (m) => join(m.runDir, 'repo');
/**
 * enqueue's own recording: its relation and mark PATCHes must not reach
 * `recorded/`, where exercise looks for the progress PATCH.
 */
const enqueueRecordEnv = (m) => ({ OMG_ADO_RECORD_DIR: join(m.runDir, 'recorded-enqueue') });

/** `omg factory setup` for the run's repository; `extra` goes before the confirmation flags. */
const setupArgs = (m, extra = []) => [
  'factory', 'setup', '--forge', 'azure-devops', '--org', m.org.replace(/^https:\/\/dev\.azure\.com\//, ''), '--project', m.project.name, '--repo', m.repo.name,
  '--intake', `area-tag:${m.project.name}#factory`, '--progress', join(m.runDir, 'progress.json'), ...extra, '--yes', '--json',
];

/** The spec work item of a run made before the enqueue flow is missing: such a run cannot take the later phases. */
function requireSpec(m) {
  if (m.spec?.id === undefined || m.spec?.id === null) throw new Error(`run ${m.runId} has no spec work item (it predates the enqueue flow); start a new run with --phase create`);
  return m.spec;
}

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
  ctx.log('User config: enqueue adds the spec creator to factory.forge.azureDevOps.trustedAuthors after it prints the change and you confirm (or --yes); cleanup lists it and never removes it.');
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
    project: { name: runId }, repo: { name: runId }, pipeline: null, policy: null, spec: null, tickets: {}, pending: null, trustedAuthorsAdded: [],
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

  // The spec (launch Phase 2): the parent the enqueued tickets link to. No factory tag, so it is not intake.
  pending('spec');
  const spec = ctx.az([
    'boards', 'work-item', 'create', '--type', SPEC_TYPE, '--title', `${runId} spec: the BACKLOG.md tickets`,
    '--description', `<p>${inlineHtml('omg live acceptance spec: the `BACKLOG.md` tickets of the test repository, enqueued as its children with `omg factory enqueue`.')}</p>`, ...scope,
  ], { placeholder: { id: '<specId>', fields: { 'System.CreatedBy': { uniqueName: '<spec creator uniqueName>' } } } });
  const createdBy = spec.json?.fields?.['System.CreatedBy'];
  m.spec = { id: spec.json?.id, createdBy: typeof createdBy === 'string' ? createdBy : createdBy?.uniqueName };
  if (m.spec.id === undefined) throw new Error('created the spec work item but could not read its id');
  pending(null);

  ctx.write(join(runDir, 'progress.json'), `${JSON.stringify(AGILE_PROGRESS, null, 2)}\n`);
  ctx.omg(setupArgs(m), { cwd: repoDir });
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
  ctx.log(`created ${runId}: project ${m.project.id}, spec work item ${m.spec.id} (created by ${m.spec.createdBy ?? 'unknown'}), pipeline ${m.pipeline.id}`);
  ctx.log('trustedAuthors: none added yet; the enqueue phase asks before it adds the spec creator to the user config.');
}

/**
 * Trust the spec's creator: on Azure DevOps enqueue (and check) trust only
 * the uniqueNames in the user config's factory.forge.azureDevOps.trustedAuthors.
 * The write is printed and confirmed first. The manifest records the name as
 * `trustPending` before the write and moves it to `trustedAuthorsAdded` once
 * setup succeeds, so cleanup can list it either way.
 */
function trustSpecCreator(ctx, m) {
  const author = requireSpec(m).createdBy;
  if (typeof author !== 'string' || !author) throw new Error(`the manifest records no creator of spec #${m.spec.id}`);
  const path = ctx.userConfig.path;
  const current = ctx.userConfig.trustedAuthors();
  if (current.some((a) => a.toLowerCase() === author.toLowerCase())) return ctx.log(`ok    ${author} is already in factory.forge.azureDevOps.trustedAuthors (${path})`);
  const next = [...current, author];
  ctx.log([
    `user-scope write: ${path}`,
    `  factory.forge.azureDevOps.trustedAuthors: ${JSON.stringify(current)} -> ${JSON.stringify(next)}`,
    `  ${author} created spec #${m.spec.id}; enqueue trusts only these uniqueNames. Cleanup lists what this run added; it never removes it.`,
  ].join('\n'));
  if (!ctx.confirm(`Add ${author} to factory.forge.azureDevOps.trustedAuthors in ${path}?`)) {
    throw new Error(`not confirmed: ${path} is unchanged. Add ${author} there yourself, or rerun with --yes`);
  }
  // Pending until setup succeeds: a failed setup may or may not have written the user config.
  m.trustPending = author;
  ctx.saveManifest();
  ctx.omg(setupArgs(m, ['--trusted-author', next.join(','), '--scope', 'user']), { cwd: repoDirOf(m), env: enqueueRecordEnv(m) });
  m.trustedAuthorsAdded = [...new Set([...(m.trustedAuthorsAdded ?? []), author])];
  m.trustPending = null;
  ctx.saveManifest();
}

/** One `omg factory enqueue` call; a refusal (exit 2) or failure throws with enqueue's own error. */
function enqueueCall(ctx, m, file, extra, placeholder) {
  const res = ctx.omg(['factory', 'enqueue', '--spec', String(m.spec.id), '--file', file, ...extra, '--json'], { cwd: repoDirOf(m), allowFail: true, placeholder, env: enqueueRecordEnv(m) });
  if (res.status !== 0) {
    // A failed real enqueue exits 1 with { ok: false, warnings } and no error field.
    const ids = (Array.isArray(res.json?.items) ? res.json.items : []).filter((r) => Number.isInteger(r?.id));
    if (ids.length && !extra.includes('--dry-run')) {
      m.enqueuedBeforeFailure = Object.fromEntries(ids.map((r) => [r.key, r.id]));
      ctx.saveManifest();
    }
    const cause = res.json?.error ?? (Array.isArray(res.json?.warnings) && res.json.warnings.length ? res.json.warnings.join('; ') : res.stderr.trim().slice(0, 2000));
    const rerun = extra.includes('--dry-run') ? '' : `${ids.length ? `; the manifest records ids ${ids.map((r) => `#${r.id}`).join(', ')}` : ''}; rerunning --phase enqueue is idempotent (enqueue matches tickets by shipyard-key)`;
    throw new Error(`omg factory enqueue${extra.map((a) => ` ${a}`).join('')} exited ${res.status}: ${cause}${rerun}`);
  }
  return res.json;
}

/**
 * launch's hand-off (integration design §3.2): the BACKLOG.md tickets as a
 * ticket file of the spec, `enqueue --dry-run`, the signature (the dry run
 * is shown, then confirmed), the real enqueue, and a second dry run that
 * must find every ticket unchanged.
 */
export function enqueue(ctx) {
  const { o } = ctx;
  const m = requireManifest(ctx);
  requireSpec(m);
  trustSpecCreator(ctx, m);
  // A dry run has no clone; it reads the same file from the source (read-only).
  const backlog = join(o.dryRun ? o.source ?? m.source : repoDirOf(m), 'BACKLOG.md');
  if (o.dryRun && !existsSync(backlog)) ctx.log(`[dry-run] no ${backlog}: pass --source to preview the ticket file (the real run reads the clone's BACKLOG.md)`);
  const { file, unknown } = o.dryRun && !existsSync(backlog) ? { file: { schemaVersion: 1, spec: m.spec.id, tickets: [] }, unknown: [] } : backlogToTicketFile(ctx.read(backlog), Number(m.spec.id));
  for (const u of unknown) ctx.log(`note: ${u}`);
  const ticketFile = join(m.runDir, 'tickets.json');
  ctx.write(ticketFile, `${JSON.stringify(file, null, 2)}\n`);

  const dry = enqueueCall(ctx, m, ticketFile, ['--dry-run'], { ok: true, dryRun: true, items: [] });
  if (!o.dryRun) for (const r of dry?.items ?? []) ctx.log(`plan  ${r.key} ${r.id === null ? '(new)' : `#${r.id}`} ${r.action}${r.planned?.links?.length ? ` links ${r.planned.links.join(', ')}` : ''}`);
  if (!ctx.confirm(`Signature (launch C3): enqueue these ${file.tickets.length} tickets as children of spec #${m.spec.id}?`)) throw new Error('enqueue not signed: nothing written');
  m.pending = 'enqueue';
  ctx.saveManifest();
  const real = enqueueCall(ctx, m, ticketFile, [], { ok: true, dryRun: false, items: [], mark: { marked: [] } });
  const byKey = new Map(file.tickets.map((t) => [t.key, t]));
  m.tickets = Object.fromEntries((real?.items ?? []).filter((r) => byKey.has(r.key)).map((r) => [r.key, { id: r.id, blockedBy: byKey.get(r.key).blockedBy }]));
  m.pending = null;
  ctx.saveManifest();
  const again = enqueueCall(ctx, m, ticketFile, ['--dry-run'], { ok: true, dryRun: true, items: [] });
  return report(ctx, 'enqueue', enqueueAssertions(file, dry, real, again));
}

export function exercise(ctx) {
  const { o } = ctx;
  const m = requireManifest(ctx);
  const cwd = repoDirOf(m);
  const results = [];
  const step = (what, res) => results.push({ what, ok: res.status === 0 });
  const spec = String(requireSpec(m).id);
  const tickets = m.tickets ?? {};
  if (!o.dryRun && Object.keys(tickets).length === 0) throw new Error(`run ${m.runId} has no enqueued tickets; run --phase enqueue first`);
  step('omg factory check --json', ctx.omg(['factory', 'check', '--json'], { cwd, allowFail: true, placeholder: { items: [] } }));
  const checkParent = () => ctx.omg(['factory', 'check', '--parent', spec, '--json'], { cwd, allowFail: true, placeholder: { items: [] } });
  const before = checkParent();
  step(`omg factory check --parent ${spec} --json`, before);
  step('omg factory board --json', ctx.omg(['factory', 'board', '--json'], { cwd, allowFail: true, placeholder: {} }));
  const next = ['factory', 'run', '--next', '--parent', spec];
  const dry = ctx.omg([...next, '--dry-run', '--json'], { cwd, allowFail: true, placeholder: { next: '<next runnable id>' } });
  step(`omg factory run --next --parent ${spec} --dry-run`, dry);
  const picked = dry.json?.next ?? undefined;
  if (!o.dryRun) results.push(...orderingAssertions(before.json, tickets, picked ?? null));
  if (o.withLanes) {
    const loaded = o.dryRun || !ctx.runLimits ? undefined : ctx.runLimits(cwd);
    ctx.log(`Copilot spend for this run is capped by factory.run: ${loaded ? JSON.stringify(loaded.limits) : '(the limits omg factory run resolves)'}`);
    const run = ctx.omg([...next, '--json'], { cwd, allowFail: true });
    step(`omg factory run --next --parent ${spec}`, run);
    const ran = run.json?.next;
    step('omg factory poll --once --json', ctx.omg(['factory', 'poll', '--once', '--json'], { cwd, allowFail: true, placeholder: {} }));
    const after = checkParent();
    step(`omg factory check --parent ${spec} --json (after the run)`, after);
    const recordedDir = join(m.runDir, 'recorded');
    const recorded = o.dryRun || !existsSync(recordedDir) ? [] : readdirSync(recordedDir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(recordedDir, n), 'utf8')));
    if (!o.dryRun) {
      results.push({ what: `the real run took the dry run's pick #${picked}`, ok: ran !== undefined && String(ran) === String(picked) });
      results.push(...exerciseAssertions(recorded, `${run.stdout}\n${run.stderr}`, ran), ...outcomeAssertions(recorded, spec, ran));
      const row = (Array.isArray(after.json?.items) ? after.json.items : []).find((r) => String(r.id) === String(ran));
      results.push({ what: `#${ran} is no longer runnable while its PR waits for the human merge`, ok: row?.bucket === 'blocked' });
      results.push(...orderingAssertions(after.json, tickets));
    }
  } else ctx.log('no lanes: pass --with-lanes to run the factory for real (spends Copilot credits)');
  results.push(noCompletedPr(ctx, m));
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
    results.push(noCompletedPr(ctx, m));
  } finally {
    git('revert', '--no-edit', sha);
    pushWithPolicyOff();
  }
  return report(ctx, 'heal-drill', results);
}

export function captureFixtures(ctx) {
  const m = requireManifest(ctx);
  // The spec and its enqueued tickets (`workItems`: runs made before the enqueue flow).
  const ids = [m.spec?.id, ...Object.values(m.tickets ?? {}).map((t) => t.id), ...Object.values(m.workItems ?? {})].filter((id) => /^\d+$/.test(String(id)));
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
  ctx.log(m.trustedAuthorsAdded?.length
    ? `this run added ${m.trustedAuthorsAdded.join(', ')} to factory.forge.azureDevOps.trustedAuthors in ${ctx.userConfig.path}; cleanup never edits the user config, so remove them there yourself if they should not stay trusted.`
    : 'no trustedAuthors were added by this run.');
  if (m.trustPending) ctx.log(`${m.trustPending} may have been added to factory.forge.azureDevOps.trustedAuthors in ${ctx.userConfig.path}: the setup that adds it did not finish; check there yourself.`);
}

const PHASE_FNS = { preflight, create, enqueue, exercise, 'heal-drill': healDrill, capture: captureFixtures, cleanup };

export function runPhases(ctx) {
  for (const phase of ctx.o.phase === 'all' ? ALL_PHASES : [ctx.o.phase]) {
    ctx.log(`\n== ${phase}${ctx.o.dryRun ? ' (dry run)' : ''}`);
    PHASE_FNS[phase](ctx);
  }
  if (ctx.o.phase === 'all' && ctx.manifest) ctx.log(`\nnext: --phase heal-drill --run ${ctx.manifest.runId} (needs an agent), then --phase cleanup --org ${ctx.manifest.org} --run ${ctx.manifest.runId}`);
}

/**
 * A y/N question on the terminal; no terminal or a read error is a no, with
 * the reason printed. isatty(0), never process.stdin.isTTY: touching
 * process.stdin makes fd 0 non-blocking on Linux and macOS, and readSync(0)
 * then throws EAGAIN. `io` is for tests.
 */
export function confirmOnTty(question, io = {}) {
  const { isTerminal = () => isatty(0), read = (buf) => readSync(0, buf, 0, buf.length, null), out = (s) => process.stdout.write(s) } = io;
  if (!isTerminal()) {
    out(`${question} no: stdin is not a terminal (pass --yes to confirm)\n`);
    return false;
  }
  out(`${question} [y/N] `);
  const buf = Buffer.alloc(256);
  let answer = '';
  try {
    while (!answer.includes('\n')) {
      const n = read(buf);
      if (n === 0) break;
      answer += buf.toString('utf8', 0, n);
    }
  } catch (error) {
    out(`no: could not read the answer (${error?.code ?? error?.message ?? error}); pass --yes to confirm\n`);
    return false;
  }
  return /^\s*y(es)?\s*$/i.test(answer);
}

async function main() {
  let o;
  try {
    o = parseAcceptanceArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ado-acceptance: ${error.message}`);
    console.error('usage: node scripts/ado-acceptance.mjs --org https://dev.azure.com/<org> --source <clone> [--phase preflight|create|enqueue|exercise|heal-drill|capture|cleanup|all] [--run <runId>] [--pool <name> | --hosted] [--with-lanes] [--yes] [--dry-run]');
    process.exit(2);
  }
  const dist = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);
  let azEntry, redact, runLimits, userConfig;
  try {
    const { resolveAzEntry } = await dist('forge/ado/az-binary.js');
    ({ redactAdoSecrets: redact } = await dist('forge/ado/redact.js'));
    azEntry = resolveAzEntry({
      platform: process.platform, env: process.env,
      isFile: (p) => existsSync(p) && statSync(p).isFile(), realpath: (p) => realpathSync.native(p),
      untrustedRoots: [o.home, ...(o.source ? [o.source] : [])],
    });
    const { resolveFactoryRunLimits } = await dist('factory/run/budget.js');
    const { trustedUserConfigPath, userConfigLayers } = await dist('ship/config.js');
    const { parseJsonc } = await dist('utils/jsonc.js');
    runLimits = (repoDir) => {
      const file = join(repoDir, '.copilot', 'omg.jsonc');
      return resolveFactoryRunLimits(userConfigLayers().trustedUser, existsSync(file) ? parseJsonc(readFileSync(file, 'utf8')) : undefined);
    };
    // The only layer the factory reads trustedAuthors from (src/forge/config.ts).
    userConfig = {
      path: trustedUserConfigPath(),
      trustedAuthors: () => {
        const list = userConfigLayers().trustedUser?.factory?.forge?.azureDevOps?.trustedAuthors;
        return Array.isArray(list) ? list.filter((a) => typeof a === 'string') : [];
      },
    };
  } catch (error) {
    if (!o.dryRun) {
      console.error(`ado-acceptance: ${error.message}\n(build first: npm run build)`);
      process.exit(1);
    }
    console.log(`[dry-run] az entry unresolved (${error.message}); showing argv as plain az`);
    azEntry = { command: 'az', prefix: [], env: {} };
  }
  const ctx = createContext(o, { spawn: spawnSync, azEntry, redact, runLimits, userConfig, confirm: confirmOnTty, sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) });
  try {
    runPhases(ctx);
  } catch (error) {
    console.error(`\nado-acceptance: ${error.message}`);
    if (ctx.manifest?.pending) console.error(`the manifest ${manifestPathOf(o.home, ctx.manifest.runId)} records a pending ${ctx.manifest.pending}; check the org before retrying`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
