#!/usr/bin/env node
/**
 * Capture live Azure DevOps answers as fixtures (ADO parity design §6
 * "Capturing fixtures on another computer"). Standalone: it needs node and
 * the Azure CLI (with the azure-devops extension) and nothing from an OMC
 * build, so it runs on any computer that can reach the org. GETs only.
 *
 *   node scripts/ado-capture.mjs --org https://dev.azure.com/<org> --project <project> --repo <repo>
 *     [--moment <label>] [--work-items 12,13] [--prs 1] [--builds 7,8] [--out <dir>] [--dry-run]
 *
 * Run it at each moment the design names (`--moment draft`, `ready`,
 * `second-push`, `red-build`, ...). Each run writes `<out>/<moment>/`:
 * one fixture per call in the format of src/forge/ado/__tests__/fixtures.ts
 * (`route`, `routeParameters`, `queryParameters`, `stdout`, provenance
 * `recorded live-capture <date> moment <label>`), the text form of failed
 * build logs under `logs-text/`, the resource table and the az environment.
 * `<out>/manifest.json` lists every file with its SHA-256.
 *
 * Bring the directory back and import it with
 * `node scripts/ado-fixture-import.mjs <out>`, which scrubs it again.
 *
 * Without `--work-items`, `--prs` or `--builds` it discovers: every PR of the
 * repo, the newest builds of main and of each PR merge ref, and the timeline
 * and failed-task logs of the failed ones. Work items are only read by id.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The routes this script reads, pinned as in src/forge/ado/routes.ts (a test
 * holds the shared ids equal). `build.definitions.GET` and
 * `git.pullRequestThreads.GET` are the design's new routes (§4); the importer
 * keeps their files aside until the route table has them.
 */
export const CAPTURE_ROUTES = Object.freeze({
  'core.projects.GET': { area: 'core', resource: 'projects', apiVersion: '7.1' },
  'git.repositories.GET': { area: 'git', resource: 'repositories', apiVersion: '7.1' },
  'wit.workItems.GET': { area: 'wit', resource: 'workItems', apiVersion: '7.1' },
  'wit.comments.GET': { area: 'wit', resource: 'comments', apiVersion: '7.1-preview.4' },
  'git.pullRequests.GET': { area: 'git', resource: 'pullRequests', apiVersion: '7.1' },
  'git.pullRequestIterations.GET': { area: 'git', resource: 'pullRequestIterations', apiVersion: '7.1' },
  'git.pullRequestStatuses.GET': { area: 'git', resource: 'pullRequestStatuses', apiVersion: '7.1' },
  // https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/list?view=azure-devops-rest-7.1
  'git.pullRequestThreads.GET': { area: 'git', resource: 'pullRequestThreads', apiVersion: '7.1' },
  'policy.evaluations.GET': { area: 'policy', resource: 'evaluations', apiVersion: '7.1-preview.1' },
  'build.builds.GET': { area: 'build', resource: 'builds', apiVersion: '7.1' },
  'build.timeline.GET': { area: 'build', resource: 'timeline', apiVersion: '7.1' },
  'build.logs.GET': { area: 'build', resource: 'logs', apiVersion: '7.1' },
  // https://learn.microsoft.com/en-us/rest/api/azure/devops/build/definitions/list?view=azure-devops-rest-7.1
  'build.definitions.GET': { area: 'build', resource: 'definitions', apiVersion: '7.1' },
});

/** The resource table query (design §6 item 1); diffed against routes.ts. */
export const RESOURCE_TABLE_QUERY = "[?area=='git' || area=='wit' || area=='policy' || area=='build' || area=='work']";

/**
 * Mirror of redactAdoSecrets (src/forge/ado/redact.ts; a test holds them
 * equal), so nothing written here carries a PAT even before the import
 * scrubs it again with the real one.
 */
export function redactLocal(text) {
  return text
    .replace(/(\bAuthorization['"]?\s*[:=]\s*['"]?)[^\r\n'"]+/gi, '$1***')
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{6,}/gi, '$1 ***')
    .replace(/(?<![A-Za-z0-9])(?=[A-Za-z0-9]{84}(?![A-Za-z0-9]))[A-Za-z0-9]*AZDO[A-Za-z0-9]*/g, '***')
    .replace(/(?<![A-Za-z0-9])[a-z2-7]{52}(?![A-Za-z0-9])/g, '***');
}

