/**
 * The exec boundary of `omg factory setup` (factory forges design §4):
 * setupGuardExec allows the read shapes the wizard builds plus the one write
 * the user confirms, `gh label create`. It runs no lane and never pushes,
 * edits an item or calls a write route; anything else is refused before it
 * spawns.
 *
 * Azure DevOps calls are `az devops invoke` GETs of a route in
 * src/forge/ado/routes.ts, pinned to the detected org and project, with the
 * route's own API version, `--detect false`, and no `--in-file`, `--debug`
 * or `--verbose` (those print headers). On Windows az runs as the bundled
 * python.exe `-IBm azure.cli` that az-binary.ts resolved, never az.cmd.
 */

import { ShipSafetyError, type Exec, type ExecResult } from '../../ship/exec.js';
import type { AzEntry } from '../../forge/ado/az-binary.js';
import { adoRouteById, findAdoRoute } from '../../forge/ado/routes.js';
import type { ForgeRepo } from '../../forge/types.js';

/** Exit codes (design §4): 2 usage, 3 auth or extension missing, 5 incompatible. */
export type SetupExitCode = 1 | 2 | 3 | 5;

export class SetupError extends Error {
  constructor(readonly exitCode: SetupExitCode, message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

export class SetupSafetyError extends ShipSafetyError {
  constructor(message: string) {
    super(message);
    this.name = 'SetupSafetyError';
  }
}

/** What the wizard talks to: the guarded exec, the repo root, the detected repo, and az on ADO. */
export interface SetupIo {
  exec: Exec;
  cwd: string;
  repo: ForgeRepo;
  az?: AzEntry;
}

export const LABEL_COLOR = '7c7c7c';
/** A GitHub label (the forge config's TRACKER_NAME rule). */
export const LABEL_NAME = /^[^\s,;\-\p{Cc}][^,;\p{Cc}]{0,49}$/u;
// A route or query parameter value: no option shape, no leading `@` (az reads `@file`), and no `/`, `?`,
// `#` or `..`, so a value can never reshape the request URL.
const PARAM_VALUE = /^(?!.*\.\.)[^\-@/?#\p{Cc}][^/?#\p{Cc}]{0,255}$/u;
const INVOKE_SINGLE = ['--area', '--resource', '--http-method', '--api-version', '--org', '--detect', '--output'];
const INVOKE_PAIRS = ['--route-parameters', '--query-parameters'];

const same = (args: readonly string[], shape: readonly string[]) => args.length === shape.length && shape.every((v, i) => args[i] === v);
/** ADO names compare case-insensitively with escapes decoded (design §8.3). */
const fold = (s: string): string => {
  try {
    return decodeURIComponent(s).toLowerCase();
  } catch {
    return s.toLowerCase();
  }
};

export const adoOrgUrl = (repo: ForgeRepo): string => `https://dev.azure.com/${encodeURIComponent(repo.owner)}`;
export const milestonesPath = (repo: ForgeRepo): string => `repos/${repo.owner}/${repo.name}/milestones?state=open&per_page=100`;

function ghAllowed(a: string[], repo: ForgeRepo): boolean {
  return same(a, ['auth', 'status', '--hostname', repo.host])
    || same(a, ['label', 'list', '--json', 'name', '--limit', '1000'])
    || (a.length === 5 && a[0] === 'label' && a[1] === 'create' && LABEL_NAME.test(a[2]) && a[3] === '--color' && a[4] === LABEL_COLOR)
    // Setup-only GET: open milestones of exactly this repository (design §4 step 4).
    || same(a, ['api', '--hostname', repo.host, '--method', 'GET', milestonesPath(repo)]);
}

function pairsAllowed(tokens: readonly string[], allowed: readonly string[]): Map<string, string> | undefined {
  const out = new Map<string, string>();
  for (const t of tokens) {
    const eq = t.indexOf('=');
    const name = t.slice(0, eq), value = t.slice(eq + 1);
    if (eq <= 0 || !allowed.includes(name) || out.has(name) || !PARAM_VALUE.test(value)) return undefined;
    out.set(name, value);
  }
  return out;
}

function invokeAllowed(r: string[], repo: ForgeRepo): boolean {
  if (r[0] !== 'devops' || r[1] !== 'invoke') return false;
  const flags = new Map<string, string[]>();
  for (let i = 2; i < r.length;) {
    const flag = r[i++];
    if (![...INVOKE_SINGLE, ...INVOKE_PAIRS].includes(flag) || flags.has(flag)) return false;
    const values: string[] = [];
    while (i < r.length && !r[i].startsWith('--')) values.push(r[i++]);
    flags.set(flag, values);
  }
  for (const f of INVOKE_SINGLE) if (flags.get(f)?.length !== 1) return false;
  const one = (f: string) => flags.get(f)![0];
  if (one('--http-method') !== 'GET' || one('--detect') !== 'false' || one('--output') !== 'json' || one('--org') !== adoOrgUrl(repo)) return false;
  const route = findAdoRoute(one('--area'), one('--resource'), 'GET');
  if (!route || one('--api-version') !== route.apiVersion) return false;
  const rp = pairsAllowed(flags.get('--route-parameters') ?? [], route.routeParams);
  const qp = pairsAllowed(flags.get('--query-parameters') ?? [], route.queryParams);
  if (!rp || !qp || (flags.has('--route-parameters') && rp.size === 0) || (flags.has('--query-parameters') && qp.size === 0)) return false;
  for (const key of ['project', 'projectId']) if (rp.has(key) && fold(rp.get(key)!) !== fold(repo.project ?? '')) return false;
  return !rp.has('repositoryId') || fold(rp.get('repositoryId')!) === fold(repo.name);
}

function azAllowed(a: string[], repo: ForgeRepo): boolean {
  return same(a, ['extension', 'show', '--name', 'azure-devops', '--output', 'json'])
    || same(a, ['account', 'show', '--output', 'json'])
    || invokeAllowed(a, repo);
}

const baseName = (cmd: string): string => cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase();

/** Throws SetupSafetyError unless `cmd args` is one of the wizard's shapes. */
export function assertSetupCommand(cmd: string, args: string[], repo: ForgeRepo, az?: AzEntry, env?: Readonly<Record<string, string>>): void {
  const file = baseName(cmd);
  const refuse = (why: string): never => {
    throw new SetupSafetyError(`omg factory setup refuses \`${file} ${args.join(' ')}\`: ${why}`);
  };
  if (!args.every((x) => typeof x === 'string')) refuse('non-string argument');
  if (/\.(cmd|bat)$/.test(file)) refuse('batch shims are never run');
  const isAz = az !== undefined && cmd === az.command && az.prefix.every((p, i) => args[i] === p);
  if (env !== undefined && !(isAz && same(Object.entries(env).flat(), Object.entries(az!.env).flat()))) refuse(`environment ${JSON.stringify(env)} is not allowed`);
  const base = file.replace(/\.exe$/, '');
  const ok = isAz
    ? azAllowed(args.slice(az!.prefix.length), repo)
    : base === 'gh' ? ghAllowed(args, repo)
      : base === 'git' ? same(args, ['remote', 'get-url', 'origin']) || same(args, ['rev-parse', '--show-toplevel'])
        : false;
  if (!ok) refuse('not one of the command shapes the setup wizard runs');
}

export function setupGuardExec(exec: Exec, repo: ForgeRepo, az?: AzEntry): Exec {
  return (cmd, args, opts) => {
    assertSetupCommand(cmd, args, repo, az, opts?.env);
    return exec(cmd, args, opts);
  };
}

/** Run one az command (`az <args>` on POSIX, `python.exe -IBm azure.cli <args>` on Windows). */
export function runAz(io: SetupIo, args: string[]): ExecResult {
  if (!io.az) throw new SetupError(1, 'az is not resolved for this forge');
  const env = Object.keys(io.az.env).length > 0 ? { env: io.az.env } : {};
  return io.exec(io.az.command, [...io.az.prefix, ...args], { cwd: io.cwd, ...env });
}

/** az stderr without token-shaped runs (PATs, bearer tokens); the wizard never prints stdout of an auth call. */
export function safeStderr(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/)[0] ?? '';
  return line.replace(/(authorization|bearer|basic)\s*:?\s*\S+/gi, '$1 ***').replace(/[A-Za-z0-9+/=_-]{32,}/g, '***').slice(0, 300);
}

/** The argv of one `az devops invoke` GET of a routes.ts route. */
export function adoInvokeArgs(repo: ForgeRepo, routeId: string, routeParameters: Record<string, string>, queryParameters: Record<string, string> = {}): string[] {
  const route = adoRouteById(routeId);
  if (route.method !== 'GET') throw new SetupError(1, `omg factory setup only reads; ${routeId} is a write`);
  const kv = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`);
  return [
    'devops', 'invoke', '--area', route.area, '--resource', route.resource,
    ...(Object.keys(routeParameters).length > 0 ? ['--route-parameters', ...kv(routeParameters)] : []),
    ...(Object.keys(queryParameters).length > 0 ? ['--query-parameters', ...kv(queryParameters)] : []),
    '--http-method', 'GET', '--api-version', route.apiVersion, '--org', adoOrgUrl(repo), '--detect', 'false', '--output', 'json',
  ];
}

/** One ADO GET; throws SetupError(code) with the redacted stderr when az fails. */
export function adoGet(io: SetupIo, routeId: string, routeParameters: Record<string, string>, queryParameters: Record<string, string> = {}, code: SetupExitCode = 5): unknown {
  const r = runAz(io, adoInvokeArgs(io.repo, routeId, routeParameters, queryParameters));
  if (r.status !== 0) throw new SetupError(code, `Azure DevOps ${routeId} failed (exit ${r.status}): ${safeStderr(r.stderr)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new SetupError(5, `Azure DevOps ${routeId} printed no JSON`);
  }
}

/** The `value` array of an ADO list response. */
export function adoList(body: unknown): Array<Record<string, unknown>> {
  const value = (body as { value?: unknown } | null)?.value;
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object') : [];
}
