/**
 * GitHub pull requests (factory forges design §2, PR 2): the `gh pr` reads
 * and writes of `omg ship`, the gates driver and the factory engine, moved
 * verbatim. Engine-step calls throw GhCommandError with the engine's own
 * message (src/forge/github/gh.ts); the others keep their callers' result
 * handling.
 */
import type { Exec, ExecResult } from '../../ship/exec.js';
import type { PrView } from '../../ship/merge.js';
import type { ForgePr, ForgeReviews } from '../types.js';
/** `gh pr view --json` fields the merge step reads. */
export declare const MERGE_VIEW_FIELDS = "number,state,isDraft,baseRefName,baseRefOid,headRefOid";
export interface MergeView extends PrView {
    baseRefOid: string;
}
/** Parse `gh pr view --json MERGE_VIEW_FIELDS`; null when a field is missing or malformed. */
export declare function parseMergeView(stdout: string): MergeView | null;
/** `gh pr view <pr> --json <fields>` in the process cwd (the `omg ship` CLI reads); the caller parses. */
export declare function ghPrView(exec: Exec, pr: number, fields: string): ExecResult;
/** `gh pr view <pr> --json headRefOid,state`; throws on anything but a full sha and a state. */
export declare function ghPrHead(exec: Exec, pr: number, cwd: string): {
    headRefOid: string;
    state: string;
};
/** The engine's review read: `gh pr view <pr> --json headRefOid,state`, fields unchecked. */
export declare function ghPrHeadState(exec: Exec, pr: number, cwd: string): {
    headRefOid?: unknown;
    state?: unknown;
};
/** `gh pr list --head <branch> --json number,state,headRefOid,url` as printed (open PRs only, gh's default). */
export declare function ghOpenPrs(exec: Exec, branch: string, cwd: string): Array<{
    number?: number;
}>;
/** The first open PR's number on `branch`, if gh reports one. */
export declare function ghFindOpenPr(exec: Exec, branch: string, cwd: string): number | undefined;
/** `gh pr create --draft`; the new PR's number from the url gh prints. */
export declare function ghCreateDraftPr(exec: Exec, o: {
    base: string;
    head: string;
    title: string;
    bodyFile: string;
}, cwd: string): number;
/** `gh pr view <pr> --json MERGE_VIEW_FIELDS`. */
export declare function ghMergeView(exec: Exec, pr: number, cwd: string): MergeView;
/** `gh pr ready <pr>`. */
export declare function ghMarkReady(exec: Exec, pr: number, cwd: string): void;
/** `gh pr comment <pr> --body-file <file>`; never throws on a gh failure. */
export declare function ghCommentPr(exec: Exec, pr: number, bodyFile: string, cwd: string): {
    ok: boolean;
    stderr: string;
};
/** `gh repo view --json url` as printed (the ci-heal intake checks the url). */
export declare function ghRepoView(exec: Exec, cwd: string): {
    url?: unknown;
};
/** The ForgePr fields, the same list `omg ship merge` reads. */
export declare const PR_VIEW_FIELDS = "number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,url";
/** `gh pr view <pr> --json PR_VIEW_FIELDS`; throws on a missing or malformed field. */
export declare function ghViewPr(exec: Exec, pr: number, cwd: string): ForgePr;
export declare function githubReviews(exec: Exec, cwd: string): ForgeReviews;
//# sourceMappingURL=reviews.d.ts.map