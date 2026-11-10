/**
 * Cross-clone run claims (night-3 goal 1, fallback design). One engine runs
 * per checkout (factoryRepoOwnerPath): the tamper snapshot covers the whole
 * common git dir, so a second engine in the same checkout would look like
 * lane tampering to the first. Parallel runs therefore need separate clones.
 * Separate clones of one repository do not see each other's run state, so
 * two of them could start the same item; the claim prevents that on one host
 * (with one OMC_STATE_DIR: the claims live in its ledger dir).
 *
 * A claim is `<ledgerDir>/claims/<repo>/run-<key>.owner`, outside every
 * checkout (the engine ledger's directory, which the lane sandbox denies).
 * `<repo>` hashes the repository's identity (claimRepoKey over the trusted
 * origin remote, trustedFactoryClaimRepo), so every clone of one repository
 * shares the directory. The local forge has no origin and a mirror per
 * checkout, so its claims are keyed on the repository's root commit
 * (localFactoryClaimRepo, dogfood F60): clones of one history share them.
 * The claim lives as long as the run is not terminal:
 * - a live engine holds it (pid, host and start identity, as state.ts's
 *   owner files);
 * - when the engine stops before a terminal phase (a park, an error) it
 *   rewrites the claim without a pid ("parked"); a crash leaves its dead pid.
 *   Either way the claim stays held while the run state of its checkout
 *   (`<root>`'s run-<key>.json) exists and is not terminal. That state is
 *   read only as its engine sealed it (its integrity and its engine ledger
 *   entry in the shared ledger dir), so a lane of that checkout cannot free
 *   the claim by writing a terminal phase; a missing or unreadable root, a
 *   state that fails those checks or is gone though its engine wrote it,
 *   keeps the claim held too, and is reported;
 * - it is deleted at a terminal phase, by `omg factory run clean` / `reset`
 *   of the same checkout, and by `omg factory run release` (a human).
 * The claiming checkout itself always takes its own parked claim back (a
 * resume). A claim is never a trust anchor: a lane that could write it could
 * only block an item or let a second clone start it, which then stops at the
 * forge's pr-exists gate once the first clone pushed.
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'fs';
import { basename, isAbsolute, join, normalize, resolve } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../../lib/atomic-write.js';
import { repoIdentity } from '../../ship/config.js';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import { FactorySafetyError, hardenedGitExec } from './exec.js';
import { emptyHooksDir, EngineLedger } from './ledger.js';
import {
  defaultOwnerDeps, describeOwner, FactoryBusyError, factoryStateDir, FactoryStateError, factoryStatePath, isOwnerRecord, ownerHolds, ownerRecord, ownerText, parseFactoryState, runLabel,
  TERMINAL_FACTORY_PHASES, verifyFactoryIntegrity, withOwnerFileLock, type FactoryOwner, type FactoryPhase, type FactoryRunKey, type OwnerDeps,
} from './state.js';

/**
 * The repository a claim is keyed on: the origin remote's URL (`git remote
 * get-url origin`, read-only, the same trusted origin the forge config is
 * derived from), or null without an origin. Needs no forge config, so heal
 * runs and `run clean` / `reset` / `release` key their claims the same way.
 * A FactorySafetyError of a hardened exec (trustedFactoryClaimRepo) is
 * thrown, never read as "no origin".
 */
export function factoryClaimRepo(exec: Exec, root: string): string | null {
  try {
    const got = exec('git', ['remote', 'get-url', 'origin'], { cwd: root, env: TRUSTED_READ_ENV });
    const url = got.status === 0 ? got.stdout.trim() : '';
    return url && !url.includes('\0') ? url : null;
  } catch (error) {
    if (error instanceof FactorySafetyError) throw error;
    return null;
  }
}

/** The claim key prefix of the local forge: `local-root:<root commit sha>`. */
export const LOCAL_CLAIM_PREFIX = 'local-root:';
const HEX40 = /^[0-9a-f]{40}$/;

/**
 * The local forge's claim repository (dogfood F60): its mirror and project id
 * are per checkout and it reads no origin, so two clones are one repository
 * by their history: the first (sorted) root commit of HEAD, as
 * `local-root:<sha>`, or null when HEAD has none. Read-only. Clones whose
 * HEADs have different root sets (one merged an unrelated history) get
 * different keys and do not share claims; a fork or template clone that
 * shares the root commit shares the key (a false busy, which `run release`
 * clears). A shallow clone is refused (FactoryStateError): its boundary
 * commits count as roots, so its key would differ from the full clones'.
 */
