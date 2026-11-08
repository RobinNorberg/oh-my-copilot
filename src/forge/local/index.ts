/**
 * The local (offline) forge (offline forge plan §1): a committed backlog
 * directory as the tracker, a JSON PR store and an engine-owned bare mirror
 * (remote `omg-local`) under the forge stateDir, the engine's `local-gate`
 * record as the one check, and a merge the human runs with git. Built on
 * the caller's guarded Exec; it never spawns, and it never runs gh, az or
 * copilot (src/forge/local/__tests__/no-spawn.test.ts).
 *
 * The store directory is derived from config.repo.url (the mirror path that
 * resolveForgeConfig computed from the root and stateDir), so the adapter
 * and the engine (localMirrorPath/localCheckRecordPath) always agree.
 */

import { statSync } from 'fs';
import { join } from 'path';
import type { Exec } from '../../ship/exec.js';
import type { Forge, ForgeFactory, ForgeOptions, ResolvedForgeConfig } from '../types.js';
import { localChecks, readCheckRecordAt, type LocalCheckRecord } from './checks.js';
import { localMerge } from './merge.js';
import { localReviews } from './reviews.js';
import { engineOwnedDir, readPrStore, type LocalPrStore } from './store.js';
import { localTracker } from './tracker.js';

export {
  LOCAL_REMOTE,
  STATE_CHANGE_LOG_FLAGS,
  backlogListArgs,
  backlogShowArgs,
  isLocalBranchName,
  lastStateChangeArgs,
  localCheckRecordPath,
  localMirrorPath,
  localPrStorePath,
  localRepoId,
  localStoreDir,
  mergedArgs,
  mirrorFetchArgs,
  mirrorInitArgs,
  mirrorPushArgs,
  mirrorRemoteAddArgs,
  mirrorRemoteGetUrlArgs,
  readMirrorRef,
} from './mirror.js';
export { LOCAL_GATE_CHECK, readCheckRecordAt, readLocalCheckRecord, writeLocalCheckRecord, type LocalCheckRecord } from './checks.js';
export { BacklogParseError, parseBacklogFile, renderBacklogFile, backlogSlug, type BacklogItem, type BacklogFields } from './backlog.js';
export { localPrUrl } from './reviews.js';

/**
 * The §1.3 lines `omg factory check`/`setup`/`board` print (and
 * `check --json` forge.limitations). `base` names the branch the human
 * merges into.
 */
export function localForgeLimitations(base = '<base>'): string[] {
  return [
    'local forge (offline): no CI; gates = factory.forge.local.gate, run once per head on this machine',
    "no remote or human PR review threads (the factory's own review lane still runs)",
    'no issue or PR comments on a server (written to .omg/factory/local/)',
    'no webhooks (omg factory listen) and no heal',
    'no progress sync to a board',
    `merge is a git merge you run on ${base}`,
    'not for sharing work between machines',
  ];
}

export const createLocalForge: ForgeFactory = (exec: Exec, cwd: string, config: ResolvedForgeConfig, options: ForgeOptions): Forge => {
  if (config.kind !== 'local' || !config.local) throw new Error(`createLocalForge needs a resolved local forge config, got ${config.kind}`);
  const mirror = config.repo.url;
  if (!/\.git$/.test(mirror)) throw new Error(`local forge: the mirror path ${mirror} does not end in .git`);
  // <stateDir>/local/<repo-id>.git -> <stateDir>/local/<repo-id>: engine-owned, never under a lane-writable root.
  const storeDir = engineOwnedDir(mirror.slice(0, -'.git'.length), options.untrustedRoots);
  const recordFor = (head: string): LocalCheckRecord | undefined => readCheckRecordAt(storeDir, head);
  const omgRoot = options.local?.omgRoot;
  if (!omgRoot) throw new Error('local forge: options.local.omgRoot is required (getOmcRoot(root))');
  const humanDir = join(omgRoot, 'factory', 'local');
  const storePath = join(storeDir, 'prs.json');
  const reviews = localReviews({ exec, root: cwd, mirror, storePath, humanDir });
  // The PR store, read once per change of the file (inode, size, mtime and ctime; bigint keeps a 64-bit Windows
  // file id and nanosecond times exact): one read per check, and a malformed store
  // is one error, thrown only to the lookups that need the store.
  let store: { key: string; value: LocalPrStore | Error } | undefined;
  const prStore = (): LocalPrStore => {
    const st = statSync(storePath, { throwIfNoEntry: false, bigint: true });
    const key = st ? `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` : 'absent';
    if (store?.key !== key) {
      try {
        store = { key, value: readPrStore(storePath) };
      } catch (err) {
        store = { key, value: err as Error };
      }
    }
    if (store.value instanceof Error) throw store.value;
    return store.value;
  };
  // F31: the item's own PR (itemId) merged into the current base, read from the engine-owned store (brought up to date from the mirror).
  const base = options.local?.base;
  const mergedPr = (id: number): { number: number; mergedHead?: string } | undefined => {
    if (base === undefined) return undefined;
    for (const p of prStore().prs.filter((x) => x.itemId === id && x.base === base && x.state !== 'CLOSED')) {
      const r = reviews.refreshPr(p);
      if (r.state === 'MERGED') return { number: r.number, ...(r.mergedHead === undefined ? {} : { mergedHead: r.mergedHead }) };
    }
    return undefined;
  };
  return {
    kind: 'local',
    provider: 'unknown',
    repo: config.repo,
    tracker: localTracker({
      exec,
      root: cwd,
      backlogDir: config.local.backlogDir,
      repoUrl: config.repo.url,
      humanDir,
      options: options.local ?? {},
      ...(options.trackerBodyDir === undefined ? {} : { trackerBodyDir: options.trackerBodyDir }),
      mergedPr,
    }),
    reviews,
    checks: localChecks(join(storeDir, 'checks'), recordFor),
    merge: localMerge(cwd),
    capabilities: { heal: false, projectsV2: false, boardColumns: false, webhookIntake: false },
    limitations: () => localForgeLimitations(),
  };
};
