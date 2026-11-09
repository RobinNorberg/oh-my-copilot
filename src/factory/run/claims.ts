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
 * origin remote, factoryClaimRepo), so every clone of one repository shares
 * the directory. The claim lives as long as the run is not terminal:
 * - a live engine holds it (pid, host and start identity, as state.ts's
 *   owner files);
 * - when the engine stops before a terminal phase (a park, an error) it
 *   rewrites the claim without a pid ("parked"); a crash leaves its dead pid.
 *   Either way the claim stays held while the run state of its checkout
 *   (`<root>`'s run-<key>.json) exists and is not terminal; a missing or
 *   unreadable root or state keeps it held too, and is reported;
 * - it is deleted at a terminal phase, by `omg factory run clean` / `reset`
 *   of the same checkout, and by `omg factory run release` (a human).
 * The claiming checkout itself always takes its own parked claim back (a
 * resume). A claim is never a trust anchor: a lane that could write it could
 * only block an item or let a second clone start it, which then stops at the
 * forge's pr-exists gate once the first clone pushed.
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { isAbsolute, join, normalize, resolve } from 'path';
import { ensureDirSync } from '../../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../../lib/file-lock.js';
import { repoIdentity } from '../../ship/config.js';
import { TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';
import {
  defaultOwnerDeps, describeOwner, FactoryBusyError, factoryStatePath, isOwnerRecord, ownerHolds, ownerRecord, runLabel, TERMINAL_FACTORY_PHASES,
  type FactoryOwner, type FactoryPhase, type FactoryRunKey, type OwnerDeps,
} from './state.js';

/**
 * The repository a claim is keyed on: the origin remote's URL (`git remote
 * get-url origin`, read-only, the same trusted origin the forge config is
 * derived from), or null without an origin (no cross-clone claim: the local
 * forge's mirror is per checkout). Needs no forge config, so heal runs and
 * `run clean` / `reset` / `release` key their claims the same way.
 */
export function factoryClaimRepo(exec: Exec, root: string): string | null {
  try {
    const got = exec('git', ['remote', 'get-url', 'origin'], { cwd: root, env: TRUSTED_READ_ENV });
    const url = got.status === 0 ? got.stdout.trim() : '';
    return url && !url.includes('\0') ? url : null;
  } catch {
    return null;
  }
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
  const id = repoIdentity(repoUrl);
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
}

const isClaimRecord = (v: unknown): v is ClaimRecord =>
  typeof v === 'object' && v !== null && typeof (v as ClaimRecord).hostname === 'string' && typeof (v as ClaimRecord).run === 'string' && typeof (v as ClaimRecord).root === 'string'
  && ((v as ClaimRecord).pid === undefined ? typeof (v as ClaimRecord).parkedAt === 'string' : isOwnerRecord(v));

/** A claim's `root`, only when it is a plain absolute, normalized path (it is data from a file, never a path to trust as given). */
function claimRoot(root: unknown): string | null {
  if (typeof root !== 'string' || root.length === 0 || root.length > 4096 || /[\0\r\n]/.test(root) || !isAbsolute(root) || resolve(root) !== root) return null;
  return root;
}

/**
 * The phase of the run `key` of the checkout `root` (read-only: the state
 * file's `phase`), null when that checkout has no run state for it, or the
 * reason it cannot be told.
 */
function runPhase(root: string, key: FactoryRunKey): { phase: FactoryPhase | null } | { unreadable: string } {
  try {
    if (!statSync(root).isDirectory()) return { unreadable: `its checkout ${root} is not a directory` };
  } catch {
    return { unreadable: `its checkout ${root} is missing` };
  }
  let raw: string;
  try {
    raw = readFileSync(factoryStatePath(root, key), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { phase: null } : { unreadable: `the run state in ${root} cannot be read` };
  }
  try {
    const phase = (JSON.parse(raw) as { phase?: unknown }).phase;
    if (typeof phase === 'string') return { phase: phase as FactoryPhase };
  } catch { /* below */ }
  return { unreadable: `the run state in ${root} is unreadable` };
}

/**
 * Whether the claim text `raw` holds `key` against the engine of `root`
 * (`deps`): a live owner holds; a parked or dead one holds while its
 * checkout's run is non-terminal, unless that checkout is `root` itself; a
 * file that does not parse holds. Null: free (taken over by the next claim).
 */
function claimHold(path: string, raw: string, root: string, key: FactoryRunKey, deps: OwnerDeps, platform: NodeJS.Platform): ClaimHold | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isClaimRecord(parsed)) return { state: 'unreadable', path, claim: null, why: `the claim file ${path} is unreadable` };
  const claim = parsed;
  if (claim.pid !== undefined && ownerHolds(claim as FactoryOwner, deps)) return { state: 'live', path, claim, why: `claimed by a live engine (${describeOwner(claim)})` };
  const other = claimRoot(claim.root);
  if (other === null) return { state: 'unreadable', path, claim, why: `the claim file ${path} names no usable checkout` };
  if (canonicalPath(other, platform) === canonicalPath(root, platform)) return null;
  const phase = runPhase(other, key);
  if ('unreadable' in phase) return { state: 'unreadable', path, claim, why: `claimed (${describeOwner(claim)}), and ${phase.unreadable}` };
  if (phase.phase === null || TERMINAL_FACTORY_PHASES.includes(phase.phase)) return null;
  return { state: 'parked', path, claim, why: `claimed by a run parked at ${phase.phase} (${describeOwner(claim)})` };
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
  return claimHold(path, raw, resolve(root), key, deps, platform);
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
  const tookOver = withFileLockSync(lockPathFor(path), () => {
    let prior: ClaimRecord | undefined;
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      const hold = claimHold(path, raw, me, key, deps, platform);
      if (hold) throw new FactoryBusyError(claimBusyMessage(key, hold));
      try { prior = JSON.parse(raw) as ClaimRecord; } catch { /* claimHold read it */ }
    }
    writeFileSync(path, `${JSON.stringify(ownerRecord(now, deps, { run: String(key), root: me }))}\n`, 'utf8');
    return prior;
  }, { timeoutMs: 5_000 });
  const whileMine = (fn: (claim: FactoryOwner) => void) => {
    try {
      withFileLockSync(lockPathFor(path), () => {
        const claim: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
        if (isOwnerRecord(claim) && claim.pid === deps.pid && claim.hostname === deps.hostname) fn(claim);
      }, { timeoutMs: 5_000 });
    } catch { /* a claim left behind is judged by its checkout's run state */ }
  };
  return {
    release: () => whileMine(() => unlinkSync(path)),
    park: (at) => whileMine((claim) => {
      const parked: ClaimRecord = { hostname: claim.hostname, startedAt: claim.startedAt, ...(claim.run ? { run: claim.run } : {}), ...(claim.root ? { root: claim.root } : {}), parkedAt: at };
      writeFileSync(path, `${JSON.stringify(parked)}\n`, 'utf8');
    }),
    ...(tookOver ? { tookOver } : {}),
  };
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
  return withFileLockSync(lockPathFor(path), () => {
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
  }, { timeoutMs: 5_000 });
}

const CLAIM_FILE = /^run-(\d+|heal-[0-9a-f]{8})\.owner$/;

/** A claim `run status` lists: one that holds against this checkout, or this checkout's own (`here`: its run resumes it). */
export type ListedClaim = { key: FactoryRunKey; state: ClaimHold['state'] | 'here'; path: string; claim: ClaimRecord | null };

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
    const hold = claimHold(path, raw, resolve(root), key, deps, platform);
    if (hold) {
      listed.push({ key, state: hold.state, path, claim: hold.claim });
      continue;
    }
    let claim: unknown;
    try { claim = JSON.parse(raw); } catch { continue; }
    const other = isClaimRecord(claim) ? claimRoot(claim.root) : null;
    if (isClaimRecord(claim) && other !== null && canonicalPath(other, platform) === canonicalPath(root, platform)) listed.push({ key, state: 'here', path, claim });
  }
  return listed;
}
