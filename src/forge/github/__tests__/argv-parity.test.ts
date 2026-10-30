/**
 * Per-method argv parity of the GitHub forge (factory forges design §A.6,
 * PR 2): every adapter function issues exactly the (cmd, argv, opts) the
 * pre-move call site issued, pinned here as literals; the Forge object built
 * by createForge issues the same calls. The end-to-end sequences stay pinned
 * by src/forge/__tests__/gh-argv-baseline*.test.ts.
 */
import { describe, expect, it } from 'vitest';

import type { Exec, ExecOptions, ExecResult } from '../../../ship/exec.js';
import { createForge, type ResolvedForgeConfig } from '../../index.js';
import { ghHeadSha, ghJobLog, ghPrChecks, ghRerun, ghRunsForHead } from '../checks.js';
import { jobLog, listRuns, viewRunJobs } from '../ci.js';
import { GhCommandError, ghJson, ghRun } from '../gh.js';
import { ghMergeCommand } from '../merge.js';
import {
  ghCommentPr, ghCreateDraftPr, ghFindMergedPr, ghFindOpenPr, ghMarkReady, ghMergeView, ghOpenPrs, ghPrHead, ghPrHeadState, ghPrView, ghRepoView, ghViewPr, MERGE_VIEW_FIELDS, PR_VIEW_FIELDS,
} from '../reviews.js';
import { ghIssueComment, ghIssueJson, ghIssueView, ghQueryItems, ghSetProgress, ghViewItem, ISSUE_FIELDS } from '../tracker.js';

const CWD = 'C:/repo';
const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr: string, status = 1): ExecResult => ({ status, stdout: '', stderr });

type Call = [cmd: string, args: string[], opts: ExecOptions | undefined];

/** A recording Exec: every call as given (opts kept as passed, absent = undefined), answered by `reply`. */
function recorder(reply: (args: string[]) => ExecResult = () => ok()) {
  const calls: Call[] = [];
  const exec: Exec = (cmd, args, ...rest: [ExecOptions?]) => {
    calls.push([cmd, [...args], rest.length === 0 ? undefined : rest[0]]);
    return reply(args);
  };
  return { exec, calls };
}

const MERGE_VIEW = { number: 7, state: 'OPEN', isDraft: true, baseRefName: 'dev', baseRefOid: BASE, headRefOid: SHA };
const PR_VIEW = { ...MERGE_VIEW, headRefName: 'factory/7', url: 'https://github.com/o/r/pull/7' };
const ISSUE = {
  title: 'T', body: 'Depends on #3\n- [ ] #5\n', state: 'OPEN', url: 'https://github.com/o/r/issues/7',
  author: { login: 'o' }, labels: [{ name: 'factory' }, { name: 'size:3' }], comments: [{ body: 'hi', author: { login: 'm' }, authorAssociation: 'MEMBER' }],
};

describe('GitHub forge argv parity: checks', () => {
  it('pr checks, head sha, run list, job log and rerun keep their argv and { cwd }', () => {
    const r = recorder((a) => (a[0] === 'pr' && a[1] === 'view' ? ok(JSON.stringify({ headRefOid: SHA })) : a[1] === 'checks' || a[1] === 'list' ? ok('[]') : ok('log')));
    ghPrChecks(r.exec, 7, CWD);
    ghPrChecks(r.exec, 7);
    ghHeadSha(r.exec, 7, CWD);
    ghRunsForHead(r.exec, SHA, CWD);
    expect(ghJobLog(r.exec, '99', CWD)).toEqual({ ok: true, text: 'log' });
    ghRerun(r.exec, '42', CWD);
    expect(r.calls).toStrictEqual([
      ['gh', ['pr', 'checks', '7', '--json', 'name,state,bucket,link,workflow,event,startedAt,completedAt'], { cwd: CWD }],
      ['gh', ['pr', 'checks', '7', '--json', 'name,state,bucket,link,workflow,event,startedAt,completedAt'], { cwd: undefined }],
      ['gh', ['pr', 'view', '7', '--json', 'headRefOid'], { cwd: CWD }],
      ['gh', ['run', 'list', '--commit', SHA, '--json', 'databaseId,status,conclusion,workflowName,headSha', '--limit', '100'], { cwd: CWD }],
      ['gh', ['run', 'view', '--job', '99', '--log'], { cwd: CWD }],
      ['gh', ['run', 'rerun', '42', '--failed'], { cwd: CWD }],
    ]);
  });

  it('a failed job log or rerun is reported, not thrown', () => {
    const r = recorder(() => fail('boom'));
    expect(ghJobLog(r.exec, '99', CWD)).toEqual({ ok: false, text: '' });
    expect(ghRerun(r.exec, '42', CWD)).toEqual({ ok: false, stderr: 'boom' });
  });
});

