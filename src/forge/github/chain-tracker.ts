/**
 * GitHub chain tracker (factory forges design §A.7, PR 2b): every chain-side
 * `gh issue ...` argv lives here. The tracker never spawns; callers inject the
 * runners and keep their own spawning (map-ingest's spawnSync, spawn-next's
 * defaultSpawnFn with its Windows `gh` shim handling).
 */

export interface GhRunner {
  (args: string[]): { status: number | null; stdout: string; stderr: string };
}

/** Comment runner: posts `body` on the ticket (stdin, never argv) and returns the gh exit status. */
export type ChainCommentRunner = (ref: { repo: string; number: number }, ticket: number, body: string) => number | null;

/** `gh issue comment` with the body on stdin (`--body-file -`): cmd.exe codepages mangle non-ASCII argv. */
export function issueCommentStdinArgv(repo: string, ticket: number): string[] {
  return ['issue', 'comment', String(ticket), '--repo', repo, '--body-file', '-'];
}

/** `gh issue edit --add-label`. */
export function issueAddLabelArgv(repo: string, issue: number, label: string): string[] {
  return ['issue', 'edit', String(issue), '--repo', repo, '--add-label', label];
}

/** `gh issue comment --body` (spawn-next's defaultSpawnFn moves the body to stdin on win32). */
export function issueCommentBodyArgv(repo: string, issue: number, body: string): string[] {
  return ['issue', 'comment', String(issue), '--repo', repo, '--body', body];
}

export interface GithubChainTracker {
  listIssues(repo: string, mapNumber: number): ReturnType<GhRunner>;
  viewIssue(repo: string, number: number, fields: string): ReturnType<GhRunner>;
  addLabel(repo: string, issue: number, label: string): ReturnType<GhRunner>;
  addAssignee(repo: string, issue: number, assignee: string): ReturnType<GhRunner>;
  comment(ref: { repo: string; number: number }, ticket: number, body: string): number | null;
}

export function createGithubChainTracker(gh: GhRunner, comment: ChainCommentRunner): GithubChainTracker {
  return {
    listIssues: (repo, mapNumber) =>
      gh(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '200', '--search', `${mapNumber} in:body`, '--json', 'number,state,labels,assignees,body']),
    viewIssue: (repo, number, fields) => gh(['issue', 'view', String(number), '--repo', repo, '--json', fields]),
    addLabel: (repo, issue, label) => gh(issueAddLabelArgv(repo, issue, label)),
    addAssignee: (repo, issue, assignee) => gh(['issue', 'edit', String(issue), '--repo', repo, '--add-assignee', assignee]),
    comment,
  };
}
