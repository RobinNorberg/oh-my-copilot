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
/** The most objects (commit, trees, blobs) a view holds; a larger commit gets no view. */
export declare const GIT_VIEW_MAX_OBJECTS = 500000;
/** Host git in the trusted repository that holds `sha` (hardened: replace objects off, no hooks); stdout as bytes. */
export type GitViewSource = (args: readonly string[], input?: Buffer) => Buffer;
/** Host git on the new view (the engine's own, fresh dir): `cwd` is the view's work tree; stdout as text. */
export type GitViewGit = (cwd: string, args: readonly string[], input?: Buffer) => string;
/**
 * Build the view of `sha` at `<dir>/.git` (`dir` is made if missing; a
 * `<dir>/.git` that already exists is refused) and return that git dir.
 * Throws on any failure; the caller removes `dir` (or its `.git`).
 */
export declare function buildGitView(dir: string, sha: string, source: GitViewSource, git: GitViewGit): string;
//# sourceMappingURL=git-view.d.ts.map