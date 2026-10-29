/**
 * GitHub chain tracker (factory forges design §A.7, PR 2b): every chain-side
 * `gh issue ...` argv lives here. The tracker never spawns; callers inject the
 * runners and keep their own spawning (map-ingest's spawnSync, spawn-next's
 * defaultSpawnFn with its Windows `gh` shim handling).
 */
/** `gh issue comment` with the body on stdin (`--body-file -`): cmd.exe codepages mangle non-ASCII argv. */
export function issueCommentStdinArgv(repo, ticket) {
    return ['issue', 'comment', String(ticket), '--repo', repo, '--body-file', '-'];
}
/** `gh issue edit --add-label`. */
export function issueAddLabelArgv(repo, issue, label) {
    return ['issue', 'edit', String(issue), '--repo', repo, '--add-label', label];
}
/** `gh issue comment --body` (spawn-next's defaultSpawnFn moves the body to stdin on win32). */
export function issueCommentBodyArgv(repo, issue, body) {
    return ['issue', 'comment', String(issue), '--repo', repo, '--body', body];
}
export function createGithubChainTracker(gh, comment) {
    return {
        listIssues: (repo, mapNumber) => gh(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '200', '--search', `${mapNumber} in:body`, '--json', 'number,state,labels,assignees,body']),
        viewIssue: (repo, number, fields) => gh(['issue', 'view', String(number), '--repo', repo, '--json', fields]),
        addLabel: (repo, issue, label) => gh(issueAddLabelArgv(repo, issue, label)),
        addAssignee: (repo, issue, assignee) => gh(['issue', 'edit', String(issue), '--repo', repo, '--add-assignee', assignee]),
        comment,
    };
}
//# sourceMappingURL=chain-tracker.js.map