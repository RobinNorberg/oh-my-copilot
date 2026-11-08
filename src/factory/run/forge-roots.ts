/**
 * The ForgeOptions the factory hands createForge (critic amendments §A.13):
 * every root a lane or job can write, so the Azure CLI entry is never
 * resolved from one, and an engine-owned state directory outside them for
 * files a human later reads (the ADO merge body).
 *
 * - the repository checkout;
 * - its omg root (`.omg`, or OMC_STATE_DIR's project dir): the lane
 *   worktrees under `team/<team>/worktrees/` (factory-run, copilot-run) and
 *   the copilot_run job dirs under `state/copilot-run/`;
 * - the team job root (OMC_JOBS_DIR, else the global `team-jobs`).
 *
 * Also the factory's forge config load (factory forges design §3) and the
 * origin's forge kind for the GitHub-only commands.
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { detectForgeRepo, ForgeConfigError, resolveForgeConfig, type LoadedForgeConfig } from '../../forge/config.js';
import { LOCAL_REMOTE, mirrorFetchArgs, mirrorInitArgs, mirrorPushArgs, mirrorRemoteAddArgs, mirrorRemoteGetUrlArgs, readMirrorRef } from '../../forge/local/index.js';
import type { ForgeKind, ForgeOptions } from '../../forge/types.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { BASE_CONFIG_PATH, readBaseFile, resolveTrustedBases } from '../../ship/config.js';
import { FOR_EACH_REF_FORMAT, LOCAL_REMOTE_REFUSED_CONFIG_ARGS, localRemoteRefusedKeys, mirrorNamedRemoteKeys, mirrorRewriteKeys, REMOTE_CONFIG_ARGS, URL_REWRITE_CONFIG_ARGS } from './exec.js';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { getGlobalOmcStatePath } from '../../utils/paths.js';

export function factoryForgeOptions(repoRoot: string, env: NodeJS.ProcessEnv = process.env): ForgeOptions {
  const omcRoot = getOmcRoot(repoRoot);
  return {
    untrustedRoots: [
      resolve(repoRoot),
      omcRoot,
      join(omcRoot, 'team'),
      join(omcRoot, 'state', 'copilot-run'),
      env.OMC_JOBS_DIR || getGlobalOmcStatePath('team-jobs'),
    ],
    stateDir: getGlobalOmcStatePath('forge'),
  };
}

const HEX40 = /^[0-9a-f]{40}$/;

const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

/**
 * Throws unless `options` names every root factoryForgeOptions lists for
 * `repoRoot` (critic amendments §A.14): `{ untrustedRoots: [] }` or any
 * partial list is refused, so no caller can resolve az from, or write the
 * merge body under, a root a lane writes.
 */
export function assertFactoryForgeOptions(repoRoot: string, options: ForgeOptions, env: NodeJS.ProcessEnv = process.env): void {
  const given = new Set(options.untrustedRoots.map(norm));
  const missing = factoryForgeOptions(repoRoot, env).untrustedRoots.filter((r) => !given.has(norm(r)));
  if (missing.length > 0) throw new Error(`the forge options must list every untrusted root (factoryForgeOptions); missing: ${missing.join(', ')}`);
}

/** `git remote get-url origin`, or null. */
function originUrl(exec: Exec, root: string): string | null {
  const got = exec('git', ['remote', 'get-url', 'origin'], { cwd: root, env: TRUSTED_READ_ENV });
  return got.status === 0 && got.stdout.trim() ? got.stdout.trim() : null;
}

/**
 * The forge config of a factory run: the user config at its default
 * location, `.copilot/omg.jsonc` committed on `origin/<base>` after a fetch
 * (absent: that layer is empty), the working-tree project config, and the
 * origin remote, through resolveForgeConfig's trust layering. The fetch
 * overwrites the tracking ref with the remote's, so a ref a lane moved
 * between runs is not read. Identity keys can only pin the origin's forge;
 * progress keys only narrow what the az guard lets the engine write.
 * `base` comes from the working tree, so a base outside ship.trustedBases
 * (resolveTrustedBases, as ship reads it) is neither fetched nor read: that
 * layer is empty, with a warning.
 */