describe('GitHub forge argv parity: reviews', () => {
  it('the omg ship CLI pr view passes no exec options', () => {
    const r = recorder(() => ok('{}'));
    ghPrView(r.exec, 7, 'baseRefName,baseRefOid,url');
    expect(r.calls).toStrictEqual([['gh', ['pr', 'view', '7', '--json', 'baseRefName,baseRefOid,url'], undefined]]);
  });

  it('every engine and gates-driver PR call keeps its argv and { cwd }', () => {
    const r = recorder((a) => {
      const s = a.join(' ');
      if (s.startsWith('pr list')) return ok(JSON.stringify([{ number: 9 }]));
      if (s.startsWith('pr create')) return ok('https://github.com/o/r/pull/12\n');
      if (s === `pr view 7 --json ${MERGE_VIEW_FIELDS}`) return ok(JSON.stringify(MERGE_VIEW));
      if (s === `pr view 7 --json ${PR_VIEW_FIELDS}`) return ok(JSON.stringify(PR_VIEW));
      if (s.startsWith('pr view')) return ok(JSON.stringify({ headRefOid: SHA, state: 'OPEN' }));
      if (s.startsWith('repo view')) return ok(JSON.stringify({ url: 'https://github.com/o/r' }));
      return ok();
    });
    expect(ghPrHead(r.exec, 7, CWD)).toEqual({ headRefOid: SHA, state: 'OPEN' });
    expect(ghPrHeadState(r.exec, 7, CWD)).toEqual({ headRefOid: SHA, state: 'OPEN' });
    expect(ghOpenPrs(r.exec, 'factory/7', CWD)).toEqual([{ number: 9 }]);
    expect(ghFindOpenPr(r.exec, 'factory/7', CWD)).toBe(9);
    expect(ghCreateDraftPr(r.exec, { base: 'dev', head: 'factory/7', title: 'Title (#7)', bodyFile: 'C:/b.md' }, CWD)).toBe(12);
    expect(ghMergeView(r.exec, 7, CWD)).toEqual(MERGE_VIEW);
    ghMarkReady(r.exec, 7, CWD);
    expect(ghCommentPr(r.exec, 7, 'C:/c.md', CWD)).toEqual({ ok: true, stderr: '' });
    expect(ghRepoView(r.exec, CWD)).toEqual({ url: 'https://github.com/o/r' });
    expect(ghViewPr(r.exec, 7, CWD)).toEqual(PR_VIEW);
    expect(r.calls).toStrictEqual([
      ['gh', ['pr', 'view', '7', '--json', 'headRefOid,state'], { cwd: CWD }],
      ['gh', ['pr', 'view', '7', '--json', 'headRefOid,state'], { cwd: CWD }],
      ['gh', ['pr', 'list', '--head', 'factory/7', '--json', 'number,state,headRefOid,url'], { cwd: CWD }],
      ['gh', ['pr', 'list', '--head', 'factory/7', '--json', 'number,state,headRefOid,url'], { cwd: CWD }],
      ['gh', ['pr', 'create', '--draft', '--base', 'dev', '--head', 'factory/7', '--title', 'Title (#7)', '--body-file', 'C:/b.md'], { cwd: CWD }],
      ['gh', ['pr', 'view', '7', '--json', 'number,state,isDraft,baseRefName,baseRefOid,headRefOid'], { cwd: CWD }],
      ['gh', ['pr', 'ready', '7'], { cwd: CWD }],
      ['gh', ['pr', 'comment', '7', '--body-file', 'C:/c.md'], { cwd: CWD }],
      ['gh', ['repo', 'view', '--json', 'url'], { cwd: CWD }],
      ['gh', ['pr', 'view', '7', '--json', 'number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,url'], { cwd: CWD }],
    ]);
  });

  it('the merged-PR lookup is the one new read: pr list --head --base --state merged', () => {
    const r = recorder((a) => ok(JSON.stringify(a.includes('factory/issue-3') ? [{ number: 21 }] : [])));
    expect(ghFindMergedPr(r.exec, 'factory/issue-3', 'dev', CWD)).toBe(21);
    expect(ghFindMergedPr(r.exec, 'factory/issue-4', 'dev', CWD)).toBeUndefined();
    expect(r.calls).toStrictEqual([
      ['gh', ['pr', 'list', '--head', 'factory/issue-3', '--base', 'dev', '--state', 'merged', '--json', 'number'], { cwd: CWD }],
      ['gh', ['pr', 'list', '--head', 'factory/issue-4', '--base', 'dev', '--state', 'merged', '--json', 'number'], { cwd: CWD }],
    ]);
  });

  it('engine-step failures keep the engine messages', () => {
    const failing = recorder(() => fail('HTTP 502\nmore', 1)).exec;
    expect(() => ghRun(failing, ['pr', 'ready', '7'], CWD)).toThrow(new GhCommandError('gh pr ready 7 failed (exit 1): HTTP 502'));
    const garbage = recorder(() => ok('not json')).exec;
    expect(() => ghJson(garbage, ['repo', 'view', '--json', 'url'], CWD)).toThrow('gh repo view --json url returned no JSON');
    expect(() => ghCreateDraftPr(garbage, { base: 'dev', head: 'h', title: 't', bodyFile: 'f' }, CWD)).toThrow('gh pr create printed no PR url: not json');
    expect(() => ghMergeView(garbage, 7, CWD)).toThrow("gh pr view 7 did not return the PR's state, base and head");
    expect(() => ghPrHead(recorder(() => fail('nope', 4)).exec, 7, CWD)).toThrow('gh pr view 7 did not return a head sha and state (exit 4): nope');
  });
});

