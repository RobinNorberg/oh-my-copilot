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
 * unreviewed), a link host git could follow out of the worktree, a
 * merge-rule or lane-protected path, and an empty change.
 *
 * Links: Git for Windows follows a directory junction in `add -A`, and the
 * engine's git runs outside the sandbox with the user's read rights, so a
 * junction to `~/.ssh` would be committed and pushed by the engine. Before
 * staging, the worktree (minus what git ignores) is walked with lstat: a
 * directory link, or on win32 any link, refuses. After staging, a new or
 * changed symlink entry (120000) refuses, and so does a staged path whose
 * real directory is outside the worktree's; those refusals reset the index
 * to the start tree.
 */

import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

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
const RUNTIME_STATE_DIRS = ['state', 'sessions'].map((d) => `${OmcPaths.ROOT}/${d}`);
/** The link walk gives up (and the lane parks) past this many entries or this depth. */
const MAX_WALK_ENTRIES = 200_000;
const MAX_WALK_DEPTH = 64;

/**
 * Paths a write lane may not change, on top of ship's PROTECTED_PATHS (which
 * `omg ship` keeps as it is): agent instructions, hooks, skills and CI.
 * `.github/` covers `.github/copilot-instructions.md` and the workflows;
 * `.claude/`, `.mcp.json` and `.vscode/` hold the hooks, MCP servers and
 * tasks other agents and editors run from a checkout.
 */
export const LANE_PROTECTED_PATHS: readonly string[] = ['.github/', '.copilot/', '.claude/', '.vscode/', '.mcp.json', '.omg/skills/', '.omc/skills/', 'AGENTS.md', 'CLAUDE.md'];

export type LaneCommitRefusal = 'moved' | 'gitlink' | 'escaped' | 'protected' | 'empty' | 'error';

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

/** GitHub's skip-CI markers (`[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`). */
const CI_SKIP = /\[\s*(?:(?:skip|no)[\s-]+(?:ci|actions)|(?:ci|actions)[\s-]+skip)\s*\]/gi;
/** A trailer-shaped line (`Key: value`), dropped from the body's last paragraph. */
const TRAILER = /^[A-Za-z0-9-]+\s*:(?:\s|$)/;
/** Trailers dropped from any line of the body: they credit an author, sign off or skip checks. */
const ANY_LINE_TRAILER = /^\s*(?:co-authored-by|signed-off-by|skip-checks)\s*:/i;

/** `body` without trailer-shaped lines (and their continuation lines) in its last paragraph, repeated while one goes. */
function dropTrailers(body: string): string {
  let lines = body.split('\n').filter((l) => !ANY_LINE_TRAILER.test(l));
  for (;;) {
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
    let start = lines.length;
    while (start > 0 && lines[start - 1].trim()) start--;
    const kept: string[] = [];
    let dropping = false;
    for (const l of lines.slice(start)) {
      dropping = TRAILER.test(l) || (dropping && /^\s/.test(l));
      if (!dropping) kept.push(l);
    }
    if (kept.length === lines.length - start) return lines.join('\n');
    lines = [...lines.slice(0, start), ...kept];
  }
}

/**
 * A commit message from untrusted lane text: no control, format or bidi
 * characters except newlines, no skip-CI marker, no trailer the lane wrote,
 * bounded.
 */
