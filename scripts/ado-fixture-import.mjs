#!/usr/bin/env node
/**
 * Bring live Azure DevOps captures into the fixture set (ADO parity design §6
 * "Bringing captures in"). Reads a scripts/ado-capture.mjs directory or an
 * `OMG_ADO_RECORD_DIR` recording, scrubs every string again on this machine,
 * and adds the files under src/forge/ado/__tests__/fixtures/live/<name>/:
 *
 *   node scripts/ado-fixture-import.mjs <dir> [--org <name>] [--project <name>] [--repo <name>] [--into <dir>] [--dry-run]
 *
 * - PATs and auth headers go through redactAdoSecrets (dist build).
 * - `uniqueName`s and emails become `user<n>@example.com`, display names
 *   `User <n>`, identity descriptors `<kind>.descriptor<n>`.
 * - The org becomes `contoso`, the project `Web`, the repository `web-app`,
 *   in every string (avatar and `_links` URLs included).
 * - GUIDs are remapped consistently across the whole import, keeping the GUID
 *   shape; the ADO policy type ids (global constants) are kept.
 *
 * A file that still matches a PAT shape, `AZDO`, one of the names, a real
 * display name or a non-example.com email after scrubbing refuses the whole
 * import, and nothing is written. Files are added, never replaced: the docs
 * samples keep their provenance, and live files sit in their own directory
 * because adoFixtureExec refuses two fixtures for one call. A fixture whose
 * route or parameters this build's route table lacks (a design route that has
 * not landed yet) is listed and left out.
 *
 * Org, project and repo default to the capture's manifest.json.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_INTO = join(ROOT, 'src', 'forge', 'ado', '__tests__', 'fixtures', 'live');

export const SCRUBBED_ORG = 'contoso';
export const SCRUBBED_PROJECT = 'Web';
export const SCRUBBED_REPO = 'web-app';

/** Build and status policy type ids (src/forge/ado/checks.ts): the same in every org. */
const KEEP_GUIDS = new Set(['0609b952-1397-4640-95ec-e00a01b2c241', 'cbdc66da-9728-4af8-aada-9a5a32e4a226', '00000000-0000-0000-0000-000000000000']);
const GUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const MAPPED_GUID = /^00000000-0000-4000-8000-[0-9a-f]{12}$/i;
// Not a URL userinfo (`https://org@dev.azure.com`): never right after `//`.
const EMAIL = /(?<![A-Za-z0-9._%+-])(?<!\/\/)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Not a person: scrubbed already, or the git user of an ssh clone URL (`git@ssh.dev.azure.com:v3/...`). */
const keepEmail = (m) => /@example\.com$/i.test(m) || /^git@/i.test(m);
const DESCRIPTOR = /\b(aad|msa|aadgp|vssgp|svc|s2s|bnd|win)\.([A-Za-z0-9_-]{8,})/g;
const CLASSIC_PAT = /(?<![A-Za-z0-9])[a-z2-7]{52}(?![A-Za-z0-9])/;
const AZDO_PAT = /(?<![A-Za-z0-9])(?=[A-Za-z0-9]{84}(?![A-Za-z0-9]))[A-Za-z0-9]*AZDO[A-Za-z0-9]*/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `name` as a whole token: not inside a longer name of letters, digits, `-` or `_`. */
const token = (name) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(name)}(?![A-Za-z0-9_-])`, 'gi');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * One scrubber per import, so a GUID, user or descriptor maps to the same
 * replacement in every file. `redact` is redactAdoSecrets.
 */
export function createScrubber({ org, project, repo, redact }) {
  if (!org || !project || !repo) throw new Error('org, project and repo names are required to scrub');
  const guids = new Map();
  const users = new Map();
  const people = new Map();
  const descriptors = new Map();
  const n = (map, key) => {
    if (!map.has(key)) map.set(key, map.size + 1);
    return map.get(key);
  };
  const userEmail = (value) => `user${n(users, value.toLowerCase())}@example.com`;
  const person = (name) => `User ${n(people, name)}`;
  // A name this short would hit ordinary words in free text.
  const learnPerson = (name) => name.trim().length >= 3 && person(name);
  const names = [[project, SCRUBBED_PROJECT], [repo, SCRUBBED_REPO], [org, SCRUBBED_ORG]]
    .filter(([real, fake], i, all) => real.toLowerCase() !== fake.toLowerCase() && all.findIndex(([r]) => r.toLowerCase() === real.toLowerCase()) === i)
    .sort((a, b) => b[0].length - a[0].length);

  const string = (s) => {
    let out = redact(s);
    for (const [real, fake] of [...people.keys()].map((p) => [p, person(p)]).sort((a, b) => b[0].length - a[0].length)) out = out.split(real).join(fake);
    out = out.replace(EMAIL, (m) => (keepEmail(m) ? m : userEmail(m)));
    out = out.replace(DESCRIPTOR, (_m, kind, value) => `${kind}.descriptor${n(descriptors, `${kind}.${value}`)}`);
    out = out.replace(GUID, (m) => {
      const lower = m.toLowerCase();
      if (KEEP_GUIDS.has(lower) || MAPPED_GUID.test(lower)) return m;
      const mapped = `00000000-0000-4000-8000-${n(guids, lower).toString(16).padStart(12, '0')}`;
      return m === lower ? mapped : mapped.toUpperCase();
    });
    // A repository named like its project (the acceptance default) is web-app in git URLs, Web elsewhere.
    if (repo.toLowerCase() === project.toLowerCase()) out = out.replace(new RegExp(`(/_git/)${escapeRe(repo)}(?![A-Za-z0-9_-])`, 'gi'), `$1${SCRUBBED_REPO}`);
    for (const [real, fake] of names) out = out.replace(token(real), fake);
    return out;
  };

  /** First pass over every file: learn the people (identity refs, git authors) so free text loses their names too. */
  const learn = (value) => {
    if (Array.isArray(value)) return value.forEach(learn);
    if (!isObject(value)) return;
    if (typeof value.displayName === 'string' && (typeof value.uniqueName === 'string' || typeof value.descriptor === 'string')) learnPerson(value.displayName);
    if (typeof value.name === 'string' && typeof value.email === 'string') learnPerson(value.name);
    Object.values(value).forEach(learn);
  };

  const walk = (value, parentKey) => {
    if (typeof value === 'string') return string(value);
    if (Array.isArray(value)) return value.map((v) => walk(v, parentKey));
    if (!isObject(value)) return value;
    const out = {};
    const isRepository = parentKey === 'repository' || typeof value.remoteUrl === 'string' || typeof value.sshUrl === 'string';
    for (const [k, v] of Object.entries(value)) {
      if (k === 'uniqueName' && typeof v === 'string') out[k] = userEmail(v);
      else if (k === 'name' && isRepository && typeof v === 'string' && v.toLowerCase() === repo.toLowerCase()) out[k] = SCRUBBED_REPO;
      else if (k === 'repositoryId' && typeof v === 'string' && v.toLowerCase() === repo.toLowerCase()) out[k] = SCRUBBED_REPO;
      else out[k] = walk(v, k);
    }
    return out;
  };

  /** Why `text` is still not safe to commit; undefined when clean. */
  const problem = (text) => {
    if (CLASSIC_PAT.test(text) || AZDO_PAT.test(text)) return 'a PAT shape survived';
    if (/AZDO/.test(text)) return 'it contains AZDO';
    for (const [real] of names) if (token(real).test(text)) return `it still names ${JSON.stringify(real)}`;
    for (const real of people.keys()) if (text.includes(real)) return 'it still names a person';
    const email = (text.match(EMAIL) ?? []).find((m) => !keepEmail(m));
    if (email) return 'it still holds a real email address';
    return undefined;
  };

  return { learn, json: (value) => walk(value), text: string, problem };
}

/** Every file under `dir` as a relative path (forward slashes). */
function files(dir, base = dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p, base) : [relative(base, p).split('\\').join('/')];
  });
}

/** Why the route table refuses a fixture; undefined when it fits. */
export function routeProblem(fixture, routes) {
  const route = routes.find((r) => r.id === fixture.route);
  if (!route) return `route ${fixture.route} is not in this build's route table`;
  for (const [what, allowed] of [['routeParameters', route.routeParams], ['queryParameters', route.queryParams]]) {
    const extra = Object.keys(fixture[what] ?? {}).find((k) => !allowed.includes(k));
    if (extra) return `${what}.${extra} is not allowed by ${route.id}`;
  }
  if (typeof fixture.provenance !== 'string' || !fixture.provenance.startsWith('recorded ')) return 'provenance must start with "recorded "';
  return undefined;
}