/**
 * The only az argv this script runs: `--version`, `extension show`, and
 * `devops invoke` without a method other than GET and without `--in-file`.
 * Throws on anything else, so a write cannot be built by mistake.
 */
export function assertReadOnly(azArgs) {
  const [a, b] = azArgs;
  if (azArgs.length === 1 && a === '--version') return;
  if (a === 'extension' && b === 'show') return;
  if (a !== 'devops' || b !== 'invoke') throw new Error(`ado-capture runs GETs only; refused az ${azArgs.join(' ')}`);
  // Every spelling argparse accepts: `--flag value`, `--flag=value` and a prefix abbreviation.
  const spells = (name, flag) => name === flag || (name.length > 2 && flag.startsWith(name));
  azArgs.forEach((arg, i) => {
    if (typeof arg !== 'string' || !arg.startsWith('--')) return;
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (spells(name, '--in-file')) throw new Error(`ado-capture never sends a body (${arg})`);
    if (!spells(name, '--http-method')) return;
    const value = eq < 0 ? azArgs[i + 1] : arg.slice(eq + 1);
    if (name !== '--http-method' || String(value).toUpperCase() !== 'GET') throw new Error(`ado-capture runs GETs only; refused ${name} ${value}`);
  });
}

const kv = (o) => Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join('&');
const pairs = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`);

/** `az devops invoke` argv for one route call; `textOut` adds the text/plain log form. */
export function invokeArgs(org, routeId, routeParameters, queryParameters = {}, textOut) {
  const r = CAPTURE_ROUTES[routeId];
  if (!r) throw new Error(`unknown capture route ${routeId}`);
  const args = ['devops', 'invoke', '--org', org, '--detect', 'false', '--area', r.area, '--resource', r.resource, '--http-method', 'GET', '--api-version', r.apiVersion];
  if (Object.keys(routeParameters).length) args.push('--route-parameters', ...pairs(routeParameters));
  if (Object.keys(queryParameters).length) args.push('--query-parameters', ...pairs(queryParameters));
  if (textOut) args.push('--accept-media-type', 'text/plain', '--out-file', textOut);
  args.push('--output', 'json');
  return args;
}

/** The fixture file name record.ts uses: `<route id>.<hash of the call key>.json`. */
export function fixtureName(routeId, routeParameters, queryParameters) {
  const key = `${routeId}?route:${kv(routeParameters)}|query:${kv(queryParameters)}`;
  return `${routeId}.${createHash('sha256').update(key).digest('hex').slice(0, 10)}.json`;
}

const parseMaybe = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * How az is spawned without cmd.exe (the v5.12.1 class): on Windows the MSI
 * layout's python.exe next to az.cmd with `-IBm azure.cli`, as
 * src/forge/ado/az-binary.ts does; elsewhere the first `az` on an absolute
 * PATH entry. This machine runs no lanes, so the lane-root checks of
 * az-binary.ts do not apply.
 */
export function resolveAzStandalone(env = process.env, platform = process.platform, isFile = (p) => existsSync(p) && statSync(p).isFile()) {
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const dirs = (env[pathKey] ?? '').split(platform === 'win32' ? ';' : delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  if (platform === 'win32') {
    for (const dir of dirs.filter((d) => /^[A-Za-z]:[\\/]/.test(d) && !/node_modules/i.test(d))) {
      if (!isFile(join(dir, 'az.cmd'))) continue;
      const python = resolve(dir, '..', 'python.exe');
      if (!isFile(python)) throw new Error(`az.cmd at ${dir} has no bundled ${python}; install the Azure CLI with the MSI (https://aka.ms/installazurecliwindows)`);
      return { command: python, prefix: ['-IBm', 'azure.cli'], env: { AZ_INSTALLER: 'MSI' }, layoutDir: resolve(dir, '..') };
    }
    throw new Error('Azure CLI not found: no az.cmd on a drive-absolute PATH entry');
  }
  for (const dir of dirs.filter((d) => d.startsWith('/') && !d.split('/').includes('node_modules'))) {
    if (isFile(join(dir, 'az'))) return { command: join(dir, 'az'), prefix: [], env: {}, layoutDir: dir };
  }
  throw new Error('Azure CLI not found: no az on an absolute PATH entry');
}

