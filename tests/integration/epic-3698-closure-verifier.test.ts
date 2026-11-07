import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  REPO_ROOT, SCRIPT, COLLECTOR, runVerifier, check, writeJson, gitFixture, fakeGhPreload, commitFixture, commitFixtureHead, buildCompleteFixture,
} from './epic-3698-fixtures.js';

describe('epic-3698 closure verifier (#3712)', () => {
  let fixture: string;

  it('rejects the unverifiable direct-only collector mode before invoking GitHub', () => {
    const result = spawnSync(process.execPath, [COLLECTOR, '--direct-only', '--out', join(tmpdir(), 'unused-direct.json')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown argument: --direct-only');
  });

  it('runs main when invoked from a path that a URL pathname would encode', () => {
    const root = mkdtempSync(join(tmpdir(), 'epic-3698 entry-'));
    try {
      const copy = join(root, 'verify-epic-3698-closure.mjs');
      copyFileSync(SCRIPT, copy);
      const result = spawnSync(process.execPath, [copy, '--no-such-flag'], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unknown argument: --no-such-flag');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses queued or in-progress PR checks instead of emitting completed evidence', () => {
    buildCompleteFixture(fixture);
    commitFixture(fixture, 'fixture');
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.checkRuns['a'.repeat(40)][0].status = 'in_progress';
    ghFixture.checkRuns['a'.repeat(40)][0].conclusion = null;
    writeJson(ghFixturePath, ghFixture);
    const result = spawnSync(process.execPath, [...fakeGhPreload(join(fixture, 'fake-gh')), COLLECTOR, '--all-children', '--out', join(fixture, 'collected.json')], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(fixture, 'fake-gh')}${delimiter}${process.env.PATH ?? ''}`,
        EPIC_GH_FIXTURE: ghFixturePath,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not completed');
    expect(existsSync(join(fixture, 'collected.json'))).toBe(false);
  });

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'epic-3698-fixture-'));
  });

  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it('passes with exit 0 when every acceptance surface is satisfied', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'tracked.txt'), 'base\n');
    commitFixture(fixture, 'base');
    gitFixture(fixture, ['branch', 'base']);
    writeFileSync(join(fixture, 'tracked.txt'), 'head\n');
    commitFixtureHead(fixture, 'head');
    writeFileSync(join(fixture, 'changed-files.txt'), 'tracked.txt\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'base',
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.report.verdict, JSON.stringify(run.report.checks, null, 2)).toBe('PASS');
    expect(run.status).toBe(0);
    for (const c of run.report.checks) expect(c.status, `${c.id}: ${c.problems.join('; ')}`).toBe('pass');
  });

  it('rejects CI evidence recorded at a stale head', () => {
    buildCompleteFixture(fixture);
    const head = 'a'.repeat(40);
    const stale = 'b'.repeat(40);
    writeJson(join(fixture, 'ci-evidence.json'), {
      schemaVersion: 1,
      payload: {
        pullRequests: [
          { number: 1, headSha: head, checks: [{ name: 'CI / Test', conclusion: 'success', sha: stale }] },
        ],
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').status).toBe('fail');
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain(stale);
  });

  it('rejects caller-controlled valid SHA evidence that disagrees with live GitHub', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const forged = 'c'.repeat(40);
    evidence.payload.pullRequests[0].headSha = forged;
    evidence.payload.pullRequests[0].mergeCommitSha = forged;
    evidence.payload.pullRequests[0].checks = [{ name: 'CI / Test', conclusion: 'success', sha: forged }];
    writeJson(evidencePath, evidence);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').status).toBe('fail');
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('does not match live PR head');
  });

  it('never passes caller evidence when live GitHub verification is unavailable', () => {
    buildCompleteFixture(fixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ], fixture, { fakeGh: false });
    expect(run.status).toBe(2);
    expect(check(run, 'exactHeadCi').status).toBe('pending');
    expect(run.report.verdict).not.toBe('PASS');
  });

  it('rejects checks without live-head binding and non-green conclusions', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'ci-evidence.json'), {
      schemaVersion: 1,
      payload: {
        pullRequests: [
          { number: 1, headSha: 'a'.repeat(40), checks: [{ name: 'CI / Test', conclusion: 'failure' }] },
        ],
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    const problems = check(run, 'exactHeadCi').problems.join(' ');
    expect(run.status).toBe(1);
    expect(problems).toContain('.sha must be a 40-char lowercase hex SHA');
    expect(problems).toContain('non-green');
  });

  it('rejects unsigned exactHead attestations', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.payload.pullRequests[0].checks = [{ name: 'CI / Test', conclusion: 'success', exactHead: true }];
    writeJson(evidencePath, evidence);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('exactHead is unsupported');
  });

  it('rejects forged child-terminal receipts that provide only free-form evidence', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'child-3702-terminal.receipt.json'), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue: 3702,
      createdAt: '2026-08-12T00:00:00Z',
      payload: { state: 'merged', evidence: 'PR #3721 merged with green CI' },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'childTerminality').status).toBe('fail');
    expect(check(run, 'childTerminality').problems.join(' ')).toContain('structured object');
  });

  it('records a terminal non-green PR truthfully without passing exact-head CI', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const pr = evidence.payload.pullRequests.find((entry: { number: number }) => entry.number === 3724);
    pr.checks.push({ name: 'CI / Test', conclusion: 'failure', sha: pr.headSha });
    writeJson(evidencePath, evidence);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'child-3704-terminal.receipt.json'), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue: 3704,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        state: 'merged',
        evidence: {
          pullRequest: { number: 3724, headSha: pr.headSha },
          commit: { sha: 'b'.repeat(40) },
          status: { conclusion: 'failure', sha: pr.headSha },
        },
      },
    });
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.checkRuns[pr.headSha].push({ name: 'CI / Test', status: 'completed', conclusion: 'failure', head_sha: pr.headSha });
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'migrationReceipts').status).toBe('pass');
    expect(check(run, 'exactHeadCi').status).toBe('fail');
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('does not exactly match live successful status checks');
  });

  it('rejects unrelated or missing child PR substitution in CI evidence', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.payload.pullRequests[0].number = 3727;
    writeJson(evidencePath, evidence);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').status).toBe('fail');
    const problems = check(run, 'exactHeadCi').problems.join(' ');
    expect(problems).toContain('not an expected child PR');
    expect(problems).toContain('missing expected PR #3721');
  });

  it('rejects CI evidence with an absent childIssue or non-merged PR state', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    delete evidence.payload.pullRequests[0].childIssue;
    evidence.payload.pullRequests[1].state = 'OPEN';
    writeJson(evidencePath, evidence);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    const problems = check(run, 'exactHeadCi').problems.join(' ');
    expect(problems).toContain('childIssue must equal');
    expect(problems).toContain('state must be MERGED');
  });

  it('rejects forged no-PR terminal evidence that does not match the direct issue artifact', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'child-3709-terminal.receipt.json'), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue: 3709,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        state: 'closed',
        evidence: {
          issue: { number: 3709, state: 'CLOSED' },
          commit: { sha: 'c'.repeat(40) },
          status: { state: 'success', sha: 'c'.repeat(40) },
        },
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).not.toBe(0);
    expect(check(run, 'childTerminality').status).toBe('fail');
    expect(check(run, 'childTerminality').problems.join(' ')).toContain('independently collected direct issue artifact');
  });

  it('rejects forged direct issue commit/status evidence even when receipt and CI JSON agree', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const forged = 'c'.repeat(40);
    const direct = evidence.payload.directIssues[0];
    direct.commit.sha = forged;
    direct.status.sha = forged;
    direct.checks[0].head_sha = forged;
    direct.workflows[0].head_sha = forged;
    direct.source.commitId = forged;
    direct.source.commit = `repos/fixture/example/commits/${forged}`;
    direct.source.status = `repos/fixture/example/commits/${forged}/status`;
    direct.source.statuses = `repos/fixture/example/commits/${forged}/statuses`;
    direct.source.checks = `repos/fixture/example/commits/${forged}/check-runs`;
    direct.shipping.mergeBaseSha = forged;
    direct.source.shipping = `repos/fixture/example/compare/${forged}...${direct.shipping.headSha}`;
    writeJson(evidencePath, evidence);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'child-3709-terminal.receipt.json'), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue: 3709,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        state: 'closed',
        evidence: {
          issue: { number: 3709, state: 'CLOSED' },
          commit: { sha: forged },
          status: { state: 'success', sha: forged },
        },
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).not.toBe(0);
    expect(check(run, 'exactHeadCi').status, JSON.stringify(check(run, 'exactHeadCi'), null, 2)).toBe('fail');
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('live issue timeline referenced.commit_id');
  });

  it('rejects committed.sha-only timeline evidence for direct issue #3709', () => {
    buildCompleteFixture(fixture);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.timelines['3709'] = [{ event: 'committed', sha: 'b'.repeat(40) }];
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('referenced.commit_id');
  });

  it('rejects mixed green and failed live PR check rollups', () => {
    buildCompleteFixture(fixture);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.checkRuns['a'.repeat(40)].push({
      name: 'Failed attempt',
      status: 'completed',
      conclusion: 'failure',
      head_sha: 'a'.repeat(40),
    });
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('does not exactly match live successful status checks');
  });

  it('fails closed when direct check-run pagination contains a late failure', () => {
    buildCompleteFixture(fixture);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.checkRuns['b'.repeat(40)] = Array.from({ length: 100 }, (_, index) => ({
      name: `green-${index}`,
      status: 'completed',
      conclusion: 'success',
      head_sha: 'b'.repeat(40),
    }));
    ghFixture.checkRuns['b'.repeat(40)].push({
      name: 'late-failure',
      status: 'completed',
      conclusion: 'failure',
      head_sha: 'b'.repeat(40),
    });
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('liveChecks[100].conclusion');
  });

  it('rejects pending legacy status contexts even when check runs and workflows are green', () => {
    buildCompleteFixture(fixture);
    const sha = 'b'.repeat(40);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.payload.directIssues[0].status.state = 'pending';
    evidence.payload.directIssues[0].statuses = [{ context: 'legacy-required', state: 'pending', sha }];
    writeJson(evidencePath, evidence);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.statuses[sha].state = 'pending';
    ghFixture.legacyStatuses[sha] = [{ context: 'legacy-required', state: 'pending', sha }];
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('statuses[0].state must be success');
  });

  it('rejects a failed child PR check beyond the first 100 records', () => {
    buildCompleteFixture(fixture);
    const head = 'a'.repeat(40);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.checkRuns[head] = Array.from({ length: 100 }, (_, index) => ({
      name: `green-${index}`,
      status: 'completed',
      conclusion: 'success',
      head_sha: head,
    }));
    ghFixture.checkRuns[head].push({ name: 'late-pr-failure', status: 'completed', conclusion: 'failure', head_sha: head });
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('does not exactly match live successful status checks');
  });

  it('finds direct issue referenced.commit_id after the first timeline page', () => {
    buildCompleteFixture(fixture);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.timelines['3709'] = [
      ...Array.from({ length: 100 }, () => ({ event: 'commented' })),
      { event: 'referenced', commit_id: 'b'.repeat(40) },
    ];
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'exactHeadCi').status).toBe('pass');
  });

  it('rejects HEAD as a valid-but-wrong base against the authenticated expected merge base', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'tracked.txt'), 'base\n');
    commitFixture(fixture, 'authenticated base');
    const authenticatedBase = gitFixture(fixture, ['rev-parse', 'HEAD']);
    writeFileSync(join(fixture, 'tracked.txt'), 'head\n');
    commitFixtureHead(fixture, 'closure head');
    writeFileSync(join(fixture, 'changed-files.txt'), 'tracked.txt\n');

    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    for (const pr of Object.values(ghFixture.prs) as Array<Record<string, unknown>>) {
      pr.baseRefName = 'main';
      pr.baseRefOid = authenticatedBase;
    }
    const closureHead = gitFixture(fixture, ['rev-parse', 'HEAD']);
    ghFixture.commitPulls[closureHead] = [{
      state: 'open',
      head: { sha: closureHead },
      base: { ref: 'main', sha: authenticatedBase },
    }];
    writeJson(ghFixturePath, ghFixture);

    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'HEAD',
      '--changed-files', join(fixture, 'changed-files.txt'),
    ], fixture, { bindHeadBase: false });
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').status).toBe('fail');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('authenticated expected merge base');
  });

  it('does not pass Git-backed release parity without an authenticated exact-head PR base', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'tracked.txt'), 'base\n');
    commitFixture(fixture, 'base');
    writeFileSync(join(fixture, 'tracked.txt'), 'head\n');
    commitFixtureHead(fixture, 'head');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'HEAD',
    ], fixture, { bindHeadBase: false });
    expect(run.status).toBe(2);
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('authenticated expected merge base unavailable');
  });

  it('derives the authenticated exact-head PR base from a later associated-pulls page', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'tracked.txt'), 'base\n');
    commitFixture(fixture, 'authenticated base');
    const authenticatedBase = gitFixture(fixture, ['rev-parse', 'HEAD']);
    writeFileSync(join(fixture, 'tracked.txt'), 'head\n');
    commitFixtureHead(fixture, 'closure head');
    const closureHead = gitFixture(fixture, ['rev-parse', 'HEAD']);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.commitPulls[closureHead] = [
      ...Array.from({ length: 100 }, () => ({ state: 'closed', head: { sha: closureHead }, base: { ref: 'other', sha: closureHead } })),
      { state: 'open', head: { sha: closureHead }, base: { ref: 'main', sha: authenticatedBase } },
    ];
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'HEAD',
    ], fixture, { bindHeadBase: false });
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('authenticated expected merge base');
  });

  it('rejects authentic direct issue evidence when the referenced commit is not shipped in exact HEAD', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'tracked.txt'), 'base\n');
    commitFixture(fixture, 'base');
    const base = gitFixture(fixture, ['rev-parse', 'HEAD']);
    writeFileSync(join(fixture, 'tracked.txt'), 'head\n');
    commitFixtureHead(fixture, 'head');
    const head = gitFixture(fixture, ['rev-parse', 'HEAD']);
    const commit = 'b'.repeat(40);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.payload.directIssues[0].shipping = {
      headSha: head,
      status: 'diverged',
      aheadBy: 5,
      behindBy: 3,
      mergeBaseSha: commit,
    };
    evidence.payload.directIssues[0].source.shipping = `repos/fixture/example/compare/${commit}...${head}`;
    writeJson(evidencePath, evidence);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.commitPulls[head] = [{ state: 'open', head: { sha: head }, base: { ref: 'base', sha: base } }];
    ghFixture.compares[`${commit}...${head}`] = {
      status: 'diverged',
      ahead_by: 5,
      behind_by: 3,
      merge_base_commit: { sha: commit },
    };
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--base', 'base',
    ], fixture, { bindHeadBase: false, bindShipping: false });
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('not proven reachable');
  });

  it('does not let --changed-files bypass package.json version-diff inspection', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'package.json'), { version: '9.9.9' });
    writeFileSync(join(fixture, 'changed-files.txt'), 'package.json\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').details).toContain('unauthenticated');
  });

  it('does not let unauthenticated --changed-files omit package.json when the Git base is unavailable', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'package.json'), { name: 'fixture', version: '9.9.9' });
    writeFileSync(join(fixture, 'changed-files.txt'), 'tracked.txt\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').details).toContain('unauthenticated');
  });

  it('detects a compact/reordered package.json version bump by parsing base and HEAD JSON', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    commitFixture(fixture, 'base package');
    writeFileSync(join(fixture, 'package.json'), '{"version":"2.0.0","name":"fixture"}\n');
    commitFixtureHead(fixture, 'bumped package');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'HEAD^',
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').status).toBe('fail');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('1.0.0 -> 2.0.0');
  });

  it('compares package.json against the exact merge-base when the selected base diverges', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    commitFixture(fixture, 'common ancestor');
    gitFixture(fixture, ['branch', 'selected-base']);
    gitFixture(fixture, ['checkout', 'selected-base']);
    writeFileSync(join(fixture, 'package.json'), '{"version":"2.0.0","name":"fixture"}\n');
    commitFixtureHead(fixture, 'selected base version');
    gitFixture(fixture, ['checkout', '-b', 'head', 'selected-base~1']);
    writeFileSync(join(fixture, 'package.json'), '{"name":"fixture","version":"2.0.0"}\n');
    commitFixtureHead(fixture, 'head version');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'selected-base',
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').status).toBe('fail');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('1.0.0 -> 2.0.0');
  });

  it('does not trust a shallow-history HEAD^ fallback when the requested base is unavailable', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, '.github', 'workflows', 'release.yml'), 'on: push\n');
    commitFixture(fixture, 'protected change before HEAD');
    writeFileSync(join(fixture, 'head.txt'), 'head\n');
    commitFixtureHead(fixture, 'head');

    // Model a depth-2 checkout: the protected change is in the shallow parent,
    // while the requested base and its origin equivalent are both unavailable.
    const shallowParent = gitFixture(fixture, ['rev-parse', 'HEAD^']);
    writeFileSync(join(fixture, '.git', 'shallow'), `${shallowParent}\n`);

    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'missing-base',
    ]);
    expect(run.status).toBe(2);
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').details).toContain('change set unavailable');
    expect(check(run, 'releaseSecurityParity').details).not.toContain('HEAD^');
  });

  it('fails closed on release/publish authority mutation in the change set', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'changed-files.txt'), '.github/workflows/release.yml\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').status).toBe('fail');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('release.yml');
  });

  it('checks both sides when a protected release workflow is renamed', () => {
    buildCompleteFixture(fixture);
    const workflowPath = join(fixture, '.github', 'workflows', 'release.yml');
    mkdirSync(join(fixture, '.github', 'workflows'), { recursive: true });
    writeFileSync(workflowPath, 'name: release\n');
    commitFixture(fixture, 'base release workflow');
    gitFixture(fixture, ['branch', 'base']);
    const renamedPath = join(fixture, '.github', 'workflows', 'ordinary.yml');
    renameSync(workflowPath, renamedPath);
    commitFixtureHead(fixture, 'rename release workflow');
    writeFileSync(join(fixture, 'changed-files.txt'), '.github/workflows/ordinary.yml\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'base',
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('release.yml');
  });
});