export function loadFactoryForgeConfig(exec: Exec, root: string, base: string, trustedUser: unknown, project: unknown, opts: { dryRun?: boolean } = {}): LoadedForgeConfig {
  const url = originUrl(exec, root) ?? undefined;
  const context = { root, stateDir: getGlobalOmcStatePath('forge') };
  const resolveOrUnavailable = (baseLayer: unknown): LoadedForgeConfig => {
    try {
      return resolveForgeConfig(trustedUser, baseLayer, project, url, context);
    } catch (error) {
      if (error instanceof ForgeConfigError && error.code !== 'invalid') throw new FactoryForgeUnavailableError(error.message);
      throw error;
    }
  };
  // Parse the origin before anything is fetched (F8): an unusable origin never reaches git fetch.
  let parsed = false;
  if (url) {
    try {
      detectForgeRepo(url);
      parsed = true;
    } catch (error) {
      if (!(error instanceof ForgeConfigError)) throw error;
    }
  }
  const trustedBases = resolveTrustedBases(trustedUser);
  if (!trustedBases.includes(base)) {
    const loaded = resolveOrUnavailable(undefined);
    const warning = `omg factory: base ${base} is not in ship.trustedBases (${trustedBases.join(', ')}); its committed ${BASE_CONFIG_PATH} is not read`;
    return { ...loaded, warnings: [warning, ...loaded.warnings] };
  }
  const git = (args: string[]) => exec('git', args, { cwd: root, env: TRUSTED_READ_ENV });
  const at = (ref: string): string | undefined => {
    const sha = git(['rev-parse', '--verify', ref]).stdout.trim();
    return HEX40.test(sha) ? sha : undefined;
  };
  const withBaseLayer = (sha: string | undefined, warnings: string[]): LoadedForgeConfig => {
    const text = sha ? readBaseFile(exec, root, sha, BASE_CONFIG_PATH) : null;
    const loaded = resolveOrUnavailable(text && text.trim() ? parseJsonc(text) : undefined);
    return warnings.length > 0 ? { ...loaded, warnings: [...warnings, ...loaded.warnings] } : loaded;
  };
  if (!parsed) {
    // No GitHub or Azure DevOps origin: only the local forge can work, and nothing is fetched. Its base is the
    // local branch the human merges into, so the committed config is read there.
    const sha = at(`refs/heads/${base}`);
    if (!sha) {
      // Without the base, only the user config can name the local forge: no forge at all is exit 5, not a base hint.
      resolveOrUnavailable(undefined);
      throw new Error(missingBaseHint(exec, root, base));
    }
    return withBaseLayer(sha, []);
  }
  const tracking = `refs/remotes/origin/${base}`;
  if (opts.dryRun) {
    // --dry-run never fetches (F8): an existing tracking ref is read as it is, else the layer is left out.
    const sha = at(tracking);
    if (!sha && !at(`refs/heads/${base}`)) throw new Error(missingBaseHint(exec, root, base));
    return withBaseLayer(sha, [sha
      ? `omg factory: --dry-run does not fetch; the committed ${BASE_CONFIG_PATH} is read at origin/${base} ${sha.slice(0, 12)}, which may be stale`
      : `omg factory: --dry-run does not fetch, and origin/${base} is not here yet; the committed ${BASE_CONFIG_PATH} is not read`]);
  }
  const fetched = git(['fetch', 'origin', base]);
  if (fetched.status !== 0) {
    if (!at(tracking) && !at(`refs/heads/${base}`)) throw new Error(missingBaseHint(exec, root, base));
    throw new Error(`git fetch origin ${base} failed: ${fetched.stderr.trim().split('\n')[0]}`);
  }
  const sha = at(tracking);
  if (!sha) throw new Error(`origin/${base} did not resolve to a commit`);
  return withBaseLayer(sha, []);
}

