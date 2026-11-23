/**
 * The repositories this host's engine ledger knows (`omg factory attention
 * --all-repos`, `omg factory dashboard --serve --all-repos`). READ-ONLY: it
 * lists and reads files under the ledger dir and stats each root; it never
 * creates, locks or writes anything, and runs no subprocess. Collecting a
 * listed root's state afterwards does not run git either when the root has a
 * `stateRoot` (withKnownOmcRoots); with OMC_STATE_DIR set, or for a --repo
 * root, the state dir is resolved the usual way (one git probe per collection).
 *
 * Trust: the ledger (defaultLedgerDir: `$OMC_STATE_DIR/factory-ledger` or
 * `~/.omg/factory-ledger`) lives outside every repository, so a root is only
 * ever taken from it: the `root` of a repository dir's `run-<key>.json`
 * records, and the `root` of claim owner records (`claims/<16 hex>/run-<key>.owner`)
 * for repositories whose ledger dir is gone. Never from a file inside a
 * repository.
 *
 * A root is listed only when:
 * - it is a plain local absolute, normalised path (claimRoot: no control or
 *   format character, no UNC / device path);
 * - a ledger dir's name is the id the engine derives from it (ledgerRepoId),
 *   and every readable record of the dir (up to RECORDS_PER_DIR) agrees: a
 *   record copied or forged into another repository's dir is refused;
 * - it exists, is a directory, is not reached through a link (its real path
 *   is itself, compared case-insensitively on win32/darwin), and holds `.git`
 *   (a directory with HEAD, or a `gitdir:` file whose target holds HEAD): a
 *   subdirectory of a repository, a plain folder or an empty `.git` is
 *   refused (`not-a-repository`);
 * - the state the collector reads for it is its own (`<root>/.omg`, or
 *   `$OMC_STATE_DIR/<its id>`): a submodule (state at the superproject) or a
 *   root under a workspace marker (a shared `.omg`) is refused
 *   (`state-elsewhere`);
 * - no other listed root has the same real path.
 * Each filesystem probe of a root runs async with a timeout (ROOT_PROBE_MS),
 * so a slow or unreachable drive is skipped (`timeout`) rather than stalling
 * the rest. A refused root is counted in `skipped` with its ledger id and a
 * reason; its path (sanitised) is for --verbose / --json only.
 *
 * Bounds: at most MAX_REPOS repository dirs and MAX_CLAIM_DIRS claim dirs are
 * looked at, at most RECORDS_PER_DIR records read per dir, each record
 * through readRegularFile (no link, no FIFO, size-capped). A malformed or
 * unreadable record is skipped with a warning, never fatal.
 */

