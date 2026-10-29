import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, relative } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { FactorySafetyError, factoryGuardExec } from '../../../factory/run/exec.js';
import { adoMergeBody, writeAdoMergeBody } from '../merge.js';
import { adoFixtureExec, loadAdoFixtures } from './fixtures.js';
import { adoWorld, CHECKOUT, HEAD, REPO, STATE_DIR, variant, WINDOWS_ENTRY } from './world.js';

const scratch = mkdtempSync(join(tmpdir(), 'omg-ado-adapter-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(STATE_DIR, { recursive: true, force: true });
});
const bodyFile = (name: string, text: string) => {
  const path = join(scratch, name);
  writeFileSync(path, text, 'utf8');
  return path;
};
const flag = (args: string[], f: string) => args[args.indexOf(f) + 1];

// One test per row of design §6, each answered by a docs-sample fixture.
describe('ADO adapter, design §6 rows', () => {
  it('view work item: fields, relations, HTML to text, open by state category, trust by uniqueName', () => {
    const { forge, routes } = adoWorld();
    const item = forge.tracker.viewItem(42);
    expect(item).toMatchObject({
      id: 42,
      url: 'https://dev.azure.com/contoso/Web/_workitems/edit/42',
      title: 'Add CSV export to the report page',
      body: 'Users want the report as CSV.',
      acceptance: '## Acceptance criteria\n\n- Run npm test\n- GET /report.csv returns 200',
      open: true,
      rawState: 'Active',
      authorTrusted: true,
      labels: ['factory', 'reports'],
      type: 'User Story',
      column: 'Ready',
      priority: 2,
      size: 3,
      dependsOn: [40],
      children: [43],
      repoUrl: REPO.url,
    });
    expect(routes()).toEqual(['wit.workItems.GET', 'wit.workItemTypeStates.GET', 'wit.comments.GET']);
  });

  it('item comments: a trusted omg-plan line counts only from a trustedAuthors uniqueName, never a display name', () => {
    const { forge } = adoWorld();
    expect(forge.tracker.viewItem(42).comments).toEqual([
      { body: 'omg-plan: docs/plans/csv-export.md', author: 'owner@example.com', trusted: true },
      { body: 'omg-plan: docs/plans/evil.md', author: 'mallory@example.com', trusted: false },
    ]);
  });

  it('type states: a Completed-category state reads as closed', () => {
    const fixtures = variant(loadAdoFixtures(), 'wit.workItems.GET.42.json', (s) => ({ ...s, fields: { ...s.fields, 'System.State': 'Closed' } }));
    expect(adoWorld({ fixtures }).forge.tracker.viewItem(42)).toMatchObject({ open: false, rawState: 'Closed' });
  });

  it('intake by saved query: the GUID query id, $top = limit', () => {
    const { forge, calls } = adoWorld();
    expect(forge.tracker.queryItems({ type: 'wiql-query', queryId: '0b6c6d2e-1a5f-4c83-9d2e-7f1a2b3c4d5e' }, 50)).toEqual([42, 44]);
    expect(() => forge.tracker.queryItems({ type: 'wiql-query', queryId: "x' OR 1=1" }, 50)).toThrow(/not a GUID/);
    expect(calls).toHaveLength(1);
    expect(flag(calls[0].args, '--http-method')).toBe('GET');
    expect(flag(calls[0].args, '--query-parameters')).toBe('$top=50');
  });

  it('intake by area path + tag: WIQL built with escapeWiql, posted via --in-file', () => {
    const { forge, calls } = adoWorld();
    expect(forge.tracker.queryItems({ type: 'area-tag', areaPath: "Web\\Factory's", tag: 'factory' }, 50)).toEqual([42]);
    expect(calls[0].body).toEqual({
      query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AreaPath] UNDER 'Web\\Factory''s' AND [System.Tags] CONTAINS 'factory' AND [System.WorkItemType] IN ('User Story', 'Bug') ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.Id] ASC",
    });
  });

  it('intake by board column: the board\'s Kanban column field from work/boards', () => {
    const { forge, calls, routes } = adoWorld();
    expect(forge.tracker.queryItems({ type: 'board-column', team: 'Web Team', board: 'Stories', column: 'Ready' }, 50)).toEqual([42]);
    expect(routes()).toEqual(['work.boards.GET', 'wit.wiql.POST']);
    expect((calls[1].body as { query: string }).query).toContain("[WEF_6CB513B6E70E43499D9FC94E5BBFB784_Kanban.Column] = 'Ready'");
    expect(() => forge.tracker.queryItems({ type: 'label', label: 'factory' }, 50)).toThrow(/GitHub source/);
  });

  it('comment on a work item: markdown, from the engine body file', () => {
    const { forge, calls } = adoWorld();
    expect(forge.tracker.comment(42, bodyFile('c.md', 'factory: PR opened'))).toEqual({ ok: true, stderr: '' });
    expect(calls[0].body).toEqual({ text: 'factory: PR opened' });
    expect(flag(calls[0].args, '--query-parameters')).toBe('format=markdown');
    expect(forge.tracker.comment(42, join(scratch, 'missing.md')).ok).toBe(false);
  });

  it('tags / state / board column move: one JSON-patch guarded by test /rev', () => {
    const { forge, calls } = adoWorld();
    expect(forge.tracker.setProgress(42, 'reviewing', { column: 'Code Review' }).ok).toBe(true);
    const patch = calls.find((c) => flag(c.args, '--http-method') === 'PATCH')!;
    expect(flag(patch.args, '--media-type')).toBe('application/json-patch+json');
    expect(patch.body).toEqual([
      { op: 'test', path: '/rev', value: 7 },
      { op: 'add', path: '/fields/WEF_6CB513B6E70E43499D9FC94E5BBFB784_Kanban.Column', value: 'Code Review' },
    ]);
  });

  it('progress is idempotent, never changes state on blocked/cancelled, and closes only on done', () => {
    const w = adoWorld();
    expect(w.forge.tracker.setProgress(42, 'queued', { column: 'Ready' })).toEqual({ ok: true, detail: 'already applied' });
    expect(w.forge.tracker.setProgress(42, 'blocked', { state: 'Closed' })).toEqual({ ok: true, detail: 'nothing mapped' });
    expect(w.forge.tracker.setProgress(42, 'cancelled', { column: 'Closed', state: 'Closed' })).toEqual({ ok: true, detail: 'nothing mapped' });
    expect(w.routes().filter((r) => r.endsWith('PATCH'))).toEqual([]);
    expect(w.forge.tracker.setProgress(42, 'reviewing', { state: 'Closed' })).toMatchObject({ ok: false, detail: expect.stringMatching(/only the done stage/) });
    expect(w.forge.tracker.setProgress(42, 'building', { state: 'Nope' })).toMatchObject({ ok: false, detail: expect.stringMatching(/not a state/) });
    const done = adoWorld();
    expect(done.forge.tracker.setProgress(42, 'done', { state: 'Closed' }).ok).toBe(true);
    expect(done.calls.at(-1)!.body).toEqual([{ op: 'test', path: '/rev', value: 7 }, { op: 'add', path: '/fields/System.State', value: 'Closed' }]);
  });

  it('a rev conflict re-reads once and retries once', () => {
    const fixtures = loadAdoFixtures().map((f) => (f.name === 'wit.workItems.PATCH.42.json' ? { ...f, provenance: 'synthetic: rev conflict', exitCode: 1, stdout: '', stderr: 'ERROR: TF26071: This work item has been changed by someone else since you opened it.' } : f));
    const w = adoWorld({ fixtures });
    const res = w.forge.tracker.setProgress(42, 'reviewing', { column: 'Code Review' });
    expect(res).toMatchObject({ ok: false, detail: expect.stringContaining('TF26071') });
    expect(w.routes().filter((r) => r === 'wit.workItems.PATCH')).toHaveLength(2);
    expect(w.routes().filter((r) => r === 'wit.workItems.GET')).toHaveLength(2);
  });

  it('check --mark: the marker tag merges into System.Tags, once', () => {
    const w = adoWorld();
    expect(w.forge.tracker.addMarker(42, 'factory-ready')).toEqual({ ok: true, stderr: '' });
    expect(w.calls.at(-1)!.body).toEqual([{ op: 'test', path: '/rev', value: 7 }, { op: 'add', path: '/fields/System.Tags', value: 'factory; reports; factory-ready' }]);
    const again = adoWorld();
    expect(again.forge.tracker.addMarker(42, 'FACTORY')).toEqual({ ok: true, stderr: '' });
    expect(again.routes()).toEqual(['wit.workItems.GET']);
  });

  it('find PR for branch: active PRs from refs/heads/<branch>', () => {
    const { forge, calls } = adoWorld();
    expect(forge.reviews.findOpenPrForBranch('factory/issue-42')).toBe(17);
    expect(calls[0].args).toEqual(expect.arrayContaining(['searchCriteria.sourceRefName=refs/heads/factory/issue-42', 'searchCriteria.status=active']));
  });

  it('create draft PR + link item: isDraft true, description from the body file', () => {
    const { forge, calls } = adoWorld();
    const pr = forge.reviews.createDraftPr({ base: 'main', head: 'factory/issue-42', title: 'factory: issue 42', bodyFile: bodyFile('pr.md', 'Closes AB#42\u0007'), itemId: 42 });
    expect(pr).toBe(17);
    expect(calls[0].body).toEqual({
      sourceRefName: 'refs/heads/factory/issue-42',
      targetRefName: 'refs/heads/main',
      title: 'factory: issue 42',
      description: 'Closes AB#42',
      isDraft: true,
      workItemRefs: [{ id: '42' }],
    });
  });

  it('create draft PR caps the description at ADO\'s 4000 characters', () => {
    const { forge, calls } = adoWorld();
    forge.reviews.createDraftPr({ base: 'main', head: 'factory/issue-42', title: 't', bodyFile: bodyFile('long.md', 'x'.repeat(9000)) });
    const description = (calls[0].body as { description: string }).description;
    expect(description.length).toBe(4000);
    expect(description).toMatch(/truncated/);
  });

  it('view PR: status, draft, base/head sha', () => {
    const { forge } = adoWorld();
    expect(forge.reviews.viewPr(17)).toEqual({
      number: 17,
      state: 'OPEN',
      isDraft: true,
      baseRefName: 'main',
      baseRefOid: '2222222222222222222222222222222222222222',
      headRefName: 'factory/issue-42',
      headRefOid: HEAD,
      url: 'https://dev.azure.com/contoso/Web/_git/web-app/pullrequest/17',
    });
    expect(forge.reviews.prHead(17)).toEqual({ headRefOid: HEAD, state: 'OPEN' });
    const merged = variant(loadAdoFixtures(), 'git.pullRequests.GET.by-id.json', (s) => ({ ...s, status: 'completed' }));
    expect(adoWorld({ fixtures: merged }).forge.reviews.viewPr(17).state).toBe('MERGED');
    const odd = variant(loadAdoFixtures(), 'git.pullRequests.GET.by-id.json', (s) => ({ ...s, status: 'weird' }));
    expect(() => adoWorld({ fixtures: odd }).forge.reviews.viewPr(17)).toThrow(/unknown status/);
  });

  it('mark ready: PATCH {isDraft:false} only', () => {
    const { forge, calls } = adoWorld();
    forge.reviews.markReady(17);
    expect(calls[0].body).toEqual({ isDraft: false });
  });

  it('PR comment: a new active thread with one text comment', () => {
    const { forge, calls } = adoWorld();
    expect(forge.reviews.commentPr(17, bodyFile('t.md', 'factory: review passed'))).toEqual({ ok: true, stderr: '' });
    expect(calls[0].body).toEqual({ comments: [{ parentCommentId: 0, content: 'factory: review passed', commentType: 1 }], status: 1 });
  });

  it('builds for exact head: only builds whose PR source sha is the head and that built the current merge commit', () => {
    const { forge } = adoWorld();
    expect(forge.checks.runsForHead(17, HEAD)).toEqual([{ databaseId: 101, status: 'completed', conclusion: 'success', workflowName: 'web-app CI', headSha: HEAD }]);
  });

  it('status-policy results + PR iterations + build-validation evaluations map to checks for the head', () => {
    const { forge, routes } = adoWorld();
    expect(forge.checks.checks(17, HEAD)).toEqual([
      { name: 'CI', state: 'SUCCESS', runId: '101', link: 'https://dev.azure.com/contoso/Web/_build/results?buildId=101', workflow: 'web-app CI', event: 'pull_request' },
      { name: 'Lint', state: 'SUCCESS', event: 'pull_request' },
      { name: 'Docs build', state: 'FAILURE', runId: '101', link: 'https://dev.azure.com/contoso/Web/_build/results?buildId=101', workflow: 'web-app CI', event: 'pull_request', advisory: true },
    ]);
    expect(routes()).toEqual(['git.pullRequests.GET', 'policy.evaluations.GET', 'build.builds.GET', 'git.pullRequestIterations.GET', 'git.pullRequestStatuses.GET']);
  });

  it('failed tasks + logs: timeline record to log lines', () => {
    const { forge, routes } = adoWorld();
    const log = forge.checks.jobLog('101:9d8c7b6a-5f4e-4d3c-9b2a-1f0e9d8c7b6a');
    expect(log.ok).toBe(true);
    expect(log.text).toContain('FAIL src/report.test.ts > exports CSV');
    expect(routes()).toEqual(['build.timeline.GET', 'build.logs.GET']);
    expect(forge.checks.jobLog('101:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')).toMatchObject({ ok: false, text: expect.stringMatching(/has no log/) });
    expect(forge.checks.jobLog('not-a-job')).toMatchObject({ ok: false });
  });

  it('rerun: requeue the build evaluation that ran the build; no match is ok:false, never a guess', () => {
    const w = adoWorld();
    expect(w.forge.checks.rerun(17, '101')).toEqual({ ok: true, stderr: '' });
    const patch = w.calls.at(-1)!;
    expect(patch.args).toEqual(expect.arrayContaining(['evaluationId=e1a2b3c4-0000-4000-8000-000000000001', 'PATCH']));
    expect(patch.inFile).toBeUndefined();
    expect(adoWorld().forge.checks.rerun(17, '555')).toMatchObject({ ok: false, stderr: expect.stringMatching(/no build policy evaluation/) });
  });

  it('merge decision from branch policies: every blocking evaluation, the draft flag and the merge status', () => {
    const { forge } = adoWorld();
    expect(forge.merge.blockingPolicies(17, HEAD)).toEqual(['pull request is a draft', 'Minimum number of reviewers: rejected']);
    const ready = variant(loadAdoFixtures(), 'git.pullRequests.GET.by-id.json', (s) => ({ ...s, isDraft: false, mergeStatus: 'conflicts' }));
    expect(adoWorld({ fixtures: ready }).forge.merge.blockingPolicies(17, 'b'.repeat(40))).toEqual([
      `Azure DevOps head ${HEAD} is not ${'b'.repeat(40)}`,
      'merge status conflicts (needs succeeded)',
      'Minimum number of reviewers: rejected',
    ]);
  });

  it('human merge command: the engine writes the head-pinned body to an absolute 0600 file outside the roots, and the factory guard refuses to run it', () => {
    const { forge, guard } = adoWorld();
    const argv = forge.merge.humanMergeCommand(17, HEAD);
    expect(argv.slice(0, 3)).toEqual(['az', 'devops', 'invoke']);
    expect(argv).toEqual(expect.arrayContaining(['pullRequests', 'PATCH', 'pullRequestId=17', '--detect', 'false']));
    const file = flag(argv, '--in-file');
    expect(isAbsolute(file)).toBe(true);
    expect(relative(realpathSync.native(STATE_DIR), file).startsWith('..')).toBe(false);
    expect(relative(CHECKOUT, file).startsWith('..')).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ status: 'completed', lastMergeSourceCommit: { commitId: HEAD }, completionOptions: { mergeStrategy: 'noFastForward' } });
    expect(adoMergeBody(HEAD)).toEqual(JSON.parse(readFileSync(file, 'utf8')));
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const run = factoryGuardExec(adoFixtureExec(loadAdoFixtures()), () => [], () => guard);
    expect(() => run('az', argv.slice(1))).toThrow(FactorySafetyError);
    expect(() => forge.merge.humanMergeCommand(17, 'HEAD')).toThrow(/40-hex/);
  });

  it('human merge command: a planted body file is replaced, and a state dir under an untrusted root is refused', () => {
    const { forge } = adoWorld();
    const first = flag(forge.merge.humanMergeCommand(17, HEAD), '--in-file');
    writeFileSync(first, JSON.stringify({ status: 'completed', completionOptions: { bypassPolicy: true } }), 'utf8');
    const again = flag(forge.merge.humanMergeCommand(17, HEAD), '--in-file');
    expect(again).toBe(first);
    expect(JSON.parse(readFileSync(again, 'utf8')).completionOptions).toEqual({ mergeStrategy: 'noFastForward' });
    const lane = join(scratch, 'lane-root');
    expect(() => writeAdoMergeBody({ repo: REPO }, { stateDir: join(lane, 'state'), untrustedRoots: [lane] }, 17, HEAD)).toThrow(/under the untrusted root/);
    expect(() => writeAdoMergeBody({ repo: REPO }, { stateDir: 'relative/state', untrustedRoots: [lane] }, 17, HEAD)).toThrow(/not absolute/);
  });

  it('runs the same way through the Windows entry: python.exe -IBm azure.cli with AZ_INSTALLER=MSI', () => {
    const w = adoWorld({ entry: WINDOWS_ENTRY });
    expect(w.forge.reviews.viewPr(17).number).toBe(17);
    w.forge.reviews.markReady(17);
    expect(w.calls.map((c) => c.cmd)).toEqual([WINDOWS_ENTRY.command, WINDOWS_ENTRY.command]);
    expect(w.calls[0].args.slice(0, 4)).toEqual(['-IBm', 'azure.cli', 'devops', 'invoke']);
    expect(w.calls[1].body).toEqual({ isDraft: false });
  });

  it('every call pins --api-version from routes.ts, --org, --detect false and --output json', () => {
    const w = adoWorld();
    w.forge.tracker.viewItem(42);
    w.forge.checks.checks(17, HEAD);
    for (const c of w.calls) {
      expect(flag(c.args, '--org')).toBe('https://dev.azure.com/contoso');
      expect(flag(c.args, '--detect')).toBe('false');
      expect(flag(c.args, '--output')).toBe('json');
    }
    expect(w.calls.find((c) => flag(c.args, '--resource') === 'comments')!.args).toEqual(expect.arrayContaining(['--api-version', '7.1-preview.4']));
    expect(w.calls.find((c) => flag(c.args, '--resource') === 'evaluations')!.args).toEqual(expect.arrayContaining(['--api-version', '7.1-preview.1']));
  });

  it('capabilities: no heal, no Projects v2, board columns, no webhook intake', () => {
    expect(adoWorld().forge).toMatchObject({ kind: 'azure-devops', provider: 'azure-devops', capabilities: { heal: false, projectsV2: false, boardColumns: true, webhookIntake: false } });
  });

  it('az errors reach the caller redacted', () => {
    const pat = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
    const fixtures = loadAdoFixtures().map((f) => (f.name === 'wit.workItems.GET.missing.json' ? { ...f, stderr: `ERROR: TF401232 Authorization: Basic ${pat}` } : f));
    expect(() => adoWorld({ fixtures }).forge.tracker.viewItem(404)).toThrow(/TF401232 Authorization: \*\*\*$/);
  });
});
