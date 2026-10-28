/**
 * Engine-side commits for `omg factory run` write lanes
 * (.omc/plans/2026-10-27-sandboxed-lanes-design.md §4.3).
 *
 * A write lane's sandbox keeps the common git dir read-only, so the lane only
 * edits its worktree. The engine commits for it, after the lane confirmed its
 * end and passed the tamper check, with host git hardened by runHostGit: no
 * hook, fsmonitor, filter or diff driver, GIT_ATTR_SOURCE the empty tree,
 * and the git dir, work tree and common dir pinned to the links recorded when
 * the worktree was created (a changed link refuses before any git runs).
 *
 * The commit is built from objects: `add -A` into the worktree's index, then
 * `write-tree` and `commit-tree` with engine-chosen parents and the
 * engine-owned identity, so no commit hook and no signing program runs and
 * nothing the lane wrote picks the author. The lane's branch and its
 * worktree's HEAD move to the commit only from the value they started at.
 *
 * Refused before any commit: a lane that moved its HEAD, a new or changed
 * gitlink (host git never enters a nested repository, so its content is
 * unreviewed), a merge-rule (protected) path, and an empty change.
 */

import { OmcPaths } from '../../lib/worktree-paths.js';
import { protectedChanges } from '../../ship/merge.js';
import { EMPTY_TREE, runHostGit, worktreeGitDirArgs } from '../../team/git-worktree.js';

/** Author and committer of every engine-made lane commit (fixed: nothing a lane wrote chooses it). */
export const ENGINE_COMMIT_IDENTITY = Object.freeze({ name: 'omg factory', email: 'omg-factory@oh-my-copilot.invalid' });

const GIT_TIMEOUT_MS = 60_000;
/** A commit message is cut at this many characters. */
const MAX_MESSAGE_CHARS = 4_000;
const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Untracked runtime state a lane's plugin hooks write in its worktree; never committed. */
const RUNTIME_STATE_EXCLUDES = ['state', 'sessions'].map((d) => `:(top,exclude)${OmcPaths.ROOT}/${d}`);

export type LaneCommitRefusal = 'moved' | 'gitlink' | 'protected' | 'empty' | 'error';

export type LaneCommitResult =
  | { ok: true; sha: string; files: string[]; notes: string[] }
  | { ok: false; refusal: LaneCommitRefusal; reason: string };

export interface LaneCommitInput {
  /** The lane worktree (its git links were recorded at creation). */
  worktree: string;
  /** The commit the lane started at: its worktree's HEAD must still be here. */
  start: string;
  /** The new commit's parents (the start for a plain lane; the PR head and the base for conflict-fix). */
  parents: readonly string[];
  /** The repository root (the lane's branch is moved from there). */
  repoRoot: string;
  /** The lane's branch, moved to the commit when it is still at `start`. */
  branch: string | null;
  message: string;
  /** Configured merge-rule paths beyond PROTECTED_PATHS (ship.knownFlakyFile). */
  extraProtected?: readonly string[];
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The engine's env with the commit identity fixed, and no variable that redirects the index or object store. */
function engineGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|AUTHOR_|COMMITTER_)/i.test(key)) delete env[key];
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: ENGINE_COMMIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: ENGINE_COMMIT_IDENTITY.email,
    GIT_COMMITTER_NAME: ENGINE_COMMIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: ENGINE_COMMIT_IDENTITY.email,
    ...extra,
  };
}

