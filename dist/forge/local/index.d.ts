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
import type { ForgeFactory } from '../types.js';
export { LOCAL_REMOTE, backlogListArgs, backlogShowArgs, isLocalBranchName, localCheckRecordPath, localMirrorPath, localPrStorePath, localRepoId, localStoreDir, mergedArgs, mirrorFetchArgs, mirrorInitArgs, mirrorPushArgs, mirrorRemoteAddArgs, mirrorRemoteGetUrlArgs, readMirrorRef, } from './mirror.js';
export { LOCAL_GATE_CHECK, readCheckRecordAt, readLocalCheckRecord, writeLocalCheckRecord, type LocalCheckRecord } from './checks.js';
export { BacklogParseError, parseBacklogFile, renderBacklogFile, backlogSlug, type BacklogItem, type BacklogFields } from './backlog.js';
export { localPrUrl } from './reviews.js';
/**
 * The §1.3 lines `omg factory check`/`setup`/`board` print (and
 * `check --json` forge.limitations). `base` names the branch the human
 * merges into.
 */
export declare function localForgeLimitations(base?: string): string[];
export declare const createLocalForge: ForgeFactory;
//# sourceMappingURL=index.d.ts.map