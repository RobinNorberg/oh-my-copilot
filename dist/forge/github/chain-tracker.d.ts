/**
 * GitHub chain tracker (factory forges design §A.7, PR 2b): every chain-side
 * `gh issue ...` argv lives here. The tracker never spawns; callers inject the
 * runners and keep their own spawning (map-ingest's spawnSync, spawn-next's
 * defaultSpawnFn with its Windows `gh` shim handling).
 */
export interface GhRunner {
    (args: string[]): {
        status: number | null;
        stdout: string;
        stderr: string;
    };
}
/** Comment runner: posts `body` on the ticket (stdin, never argv) and returns the gh exit status. */
export type ChainCommentRunner = (ref: {
    repo: string;
    number: number;
}, ticket: number, body: string) => number | null;
/** `gh issue comment` with the body on stdin (`--body-file -`): cmd.exe codepages mangle non-ASCII argv. */
export declare function issueCommentStdinArgv(repo: string, ticket: number): string[];
/** `gh issue edit --add-label`. */
export declare function issueAddLabelArgv(repo: string, issue: number, label: string): string[];
/** `gh issue comment --body` (spawn-next's defaultSpawnFn moves the body to stdin on win32). */
export declare function issueCommentBodyArgv(repo: string, issue: number, body: string): string[];
export interface GithubChainTracker {
    listIssues(repo: string, mapNumber: number): ReturnType<GhRunner>;
    viewIssue(repo: string, number: number, fields: string): ReturnType<GhRunner>;
    addLabel(repo: string, issue: number, label: string): ReturnType<GhRunner>;
    addAssignee(repo: string, issue: number, assignee: string): ReturnType<GhRunner>;
    comment(ref: {
        repo: string;
        number: number;
    }, ticket: number, body: string): number | null;
}
export declare function createGithubChainTracker(gh: GhRunner, comment: ChainCommentRunner): GithubChainTracker;
//# sourceMappingURL=chain-tracker.d.ts.map