/**
 * Plan an import: scrub every fixture (`*.json` with `route` and `stdout`)
 * and every captured text log (`*.txt` under logs-text/), skip the env files
 * and the manifest. Returns what would be written, what was left out and
 * why; throws when a scrubbed file is still unsafe.
 */
export function planImport(sourceDir, { org, project, repo, redact, routes, into }) {
  const scrub = createScrubber({ org, project, repo, redact });
  const entries = [];
  const skipped = [];
  for (const rel of files(sourceDir)) {
    if (rel === 'manifest.json' || rel.split('/').includes('env')) continue;
    const raw = readFileSync(join(sourceDir, rel), 'utf8');
    if (rel.endsWith('.txt') && rel.split('/').includes('logs-text')) entries.push({ rel, kind: 'text', raw });
    else if (rel.endsWith('.json')) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        skipped.push({ rel, why: 'not JSON' });
        continue;
      }
      if (!isObject(parsed) || typeof parsed.route !== 'string' || parsed.stdout === undefined) {
        skipped.push({ rel, why: 'not a fixture' });
        continue;
      }
      const why = routeProblem(parsed, routes);
      if (why) skipped.push({ rel, why });
      else entries.push({ rel, kind: 'json', parsed });
    } else skipped.push({ rel, why: 'not a fixture or text log' });
  }
  for (const e of entries) scrub.learn(e.kind === 'json' ? e.parsed : '');
  const writes = entries.map((e) => {
    const text = e.kind === 'json' ? `${JSON.stringify(scrub.json(e.parsed), null, 2)}\n` : scrub.text(e.raw);
    const why = scrub.problem(text);
    if (why) throw new Error(`${e.rel}: refused after scrubbing, ${why}; nothing was imported`);
    return { path: join(into, scrub.text(e.rel)), text };
  });
  const existing = writes.find((w) => existsSync(w.path));
  if (existing) throw new Error(`${existing.path} exists; imports add files and never replace them`);
  return { writes, skipped };
}