export function localFactoryClaimRepo(exec: Exec, root: string): string | null {
  let shallow = false;
  try {
    shallow = exec('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, env: TRUSTED_READ_ENV }).stdout.trim() === 'true';
  } catch (error) {
    if (error instanceof FactorySafetyError) throw error;
  }
  if (shallow) {
    throw new FactoryStateError(`${root} is a shallow clone: the local forge keys its cross-clone claims on the root commit, which a shallow history does not have (git fetch --unshallow, then rerun)`);
  }
  try {
    const got = exec('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: root, env: TRUSTED_READ_ENV });
    const roots = got.status === 0 ? got.stdout.split(/\s+/).filter((l) => HEX40.test(l)).sort() : [];
    return roots.length > 0 ? `${LOCAL_CLAIM_PREFIX}${roots[0]}` : null;
  } catch (error) {
    if (error instanceof FactorySafetyError) throw error;
    return null;
  }
}

/** localFactoryClaimRepo through the engine's hardened git, as trustedFactoryClaimRepo. */
export function trustedLocalFactoryClaimRepo(exec: Exec, root: string, ledgerDir: string): string | null {
  return localFactoryClaimRepo(hardenedGitExec(exec, emptyHooksDir(ledgerDir)), root);
}

/**
 * factoryClaimRepo through the engine's hardened git (no hooks, no
 * fsmonitor: hardenedGitExec over the ledger dir's empty hooks dir). The
 * one origin read for a claim key: the engine and the omg factory run CLI
 * both use it, over the raw exec.
 */
export function trustedFactoryClaimRepo(exec: Exec, root: string, ledgerDir: string): string | null {
  return factoryClaimRepo(hardenedGitExec(exec, emptyHooksDir(ledgerDir)), root);
}

/** A path as one spelling: realpath when it exists (junctions, symlinks, 8.3 names), normalized, case-folded only where the filesystem folds case. */
function canonicalPath(path: string, platform: NodeJS.Platform): string {
  let abs = normalize(resolve(path));
  try {
    abs = realpathSync.native(abs);
  } catch { /* not here (yet): the normalized spelling */ }
  const slashed = abs.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' || platform === 'darwin' ? slashed.toLowerCase() : slashed;
}

/** github.com's other spellings (ssh over 443, the www alias) are github.com. */
const GITHUB_ALIASES = new Set(['ssh.github.com', 'www.github.com']);

/**
 * The claim directory's key: the repoIdentity of the repository, with
 * github.com aliases folded; a local path (an origin that is another
 * directory) is resolved against the checkout and canonicalized
 * (canonicalPath), so one directory never gets two keys.
 */
export function claimRepoKey(repoUrl: string, root: string, platform: NodeJS.Platform = process.platform): string {
  // A local-forge key names a commit, not a path: never resolved against the checkout.
  const local = repoUrl.startsWith(LOCAL_CLAIM_PREFIX) && HEX40.test(repoUrl.slice(LOCAL_CLAIM_PREFIX.length));
  const id = local ? repoUrl : repoIdentity(repoUrl);
  let key = id;
  if (id.startsWith('gh:')) {
    const [host, ...rest] = id.slice(3).split('/');
    key = `gh:${GITHUB_ALIASES.has(host) ? 'github.com' : host}/${rest.join('/')}`;
  } else if (id.startsWith('path:')) {
    const raw = repoUrl.trim().replace(/^file:\/\//i, '');
    key = `path:${canonicalPath(isAbsolute(raw) ? raw : resolve(root, raw), platform).replace(/\.git$/i, '')}`;
  }
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function factoryClaimsDir(ledgerDir: string, repoUrl: string, root: string): string {
  return join(ledgerDir, 'claims', claimRepoKey(repoUrl, root));
}

export function factoryClaimPath(ledgerDir: string, repoUrl: string, root: string, key: FactoryRunKey): string {
  return join(factoryClaimsDir(ledgerDir, repoUrl, root), `run-${key}.owner`);
}

/** A claim file as written: a live engine's owner record, or a parked one (no pid). */
export type ClaimRecord = Partial<FactoryOwner> & { parkedAt?: string };

/** Why a claim is held: a live engine, a parked or crashed run of another checkout, or a file / root / state nobody can read. */
export interface ClaimHold {
  state: 'live' | 'parked' | 'unreadable';
  path: string;
  claim: ClaimRecord | null;
  why: string;
  /** The claim's checkout is another folder that resolves to this checkout's state root (claimSharesState). */
  sharedState?: true;
}

const isClaimRecord = (v: unknown): v is ClaimRecord =>
  typeof v === 'object' && v !== null && typeof (v as ClaimRecord).hostname === 'string' && typeof (v as ClaimRecord).run === 'string' && typeof (v as ClaimRecord).root === 'string'
  && ((v as ClaimRecord).pid === undefined ? typeof (v as ClaimRecord).parkedAt === 'string' : isOwnerRecord(v));

/**
 * A claim's `root`, only when it is a plain local absolute, normalized path
 * (it is data from a file, never a path to trust as given): no UNC or device
 * path (`\\server`, `//server`, `\\?\`, `\\.\`), which a stat would reach
 * over the network, no relative path, no control character. Checked before
 * anything stats it.
 */
export function claimRoot(root: unknown): string | null {
  if (typeof root !== 'string' || root.length === 0 || root.length > 4096) return null;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(root) || /^[\\/]{2}/.test(root)) return null;
  if (!isAbsolute(root) || resolve(root) !== root) return null;
  return root;
}

/**
 * The phase of the run `key` of the checkout `root` as its engine sealed it,
 * null when that checkout never ran it, or the reason it cannot be told. The
 * state counts only when its bytes are the engine's last write (its ledger
 * entry under `ledgerDir`) and its integrity seal holds; a bare `phase` is
 * never trusted (a lane there could write "merged"). Read-only.
 */
function runPhase(root: string, key: FactoryRunKey, ledgerDir: string): { phase: FactoryPhase | null } | { unreadable: string } {
  const shown = ownerText(root);
  try {
    if (!statSync(root).isDirectory()) return { unreadable: `its checkout ${shown} is not a directory` };
  } catch {
    return { unreadable: `its checkout ${shown} is missing` };
  }
  const unreadable = (why: string) => ({ unreadable: `the run state in ${shown} is unreadable (${why})` });
  let path: string;
  let bytes: Buffer | null;
  try {
    path = factoryStatePath(root, key);
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unreadable('it cannot be read');
    bytes = null;
  }
  let ledger: EngineLedger;
  try {
    ledger = EngineLedger.open(ledgerDir, root, key);
  } catch {
    return unreadable('its engine ledger is unreadable');
  }
  if (bytes === null) {
    if (typeof ledger.recorded(path!) === 'string') return unreadable('it is gone, though its engine wrote it');
    // L2: the engine recorded this run's state under another path (its state root moved, e.g. a changed origin with OMC_STATE_DIR).
    const name = basename(path!);
    // L3: only a LIVE record counts (a deleted state, recorded null, is a cleaned run, not a moved one).
    if (!ledger.tracks(path!) && ledger.trackedPaths().some((p) => basename(p) === name && typeof ledger.recorded(p) === 'string')) return unreadable('its state path moved: its engine wrote it elsewhere');
    return { phase: null };
  }
  if (!ledger.matches(path!, bytes)) return unreadable('it is not the one its engine wrote');
  try {
    const state = parseFactoryState(path!, key, bytes.toString('utf8'));
    return verifyFactoryIntegrity(state) ? { phase: state.phase } : unreadable('it fails its integrity check');
  } catch {
    return unreadable('it does not parse');
  }
}

/**
 * Whether the checkout `other` (a claim's, another folder than `root`)
 * resolves to the state root of `root`: with OMC_STATE_DIR set, the state
 * root is keyed by folder name and origin, so two clones with the same
 * folder name share one state root, lock and run state, and cannot run in
 * parallel (MEDIUM-C: no behaviour change, a warning).
 */
function claimSharesState(other: string, root: string, platform: NodeJS.Platform): boolean {
  try {
    return statSync(other).isDirectory() && canonicalPath(factoryStateDir(other), platform) === canonicalPath(factoryStateDir(root), platform);
  } catch {
    return false;
  }
}

/** The warning a busy message carries when the holder's checkout shares this checkout's state root. */
export const SHARED_STATE_WARNING = 'WARNING: that checkout shares this checkout\'s state root (with OMC_STATE_DIR set, parallel clones need distinct folder names)';

/**
 * Whether the claim text `raw` holds `key` against the engine of `root`
 * (`deps`): a live owner holds; a parked or dead one holds while its
 * checkout's run is non-terminal (runPhase), unless that checkout is `root`
 * itself; a file that does not parse holds. Null: free (taken over by the
 * next claim).
 */
function claimHold(path: string, raw: string, root: string, key: FactoryRunKey, ledgerDir: string, deps: OwnerDeps, platform: NodeJS.Platform): ClaimHold | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isClaimRecord(parsed)) return { state: 'unreadable', path, claim: null, why: `the claim file ${path} is unreadable` };
  const claim = parsed;
  const other = claimRoot(claim.root);
  const here = other !== null && canonicalPath(other, platform) === canonicalPath(root, platform);
  const shared = other !== null && !here && claimSharesState(other, root, platform);
  const held = (state: ClaimHold['state'], why: string): ClaimHold =>
    ({ state, path, claim, why: shared ? `${why}; ${SHARED_STATE_WARNING}` : why, ...(shared ? { sharedState: true as const } : {}) });
  if (claim.pid !== undefined && ownerHolds(claim as FactoryOwner, deps)) return held('live', `claimed by a live engine (${describeOwner(claim)})`);
  if (other === null) return { state: 'unreadable', path, claim, why: `the claim file ${path} names no usable checkout` };
  if (here) return null;
  const phase = runPhase(other, key, ledgerDir);
  if ('unreadable' in phase) return held('unreadable', `claimed (${describeOwner(claim)}), and ${phase.unreadable}`);
  if (phase.phase === null || TERMINAL_FACTORY_PHASES.includes(phase.phase)) return null;
  return held('parked', `claimed by a run parked at ${phase.phase} (${describeOwner(claim)})`);
}

/** The claim holding `key` against the engine of `root`, or null (read-only; acquireFactoryClaim stays the binding check). */
export function factoryClaimHolder(ledgerDir: string, repoUrl: string, root: string, key: FactoryRunKey, deps: OwnerDeps = defaultOwnerDeps(), platform: NodeJS.Platform = process.platform): ClaimHold | null {
  const path = factoryClaimPath(ledgerDir, repoUrl, root, key);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  return claimHold(path, raw, resolve(root), key, ledgerDir, deps, platform);
}

/** The busy message of a held claim; it names the claim file and how a human clears a claim nobody holds. */
export function claimBusyMessage(key: FactoryRunKey, hold: ClaimHold): string {
  const clear = hold.state === 'live' ? '' : `; if no engine will resume it, omg factory run release ${typeof key === 'number' ? key : runLabel(key)} removes the claim`;
  return `factory run ${runLabel(key)} is ${hold.why}; one engine runs an item at a time across clones (claim file ${hold.path})${clear}`;
}

/** A held claim: release() deletes it, park() rewrites it without a pid (the run stopped before a terminal phase); both only while it is still this process's. */
export interface HeldClaim {
  release: () => void;
  park: (at: string) => void;
  tookOver?: ClaimRecord;
}

/** Claim `key` of the repository for the engine in `root`; a held claim (factoryClaimHolder) refuses with a FactoryBusyError. */
export function acquireFactoryClaim(ledgerDir: string, repoUrl: string, root: string, key: FactoryRunKey, now: string, deps: OwnerDeps = defaultOwnerDeps(), platform: NodeJS.Platform = process.platform): HeldClaim {
  const path = factoryClaimPath(ledgerDir, repoUrl, root, key);
  const me = resolve(root);
  ensureDirSync(join(path, '..'));
  // This process's own start identity is read (once, cached) before the file lock: no spawn of ours while holding it.
  const record = `${JSON.stringify(ownerRecord(now, deps, { run: String(key), root: me }))}\n`;
  const tookOver = withOwnerFileLock(path, () => {
    let prior: ClaimRecord | undefined;
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      const hold = claimHold(path, raw, me, key, ledgerDir, deps, platform);
      if (hold) throw new FactoryBusyError(claimBusyMessage(key, hold));
      try { prior = JSON.parse(raw) as ClaimRecord; } catch { /* claimHold read it */ }
    }
    atomicWriteFileSync(path, record);
    return prior;
  });
  const whileMine = (fn: (claim: FactoryOwner) => void) => {
    try {
      withOwnerFileLock(path, () => {
        const claim: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
        if (isOwnerRecord(claim) && claim.pid === deps.pid && claim.hostname === deps.hostname) fn(claim);
      });
    } catch { /* a claim left behind is judged by its checkout's run state */ }
  };
  return {
    release: () => whileMine(() => unlinkSync(path)),
    park: (at) => whileMine((claim) => {
      const parked: ClaimRecord = { hostname: claim.hostname, startedAt: claim.startedAt, ...(claim.run ? { run: claim.run } : {}), ...(claim.root ? { root: claim.root } : {}), parkedAt: at };
      atomicWriteFileSync(path, `${JSON.stringify(parked)}\n`);
    }),
    ...(tookOver ? { tookOver } : {}),
  };
}