/** `base branch 'dev' not found; set ship.base in .copilot/omg.jsonc (branches here: main)` (F8). */
function missingBaseHint(exec: Exec, root: string, base: string): string {
  const refs = exec('git', ['for-each-ref', FOR_EACH_REF_FORMAT], { cwd: root, env: TRUSTED_READ_ENV }).stdout;
  const branches = refs.split(/\r?\n/).map((l) => /^refs\/heads\/(\S+) /.exec(l)?.[1]).filter((b): b is string => Boolean(b));
  return `base branch '${base}' not found; set ship.base in ${BASE_CONFIG_PATH} (branches here: ${branches.length > 0 ? branches.join(', ') : 'none'})`;
}

/**
 * The run has no usable forge: no origin, an origin that is neither GitHub
 * nor Azure DevOps, or a configured forge the origin contradicts. Every
 * `omg factory` command exits 5 for it (F9), like check / board / setup.
 */
export class FactoryForgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactoryForgeUnavailableError';
  }
}

/** Exit code of FactoryForgeUnavailableError (EXIT_CHECK_INCOMPATIBLE, setup's 5). */
export const EXIT_FORGE_UNAVAILABLE = 5;

/**
 * Null when the checkout's `omg-local` remote fetches from and pushes to
 * exactly `mirror`; otherwise why not. Unlike remoteRepoMismatch (ship's
 * sameRepo drops `.git` and case for forge URLs), the url and every push url
 * (insteadOf / pushInsteadOf applied by git) must be exactly the mirror
 * string the engine registers: not another spelling of the same directory
 * (forward slashes, a trailing slash, a case variant, a junction), which a
 * `url.<x>.insteadOf` of the literal mirror path would not rewrite.
 */
export function localRemoteMismatch(exec: Exec, root: string, mirror: string): string | null {
  const same = (url: string) => url === mirror;
  const got = exec('git', ['remote', 'get-url', LOCAL_REMOTE], { cwd: root, env: TRUSTED_READ_ENV });
  if (got.status !== 0) return `git remote get-url ${LOCAL_REMOTE} failed: ${got.stderr.trim().split('\n')[0]}`;
  const url = got.stdout.trim();
  // git prints the remote's name when it has no url (only a planted pushurl, say).
  const urlNote = same(url) ? '' : !url || url === LOCAL_REMOTE ? '; the remote has no url' : `; its url ${url} is not the mirror either`;
  const push = exec('git', ['remote', 'get-url', '--push', '--all', LOCAL_REMOTE], { cwd: root, env: TRUSTED_READ_ENV });
  if (push.status !== 0) return `git remote get-url --push --all ${LOCAL_REMOTE} failed: ${push.stderr.trim().split('\n')[0]}`;
  const pushUrls = push.stdout.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
  // F26: a push url other than the remote url is planted (pushurl or pushInsteadOf); name it first, whatever the url says.
  const planted = pushUrls.find((u) => !same(u) && u !== url);
  if (planted) return `remote ${LOCAL_REMOTE} pushes to ${planted} (a remote.${LOCAL_REMOTE}.pushurl or pushInsteadOf), not the mirror ${mirror}${urlNote}`;
  if (!url || url === LOCAL_REMOTE) return `remote ${LOCAL_REMOTE} has no url, not the mirror ${mirror}`;
  if (!same(url)) return `remote ${LOCAL_REMOTE} points at ${url}, not the mirror ${mirror}`;
  if (pushUrls.length === 0) return `git remote get-url --push --all ${LOCAL_REMOTE} printed no push URL`;
  return null;
}

/** `key\nvalue` records of `git config -z --get-regexp` output. */
const configRecords = (stdout: string): Array<{ key: string; value: string }> =>
  stdout.split('\0').filter(Boolean).map((rec) => {
    const nl = rec.indexOf('\n');
    return nl < 0 ? { key: rec, value: '' } : { key: rec.slice(0, nl), value: rec.slice(nl + 1) };
  });

/**
 * The commands that point the checkout's `omg-local` remote back at
 * `mirror`, per cause (read from the config, any scope): set the url, unset
 * a planted pushurl, unset a pushInsteadOf that rewrites the url.
 */