export function laneCommitMessage(title: string, body: string | null): string {
  const unskip = (t: string) => {
    let prev: string;
    do {
      prev = t;
      t = t.replace(CI_SKIP, '');
    } while (t !== prev);
    return t;
  };
  const clean = (t: string) => unskip(t.replace(/\r\n?/g, '\n').replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (c) => (c === '\n' ? c : ' ')));
  const text = `${clean(title).replace(/\n/g, ' ').trim()}\n\n${dropTrailers(clean(body ?? '')).trim()}`.trim();
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n...` : text;
}

/**
 * The first link host git could follow out of `worktree`, or a walk past its
 * limits (fail closed); null when there is none. lstat only, so no link is
 * followed; `.git` entries and the paths in `ignored` (git skips both) are
 * not entered. On win32 every link counts (Git for Windows follows a
 * junction); elsewhere a link to a directory does, and a file symlink is
 * left to the 120000 check after staging.
 */
function linkEscape(worktree: string, ignored: ReadonlySet<string>): string | null {
  let entries = 0;
  const walk = (dir: string, rel: string, depth: number): string | null => {
    if (depth > MAX_WALK_DEPTH) return `the worktree is nested deeper than ${MAX_WALK_DEPTH} directories at ${rel}, so it was not checked for links`;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (++entries > MAX_WALK_ENTRIES) return `the worktree holds more than ${MAX_WALK_ENTRIES} entries git does not ignore, so it was not checked for links`;
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isFile() || d.name === '.git' || ignored.has(path)) continue;
      const abs = join(dir, d.name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        let toDir = false;
        try { toDir = statSync(abs).isDirectory(); } catch { /* a dangling link: a file symlink to git */ }
        if (process.platform === 'win32' || toDir) return `the lane left a link at ${path} (a symlink or junction); host git could read through it outside the worktree`;
      } else if (st.isDirectory()) {
        const hit = walk(abs, path, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(worktree, '', 0);
}

/** The staged paths whose real directory is outside the worktree's (a link git followed). */
export function outsideWorktree(worktree: string, files: readonly string[]): string[] {
  const root = realpathSync.native(worktree);
  return files.filter((f) => {
    let dir: string;
    try {
      dir = realpathSync.native(dirname(join(worktree, f)));
    } catch (err) {
      // A deleted path's directory may be gone: nothing is read there. Any other failure counts as outside.
      const code = (err as NodeJS.ErrnoException).code;
      return code !== 'ENOENT' && code !== 'ENOTDIR';
    }
    const r = relative(root, dir);
    return r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r);
  });
}

/** `<sha>\t<path>` of every `mode` entry (160000 gitlink, 120000 symlink) in `ls-files -z --stage` (index) or `ls-tree -r -z` (tree) output. */
function entriesOfMode(out: string, from: 'index' | 'tree', mode: '160000' | '120000'): Set<string> {
  const set = new Set<string>();
  for (const entry of out.split('\0')) {
    if (!entry.startsWith(`${mode} `)) continue;
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
    // What git ignores it never enters in `add -A`, so the link walk skips it (directories come as `dir/`).
    const ignored = new Set(git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']).split('\0').filter(Boolean).map((p) => p.replace(/\/$/, '')));
    const link = linkEscape(input.worktree, ignored);
    if (link) return { ok: false, refusal: 'escaped', reason: link };
    // An exclude pathspec naming an ignored path fails `add` ("paths are ignored"), and git skips that path anyway.
    const isIgnored = (p: string) => p.split('/').some((_, i, segs) => ignored.has(segs.slice(0, i + 1).join('/')));
    const excludes = RUNTIME_STATE_DIRS.filter((d) => !isIgnored(d)).map((d) => `:(top,exclude)${d}`);
    git(['add', '-A', '--', '.', ...excludes], engineGitEnv());
    // Every refusal from here resets the index to the start tree, so nothing the lane staged stays staged.
    const refuse = (refusal: LaneCommitRefusal, reason: string): LaneCommitResult => {
      try {
        git(['read-tree', input.start]);
      } catch (err) {
        return { ok: false, refusal, reason: `${reason}; the index could not be reset: ${errText(err)}` };
      }
      return { ok: false, refusal, reason };
    };
    const index = git(['ls-files', '-z', '--stage']);
    const startTree = git(['ls-tree', '-r', '-z', '--full-tree', input.start]);
    const changedOfMode = (mode: '160000' | '120000') => {
      const known = entriesOfMode(startTree, 'tree', mode);
      return [...entriesOfMode(index, 'index', mode)].filter((g) => !known.has(g)).map((g) => g.slice(g.indexOf('\t') + 1));
    };
    const nested = changedOfMode('160000');
    if (nested.length > 0) {
      return refuse('gitlink', `the lane added or changed nested repositories (gitlinks): ${nested.slice(0, 5).join(', ')}; host git does not enter them, so their content is not reviewed`);
    }
    const symlinks = changedOfMode('120000');
    if (symlinks.length > 0) return refuse('escaped', `the lane added or changed symlinks: ${symlinks.slice(0, 5).join(', ')}`);
    const files = git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', input.start, '--']).split('\0').filter(Boolean);
    const outside = outsideWorktree(input.worktree, files);
    if (outside.length > 0) return refuse('escaped', `staged paths resolve outside the worktree (through a link): ${outside.slice(0, 5).join(', ')}`);
    // A hard link to a file outside the worktree passes the link walk and the realpath check, but shares its inode.
    const hardLinked = files.filter((f) => {
      try {
        return lstatSync(join(input.worktree, f)).nlink > 1;
      } catch {
        return false; // deleted by the lane
      }
    });
    if (hardLinked.length > 0) return refuse('escaped', `the lane staged hard-linked files (their content may come from outside the worktree): ${hardLinked.slice(0, 5).join(', ')}`);
    const hit = protectedChanges(files, [...LANE_PROTECTED_PATHS, ...(input.extraProtected ?? [])]);
    if (hit.length > 0) return refuse('protected', `the lane changed merge-rule or lane-protected paths: ${hit.join(', ')}`);
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
