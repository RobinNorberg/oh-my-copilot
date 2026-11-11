/**
 * What the engine does after a detected tamper of the shared git dir (audit
 * M3): quarantine what changed, put the snapshot's bytes back where that is
 * safe, and hold every new run in this checkout until a human clears it.
 *
 * Before, a lane-tampered park left the planted hook, config key or ref in
 * `.git`: the user's next commit or checkout ran it, and the next run took
 * the tampered state as its baseline.
 *
 * Now, on lane-tampered, review-tampered and prepare-tampered (and a late
 * change found by the recheck), after the lane's process tree was killed,
 * compared with the snapshot taken by THIS run before the lane or prepare
 * (RepoSnapshot.restore keeps the bytes, restorableFiles), item by item:
 * - hooks/ and info/ (not info/refs) of the common git dir and of every
 *   submodule git dir under modules/: every file added or changed is saved
 *   into `<ledgerDir>/quarantine/<repo>/<stamp>/` and the snapshot's bytes
 *   are written back (an added file is removed); a deleted file is restored.
 * - config, config.worktree, every worktrees/<id>/config.worktree and the
 *   submodules' config files: saved into the quarantine always. When every
 *   added, changed or removed key is benign (BENIGN_KEYS: keys that name no
 *   program and redirect nothing, user.*, a remote's tag and prune
 *   options...; a branch's remote, pushremote and merge only by value, see
 *   benignChange) the file stays as it is: that is what a user's own
 *   `git push -u origin x` or `git config user.email` during the run
 *   writes. Any other key counts as program-running or redirecting (an
 *   allowlist, so a key git adds later, or one like diff.external, is never
 *   missed; a remote's url, pushurl and fetch are not on it, review-484b 1:
 *   they send the user's next fetch, pull or push where the lane chose): its
 *   old values are put back under git's own lock (`<file>.lock` created
 *   exclusively, the file read again under it, the keys merged onto THAT
 *   content with `git config --file` on a copy, written into the lock and
 *   renamed over; the whole old file when a key cannot be merged exactly),
 *   and the undo command for the user's own change is in undo.txt.
 * - refs: a created refs/replace/* is deleted (its value saved); every other
 *   ref change is only listed with the update-ref command that undoes it,
 *   because the user's own commit or branch switch during a run moves refs
 *   too, and moving those back would hide their work.
 * Each item on its own: a copy that fails (a file the lane made unreadable)
 * renames the item into the quarantine (or `<name>.omg-quarantined` next to
 * it on another volume), which needs no read; an item that can be neither
 * saved nor restored is named STILL ACTIVE, and the rest go on. Nothing is
 * deleted that is not first saved. A hook or info/ restore writes a
 * temporary file next to the target and renames it over (atomic); a config
 * restore goes through the lock above, and a lock someone else holds leaves
 * that item STILL ACTIVE. A file the snapshot holds only as a hash (over
 * 1 MiB, unreadable) or a link is moved away but not written back.
 *
 * Every compare problem that is not a ref change, an allowlisted config
 * change, a change the restore above undid, or a change that runs nothing
 * (the main checkout's files or HEAD, another worktree's HEAD, a removed
 * worktree or submodule) is named STILL ACTIVE with what to do: the global
 * git config and its include targets, objects/info/alternates, the shallow
 * file, links in place of directories, the main checkout's .env / .npmrc /
 * node_modules/.bin, a snapshot that failed.
 *
 * The hold is set unless only refs (not replace refs), allowlisted config
 * keys and changes that run nothing were found. The hold
 * (`<ledgerDir>/holds/<repo>.json`) makes `omg factory run`, the poller's
 * auto-start and the engine refuse (exit 6) with the quarantine path, until
 * `omg factory run release --tamper` (a human) prints what was quarantined
 * and removes it. An unreadable hold counts as held.
 *
 * Parameterised by the snapshot's common git dir and the checkout root only,
 * so a run whose lanes work in another repository (a private store) passes
 * that repository's snapshot; the hold stays keyed on the checkout.
 */

import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { atomicWriteFileSync } from '../../lib/atomic-write.js';
import { runHostGit } from '../../team/git-worktree.js';
import { sha256 } from './ledger.js';
import { restorableFiles, RESTORE_SCOPE, RESTORE_SCOPE_KEY, type RepoSnapshot } from './review-guard.js';

/** The checkout's key under quarantine/ and holds/ (the ledger's own per-root key). */
export const repoKey = (root: string): string => sha256(resolve(root).toLowerCase()).slice(0, 16);