export function localRemoteFixes(exec: Exec, root: string, mirror: string): string[] {
  const read = (args: readonly string[]) => {
    const r = exec('git', [...args], { cwd: root, env: TRUSTED_READ_ENV });
    return r.status === 0 ? configRecords(r.stdout) : [];
  };
  const remote = read(REMOTE_CONFIG_ARGS);
  const urls = remote.filter((r) => r.key === `remote.${LOCAL_REMOTE}.url`).map((r) => r.value);
  const fixes: string[] = [];
  if (!urls.includes(mirror)) fixes.push(urls.length > 0 ? `git remote set-url ${LOCAL_REMOTE} ${mirror}` : `git config remote.${LOCAL_REMOTE}.url ${mirror}`);
  if (remote.some((r) => r.key === `remote.${LOCAL_REMOTE}.pushurl`)) fixes.push(`git config --unset-all remote.${LOCAL_REMOTE}.pushurl`);
  // A pushInsteadOf applies only without a pushurl, to the url git would push to.
  const rewrites = read(URL_REWRITE_CONFIG_ARGS).filter((r) => r.key.endsWith('.pushinsteadof') && r.value !== '' && urls.some((u) => u.startsWith(r.value)));
  for (const key of new Set(rewrites.map((r) => r.key))) fixes.push(`git config --unset-all ${key}`);
  return fixes;
}

/**
 * The refused `remote.omg-local.*` settings of the checkout (any include
 * counts), or null: `vcs` hands the transport to `git remote-<vcs>`
 * (remote-ext runs a command), `mirror` turns a push into a mirror push, and
 * a `fetch` refspec other than the default could map a pushed branch onto
 * local refs (localRemoteRefusedKeys). Also any `url.<x>.insteadOf` /
 * `pushInsteadOf` whose value is a prefix of `mirror` (mirrorRewriteKeys):
 * git would rewrite the push to the mirror path into another repository.
 * And any `remote.<name>.*` whose name is a spelling of `mirror`
 * (mirrorNamedRemoteKeys): Windows git would push through that remote.
 */
export function localRemoteRefusedConfig(exec: Exec, root: string, mirror: string): string | null {
  const read = (args: readonly string[], parse: (stdout: string) => string[]): string[] | string => {
    const r = exec('git', [...args], { cwd: root, env: TRUSTED_READ_ENV });
    return r.status > 1 ? `git ${args.join(' ')} failed: ${r.stderr.trim().split('\n')[0]}` : parse(r.stdout);
  };
  const keys = read(LOCAL_REMOTE_REFUSED_CONFIG_ARGS, localRemoteRefusedKeys);
  if (typeof keys === 'string') return keys;
  const rewrites = read(URL_REWRITE_CONFIG_ARGS, (stdout) => mirrorRewriteKeys(stdout, mirror));
  if (typeof rewrites === 'string') return rewrites;
  const named = read(REMOTE_CONFIG_ARGS, (stdout) => mirrorNamedRemoteKeys(stdout, mirror));
  if (typeof named === 'string') return named;
  const all = [...keys, ...rewrites, ...named];
  return all.length > 0 ? `the git config sets ${all.join(', ')}` : null;
}

/**
 * Create (once) and sync the local forge's bare mirror (offline forge plan
 * §1.1), through the engine's guarded, hardened Exec:
 * - `git init --bare` at `mirror` when it does not exist;
 * - `remote.omg-local.vcs` / `.mirror`, or a `remote.omg-local.fetch` other
 *   than the default, in the checkout refuse with
 *   FactoryForgeUnavailableError (exit 5);
 * - the checkout's `omg-local` remote is added when missing; an existing one
 *   must point at exactly `mirror` for fetch and for every push url
 *   (localRemoteMismatch: a planted pushurl, an insteadOf or a remote added
 *   under another spelling of the mirror path refuses, exit 5);
 * - the local `<base>` is pushed to the mirror without `+`, so the sync is
 *   fast-forward only: a diverged mirror base refuses with a message. Before
 *   the push, `onBase` gets the sha read from the local base: the guard lets
 *   only that sha be pushed there (LocalGuardContext.baseSha);
 * - `git fetch omg-local <base>` updates `refs/remotes/omg-local/<base>`
 *   (hardenedGitExec makes it an explicit refspec with `--refmap=`).
 * Returns the base sha. Throws (a plain Error) on any other refusal.
 */