describe('GitHub forge argv parity: tracker', () => {
  it('issue view and comment keep their argv and { cwd }', () => {
    const r = recorder((a) => (a[1] === 'view' ? ok(JSON.stringify(ISSUE)) : ok()));
    ghIssueView(r.exec, 7, CWD);
    expect(ghIssueJson(r.exec, 7, CWD)).toEqual(ISSUE);
    expect(ghIssueComment(r.exec, 7, 'C:/g.md', CWD)).toEqual({ ok: true, stderr: '' });
    expect(r.calls).toStrictEqual([
      ['gh', ['issue', 'view', '7', '--json', 'title,body,labels,state,url,author,comments'], { cwd: CWD }],
      ['gh', ['issue', 'view', '7', '--json', ISSUE_FIELDS], { cwd: CWD }],
      ['gh', ['issue', 'comment', '7', '--body-file', 'C:/g.md'], { cwd: CWD }],
    ]);
  });

  it('viewItem normalizes the issue; queryItems and progress use issue list / edit', () => {
    const r = recorder((a) => (a[1] === 'view' ? ok(JSON.stringify(ISSUE)) : a[1] === 'list' ? ok(JSON.stringify([{ number: 3 }, { number: 5 }])) : ok()));
    expect(ghViewItem(r.exec, 7, CWD)).toEqual({
      id: 7, url: ISSUE.url, title: 'T', body: ISSUE.body, open: true, rawState: 'OPEN', authorTrusted: true,
      comments: [{ body: 'hi', author: 'm', trusted: true }], labels: ['factory', 'size:3'], size: 3, dependsOn: [3], children: [5], repoUrl: 'https://github.com/o/r',
    });
    expect(ghQueryItems(r.exec, { type: 'label', label: 'factory' }, 50, CWD)).toEqual([3, 5]);
    ghQueryItems(r.exec, { type: 'milestone', milestone: 'v5.18' }, 10, CWD);
    expect(() => ghQueryItems(r.exec, { type: 'wiql-query', queryId: 'q' }, 10, CWD)).toThrow('intake source wiql-query is not a GitHub source');
    const stages = { queued: { label: 'factory:queued' }, building: { label: 'factory:building' }, reviewing: { column: 'Code Review' } };
    expect(ghSetProgress(r.exec, 7, 'building', stages.building, stages, CWD)).toEqual({ ok: true, detail: 'label factory:building' });
    expect(ghSetProgress(r.exec, 7, 'reviewing', stages.reviewing, stages, CWD)).toEqual({ ok: true, detail: 'no label for stage reviewing' });
    expect(r.calls.slice(1)).toStrictEqual([
      ['gh', ['issue', 'list', '--label', 'factory', '--state', 'open', '--json', 'number', '--limit', '50'], { cwd: CWD }],
      ['gh', ['issue', 'list', '--milestone', 'v5.18', '--state', 'open', '--json', 'number', '--limit', '10'], { cwd: CWD }],
      ['gh', ['issue', 'edit', '7', '--add-label', 'factory:building', '--remove-label', 'factory:queued'], { cwd: CWD }],
    ]);
  });

  it('viewItem reads the parent from the first `Part of #n` line', () => {
    const body = 'intro\nPart of #41\npart of #42\nDepends on #3\n';
    const r = recorder(() => ok(JSON.stringify({ ...ISSUE, body })));
    expect(ghViewItem(r.exec, 7, CWD)).toMatchObject({ parent: 41, dependsOn: [3] });
    expect(r.calls).toStrictEqual([['gh', ['issue', 'view', '7', '--json', ISSUE_FIELDS], { cwd: CWD }]]);
    expect('parent' in ghViewItem(recorder(() => ok(JSON.stringify(ISSUE))).exec, 7, CWD)).toBe(false);
  });

  it('a refused label write is ok: false, never a throw', () => {
    const refusing: Exec = () => { throw new Error('refused by the guard'); };
    expect(ghSetProgress(refusing, 7, 'queued', { label: 'q' }, {}, CWD)).toEqual({ ok: false, detail: 'refused by the guard' });
  });
});