/**
 * The engine's end of a run in `root`: a terminal phase or a run that never
 * started (no state) releases the claim; any other phase parks it. The phase
 * counts only as the engine sealed it (runPhase: its ledger entry under
 * `ledgerDir` matches and the integrity seal holds), so a lane that wrote a
 * terminal phase after the engine's last write never frees it (L3); a state
 * that cannot be read or told parks it too: it may hide a run in flight.
 */
export function settleFactoryClaim(claim: HeldClaim, root: string, key: FactoryRunKey, ledgerDir: string, at: string): 'released' | 'parked' {
  let terminal = false;
  try {
    const p = runPhase(root, key, ledgerDir);
    terminal = !('unreadable' in p) && (p.phase === null || TERMINAL_FACTORY_PHASES.includes(p.phase));
  } catch { /* unreadable: parked, never released */ }
  if (terminal) claim.release();
  else claim.park(at);
  return terminal ? 'released' : 'parked';
}

/**
 * Delete the claim on `key` unless a live engine holds it (FactoryBusyError).
 * `onlyRoot`: only a claim of that checkout (run clean / reset); without it,
 * any claim nobody runs (omg factory run release, a human decision). Returns
 * the deleted path, or null when there was nothing to delete.
 */
export function removeFactoryClaim(ledgerDir: string, repoUrl: string, root: string, key: FactoryRunKey, o: { onlyRoot?: boolean; deps?: OwnerDeps; platform?: NodeJS.Platform } = {}): string | null {
  const path = factoryClaimPath(ledgerDir, repoUrl, root, key);
  if (!existsSync(path)) return null;
  const deps = o.deps ?? defaultOwnerDeps();
  const platform = o.platform ?? process.platform;
  return withOwnerFileLock(path, () => {
    if (!existsSync(path)) return null;
    let claim: unknown;
    try { claim = JSON.parse(readFileSync(path, 'utf8')); } catch { claim = undefined; }
    if (isClaimRecord(claim) && claim.pid !== undefined && ownerHolds(claim as FactoryOwner, deps)) {
      throw new FactoryBusyError(claimBusyMessage(key, { state: 'live', path, claim, why: `claimed by a live engine (${describeOwner(claim)})` }));
    }
    if (o.onlyRoot) {
      const other = isClaimRecord(claim) ? claimRoot(claim.root) : null;
      if (other === null || canonicalPath(other, platform) !== canonicalPath(root, platform)) return null;
    }
    unlinkSync(path);
    return path;
  });
}