export function parseImportArgs(argv) {
  const o = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === '--org') o.org = value();
    else if (flag === '--project') o.project = value();
    else if (flag === '--repo') o.repo = value();
    else if (flag === '--into') o.into = value();
    else if (flag === '--dry-run') o.dryRun = true;
    else if (flag.startsWith('--')) throw new Error(`unknown flag ${flag}`);
    else if (o.dir) throw new Error('one capture directory at a time');
    else o.dir = flag;
  }
  if (!o.dir) throw new Error('a capture directory is required');
  return o;
}

/** `https://dev.azure.com/<org>` or `https://<org>.visualstudio.com` → `<org>`. */
export const orgNameOf = (org) => org.replace(/\/+$/, '').replace(/^https:\/\/dev\.azure\.com\//i, '').replace(/^https:\/\/([^.]+)\.visualstudio\.com$/i, '$1');

async function main() {
  let o;
  try {
    o = parseImportArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ado-fixture-import: ${error.message}`);
    console.error('usage: node scripts/ado-fixture-import.mjs <dir> [--org <name>] [--project <name>] [--repo <name>] [--into <dir>] [--dry-run]');
    process.exit(2);
  }
  const manifestPath = join(o.dir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  const org = orgNameOf(o.org ?? manifest.org ?? '');
  const project = o.project ?? manifest.project;
  const repo = o.repo ?? manifest.repo;
  if (!org || !project || !repo) {
    console.error('ado-fixture-import: --org, --project and --repo are required when the directory has no capture manifest.json');
    process.exit(2);
  }
  const { redactAdoSecrets } = await import('../dist/forge/ado/redact.js');
  const { ADO_ROUTES } = await import('../dist/forge/ado/routes.js');
  const into = resolve(o.into ?? join(DEFAULT_INTO, basename(resolve(o.dir))));
  let plan;
  try {
    plan = planImport(o.dir, { org, project, repo, redact: redactAdoSecrets, routes: ADO_ROUTES, into });
  } catch (error) {
    console.error(`ado-fixture-import: ${error.message}`);
    process.exit(1);
  }
  for (const s of plan.skipped) console.log(`left out ${s.rel}: ${s.why}`);
  for (const w of plan.writes) {
    if (o.dryRun) {
      console.log(`[dry-run] would add ${w.path}`);
      continue;
    }
    mkdirSync(dirname(w.path), { recursive: true });
    writeFileSync(w.path, w.text, { encoding: 'utf8', flag: 'wx' });
  }
  console.log(`${o.dryRun ? 'would add' : 'added'} ${plan.writes.length} file(s) under ${into}; ${plan.skipped.length} left out`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