import { promises as fsp, readdirSync, lstatSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { plainText } from '../check/score.js';
import { readRegularFile, runKeyOfName } from '../attention/collect.js';
import { canonicalPath, claimRoot } from './claims.js';
import { ledgerRepoId } from './ledger.js';
import { findWorkspaceRoot, OmcPaths } from '../../lib/worktree-paths.js';

export const MAX_REPOS = 200;
export const MAX_CLAIM_DIRS = 200;
export const RECORDS_PER_DIR = 4;
/** A ledger record or claim larger than this is not read for its root. */
export const RECORD_MAX_BYTES = 4 * 1024 * 1024;
export const ROOT_PROBE_MS = 3_000;
const ROOT_TEXT_MAX = 300;
const LEDGER_ID = /^[0-9a-f]{16}$/;
const OWNER_FILE = /^run-(\d+|heal-[0-9a-f]{8})\.owner$/;

export type SkipReason =
  | 'invalid-root' | 'id-mismatch' | 'conflict' | 'missing' | 'not-a-directory' | 'not-a-repository' | 'state-elsewhere' | 'link' | 'duplicate' | 'timeout' | 'unreadable' | 'no-root';

export interface LedgerRoot {
  /** The ledger id (ledgerRepoId of the root): the opaque handle the dashboard uses. */
  id: string;
  root: string;
  /** Where the root came from: a ledger dir's records, a claim, or --repo. */
  source: 'ledger' | 'claim' | 'pinned';
  /** The ledger holds a dir for this root (runs the engine recorded on this host). */
  recorded: boolean;
  /**
   * The root's own state dir (`<root>/.omg`), validated by probeRoot without git: collection resolves it
   * from here (withKnownOmcRoots) instead of spawning git in the repository. Absent with OMC_STATE_DIR
   * (the centralized id needs git) and for a pinned root: resolved the usual way then.
   */
  stateRoot?: string;
}

export interface SkippedRoot {
  id: string;
  reason: SkipReason;
  /** The recorded root, sanitised and cut: --verbose / --json only, never a command. */
  root?: string;
}

export interface LedgerRoots {
  roots: LedgerRoot[];
  skipped: SkippedRoot[];
  warnings: string[];
}

export interface DiscoverOptions {
  ledgerDir: string;
  /** --repo: only these roots (each already checked by checkPinnedRoot). */
  pinned?: readonly string[];
  platform?: NodeJS.Platform;
  maxRepos?: number;
  probeMs?: number;
}

const shown = (root: string): string => plainText(root).slice(0, ROOT_TEXT_MAX);

/** The names in `dir`, sorted; [] when it cannot be listed. */
function names(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** A real directory (not a link) under the ledger. */
function isPlainDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

type RootRead = { root: string } | { reason: SkipReason; root?: string; warning?: string };

/** The `root` of a JSON record, if it has a string one. */
function recordRoot(path: string, check: (v: Record<string, unknown>) => boolean): { root: unknown } | { warning: string } {
  const r = readRegularFile(path, RECORD_MAX_BYTES);
  if (!('bytes' in r)) return { warning: 'missing' in r ? 'it disappeared' : 'it cannot be read' };
  try {
    const v = JSON.parse(r.bytes.toString('utf8')) as unknown;
    if (typeof v !== 'object' || v === null || !check(v as Record<string, unknown>)) return { warning: 'it is not a record of this shape' };
    return { root: (v as Record<string, unknown>).root };
  } catch {
    return { warning: 'it is not valid JSON' };
  }
}

/**
 * The root a repository dir's ledger records name: every readable one of up
 * to RECORDS_PER_DIR must name the same root and pass the id check, else the
 * dir is skipped (`conflict`, or the failing record's reason), so no single
 * record decides.
 */
function ledgerDirRoot(dir: string, id: string): RootRead {
  const files = names(dir).filter((n) => runKeyOfName(n) !== null).slice(0, RECORDS_PER_DIR);
  let problems = 0;
  let agreed: string | null = null;
  for (const name of files) {
    const key = runKeyOfName(name)!;
    const got = recordRoot(join(dir, name), (v) => v.version === 1 && v.issue === key);
    if ('warning' in got) {
      problems++;
      continue;
    }
    const r = rootOf(got.root, id, true);
    if ('reason' in r) return r;
    if (agreed !== null && canonicalPath(r.root, process.platform) !== canonicalPath(agreed, process.platform)) return { reason: 'conflict', warning: `engine ledger dir ${id}: its run records name different roots; skipped` };
    agreed = r.root;
  }
  if (agreed !== null) return { root: agreed };
  // A fixed message: no error text and no path (it may reach the --serve page).
  if (problems > 0) return { reason: 'unreadable', warning: `engine ledger dir ${id}: none of its first ${problems} run record(s) is a readable engine record; skipped` };
  return { reason: 'no-root' };
}

/** A recorded root checked for shape and, for a ledger dir, for the dir's id. */
function rootOf(raw: unknown, id: string, bound: boolean): RootRead {
  const root = claimRoot(raw);
  if (root === null) return { reason: 'invalid-root', ...(typeof raw === 'string' ? { root: shown(raw) } : {}) };
  if (bound && ledgerRepoId(root) !== id) return { reason: 'id-mismatch', root: shown(root) };
  return { root };
}

const timeout = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<'timeout'>((done) => { t = setTimeout(() => done('timeout'), ms); t.unref(); })]).finally(() => clearTimeout(t));
};

const isFile = (path: string): Promise<boolean> => fsp.lstat(path).then((s) => s.isFile(), () => false);

/**
 * The superproject whose submodule `root` is, else null: the nearest
 * enclosing repository lists `root` as a submodule path in its
 * `.gitmodules` (git's own test for --show-superproject-working-tree is the
 * gitlink in that parent's index; the state anchor climbs to it). Read-only,
 * no git.
 */