const CLAIM_FILE = /^run-(\d+|heal-[0-9a-f]{8})\.owner$/;

/** A claim `run status` lists: one that holds against this checkout, or this checkout's own (`here`: its run resumes it). */
export type ListedClaim = { key: FactoryRunKey; state: ClaimHold['state'] | 'here'; path: string; claim: ClaimRecord | null; sharedState?: true };

/** Every claim of the repository that holds against the engine of `root`, and `root`'s own; a free one is left out (read-only). */
export function listFactoryClaims(ledgerDir: string, repoUrl: string, root: string, deps: OwnerDeps = defaultOwnerDeps(), platform: NodeJS.Platform = process.platform): ListedClaim[] {
  const dir = factoryClaimsDir(ledgerDir, repoUrl, root);
  let names: string[] = [];
  try { names = readdirSync(dir).sort(); } catch { /* no claims yet */ }
  const listed: ListedClaim[] = [];
  for (const name of names) {
    const m = CLAIM_FILE.exec(name);
    if (!m) continue;
    const key: FactoryRunKey = /^\d+$/.test(m[1]) ? Number(m[1]) : (m[1] as `heal-${string}`);
    const path = join(dir, name);
    let raw: string;
    try { raw = readFileSync(path, 'utf8'); } catch { continue; }
    const hold = claimHold(path, raw, resolve(root), key, ledgerDir, deps, platform);
    if (hold) {
      listed.push({ key, state: hold.state, path, claim: hold.claim, ...(hold.sharedState ? { sharedState: true as const } : {}) });
      continue;
    }
    let claim: unknown;
    try { claim = JSON.parse(raw); } catch { continue; }
    const other = isClaimRecord(claim) ? claimRoot(claim.root) : null;
    if (isClaimRecord(claim) && other !== null && canonicalPath(other, platform) === canonicalPath(root, platform)) listed.push({ key, state: 'here', path, claim });
  }
  return listed;
}
