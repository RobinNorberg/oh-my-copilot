import { sealWikiManifest } from './cleanup-manifest.js';
import { spawnSessionEndWorker } from './worker.js';
import { buildWikiSessionEndCaptureIntent } from '../wiki/session-hooks.js';
import { resolveToWorktreeRoot } from '../../lib/worktree-paths.js';

export interface WikiSessionEndBootstrapInput { session_id: string; cwd: string; }
export interface WikiSessionEndBootstrapResult { continue: true; }

/**
 * Wiki SessionEnd producer: no foreground lock or wiki write, it only seals a
 * durable capture/no-op intent and hands off to the existing worker.
 *
 * Kept out of `index.ts` so `scripts/wiki-session-end.mjs` does not load the
 * full SessionEnd module graph (~100ms) inside run.cjs's 300ms foreground
 * budget — the same split `foreground-bootstrap.ts` makes for `session-end.mjs`.
 */
export async function processWikiSessionEnd(input: WikiSessionEndBootstrapInput): Promise<WikiSessionEndBootstrapResult> {
  const directory = resolveToWorktreeRoot(input.cwd);
  const intent = buildWikiSessionEndCaptureIntent({ cwd: directory, session_id: input.session_id });
  sealWikiManifest(directory, input.session_id, intent ? { ...intent } : undefined);
  spawnSessionEndWorker({ directory, sessionId: input.session_id });
  return { continue: true };
}