async function superprojectOf(root: string): Promise<string | null> {
  let dir = dirname(resolve(root));
  for (let depth = 0; depth < 64 && dir !== dirname(dir); depth++, dir = dirname(dir)) {
    if (!(await fsp.lstat(join(dir, '.git')).then(() => true, () => false))) continue;
    const r = readRegularFile(join(dir, '.gitmodules'), 256 * 1024);
    if (!('bytes' in r)) return null;
    const rel = relative(dir, resolve(root)).replace(/\\/g, '/');
    const paths = r.bytes.toString('utf8').split(/\r?\n/).map((l) => /^\s*path\s*=\s*(.+?)\s*$/.exec(l)?.[1]).filter((p): p is string => p !== undefined);
    return paths.some((p) => p.replace(/\\/g, '/').replace(/\/+$/, '') === rel) ? dir : null;
  }
  return null;
}

type Probed = { real: string; stateRoot?: string };

/**
 * Whether `root` is a repository top level here whose factory state is its
 * own: a directory, not reached through a link, holding `.git` (a dir with
 * `HEAD`, or a `gitdir:` file whose target holds `HEAD`: a linked worktree
 * or a `--separate-git-dir` repository), not a submodule (its state anchors
 * at the superproject) and not under a workspace marker (a shared `.omg`):
 * `state-elsewhere`. Returns its canonical real path (the dedupe key) and,
 * without OMC_STATE_DIR, its state root (`<root>/.omg`), or why not.
 *
 * A linked worktree is a valid root: its state is its own `.omg` (getOmcRoot
 * does not climb from a worktree), though the engine's ledger records the
 * main checkout, so it is listed only when a record or --repo names it.
 */
