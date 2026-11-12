/**
 * A gate checkout's git view: a disposable standalone repository holding
 * exactly one commit, so a prepare check, the local gate or a base
 * calibration can run read-only git (`git rev-parse HEAD`, `git ls-files`,
 * `git merge-base --is-ancestor HEAD HEAD`) where the checkout has no usable
 * git of its own: the base calibration's plain export, and the gate
 * container's copy of a checkout (its `.git` file names a host path).
 *
 * Built by the engine on the host from TRUSTED objects only, before any code
 * runs there: `rev-list --objects --no-walk <sha>` (the commit, its trees and
 * blobs; no parent, no other ref) in the trusted repository with replace
 * objects off (the caller's hardened host git), `pack-objects` over that
 * list, then in a fresh `git init --template=` (no hooks, no info/exclude,
 * no description) `index-pack` of that pack, `shallow` naming the commit (so
 * git never looks for its parents), a detached HEAD written as the sha (no
 * branch, no reflog, no identity), and the index from `read-tree`. No
 * remote, no fetch, no upload-pack runs, and nothing of the user's
 * repository or of another run's commits is in it.
 *
 * The gate's code may write anything into the view (it is in the read-write
 * checkout, or in the container's own copy): the engine never reads anything
 * from a view after the code ran, for a trust decision or otherwise. It is
 * removed with its gate checkout.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The most objects (commit, trees, blobs) a view holds; a larger commit gets no view. */
export const GIT_VIEW_MAX_OBJECTS = 500_000;

const HEX40 = /^[0-9a-f]{40}$/;

/** Host git in the trusted repository that holds `sha` (hardened: replace objects off, no hooks); stdout as bytes. */
export type GitViewSource = (args: readonly string[], input?: Buffer) => Buffer;

/** Host git on the new view (the engine's own, fresh dir): `cwd` is the view's work tree; stdout as text. */
export type GitViewGit = (cwd: string, args: readonly string[], input?: Buffer) => string;

/**
 * Build the view of `sha` at `<dir>/.git` (`dir` is made if missing; a
 * `<dir>/.git` that already exists is refused) and return that git dir.
 * Throws on any failure; the caller removes `dir` (or its `.git`).
 */
export function buildGitView(dir: string, sha: string, source: GitViewSource, git: GitViewGit): string {
  if (!HEX40.test(sha)) throw new Error(`the git view needs a full commit id, not ${JSON.stringify(sha)}`);
  const type = source(['cat-file', '-t', sha]).toString('utf8').trim();
  if (type !== 'commit') throw new Error(`${sha.slice(0, 12)} is a ${type || 'missing object'}, not a commit`);
  const list = source(['rev-list', '--objects', '--no-walk', sha]);
  const count = list.toString('utf8').split('\n').filter((l) => l.trim()).length;
  if (count > GIT_VIEW_MAX_OBJECTS) throw new Error(`${sha.slice(0, 12)} has ${count} objects, above the ${GIT_VIEW_MAX_OBJECTS} a git view holds`);
  const pack = source(['pack-objects', '--stdout', '-q'], list);
  mkdirSync(dir, { recursive: true });
  const gitDir = join(dir, '.git');
  if (existsSync(gitDir)) throw new Error(`${gitDir} already exists`);
  git(dir, ['init', '-q', '--template=', dir]);
  const own = ['--git-dir', gitDir, '--work-tree', dir];
  git(dir, [...own, 'index-pack', '--stdin'], pack);
  writeFileSync(join(gitDir, 'shallow'), `${sha}\n`);
  writeFileSync(join(gitDir, 'HEAD'), `${sha}\n`);
  git(dir, [...own, 'read-tree', sha]);
  const head = git(dir, [...own, 'rev-parse', '--verify', 'HEAD^{commit}']).trim();
  if (head !== sha) throw new Error(`the git view's HEAD is ${head.slice(0, 12)}, not ${sha.slice(0, 12)}`);
  return gitDir;
}