export const tamperHoldPath = (ledgerDir: string, root: string): string => join(ledgerDir, 'holds', `${repoKey(root)}.json`);

export const RELEASE_TAMPER_COMMAND = 'omg factory run release --tamper';

/** The prefix of every `active` entry. */
export const STILL_ACTIVE = 'STILL ACTIVE (it can run on your next git command)';

export interface TamperHold {
  root: string;
  at: string;
  run: string;
  gate: string;
  /** The quarantine folder, absent when nothing was saved there. */
  quarantine?: string;
  moved: string[];
  restored: string[];
  notRestored: string[];
  refs: string[];
  /** Config files left as they are: only allowlisted keys changed. */
  kept?: string[];
  /** What is still in place and can run code or steer git, with what to do. */
  active?: string[];
  /** How to put the user's own change back, per item (also undo.txt in the quarantine). */
  undo?: string[];
  failed?: string;
  /** True when the hold was set; false: only listed and copied, or the hold file could not be written (holdNotWritten). */
  held?: boolean;
  /** Why the hold file could not be written, when a hold was due: no run is held. */
  holdNotWritten?: string;
}

/**
 * Config keys that name no program and make git load nothing (as `git config
 * --list` prints them: section and key lowercased, subsection kept). A
 * change to any other key is put back. Each with why it is safe:
 */
export const BENIGN_KEYS: readonly { re: RegExp; why: string }[] = [
  { re: /^user\.[^.]+$/, why: 'who commits (name, email, the signing key name): the signing program is gpg.*, which is not on this list' },
  // Not remote, pushremote or merge (review-484c 1): those are benign only by their values, see benignChange.
  { re: /^branch\..+\.(?:rebase|description)$/, why: 'a branch\'s pull mode and description; neither names a program or a place' },
  { re: /^branch\..+\.vscode-merge-base$/, why: 'written by VS Code when it creates a branch; git never reads it' },
  // Not url, pushurl or fetch (review-484b 1): they send the user's next push to a host the lane picks, or fetch its
  // commits and refs (refs/replace/* too) into the user's repository on the next plain `git fetch` or `git pull`.
  { re: /^remote\..+\.(?:tagopt|prune|prunetags)$/, why: 'which tags a fetch follows and whether it prunes gone remote branches, from the remote the user configured into its own remote-tracking refs' },
  { re: /^remote\..+\.gh-resolved$/, why: 'written by the GitHub CLI to pick the base remote; git never reads it' },
  { re: /^maintenance\.(?:auto|strategy|[^.]+\.(?:enabled|schedule))$/, why: '`git maintenance start` writes them; they pick only git\'s own built-in tasks' },
];

export const benignKey = (key: string): boolean => BENIGN_KEYS.some((b) => b.re.test(key));

/** A config file's values per key, in order (null for a bare boolean); keys as `git config --list` prints them. */
export type ConfigValues = ReadonlyMap<string, readonly (string | null)[]>;