describe('GitHub forge argv parity: ci and merge', () => {
  it('heal reads keep their argv, and no exec options without a cwd', () => {
    const r = recorder((a) => (a[1] === 'list' ? ok('[]') : a[3] === '--json' ? ok('{"jobs":[]}') : ok('log')));
    listRuns(r.exec, { workflow: 'ci.yml', event: 'push', branch: 'dev', limit: 30, cwd: CWD });
    listRuns(r.exec, { workflow: 'ci.yml', event: 'pull_request', limit: 30 });
    viewRunJobs(r.exec, '5', CWD);
    expect(jobLog(r.exec, '6')).toBe('log');
    expect(r.calls).toStrictEqual([
      ['gh', ['run', 'list', '--branch', 'dev', '--workflow', 'ci.yml', '--event', 'push', '--json', 'databaseId,conclusion,status,headSha,headBranch,event,createdAt', '--limit', '30'], { cwd: CWD }],
      ['gh', ['run', 'list', '--workflow', 'ci.yml', '--event', 'pull_request', '--json', 'databaseId,conclusion,status,headSha,headBranch,event,createdAt', '--limit', '30'], undefined],
      ['gh', ['run', 'view', '5', '--json', 'jobs'], { cwd: CWD }],
      ['gh', ['run', 'view', '--job', '6', '--log'], undefined],
    ]);
  });

  it('the human merge command is the admin merge pinned to the head', () => {
    expect(ghMergeCommand(7, SHA)).toEqual(['gh', 'pr', 'merge', '7', '--admin', '--merge', '--match-head-commit', SHA]);
  });
});