export function syncLocalMirror(exec: Exec, root: string, mirror: string, base: string, onBase?: (sha: string) => void): string {
  const git = (args: string[], env?: Readonly<Record<string, string>>) => exec('git', args, { cwd: root, ...(env ? { env } : {}) });
  const must = (args: string[], what: string, env?: Readonly<Record<string, string>>): string => {
    const r = git(args, env);
    if (r.status !== 0) throw new Error(`${what}: git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
    return r.stdout;
  };
  const refused = localRemoteRefusedConfig(exec, root, mirror);
  if (refused) throw new FactoryForgeUnavailableError(`refusing the local forge: ${refused}; remove it (git config --unset <key>, in the config file that sets it: git config --show-origin --get-regexp <key>)`);
  if (!existsSync(join(mirror, 'HEAD'))) must(mirrorInitArgs(mirror), 'local forge mirror');
  const current = git(mirrorRemoteGetUrlArgs(), TRUSTED_READ_ENV);
  if (current.status !== 0) must(mirrorRemoteAddArgs(mirror), 'local forge remote');
  const mismatch = localRemoteMismatch(exec, root, mirror);
  if (mismatch) {
    const fixes = localRemoteFixes(exec, root, mirror);
    const how = fixes.length > 0 ? fixes.join('; ') : `git config --show-origin --get-regexp "^remote\\.${LOCAL_REMOTE}\\.|pushinsteadof$" names the settings`;
    throw new FactoryForgeUnavailableError(`refusing to sync the local forge mirror: ${mismatch}; point the ${LOCAL_REMOTE} remote back at the mirror: ${how} (a key set in another config file: add --global, or --file from git config --show-origin)`);
  }
  const local = must(['rev-parse', '--verify', `refs/heads/${base}`], `local base ${base}`, TRUSTED_READ_ENV).trim();
  if (!HEX40.test(local)) throw new Error(`local base ${base} did not resolve to a commit`);
  onBase?.(local);
  // F27, an idle tick: the mirror base and the tracking ref already name the local base, so the fetch (and the
  // config reads its hardened transport repeats) would change nothing; on Windows each git spawn costs ~0.2-1 s.
  const upToDate = readMirrorRef(mirror, base) === local;
  if (upToDate && git(['rev-parse', '--verify', `refs/remotes/${LOCAL_REMOTE}/${base}`], TRUSTED_READ_ENV).stdout.trim() === local) return local;
  if (!upToDate) {
    const pushed = git(mirrorPushArgs(local, base));
    if (pushed.status !== 0) {
      const detail = (pushed.stderr || pushed.stdout).trim().split('\n')[0];
      throw new Error(/non-fast-forward|fetch first|rejected/i.test(pushed.stderr)
        ? `the local forge mirror's ${base} is not an ancestor of your ${base} (it was rewritten or reset); the mirror syncs fast-forward only. Restore ${base}, or move the mirror ${mirror} aside to start a new one (${detail})`
        : `syncing ${base} to the local forge mirror failed: ${detail}`);
    }
  }
  must(mirrorFetchArgs(base), 'local forge fetch', TRUSTED_READ_ENV);
  return local;
}

/**
 * The forge kind the origin remote names; github when there is no origin or
 * it cannot be parsed (today's behaviour). For the GitHub-only commands
 * (`omg factory listen`, `omg factory heal`), which refuse Azure DevOps.
 */
export function originForgeKind(exec: Exec, root: string): ForgeKind {
  const url = originUrl(exec, root);
  if (!url) return 'github';
  try {
    return detectForgeRepo(url).kind;
  } catch {
    return 'github';
  }
}
