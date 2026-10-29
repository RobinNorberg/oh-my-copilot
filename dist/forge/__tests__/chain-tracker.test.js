import { describe, expect, it } from 'vitest';
import { createGithubChainTracker, issueAddLabelArgv, issueCommentBodyArgv, issueCommentStdinArgv, } from '../github/chain-tracker.js';
const OK = { status: 0, stdout: '', stderr: '' };
describe('GitHub chain tracker argv', () => {
    it('builds the exact chain argv the call sites used to inline', () => {
        expect(issueAddLabelArgv('o/r', 7, 'harbor:need-info')).toEqual(['issue', 'edit', '7', '--repo', 'o/r', '--add-label', 'harbor:need-info']);
        expect(issueCommentBodyArgv('o/r', 7, 'hi')).toEqual(['issue', 'comment', '7', '--repo', 'o/r', '--body', 'hi']);
        expect(issueCommentStdinArgv('o/r', 7)).toEqual(['issue', 'comment', '7', '--repo', 'o/r', '--body-file', '-']);
    });
    it('routes map reads and edits through the injected runner', () => {
        const calls = [];
        const gh = (args) => {
            calls.push(args);
            return OK;
        };
        const comments = [];
        const t = createGithubChainTracker(gh, (ref, ticket, body) => {
            comments.push([ref.repo, ref.number, ticket, body]);
            return 0;
        });
        t.listIssues('o/r', 46);
        t.viewIssue('o/r', 80, 'number,state');
        t.addLabel('o/r', 81, 'wayfinder:awaiting-human');
        t.addAssignee('o/r', 81, '@me');
        expect(t.comment({ repo: 'o/r', number: 46 }, 81, 'body')).toBe(0);
        expect(calls).toEqual([
            ['issue', 'list', '--repo', 'o/r', '--state', 'all', '--limit', '200', '--search', '46 in:body', '--json', 'number,state,labels,assignees,body'],
            ['issue', 'view', '80', '--repo', 'o/r', '--json', 'number,state'],
            ['issue', 'edit', '81', '--repo', 'o/r', '--add-label', 'wayfinder:awaiting-human'],
            ['issue', 'edit', '81', '--repo', 'o/r', '--add-assignee', '@me'],
        ]);
        expect(comments).toEqual([['o/r', 46, 81, 'body']]);
    });
});
//# sourceMappingURL=chain-tracker.test.js.map