/** A commit message from untrusted lane text: no control characters except newlines, bounded. */
export function laneCommitMessage(title: string, body: string | null): string {
  const clean = (t: string) => t.replace(/\r\n?/g, '\n').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (c) => (c === '\n' ? c : ' '));
  const text = `${clean(title).replace(/\n/g, ' ').trim()}\n\n${clean(body ?? '').trim()}`.trim();
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n...` : text;
}

/** `<sha>\t<path>` of every gitlink (mode 160000) in `ls-files -z --stage` (index) or `ls-tree -r -z` (tree) output. */
function gitlinks(out: string, from: 'index' | 'tree'): Set<string> {
  const set = new Set<string>();
  for (const entry of out.split('\0')) {
    if (!entry.startsWith('160000 ')) continue;
    const tab = entry.indexOf('\t');
    const fields = entry.slice(0, tab).split(' ');
    set.add(`${from === 'index' ? fields[1] : fields[2]}\t${entry.slice(tab + 1)}`);
  }
  return set;
}

/**
 * Commit a write lane's worktree changes for it (see the module comment).
 * Call only after the lane confirmed its end and its tamper check passed.
 * Never throws: a git failure is `error`.
 */
export function commitLaneWork(input: LaneCommitInput): LaneCommitResult {
  try {
    if (!HEX.test(input.start) || input.parents.length === 0 || !input.parents.every((p) => HEX.test(p))) {
      return { ok: false, refusal: 'error', reason: 'the start and parent commits must be full shas' };
    }
    // Throws when no links were recorded for the worktree; runHostGit re-checks them before every command.
    const dirs = worktreeGitDirArgs(input.worktree);
    const git = (args: string[], env?: NodeJS.ProcessEnv) => runHostGit(input.worktree, [...dirs, ...args], GIT_TIMEOUT_MS, env).trim();
    const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head !== input.start) {
      return { ok: false, refusal: 'moved', reason: `the lane moved its worktree's HEAD to ${head.slice(0, 12) || '(none)'} (it started at ${input.start.slice(0, 12)}); a write lane leaves its changes uncommitted and the engine commits them` };
    }
    git(['add', '-A', '--', '.', ...RUNTIME_STATE_EXCLUDES], engineGitEnv());
    const added = [...gitlinks(git(['ls-files', '-z', '--stage']), 'index')];
    const known = gitlinks(git(['ls-tree', '-r', '-z', '--full-tree', input.start]), 'tree');
    const nested = added.filter((g) => !known.has(g)).map((g) => g.slice(g.indexOf('\t') + 1));
    if (nested.length > 0) {
      return { ok: false, refusal: 'gitlink', reason: `the lane added or changed nested repositories (gitlinks): ${nested.slice(0, 5).join(', ')}; host git does not enter them, so their content is not reviewed` };
    }
    const files = git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', input.start, '--']).split('\0').filter(Boolean);
    const hit = protectedChanges(files, input.extraProtected ?? []);
    if (hit.length > 0) return { ok: false, refusal: 'protected', reason: `the lane changed merge-rule paths: ${hit.join(', ')}` };
    const tree = git(['write-tree']);
    if (!HEX.test(tree)) return { ok: false, refusal: 'error', reason: `git write-tree printed ${JSON.stringify(tree.slice(0, 80))}` };
    if (tree === git(['rev-parse', '--verify', '--quiet', `${input.start}^{tree}`])) {
      return { ok: false, refusal: 'empty', reason: 'the lane left no changes in its worktree' };
    }
    const sha = git(['commit-tree', '--no-gpg-sign', ...input.parents.flatMap((p) => ['-p', p]), '-m', input.message, tree], engineGitEnv());
    if (!HEX.test(sha)) return { ok: false, refusal: 'error', reason: `git commit-tree printed ${JSON.stringify(sha.slice(0, 80))}` };
    const notes: string[] = [];
    git(['update-ref', '--no-deref', '-m', 'omg factory run: the engine commit of the lane', 'HEAD', sha, input.start]);
    if (input.branch) {
      const ref = `refs/heads/${input.branch}`;
      const at = runHostGit(input.repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], GIT_TIMEOUT_MS).trim();
      if (at === input.start) runHostGit(input.repoRoot, ['update-ref', '-m', 'omg factory run: the engine commit of the lane', ref, sha, input.start], GIT_TIMEOUT_MS);
      else notes.push(`the lane branch ${input.branch} is at ${at.slice(0, 12) || '(none)'}, not the lane start; it was left there`);
    }
    return { ok: true, sha, files, notes };
  } catch (err) {
    return { ok: false, refusal: 'error', reason: `the engine commit failed: ${errText(err)}` };
  }
}

/**
 * The start commit of a conflict-fix lane: `merge-tree --write-tree` of the
 * PR head and the base, committed with both as parents. Conflicted files keep
 * git's conflict markers for the lane to resolve; nothing is checked out, no
 * ref moves, and GIT_ATTR_SOURCE is the empty tree, so no merge driver,
 * filter or attribute from either side applies. The engine's final commit
 * takes the same two parents (commitLaneWork), never this commit.
 */
export function conflictFixStart(repoRoot: string, head: string, base: string, message: string): { sha: string; conflicted: string[] } {
  const format = runHostGit(repoRoot, ['rev-parse', '--show-object-format'], GIT_TIMEOUT_MS).trim();
  const emptyTree = EMPTY_TREE[format];
  if (!emptyTree) throw new Error(`unknown object format ${JSON.stringify(format)}`);
  const env = engineGitEnv({ GIT_ATTR_SOURCE: emptyTree });
  let out: string;
  try {
    out = runHostGit(repoRoot, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, base], GIT_TIMEOUT_MS, env);
  } catch (err) {
    // Exit 1: the merge has conflicts; stdout still names the tree and the conflicted files.
    const e = err as { status?: number; stdout?: unknown };
    if (e.status !== 1 || typeof e.stdout !== 'string') throw err;
    out = e.stdout;
  }
  const [tree, ...conflicted] = out.split('\0').filter(Boolean);
  if (!tree || !HEX.test(tree)) throw new Error(`git merge-tree printed no tree (${JSON.stringify(out.slice(0, 80))})`);
  const sha = runHostGit(repoRoot, ['commit-tree', '--no-gpg-sign', '-p', head, '-p', base, '-m', message, tree], GIT_TIMEOUT_MS, env).trim();
  if (!HEX.test(sha)) throw new Error(`git commit-tree printed ${JSON.stringify(sha.slice(0, 80))}`);
  return { sha, conflicted: [...new Set(conflicted)] };
}