export function parseCaptureArgs(argv) {
  const o = { moment: 'snapshot', workItems: [], prs: [], builds: [], dryRun: false };
  const ids = (v, flag) => {
    const list = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length === 0 || list.some((s) => !/^[1-9]\d{0,9}$/.test(s))) throw new Error(`${flag} takes comma-separated numeric ids`);
    return list;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === '--org') o.org = value().replace(/\/+$/, '');
    else if (flag === '--project') o.project = value();
    else if (flag === '--repo') o.repo = value();
    else if (flag === '--moment') o.moment = value();
    else if (flag === '--out') o.out = value();
    else if (flag === '--work-items') o.workItems = ids(value(), flag);
    else if (flag === '--prs') o.prs = ids(value(), flag);
    else if (flag === '--builds') o.builds = ids(value(), flag);
    else if (flag === '--dry-run') o.dryRun = true;
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!o.org || !/^https:\/\/(dev\.azure\.com\/[^/\s]+|[^./\s]+\.visualstudio\.com)$/i.test(o.org)) throw new Error('--org must be https://dev.azure.com/<org>');
  if (!o.project || !o.repo) throw new Error('--project and --repo are required');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(o.moment)) throw new Error('--moment must be a short label ([A-Za-z0-9._-])');
  o.out ??= `omg-ado-capture-${new Date().toISOString().slice(0, 10)}`;
  return o;
}

const list = (json) => (json && Array.isArray(json.value) ? json.value : []);

/**
 * Run one capture. `az(args)` returns `{ status, stdout, stderr }` (it is
 * only ever called with read-only argv); `write(path, text)` stores a file.
 */