export async function probeRoot(root: string, platform: NodeJS.Platform = process.platform, ms = ROOT_PROBE_MS): Promise<Probed | { reason: SkipReason }> {
  const probe = async (): Promise<Probed | { reason: SkipReason }> => {
    let st;
    try {
      st = await fsp.lstat(root);
    } catch (error) {
      return { reason: (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'missing' : 'unreadable' };
    }
    if (st.isSymbolicLink()) return { reason: 'link' };
    if (!st.isDirectory()) return { reason: 'not-a-directory' };
    let real: string;
    try {
      real = await fsp.realpath(root);
    } catch {
      return { reason: 'unreadable' };
    }
    // A junction (or a parent link) resolves elsewhere: the engine's root is the real top level.
    if (canonicalPath(real, platform) !== fold(resolve(root), platform)) return { reason: 'link' };
    let git;
    try {
      git = await fsp.lstat(join(root, '.git'));
    } catch {
      return { reason: 'not-a-repository' };
    }
    if (git.isFile()) {
      if (git.size > 4096) return { reason: 'not-a-repository' };
      const head = await fsp.readFile(join(root, '.git'), 'utf8').catch(() => '');
      if (!head.startsWith('gitdir:')) return { reason: 'not-a-repository' };
      // The gitdir must be a git dir (HEAD inside): an empty or dangling pointer is not a repository git recognises.
      const target = resolve(root, head.slice('gitdir:'.length).trim());
      if (!(await isFile(join(target, 'HEAD')))) return { reason: 'not-a-repository' };
    } else if (!git.isDirectory() || !(await isFile(join(root, '.git', 'HEAD')))) return { reason: 'not-a-repository' };
    // The state the collector reads must be this root's own, not a shared anchor elsewhere.
    if (await superprojectOf(root)) return { reason: 'state-elsewhere' };
    const workspace = findWorkspaceRoot(root);
    if (workspace !== null && fold(resolve(workspace), platform) !== fold(resolve(root), platform)) return { reason: 'state-elsewhere' };
    return { real: canonicalPath(real, platform), ...(process.env.OMC_STATE_DIR ? {} : { stateRoot: join(root, OmcPaths.ROOT) }) };
  };
  const got = await timeout(probe(), ms);
  return got === 'timeout' ? { reason: 'timeout' } : got;
}

const fold = (p: string, platform: NodeJS.Platform): string => {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' || platform === 'darwin' ? slashed.toLowerCase() : slashed;
};

/** --repo <path>: resolved against the cwd; it must be a repository top level (null) or the reason it is not. */
export async function checkPinnedRoot(path: string, platform: NodeJS.Platform = process.platform, ms = ROOT_PROBE_MS): Promise<{ root: string } | { error: string }> {
  const root = resolve(path);
  if (claimRoot(root) === null) return { error: `--repo ${JSON.stringify(shown(path))} is not a plain local path` };
  const p = await probeRoot(root, platform, ms);
  if ('reason' in p) return { error: `--repo ${JSON.stringify(shown(root))} is not a repository top level (${p.reason})` };
  return { root };
}

/** Every repository the engine ledger of this host records (or the pinned ones), validated; read-only. */
export async function discoverLedgerRoots(o: DiscoverOptions): Promise<LedgerRoots> {
  const platform = o.platform ?? process.platform;
  const maxRepos = o.maxRepos ?? MAX_REPOS;
  const warnings: string[] = [];
  const skipped: SkippedRoot[] = [];
  const candidates: { id: string; root: string; source: LedgerRoot['source']; recorded: boolean }[] = [];
  const seenIds = new Set<string>();

  const ids = names(o.ledgerDir).filter((n) => LEDGER_ID.test(n) && isPlainDir(join(o.ledgerDir, n)));
  if (ids.length > maxRepos) warnings.push(`the engine ledger has ${ids.length} repository dirs; only the first ${maxRepos} were read`);
  for (const id of ids.slice(0, maxRepos)) {
    seenIds.add(id);
    const r = ledgerDirRoot(join(o.ledgerDir, id), id);
    if ('warning' in r && r.warning) warnings.push(plainText(r.warning).slice(0, 500));
    if ('reason' in r) {
      // A dir with heal seals only names no root: nothing to list, nothing wrong.
      if (r.reason !== 'no-root') skipped.push({ id, reason: r.reason, ...(r.root ? { root: r.root } : {}) });
      continue;
    }
    candidates.push({ id, root: r.root, source: 'ledger', recorded: true });
  }

  // Claim owners name roots too; they add a repository only when its ledger dir is gone.
  const claimsDir = join(o.ledgerDir, 'claims');
  const claimDirs = names(claimsDir).filter((n) => LEDGER_ID.test(n) && isPlainDir(join(claimsDir, n)));
  if (claimDirs.length > MAX_CLAIM_DIRS) warnings.push(`the engine ledger has ${claimDirs.length} claim dirs; only the first ${MAX_CLAIM_DIRS} were read`);
  for (const c of claimDirs.slice(0, MAX_CLAIM_DIRS)) {
    for (const name of names(join(claimsDir, c)).filter((n) => OWNER_FILE.test(n)).slice(0, RECORDS_PER_DIR)) {
      const got = recordRoot(join(claimsDir, c, name), (v) => typeof v.hostname === 'string' && typeof v.root === 'string');
      if ('warning' in got) continue; // A claim is a hint here: an unreadable one adds nothing.
      const root = claimRoot(got.root);
      if (root === null) continue;
      const id = ledgerRepoId(root);
      if (seenIds.has(id) || candidates.length >= maxRepos) continue;
      seenIds.add(id);
      candidates.push({ id, root, source: 'claim', recorded: false });
    }
  }

  const probed = await Promise.all(candidates.map(async (c) => ({ c, p: await probeRoot(c.root, platform, o.probeMs) })));
  const byReal = new Map<string, LedgerRoot>();
  for (const { c, p } of probed) {
    if ('reason' in p) {
      skipped.push({ id: c.id, reason: p.reason, root: shown(c.root) });
      continue;
    }
    if (byReal.has(p.real)) {
      skipped.push({ id: c.id, reason: 'duplicate', root: shown(c.root) });
      continue;
    }
    byReal.set(p.real, { id: c.id, root: c.root, source: c.source, recorded: c.recorded, ...(p.stateRoot ? { stateRoot: p.stateRoot } : {}) });
  }
  let roots = [...byReal.values()];

  if (o.pinned) {
    // --repo: exactly these roots; each one's ledger record (if any) by its id.
    const known = new Map(roots.map((r) => [canonicalPath(r.root, platform), r]));
    const out: LedgerRoot[] = [];
    const seen = new Set<string>();
    for (const pin of o.pinned) {
      const key = canonicalPath(pin, platform);
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = known.get(key);
      const id = ledgerRepoId(pin);
      out.push(hit ?? { id, root: resolve(pin), source: 'pinned', recorded: isPlainDir(join(o.ledgerDir, id)) });
    }
    roots = out;
    // Skipped records of roots outside the pinned set are not this view's business.
    const pinnedIds = new Set(out.map((r) => r.id));
    return { roots, skipped: skipped.filter((s) => pinnedIds.has(s.id)), warnings };
  }
  roots.sort((a, b) => basename(a.root).localeCompare(basename(b.root)) || a.root.localeCompare(b.root));
  return { roots, skipped, warnings };
}