const BRANCH_UPSTREAM = /^branch\.(.+)\.(remote|pushremote|merge)$/;
/** A local branch ref: no `..`, no control character, nothing else git refuses in a ref name. */
const HEADS_REF = /^refs\/heads\/(?!.*\.\.)[^\p{Cc}\s~^:?*[\\]+$/u;

const sameValues = (a: readonly (string | null)[] | undefined, b: readonly (string | null)[] | undefined): boolean => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/**
 * `name` is a plain remote name (not a path, a URL or `.`) of a remote that
 * had a url in the snapshot's config, and whose url, pushurl and fetch are
 * the same now: a pull or push through it reaches only what the user had
 * configured before the run.
 */
function unchangedOldRemote(name: string | null | undefined, was: ConfigValues, now: ConfigValues): boolean {
  if (typeof name !== 'string' || /^\.*$/.test(name) || /[/:\\\s\p{Cc}]/u.test(name)) return false;
  if (!was.get(`remote.${name}.url`)?.length) return false;
  return ['url', 'pushurl', 'fetch'].every((k) => sameValues(was.get(`remote.${name}.${k}`), now.get(`remote.${name}.${k}`)));
}

/**
 * Whether one key that was added, changed or removed between `was` (the
 * snapshot's config) and `now` is benign. Pure.
 *
 * branch.<b>.remote, pushremote and merge decide what the user's next plain
 * `git pull` merges and where a plain `git push` goes, and git takes a path,
 * a URL or `.` (this repository) there with no remote.* key changed
 * (review-484c 1). So they are benign by value only:
 * - removed: it can only take a default away from a pull or a push;
 * - remote / pushremote: the plain name of a remote that existed before the
 *   run and is unchanged (unchangedOldRemote): the user's own
 *   `git push -u origin x`;
 * - merge: every value is refs/heads/<name> and the branch's remote as git
 *   reads it now passes the rule above: a pull can then only bring what the
 *   user's own unchanged remote serves.
 * Every other key is benign only when on BENIGN_KEYS.
 */
export function benignChange(key: string, was: ConfigValues, now: ConfigValues): boolean {
  const m = BRANCH_UPSTREAM.exec(key);
  if (!m) return benignKey(key);
  const values = now.get(key);
  if (!values?.length) return true;
  if (m[2] === 'merge') {
    const remote = now.get(`branch.${m[1]}.remote`);
    return values.every((v) => typeof v === 'string' && HEADS_REF.test(v)) && remote?.length === 1 && unchangedOldRemote(remote[0], was, now);
  }
  return values.length === 1 && unchangedOldRemote(values[0], was, now);
}

/** `[key, value]` entries of a config file, in order, as git parses it (`--file` follows no include); value null for a bare boolean. */
function configEntries(bytes: Buffer | null, tmp: string): [string, string | null][] | null {
  if (bytes === null) return [];
  const file = join(tmp, `cfg-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, bytes);
  try {
    const out = runHostGit(tmp, ['config', '--file', file, '--null', '--list'], 30_000);
    return out.split('\0').filter(Boolean).map((e) => {
      const nl = e.indexOf('\n');
      return nl < 0 ? [e, null] : [e.slice(0, nl), e.slice(nl + 1)];
    });
  } catch {
    return null;
  } finally {
    try { unlinkSync(file); } catch { /* temp */ }
  }
}

const valuesByKey = (entries: [string, string | null][]): Map<string, (string | null)[]> => {
  const m = new Map<string, (string | null)[]>();
  for (const [k, v] of entries) m.set(k, [...(m.get(k) ?? []), v]);
  return m;
};

/**
 * The keys whose values (in order) differ, added and removed ones included,
 * and those of them that are not benign (benignChange, on both files'
 * values); null when a file does not parse.
 */
function changedKeys(before: Buffer | null, after: Buffer | null, tmp: string): { keys: string[]; held: string[] } | null {
  const wasEntries = configEntries(before, tmp);
  const nowEntries = configEntries(after, tmp);
  if (!wasEntries || !nowEntries) return null;
  const was = valuesByKey(wasEntries);
  const now = valuesByKey(nowEntries);
  const keys = [...new Set([...was.keys(), ...now.keys()])].filter((k) => !sameValues(was.get(k), now.get(k))).sort();
  return { keys, held: keys.filter((k) => !benignChange(k, was, now)) };
}

/**
 * `current` with `keys` set back to their values in `old` (git config on a
 * copy, so the user's other changes stay); null when that cannot be done
 * exactly (a bare boolean, a git failure): the caller puts the whole old file back.
 */
function putKeysBack(current: Buffer, old: Buffer, keys: readonly string[], tmp: string): Buffer | null {
  const entries = configEntries(old, tmp);
  if (!entries) return null;
  const file = join(tmp, `merge-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, current);
  try {
    for (const key of keys) {
      const values = entries.filter(([k]) => k === key).map(([, v]) => v);
      if (values.some((v) => v === null)) return null;
      try {
        runHostGit(tmp, ['config', '--file', file, '--unset-all', key], 30_000);
      } catch (error) {
        // 5: the key is not there (it was removed, or only added and now goes back to absent).
        if ((error as { status?: number }).status !== 5) return null;
      }
      for (const v of values) runHostGit(tmp, ['config', '--file', file, '--add', key, v as string], 30_000);
    }
    return readFileSync(file);
  } catch {
    return null;
  } finally {
    try { unlinkSync(file); } catch { /* temp */ }
  }
}

const decode = (v: string | undefined): Buffer | null => (v?.startsWith('b64:') ? Buffer.from(v.slice(4), 'base64') : v?.startsWith('b64x:') ? Buffer.from(v.slice(5), 'base64') : null);

/** A config file the snapshot keeps (not a hook or info/ file that happens to be called config). */
const isConfigRel = (rel: string): boolean => /^(?:config|config\.worktree|worktrees\/[^/]+\/config\.worktree|modules\/.+\/(?:config|config\.worktree))$/.test(rel) && !/\/(?:hooks|info)\//.test(`/${rel}`);

/** The git dir a submodule's or another worktree's item belongs to (null: the common git dir's own). */
function ownerOf(rel: string): string | null {
  if (rel.startsWith('worktrees/')) return rel.split('/').slice(0, 2).join('/');
  if (!rel.startsWith('modules/')) return null;
  return /^(.*?)\/(?:config|config\.worktree|hooks|info)(?:\/.*)?$/.exec(rel)?.[1] ?? null;
}

const realDir = (path: string): boolean => {
  try { const st = lstatSync(path); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
};

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Every directory from `common` down to `rel`'s parent is a real directory (a link there would redirect the write). */
function assertParentsReal(common: string, rel: string): void {
  const segs = rel.split('/').slice(0, -1);
  let dir = common;
  for (const s of segs) {
    dir = join(dir, s);
    let st;
    try { st = lstatSync(dir); } catch { mkdirSync(dir); continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a real directory`);
  }
}

/** The reason a config restore fails while someone else holds `<file>.lock`. */
export const CONFIG_LOCKED = 'git config is locked by another process';

/**
 * Rewrite the config file `abs` under git's own lock protocol (review-484b
 * 3): `<abs>.lock` created with O_EXCL (held: CONFIG_LOCKED), the file read
 * again under the lock, `compute` on THAT content (null: the file goes),
 * written into the lock file and renamed over the file. A `git config` that
 * ran after the engine first read the file is kept; one that runs now fails
 * on the lock, as between two git commands.
 */
function restoreConfigLocked(abs: string, compute: (locked: Buffer | null) => Buffer | null): void {
  const lock = `${abs}.lock`;
  let fd: number | undefined;
  try {
    fd = openSync(lock, 'wx', 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(CONFIG_LOCKED);
    throw error;
  }
  try {
    let locked: Buffer | null = null;
    try { locked = readFileSync(abs); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const out = compute(locked);
    if (out === null) {
      closeSync(fd);
      fd = undefined;
      if (locked !== null) unlinkSync(abs);
      unlinkSync(lock);
      return;
    }
    writeSync(fd, out);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(lock, abs);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(lock); } catch { /* renamed or gone */ }
    throw error;
  }
}

/** Write `bytes` at `abs` atomically (temp file next to it, then rename); refuses while git holds `<abs>.lock`. */
function atomicRestore(abs: string, bytes: Buffer, exec: boolean): void {
  if (existsSync(`${abs}.lock`)) throw new Error(`${basename(abs)}.lock exists (a git command is writing it), so it was not restored`);
  let st;
  try { st = lstatSync(abs); } catch { st = undefined; }
  if (st?.isDirectory()) rmdirSync(abs);
  else if (st?.isSymbolicLink()) removeEntry(abs);
  const tmp = `${abs}.omg-restore-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, bytes, { mode: exec ? 0o755 : 0o644, flag: 'wx' });
  try {
    if (exec) chmodSync(tmp, 0o755);
    renameSync(tmp, abs);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

/** Remove a file or a link (a directory symlink or junction: the link only, never its target). */
function removeEntry(abs: string): void {
  try {
    unlinkSync(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code !== 'EPERM' && code !== 'EISDIR') || !lstatSync(abs).isSymbolicLink()) throw error;
    rmdirSync(abs);
  }
}

/** The first free `<abs>.omg-quarantined[-n]`. */
function asideName(abs: string): string {
  for (let n = 0; ; n++) {
    const p = `${abs}.omg-quarantined${n ? `-${n}` : ''}`;
    if (!existsSync(p)) return p;
  }
}

/** Links are saved under this top-level folder of the quarantine (their target as text), so `x` never collides with a file `x.link`. */
const LINKS_DIR = '.links';

/** Compare problems that run nothing or that the steps above handle (see the module comment). */
function problemStatus(p: string, touched: (prefix: string) => boolean, before: RepoSnapshot, after: RepoSnapshot | undefined): 'ok' | 'unhandled' {
  if (/^ref \S+ /.test(p)) return 'ok';
  if (/^the main checkout's (?:HEAD moved|HEAD switched|working tree changed)/.test(p)) return 'ok';
  if (/^the checkout's branch \S+ is gone$/.test(p)) return 'ok';
  if (p === 'the common git config changed') return touched('config') ? 'ok' : 'unhandled';
  if (p === 'config.worktree changed') return touched('config.worktree') ? 'ok' : 'unhandled';
  if (p === 'the hooks/ directory changed') return touched('hooks/') ? 'ok' : 'unhandled';
  if (p === 'the info/ directory changed') return touched('info/') ? 'ok' : 'unhandled';
  let m = /^worktrees\/([^/]+)\/config\.worktree changed$/.exec(p);
  if (m) return touched(`worktrees/${m[1]}/config.worktree`) ? 'ok' : 'unhandled';
  m = /^submodule git dir (modules\/.+) was removed$/.exec(p);
  if (m) return 'ok';
  m = /^submodule git dir (modules\/.+) was added$/.exec(p) ?? /^(modules\/.+) changed \(config, hooks, info or alternates\)$/.exec(p);
  // A submodule's alternates are hashed but not kept: named when the file is there.
  if (m) return touched(`${m[1]}/`) && !existsSync(join(before.commonDir, ...m[1].split('/'), 'objects', 'info', 'alternates')) ? 'ok' : 'unhandled';
  m = /^worktree entry worktrees\/([^/]+) was added$/.exec(p);
  if (m) return after?.worktrees?.[m[1]]?.commondir === '../..' ? 'ok' : 'unhandled';
  if (/^worktree entry worktrees\/[^/]+ was removed or is no longer a directory$/.test(p)) return 'ok';
  m = /^worktrees\/([^/]+) changed \(HEAD, gitdir, commondir or per-worktree refs\)$/.exec(p);
  if (m) {
    const was = before.worktrees?.[m[1]];
    const now = after?.worktrees?.[m[1]];
    // Only its HEAD or per-worktree refs moved (a checkout in that worktree): nothing runs from them.
    return was && now && !now.notDir && was.gitdir === now.gitdir && was.commondir === now.commondir ? 'ok' : 'unhandled';
  }
  return 'unhandled';
}

function advice(p: string, common: string): string {
  if (/^lane \S+'s process/.test(p)) return 'make sure no process of that lane still runs (copilot, node, git or a shell started from its worktree: Task Manager or ps) before you release the hold; one that runs can change .git again';
  if (/global git config/.test(p)) return 'check ~/.gitconfig, $XDG_CONFIG_HOME/git/config and every include.path / includeIf target they or the repository config name, and remove what you did not add';
  if (/^an ignored file in the main checkout changed/.test(p)) return 'check .env*, .npmrc, .yarnrc, .yarnrc.yml and node_modules/.bin in the checkout (they also run on your next npm or yarn command) and remove what you did not add';
  if (/snapshot failed/.test(p)) return `the engine could not tell what changed: check ${common} (config, hooks, info, refs) by hand`;
  return `inspect it in ${common} and remove what you did not add`;
}

export interface QuarantineInput {
  ledgerDir: string;
  root: string;
  before: RepoSnapshot;
  /** The after-snapshot when there is one (decides whether a worktree entry change runs anything). */
  after?: RepoSnapshot;
  /** The refs as they are now (the after-snapshot's, or read again). */
  refsNow?: Record<string, string>;
  /** Only these refs count (the ones the tamper compare reported); omitted = every difference. */
  onlyRefs?: readonly string[];
  /** The compare's problems: each not handled here is named STILL ACTIVE and holds. */
  problems?: readonly string[];
  /** Test seam: called right before a config file's lock is taken (where a concurrent `git config` would land). */
  beforeConfigLock?: (abs: string) => void;
  run: string;
  gate: string;
  at: string;
}

/**
 * Quarantine and restore after a tamper (see the module comment), then
 * write the hold. Never throws: a failure is in `failed` or `active`, and
 * the hold is still written when it can be.
 */
export function quarantineTamper(i: QuarantineInput): TamperHold {
  const hold: TamperHold = { root: resolve(i.root), at: i.at, run: i.run, gate: i.gate, moved: [], restored: [], notRestored: [], refs: [], kept: [], active: [], undo: [] };
  const common = i.before.commonDir;
  const kept = i.before.restore;
  const touchedRels: string[] = [];
  const failedRels = new Set<string>();
  const dir = join(i.ledgerDir, 'quarantine', repoKey(i.root), i.at.replace(/[:.]/g, '-'));
  const quarantine = (): string => {
    if (!hold.quarantine) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      hold.quarantine = dir;
    }
    return dir;
  };
  if (!kept) {
    hold.failed = 'the snapshot from before the lane was recorded by an older release and holds no bytes, so nothing was quarantined or restored';
  } else {
    let now: Record<string, string> | null = null;
    try { now = restorableFiles(common); } catch (error) { hold.failed = `the repository's git dir could not be read: ${errText(error)}`; }
    if (now) {
      const scoped = kept[RESTORE_SCOPE_KEY] === RESTORE_SCOPE;
      const changed = [...new Set([...Object.keys(kept), ...Object.keys(now)])]
        .filter((rel) => rel !== RESTORE_SCOPE_KEY && kept[rel] !== now![rel] && (scoped || !/^(?:modules|worktrees)\//.test(rel)))
        .sort();
      touchedRels.push(...changed);
      const tmp = join(dir, '.tmp');
      const movedAway: string[] = [];
      // Additions first, deepest first (a file that became a directory is emptied before the file comes back; a link
      // put in place of hooks/ goes before what was under it is restored), then the rest, parents first.
      const added = changed.filter((rel) => kept[rel] === undefined).reverse();
      for (const rel of [...added, ...changed.filter((rel) => kept[rel] !== undefined)]) {
        // Under something already moved away whole (a directory renamed aside): it went with it.
        if (movedAway.some((p) => rel.startsWith(`${p}/`))) continue;
        try {
          const renamed = handleItem(rel, kept[rel], now[rel]);
          if (renamed) movedAway.push(rel);
        } catch (error) {
          failedRels.add(rel);
          hold.active!.push(`${rel}: ${STILL_ACTIVE}: it could not be moved or restored (${errText(error)}); remove or fix it by hand in ${common}`);
        }
      }
      rmSync(tmp, { recursive: true, force: true });

      // One item: true when it was renamed away (rather than copied).
      function handleItem(rel: string, was: string | undefined, is: string | undefined): boolean {
        const abs = join(common, ...rel.split('/'));
        const owner = ownerOf(rel);
        // A worktree or submodule git dir that is gone (git worktree remove, a deleted submodule): nothing reads it; never recreated.
        if (owner && !realDir(join(common, ...owner.split('/')))) {
          hold.kept!.push(`${rel} (its git dir ${owner} is gone; nothing was recreated)`);
          return false;
        }
        const old = decode(was);
        if (isConfigRel(rel) && (was === undefined || old !== null) && (is?.startsWith('b64') ?? false)) {
          const current = decode(is)!;
          quarantine();
          mkdirSync(tmp, { recursive: true });
          const diff = changedKeys(old, current, tmp);
          if (diff !== null) {
            const { keys, held: program } = diff;
            if (program.length === 0) {
              let copy = '';
              try { copy = `; a copy is in ${saveBytes(rel, current)}`; } catch { /* the file stays; nothing to undo */ }
              hold.kept!.push(`${rel} (only ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''} changed: allowlisted keys that name no program; left as it is${copy})`);
              return false;
            }
            const to = saveBytes(rel, current);
            assertParentsReal(common, rel);
            i.beforeConfigLock?.(abs);
            // Under the lock, on the file as it is NOW: which keys go back, and the merge (a later `git config` stays).
            let putBack = program;
            let exact = false;
            restoreConfigLocked(abs, (locked) => {
              if (locked === null) return old;
              // The user's version as it is now (it may hold a key written since the first read).
              if (!locked.equals(current)) writeFileSync(to, locked);
              const keysNow = changedKeys(old, locked, tmp);
              if (keysNow !== null) {
                putBack = keysNow.held;
                if (putBack.length === 0) { exact = true; return locked; }
              }
              const out = keysNow !== null && old !== null ? putKeysBack(locked, old, putBack, tmp) : null;
              exact = out !== null;
              return out ?? old;
            });
            if (old === null) hold.moved.push(rel);
            else hold.restored.push(`${rel} (${putBack.slice(0, 5).join(', ')}${putBack.length > 5 ? ', ...' : ''} put back${exact ? '' : '; the whole file, so other changes to it are only in the copy'})`);
            hold.undo!.push(`${rel}: if the change was yours, put your version back: cp "${to}" "${abs}"`);
            return false;
          }
        }
        let renamed = false;
        if (is !== undefined) {
          const saved = saveCurrent(rel, abs, is);
          renamed = saved.renamed;
          hold.undo!.push(is.startsWith('link:')
            ? `${rel}: was a link to ${is.slice(5)} (saved in ${saved.at}); if it was yours, make it again`
            : `${rel}: if it was yours, put it back: cp "${saved.at}" "${abs}"`);
        }
        if (was === undefined) {
          if (is !== undefined && !renamed) removeEntry(abs);
          hold.moved.push(rel);
          return renamed;
        }
        if (old !== null) {
          assertParentsReal(common, rel);
          atomicRestore(abs, old, was.startsWith('b64x:'));
          if (is !== undefined) hold.moved.push(rel);
          hold.restored.push(rel);
          return renamed;
        }
        // The snapshot holds no bytes (a link, over 1 MiB, unreadable): the changed item must not stay where git runs or reads it.
        if (is !== undefined && !renamed) removeEntry(abs);
        if (is !== undefined) hold.moved.push(rel);
        if (was.startsWith('link:')) {
          try {
            assertParentsReal(common, rel);
            symlinkSync(was.slice(5), abs);
            hold.restored.push(rel);
          } catch (error) {
            hold.notRestored.push(`${rel} (a link to ${was.slice(5)} before the run; it could not be made again: ${errText(error)})`);
          }
        } else {
          hold.notRestored.push(`${rel} (${was.startsWith('big:') ? 'over 1 MiB' : 'unreadable'} before the run, so only its hash was kept${is !== undefined ? '; the changed one was moved to the quarantine' : ''})`);
        }
        return renamed;
      }

      function saveBytes(rel: string, bytes: Buffer): string {
        const to = join(quarantine(), ...rel.split('/'));
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, bytes);
        return to;
      }

      // The item as it is now into the quarantine: its bytes when the snapshot read them, else a copy, else renamed (no read needed).
      function saveCurrent(rel: string, abs: string, is: string): { at: string; renamed: boolean } {
        if (is.startsWith('link:')) {
          const to = join(quarantine(), LINKS_DIR, ...rel.split('/'));
          mkdirSync(dirname(to), { recursive: true });
          writeFileSync(to, is.slice(5));
          return { at: to, renamed: false };
        }
        const bytes = decode(is);
        if (bytes) {
          const to = saveBytes(rel, bytes);
          if (is.startsWith('b64x:')) chmodSync(to, 0o755);
          return { at: to, renamed: false };
        }
        const to = join(quarantine(), ...rel.split('/'));
        mkdirSync(dirname(to), { recursive: true });
        try {
          copyFileSync(abs, to);
          return { at: to, renamed: false };
        } catch { /* unreadable: rename it below */ }
        try {
          renameSync(abs, to);
          return { at: to, renamed: true };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        }
        const aside = asideName(abs);
        renameSync(abs, aside);
        return { at: aside, renamed: true };
      }
    }
  }
  try {
    hold.refs = refChanges(i.before.refs, i.refsNow ?? i.before.refs, common, () => quarantine(), i.onlyRefs);
  } catch (error) {
    hold.failed = `${hold.failed ? `${hold.failed}; ` : ''}the ref changes could not be handled: ${errText(error)}`;
  }
  // Compare problems the steps above did not undo: named, and they hold.
  const touched = (prefix: string) => touchedRels.some((r) => (r === prefix || (prefix.endsWith('/') && (r.startsWith(prefix) || r === prefix.slice(0, -1)))) && !failedRels.has(r));
  for (const p of i.problems ?? []) {
    if (problemStatus(p, touched, i.before, i.after) === 'unhandled') hold.active!.push(`${p}: ${STILL_ACTIVE}; ${advice(p, common)}`);
  }
  if (hold.quarantine && hold.undo!.length > 0) {
    try { writeFileSync(join(hold.quarantine, 'undo.txt'), `${hold.undo!.join('\n')}\n`); } catch { /* the hold lists them too */ }
  }
  // Nothing differs and nothing is active (the change was the main checkout's files): no hold, the park alone stops this run.
  if (!hold.failed && hold.moved.length + hold.restored.length + hold.notRestored.length + hold.refs.length + hold.kept!.length + hold.active!.length === 0) {
    if (hold.quarantine) rmSync(hold.quarantine, { recursive: true, force: true });
    delete hold.quarantine;
    return hold;
  }
  // No hold when only refs (not replace refs) and allowlisted config keys changed: what the user's own git does during a run.
  const replaced = hold.refs.some((r) => r.startsWith('refs/replace/'));
  if (!hold.failed && hold.moved.length + hold.restored.length + hold.notRestored.length + hold.active!.length === 0 && !replaced) return hold;
  hold.held = true;
  try {
    writeTamperHold(i.ledgerDir, i.root, hold);
  } catch (error) {
    // No hold file exists, so nothing holds the next run (review-484c 8): the caller says so.
    hold.held = false;
    hold.holdNotWritten = errText(error);
    hold.failed = `${hold.failed ? `${hold.failed}; ` : ''}the hold could not be written: ${errText(error)}`;
  }
  return hold;
}

/** Ref changes since the snapshot: a created replace ref is deleted (value saved); others are listed with their undo command. */
function refChanges(before: Record<string, string>, now: Record<string, string>, common: string, quarantine: () => string, only?: readonly string[]): string[] {
  const out: string[] = [];
  const saved: string[] = [];
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((n) => !only || only.includes(n)).sort()) {
    const was = before[name];
    const is = now[name];
    if (was === is) continue;
    if (was === undefined && name.startsWith('refs/replace/')) {
      saved.push(`${name} ${is}`);
      writeFileSync(join(quarantine(), 'refs.txt'), `${saved.join('\n')}\n`);
      runHostGit(common, ['--git-dir', common, 'update-ref', '-d', name, is], 30_000);
      out.push(`${name} was created at ${is.slice(0, 12)}: deleted (saved in refs.txt)`);
    } else if (was === undefined) out.push(`${name} was created at ${is.slice(0, 12)}; if you did not make it: git update-ref -d ${name} ${is}`);
    else if (is === undefined) out.push(`${name} was deleted (was ${was.slice(0, 12)}); to put it back: git update-ref ${name} ${was}`);
    else out.push(`${name} moved ${was.slice(0, 12)} -> ${is.slice(0, 12)}; if you did not move it: git update-ref ${name} ${was} ${is}`);
  }
  if (out.length > 0) writeFileSync(join(quarantine(), 'refs.txt'), `${[...saved, ...out].join('\n')}\n`);
  return out;
}

export function writeTamperHold(ledgerDir: string, root: string, hold: TamperHold): void {
  const path = tamperHoldPath(ledgerDir, root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, `${JSON.stringify(hold, null, 2)}\n`);
}

/** The hold on this checkout: null when there is none; `unreadable` when the file exists but does not parse (held). */
export function readTamperHold(ledgerDir: string, root: string): TamperHold | 'unreadable' | null {
  const path = tamperHoldPath(ledgerDir, root);
  if (!existsSync(path)) return null;
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as TamperHold;
    return typeof h === 'object' && h !== null && typeof h.gate === 'string' ? h : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** The refusal text while a hold exists, or null. */
export function tamperHoldMessage(ledgerDir: string, root: string): string | null {
  const hold = readTamperHold(ledgerDir, root);
  if (hold === null) return null;
  const path = tamperHoldPath(ledgerDir, root);
  if (hold === 'unreadable') return `a tamper hold is set on this checkout (${path}, unreadable), so no factory run starts here; check the repository's .git (hooks, config, info, refs), then run ${RELEASE_TAMPER_COMMAND}`;
  const active = hold.active ?? [];
  return `a tamper hold is set on this checkout since ${hold.at} (run ${hold.run} parked at ${hold.gate}), so no factory run starts here${hold.quarantine ? `; what changed in .git is in ${hold.quarantine}` : ''}${active.length ? `; ${active.length} item(s) are ${STILL_ACTIVE}: ${active.slice(0, 3).join('; ')}` : ''}. Your own change during that run (a git config key, \`git remote add\` or \`git remote set-url\` included, and a branch's upstream set to a path, a URL, "." or a remote added during the run, a hook husky or an editor installed) triggers this too: put it back with the cp command in undo.txt in that folder if it was yours. Then run ${RELEASE_TAMPER_COMMAND}`;
}

/** `release --tamper`: the hold's report lines, after the hold file is removed; null when there was none. */
export function releaseTamperHold(ledgerDir: string, root: string): string[] | null {
  const hold = readTamperHold(ledgerDir, root);
  if (hold === null) return null;
  const path = tamperHoldPath(ledgerDir, root);
  const lines: string[] = [];
  if (hold === 'unreadable') lines.push(`the hold file ${path} was unreadable`);
  else {
    lines.push(`tamper hold from ${hold.at}: run ${hold.run} parked at ${hold.gate}`);
    if (hold.quarantine) lines.push(`quarantine: ${hold.quarantine}`);
    for (const m of hold.moved) lines.push(`moved to the quarantine: .git/${m}`);
    for (const r of hold.restored) lines.push(`restored from the run's snapshot: .git/${r}`);
    for (const r of hold.notRestored) lines.push(`not restored: .git/${r}`);
    for (const r of hold.kept ?? []) lines.push(`left as it is: .git/${r}`);
    for (const r of hold.refs) lines.push(`ref: ${r}`);
    for (const a of hold.active ?? []) lines.push(`still active: ${a}`);
    for (const u of hold.undo ?? []) lines.push(`undo: ${u}`);
    if (hold.failed) lines.push(`problem: ${hold.failed}`);
    if (hold.quarantine && existsSync(hold.quarantine)) {
      const walk = (d: string, rel: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
      lines.push(`quarantined files: ${walk(hold.quarantine, '').join(', ') || '(none)'}`);
    }
  }
  unlinkSync(path);
  lines.push('hold cleared: factory runs start again in this checkout');
  return lines;
}