export function capture(o, { az, write, now = () => new Date(), log = console.log, readText = (p) => readFileSync(p, 'utf8'), layout = () => '' }) {
  const dir = join(o.out, o.moment);
  const stamp = now().toISOString();
  const provenance = `recorded live-capture ${stamp} moment ${o.moment}`;
  const run = (args) => {
    assertReadOnly(args);
    return az(args);
  };
  const get = (routeId, routeParameters, queryParameters = {}) => {
    const args = invokeArgs(o.org, routeId, routeParameters, queryParameters);
    const res = run(args);
    const fixture = {
      provenance, route: routeId, routeParameters, queryParameters, exitCode: res.status,
      stdout: parseMaybe(redactLocal(res.stdout)), stderr: redactLocal(res.stderr), argv: args,
    };
    write(join(dir, fixtureName(routeId, routeParameters, queryParameters)), `${JSON.stringify(fixture, null, 2)}\n`);
    if (res.status !== 0) log(`  ${routeId} ${kv(routeParameters)} ${kv(queryParameters)}: exit ${res.status}`);
    return res.status === 0 ? parseMaybe(res.stdout) : undefined;
  };
  const project = { project: o.project };

  const table = run(['devops', 'invoke', '--org', o.org, '--detect', 'false', '--query', RESOURCE_TABLE_QUERY, '--output', 'json']);
  write(join(dir, 'env', 'resource-table.json'), redactLocal(table.stdout));
  write(join(dir, 'env', 'az-version.txt'), redactLocal(run(['--version']).stdout));
  write(join(dir, 'env', 'az-extension.json'), redactLocal(run(['extension', 'show', '--name', 'azure-devops', '--output', 'json']).stdout));
  write(join(dir, 'env', 'az-layout.txt'), layout());

  const projectJson = get('core.projects.GET', { projectId: o.project });
  const repoJson = get('git.repositories.GET', { project: o.project, repositoryId: o.repo });
  const projectId = projectJson?.id;
  const repoId = repoJson?.id;
  if (repoId) get('build.definitions.GET', project, { repositoryId: repoId, repositoryType: 'TfsGit', includeAllProperties: 'true' });

  for (const id of o.workItems) {
    get('wit.workItems.GET', { project: o.project, id }, { $expand: 'relations' });
    get('wit.comments.GET', { project: o.project, workItemId: id });
  }

  const repo = { project: o.project, repositoryId: o.repo };
  const prIds = o.prs.length ? o.prs : list(get('git.pullRequests.GET', repo, { 'searchCriteria.status': 'all', $top: '50' })).map((p) => String(p.pullRequestId)).filter((s) => /^\d+$/.test(s));
  const buildIds = new Set(o.builds);
  const failed = new Set();
  const takeBuilds = (json) => {
    for (const b of list(json).slice(0, 5)) {
      buildIds.add(String(b.id));
      if (b.result && b.result !== 'succeeded') failed.add(String(b.id));
    }
  };
  for (const pr of prIds) {
    const view = get('git.pullRequests.GET', { ...repo, pullRequestId: pr });
    if (view?.sourceRefName) get('git.pullRequests.GET', repo, { 'searchCriteria.sourceRefName': view.sourceRefName, 'searchCriteria.status': 'all' });
    get('git.pullRequestIterations.GET', { ...repo, pullRequestId: pr });
    get('git.pullRequestStatuses.GET', { ...repo, pullRequestId: pr });
    get('git.pullRequestThreads.GET', { ...repo, pullRequestId: pr });
    if (projectId) get('policy.evaluations.GET', project, { artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${pr}` });
    if (!o.builds.length) takeBuilds(get('build.builds.GET', project, { branchName: `refs/pull/${pr}/merge`, queryOrder: 'queueTimeDescending', $top: '5' }));
  }
  if (!o.builds.length) takeBuilds(get('build.builds.GET', project, { branchName: 'refs/heads/main', queryOrder: 'queueTimeDescending', $top: '10' }));

  for (const id of [...buildIds].sort((a, b) => Number(a) - Number(b))) {
    if (o.builds.length) get('build.builds.GET', { project: o.project, buildId: id });
    const timeline = get('build.timeline.GET', { project: o.project, buildId: id });
    if (!o.builds.length && !failed.has(id)) continue;
    const logIds = new Set((timeline?.records ?? []).filter((r) => r?.log?.id && (r.result === 'failed' || r.type === 'Job')).map((r) => String(r.log.id)));
    for (const logId of logIds) {
      const routeParameters = { project: o.project, buildId: id, logId };
      get('build.logs.GET', routeParameters);
      const textFile = join(dir, 'logs-text', `build-${id}-log-${logId}.txt`);
      write(textFile, '');
      const res = run(invokeArgs(o.org, 'build.logs.GET', routeParameters, {}, resolve(textFile)));
      if (res.status === 0 && !o.dryRun) write(textFile, redactLocal(readText(textFile)));
      else log(`  text log ${id}/${logId}: exit ${res.status}`);
    }
  }
  return { dir, prs: prIds, builds: [...buildIds] };
}

/** Every file under `dir` (but manifest.json) with its SHA-256, for `<out>/manifest.json`. */
export function hashTree(dir, base = dir) {
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) Object.assign(out, hashTree(p, base));
    else if (relative(base, p) !== 'manifest.json') out[relative(base, p).split('\\').join('/')] = createHash('sha256').update(readFileSync(p)).digest('hex');
  }
  return out;
}

function main() {
  let o;
  try {
    o = parseCaptureArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ado-capture: ${error.message}`);
    console.error('usage: node scripts/ado-capture.mjs --org https://dev.azure.com/<org> --project <p> --repo <r> [--moment <label>] [--work-items ids] [--prs ids] [--builds ids] [--out dir] [--dry-run]');
    process.exit(2);
  }
  const entry = resolveAzStandalone();
  const layout = () => {
    try {
      return readdirSync(entry.layoutDir).sort().join('\n') + `\n\nwbin:\n${readdirSync(join(entry.layoutDir, 'wbin')).sort().join('\n')}\n`;
    } catch {
      return readdirSync(entry.layoutDir).sort().join('\n');
    }
  };
  const az = (args) => {
    if (o.dryRun) {
      console.log(`[dry-run] az: ${JSON.stringify([entry.command, ...entry.prefix, ...args])}`);
      return { status: 0, stdout: '{}', stderr: '' };
    }
    const r = spawnSync(entry.command, [...entry.prefix, ...args], { encoding: 'utf8', env: { ...process.env, ...entry.env }, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
  };
  const write = (path, text) => {
    if (o.dryRun) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  };
  const result = capture(o, { az, write, layout });
  if (o.dryRun) return;
  const manifestPath = join(o.out, 'manifest.json');
  const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { moments: {} };
  const manifest = {
    tool: 'scripts/ado-capture.mjs',
    org: o.org, project: o.project, repo: o.repo,
    moments: { ...previous.moments, [o.moment]: { capturedAt: new Date().toISOString(), prs: result.prs, builds: result.builds, workItems: o.workItems } },
    files: hashTree(o.out),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`captured ${Object.keys(manifest.files).length} files into ${resolve(o.out)} (moment ${o.moment})`);
  console.log(`import here with: node scripts/ado-fixture-import.mjs ${o.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