describe('createForge(github)', () => {
  const config = {
    kind: 'github',
    repo: { kind: 'github', host: 'github.com', owner: 'o', name: 'r', url: 'https://github.com/o/r' },
    intake: { itemTypes: [], limit: 50, marker: 'factory-ready' },
    check: { maxAcceptanceItems: 12, maxSize: 8, maxBodyChars: 20000 },
    progress: { enabled: true, stages: { queued: { label: 'factory:queued' } } },
  } as ResolvedForgeConfig;

  it('is the GitHub adapter, and its methods issue the same calls as the functions', () => {
    const r = recorder((a) => {
      const s = a.join(' ');
      if (s.startsWith('pr view 7 --json headRefOid,state')) return ok(JSON.stringify({ headRefOid: SHA, state: 'OPEN' }));
      if (s.startsWith('pr list') || s.startsWith('run list') || s.startsWith('pr checks')) return ok('[]');
      if (s.startsWith('run view 5')) return ok('{"jobs":[]}');
      return ok();
    });
    const forge = createForge(r.exec, CWD, config, { untrustedRoots: [CWD] });
    expect(forge.kind).toBe('github');
    expect(forge.provider).toBe('github');
    expect(forge.repo).toBe(config.repo);
    expect(forge.capabilities).toEqual({ heal: true, projectsV2: false, boardColumns: false, webhookIntake: true });
    expect(forge.checks.transientError.test('HTTP 502')).toBe(true);
    forge.checks.checks(7, SHA);
    forge.checks.runsForHead(7, SHA);
    forge.checks.jobLog('99');
    forge.checks.rerun(7, '42');
    forge.reviews.prHead(7);
    expect(forge.reviews.findOpenPrForBranch('factory/7')).toBeUndefined();
    forge.reviews.commentPr(7, 'C:/c.md');
    forge.reviews.markReady(7);
    forge.tracker.comment(7, 'C:/g.md');
    forge.tracker.addMarker(7, 'factory-ready');
    forge.tracker.setProgress(7, 'queued', { label: 'factory:queued' });
    forge.ci!.listRuns({ workflow: 'ci.yml', event: 'push', limit: 5 });
    forge.ci!.runJobs('5');
    forge.ci!.jobLog('6');
    expect(forge.merge.humanMergeCommand(7, SHA)).toEqual(ghMergeCommand(7, SHA));
    expect(forge.merge.blockingPolicies(7, SHA)).toEqual([]);
    expect(r.calls).toStrictEqual([
      ['gh', ['pr', 'checks', '7', '--json', 'name,state,bucket,link,workflow,event,startedAt,completedAt'], { cwd: CWD }],
      ['gh', ['run', 'list', '--commit', SHA, '--json', 'databaseId,status,conclusion,workflowName,headSha', '--limit', '100'], { cwd: CWD }],
      ['gh', ['run', 'view', '--job', '99', '--log'], { cwd: CWD }],
      ['gh', ['run', 'rerun', '42', '--failed'], { cwd: CWD }],
      ['gh', ['pr', 'view', '7', '--json', 'headRefOid,state'], { cwd: CWD }],
      ['gh', ['pr', 'list', '--head', 'factory/7', '--json', 'number,state,headRefOid,url'], { cwd: CWD }],
      ['gh', ['pr', 'comment', '7', '--body-file', 'C:/c.md'], { cwd: CWD }],
      ['gh', ['pr', 'ready', '7'], { cwd: CWD }],
      ['gh', ['issue', 'comment', '7', '--body-file', 'C:/g.md'], { cwd: CWD }],
      ['gh', ['issue', 'edit', '7', '--add-label', 'factory-ready'], { cwd: CWD }],
      ['gh', ['issue', 'edit', '7', '--add-label', 'factory:queued'], { cwd: CWD }],
      ['gh', ['run', 'list', '--workflow', 'ci.yml', '--event', 'push', '--json', 'databaseId,conclusion,status,headSha,headBranch,event,createdAt', '--limit', '5'], { cwd: CWD }],
      ['gh', ['run', 'view', '5', '--json', 'jobs'], { cwd: CWD }],
      ['gh', ['run', 'view', '--job', '6', '--log'], { cwd: CWD }],
    ]);
  });
});
