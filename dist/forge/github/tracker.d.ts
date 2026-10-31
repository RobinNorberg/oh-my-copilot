/**
 * GitHub issues as the factory tracker (factory forges design §2, PR 2): the
 * engine's `gh issue view` / `gh issue comment` moved verbatim, plus the
 * ForgeTracker reads and label writes, plus the `omg factory enqueue` item
 * writes (shipyard-factory design PR 7a), which pass the factory guard only
 * with enqueue's TrackerWriteContext (src/factory/run/exec.ts).
 */
import type { Exec, ExecResult } from '../../ship/exec.js';
import { type IssueComment } from '../../factory/run/plan-rules.js';
import { type ForgeItem, type ForgeItemDraft, type ForgeItemUpdate, type ForgeRepo, type ForgeTracker, type IntakeSource, type ProgressMapping, type ProgressStage, type ResolvedForgeConfig } from '../types.js';
/** `gh issue view --json` fields the engine reads (author: whose body `omg-plan:` line counts). */
export declare const ISSUE_FIELDS = "title,body,labels,state,url,author,comments";
export interface GhIssue {
    title?: unknown;
    body?: unknown;
    labels?: unknown;
    state?: unknown;
    url?: unknown;
    author?: unknown;
    comments?: IssueComment[];
}
/** `gh issue view <id> --json ISSUE_FIELDS` (the engine's dry run handles the result itself). */
export declare function ghIssueView(exec: Exec, issue: number, cwd: string): ExecResult;
/** ghIssueView as an engine step: GhCommandError on failure or no JSON; fields unchecked. */
export declare function ghIssueJson(exec: Exec, issue: number, cwd: string): GhIssue;
/** `gh issue comment <id> --body-file <file>`; never throws on a gh failure. */
export declare function ghIssueComment(exec: Exec, issue: number, bodyFile: string, cwd: string): {
    ok: boolean;
    stderr: string;
};
/** ForgeItem.dependsOn of an issue body: its `Depends on #n` / `Blocked by #n` lines (the engine's blocked-by gate reads it too). */
export declare const ghDependsOn: (body: string) => number[];
/** `gh issue view` as a ForgeItem; throws GhCommandError when it is not the issue asked for. */
export declare function ghViewItem(exec: Exec, issue: number, cwd: string): ForgeItem;
/** Open issue numbers for a label or milestone source; the ADO sources are refused. */
export declare function ghQueryItems(exec: Exec, source: IntakeSource, limit: number, cwd: string): number[];
/**
 * A stage's label; the other stages' labels are removed (one label family).
 * GitHub progress is labels only: a column or state mapping is ignored.
 * `cancelled` removes the whole family (design §7).
 */
export declare function ghSetProgress(exec: Exec, issue: number, stage: ProgressStage, mapping: ProgressMapping, stages: ResolvedForgeConfig['progress']['stages'], cwd: string): {
    ok: boolean;
    detail: string;
};
/**
 * The issues of `repo` with exactly one `shipyard-key: <spec>/<key>` line,
 * found by `gh issue list --search` and then read with `gh issue view` (for
 * trust and parent). A body whose key differs between the two reads, or an
 * issue of another repository, is skipped.
 */
export declare function ghFindByKey(exec: Exec, repo: ForgeRepo, spec: number, cwd: string): Array<{
    key: string;
    item: ForgeItem;
}>;
/** `gh issue create` from a body file; the new issue's number from the url gh prints. */
export declare function ghCreateItem(exec: Exec, repo: ForgeRepo, draft: ForgeItemDraft, cwd: string): number;
/** `gh issue edit`: title and body from a body file, then label adds and removes. */
export declare function ghUpdateItem(exec: Exec, repo: ForgeRepo, id: number, update: ForgeItemUpdate, cwd: string): void;
export declare function githubTracker(exec: Exec, cwd: string, config: ResolvedForgeConfig): ForgeTracker;
//# sourceMappingURL=tracker.d.ts.map