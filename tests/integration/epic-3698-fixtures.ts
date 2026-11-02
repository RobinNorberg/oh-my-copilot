/** Shared fixtures of the epic-3698-closure-verifier*.test.ts files: the verifier and collector scripts against a complete fixture repository. */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

import { IS_WIN } from '../../src/__tests__/helpers/platform.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..', '..');
export const SCRIPT = join(REPO_ROOT, 'scripts', 'verify-epic-3698-closure.mjs');
export const COLLECTOR = join(REPO_ROOT, 'scripts', 'collect-epic-3698-ci-evidence.mjs');

export interface RunResult {
  status: number;
  report: {
    verdict: string;
    exitCode: number;
    checks: Array<{ id: string; status: string; problems: string[] }>;
  };
}

export function runVerifier(args: string[], cwd = REPO_ROOT, options: { fakeGh?: boolean; bindHeadBase?: boolean; bindShipping?: boolean } = {}): RunResult {
  const env = { ...process.env };
  const rootIndex = args.indexOf('--root');
  const fixtureRoot = rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : cwd;
  const fakeGh = join(fixtureRoot, 'fake-gh', 'gh');
  if (options.fakeGh !== false && existsSync(fakeGh)) {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRoot, encoding: 'utf8' });
    if (head.status === 0) {
      const fixturePath = join(fixtureRoot, 'gh-fixture.json');
      const ghFixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
      const headSha = head.stdout.trim();
      const evidencePath = join(fixtureRoot, 'ci-evidence.json');
      if (options.bindShipping !== false && existsSync(evidencePath)) {
        const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
        const direct = evidence.payload?.directIssues?.[0];
        if (direct?.commit?.sha) {
          direct.shipping = {
            headSha,
            status: 'ahead',
            aheadBy: 1,
            behindBy: 0,
            mergeBaseSha: direct.commit.sha,
          };
          direct.source.shipping = `repos/fixture/example/compare/${direct.commit.sha}...${headSha}`;
          ghFixture.compares[`${direct.commit.sha}...${headSha}`] = {
            status: 'ahead',
            ahead_by: 1,
            behind_by: 0,
            merge_base_commit: { sha: direct.commit.sha },
          };
          writeJson(evidencePath, evidence);
        }
      }
      if (options.bindHeadBase !== false) {
        const baseIndex = args.indexOf('--base');
        const base = baseIndex >= 0 ? args[baseIndex + 1] : null;
        if (base) {
        const mergeBase = spawnSync('git', ['merge-base', base, 'HEAD'], { cwd: fixtureRoot, encoding: 'utf8' });
          if (mergeBase.status === 0) {
          ghFixture.commitPulls ??= {};
          ghFixture.commitPulls[headSha] = [{
            state: 'open',
            head: { sha: headSha },
            base: { ref: base, sha: mergeBase.stdout.trim() },
          }];
          }
        }
      }
      writeJson(fixturePath, ghFixture);
    }
    env.PATH = `${dirname(fakeGh)}${delimiter}${env.PATH ?? ''}`;
    env.EPIC_GH_FIXTURE = join(fixtureRoot, 'gh-fixture.json');
  } else if (options.fakeGh === false) {
    env.PATH = '';
  }
  const preload = options.fakeGh !== false && existsSync(fakeGh) ? fakeGhPreload(dirname(fakeGh)) : [];
  const result = spawnSync(process.execPath, [...preload, SCRIPT, ...args], { cwd, encoding: 'utf8', env });
  const report = JSON.parse(result.stdout);
  return { status: result.status ?? -1, report };
}

export function check(run: RunResult, id: string) {
  const found = run.report.checks.find((c) => c.id === id);
  expect(found, `check ${id} present`).toBeTruthy();
  return found!;
}

export const TIER0_WORKFLOWS = ['plan', 'execute', 'review', 'verify'];
export const TIER0_ROLES = ['planner', 'executor', 'reviewer', 'verifier'];
export const ALL_CHILDREN = [3702, 3703, 3704, 3705, 3706, 3707, 3708, 3709, 3710, 3711];
export const EXPECTED_CHILD_PRS: Record<number, number | null> = {
  3702: 3721,
  3703: 3720,
  3704: 3724,
  3705: 3716,
  3706: 3715,
  3707: 3725,
  3708: 3729,
  3709: null,
  3710: 3719,
  3711: 3723,
};

export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function gitFixture(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// Windows cannot execute the extensionless shebang fake, so on win32 the scripts get a preload
// that routes execFileSync('gh') through node.
export const FAKE_GH_PRELOAD = [
  "const childProcess = require('node:child_process');",
  "const { syncBuiltinESMExports } = require('node:module');",
  "const { join } = require('node:path');",
  'const execFileSync = childProcess.execFileSync;',
  "childProcess.execFileSync = (file, args, options) => file === 'gh'",
  "  ? execFileSync(process.execPath, [join(__dirname, 'gh'), ...(args ?? [])], options)",
  '  : execFileSync(file, args, options);',
  'syncBuiltinESMExports();',
  '',
].join('\n');

export function fakeGhPreload(fakeGhDir: string): string[] {
  return IS_WIN ? ['--require', join(fakeGhDir, 'preload.cjs')] : [];
}

export function installFakeGh(root: string, data: unknown) {
  const fakeGhDir = join(root, 'fake-gh');
  mkdirSync(fakeGhDir, { recursive: true });
  writeJson(join(root, 'gh-fixture.json'), data);
  const script = [
    '#!/usr/bin/env node',
    "const { readFileSync } = require('node:fs');",
    "const data = JSON.parse(readFileSync(process.env.EPIC_GH_FIXTURE, 'utf8'));",
    'const args = process.argv.slice(2);',
    "const out = (value) => process.stdout.write(JSON.stringify(value ?? null) + '\\n');",
    "if (args[0] === 'repo' && args[1] === 'view') out({ nameWithOwner: data.repository });",
    "else if (args[0] === 'pr' && args[1] === 'view') out(data.prs[args[2]]);",
    "else if (args[0] === 'issue' && args[1] === 'view') out(data.issues[args[2]]);",
    "else if (args[0] === 'api') {",
    '  const path = args[1];',
    "  const page = Number(new URL('https://fixture.invalid/' + path).searchParams.get('page') ?? '1');",
    '  const pageRecords = (values) => values.slice((page - 1) * 100, page * 100);',
    '  const pull = path.match(/^repos\\/[^/]+\\/[^/]+\\/pulls\\/(\\d+)$/);',
    '  const timeline = path.match(/^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)\\/timeline/);',
    '  const status = path.match(/^repos\\/[^/]+\\/[^/]+\\/commits\\/([0-9a-f]{40})\\/status$/);',
    '  const statuses = path.match(/^repos\\/[^/]+\\/[^/]+\\/commits\\/([0-9a-f]{40})\\/statuses/);',
    '  const checks = path.match(/^repos\\/[^/]+\\/[^/]+\\/commits\\/([0-9a-f]{40})\\/check-runs/);',
    '  const commitPulls = path.match(/^repos\\/[^/]+\\/[^/]+\\/commits\\/([0-9a-f]{40})\\/pulls/);',
    '  const commit = path.match(/^repos\\/[^/]+\\/[^/]+\\/commits\\/([0-9a-f]{40})$/);',
    '  const workflows = path.match(/^repos\\/[^/]+\\/[^/]+\\/actions\\/runs/);',
    '  const compare = path.match(/^repos\\/[^/]+\\/[^/]+\\/compare\\/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})/);',
    '  if (pull) { const pr = data.prs[pull[1]]; out({ number: pr.number, state: pr.state === "MERGED" ? "closed" : "open", merged_at: pr.state === "MERGED" ? "2026-08-12T00:00:00Z" : null, head: { sha: pr.headRefOid }, merge_commit_sha: pr.mergeCommit.oid, base: { ref: pr.baseRefName, sha: pr.baseRefOid } }); }',
    '  else if (timeline) out(pageRecords(data.timelines[timeline[1]] ?? []));',
    '  else if (status) out(data.statuses[status[1]]);',
    '  else if (statuses) out(pageRecords(data.legacyStatuses?.[statuses[1]] ?? []));',
    '  else if (checks) { const values = data.checkRuns[checks[1]] ?? []; out({ total_count: values.length, check_runs: pageRecords(values) }); }',
    '  else if (commitPulls) out(pageRecords(data.commitPulls?.[commitPulls[1]] ?? []));',
    '  else if (commit) out(data.commits[commit[1]]);',
    '  else if (workflows) { const values = data.workflowRuns ?? []; out({ total_count: values.length, workflow_runs: pageRecords(values) }); }',
    '  else if (compare) out(data.compares?.[compare[1] + "..." + compare[2]]);',
    "  else { process.stderr.write('unknown fake gh api: ' + path + '\\n'); process.exit(2); }",
    "} else { process.stderr.write('unknown fake gh args: ' + args.join(' ') + '\\n'); process.exit(2); }",
    '',
  ].join('\n');
  writeFileSync(join(fakeGhDir, 'gh'), script);
  chmodSync(join(fakeGhDir, 'gh'), 0o755);
  writeFileSync(join(fakeGhDir, 'preload.cjs'), FAKE_GH_PRELOAD);
}

export function commitFixture(root: string, message: string) {
  const commands = [
    ['init', '-q'],
    ['config', 'user.email', 'fixture@example.invalid'],
    ['config', 'user.name', 'fixture'],
    ['add', '-A'],
    ['commit', '-qm', message],
  ];
  for (const args of commands) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

export function commitFixtureHead(root: string, message: string) {
  for (const args of [['add', '-A'], ['commit', '-qm', message]]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

// Builds a synthetic repository root where every epic #3698 closure
// prerequisite is satisfied, so the verifier must return PASS / exit 0.
export function buildCompleteFixture(root: string) {
  for (const skill of TIER0_WORKFLOWS) {
    mkdirSync(join(root, 'skills', skill), { recursive: true });
    writeFileSync(join(root, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
  mkdirSync(join(root, 'commands'), { recursive: true });
  for (let i = 0; i < 12; i += 1) writeFileSync(join(root, 'commands', `cmd-${i}.md`), 'x\n');
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  for (let i = 0; i < 5; i += 1) writeFileSync(join(root, '.github', 'workflows', `w${i}.yml`), 'on: push\n');
  mkdirSync(join(root, 'src', 'agents'), { recursive: true });
  for (const role of TIER0_ROLES) writeFileSync(join(root, 'src', 'agents', `${role}.ts`), 'export {};\n');

  const receipts = join(root, 'receipts', 'epic-3698');
  mkdirSync(receipts, { recursive: true });
  const head = 'a'.repeat(40);
  for (const issue of ALL_CHILDREN) {
    const pullRequest = EXPECTED_CHILD_PRS[issue];
    writeJson(join(receipts, `child-${issue}-terminal.receipt.json`), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        state: 'merged',
        evidence: pullRequest === null
          ? {
              issue: { number: 3709, state: 'CLOSED' },
              commit: { sha: 'b'.repeat(40) },
              status: { state: 'success', sha: 'b'.repeat(40) },
            }
          : {
              pullRequest: { number: pullRequest, headSha: head },
              commit: { sha: 'b'.repeat(40) },
              status: { conclusion: 'success', sha: head },
            },
      },
    });
  }
  writeJson(join(receipts, 'alias-usage.receipt.json'), {
    schemaVersion: 1,
    kind: 'alias-usage',
    issue: 3711,
    createdAt: '2026-08-12T00:00:00Z',
    payload: {
      canonicalShare: 0.97,
      minorReleases: 2,
      daysSinceDeprecation: 91,
      consecutiveReleasesAtThreshold: 2,
      knownCriticalIntegrations: 0,
    },
  });
  writeJson(join(root, 'receipts', 'epic-3698', 'remaining-risk.json'), {
    schemaVersion: 1,
    risks: [
      { id: 'R1', description: 'residual', severity: 'low', mitigation: 'monitored by verifier', status: 'monitored' },
    ],
  });
  writeFileSync(join(receipts, 'README.md'), '# receipts\n');
  mkdirSync(join(root, 'docs', 'design'), { recursive: true });
  writeFileSync(join(root, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'), '# design\n[receipts](../../receipts/epic-3698/README.md)\n');

  writeJson(join(root, 'ci-evidence.json'), {
    schemaVersion: 1,
    kind: 'ci-evidence',
    issue: 3712,
    createdAt: '2026-08-12T00:00:00Z',
    payload: {
      collector: 'test-fixture-collector',
      repository: 'fixture/example',
      directIssues: [{
        issue: 3709,
        state: 'CLOSED',
        commit: { sha: 'b'.repeat(40) },
        status: { sha: 'b'.repeat(40), state: 'success' },
        statuses: [],
        checks: [{ name: 'direct-check', status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) }],
        workflows: [{ id: 1, name: 'Direct CI', path: '.github/workflows/direct.yml', status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) }],
        shipping: { headSha: 'e'.repeat(40), status: 'ahead', aheadBy: 1, behindBy: 0, mergeBaseSha: 'b'.repeat(40) },
        source: {
          repository: 'fixture/example',
          issue: 'repos/fixture/example/issues/3709',
          timeline: 'repos/fixture/example/issues/3709/timeline',
          eventType: 'referenced',
          commitId: 'b'.repeat(40),
          commit: `repos/fixture/example/commits/${'b'.repeat(40)}`,
          status: `repos/fixture/example/commits/${'b'.repeat(40)}/status`,
          statuses: `repos/fixture/example/commits/${'b'.repeat(40)}/statuses`,
          checks: `repos/fixture/example/commits/${'b'.repeat(40)}/check-runs`,
          workflows: 'repos/fixture/example/actions/runs',
          shipping: `repos/fixture/example/compare/${'b'.repeat(40)}...${'e'.repeat(40)}`,
        },
      }],
      pullRequests: ALL_CHILDREN.filter((issue) => EXPECTED_CHILD_PRS[issue] !== null).map((issue) => ({
        childIssue: issue,
        number: EXPECTED_CHILD_PRS[issue],
        headSha: head,
        mergeCommitSha: 'b'.repeat(40),
        state: 'MERGED',
        checks: [
          { name: 'CI / Test', conclusion: 'success', sha: head },
          { name: 'CI / Lint', conclusion: 'skipped', sha: head },
        ],
      })),
    },
  });
  installFakeGh(root, {
    repository: 'fixture/example',
    prs: Object.fromEntries(ALL_CHILDREN
      .filter((issue) => EXPECTED_CHILD_PRS[issue] !== null)
      .map((issue) => [String(EXPECTED_CHILD_PRS[issue]), {
        number: EXPECTED_CHILD_PRS[issue],
        state: 'MERGED',
        headRefOid: head,
        mergeCommit: { oid: 'b'.repeat(40) },
        baseRefName: 'dev',
        baseRefOid: 'd'.repeat(40),
        statusCheckRollup: [
          { workflowName: 'CI', name: 'Test', conclusion: 'success' },
          { workflowName: 'CI', name: 'Lint', conclusion: 'skipped' },
        ],
      }])),
    issues: Object.fromEntries(ALL_CHILDREN.map((issue) => [String(issue), { number: issue, state: 'CLOSED' }])),
    timelines: { '3709': [{ event: 'referenced', commit_id: 'b'.repeat(40) }] },
    commits: { ['b'.repeat(40)]: { sha: 'b'.repeat(40), repository: { full_name: 'fixture/example' } } },
    statuses: { ['b'.repeat(40)]: { sha: 'b'.repeat(40), state: 'success' } },
    checkRuns: {
      [head]: [
        { name: 'CI / Test', status: 'completed', conclusion: 'success', head_sha: head },
        { name: 'CI / Lint', status: 'completed', conclusion: 'skipped', head_sha: head },
      ],
      ['b'.repeat(40)]: [{ name: 'direct-check', status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) }],
    },
    legacyStatuses: { [head]: [], ['b'.repeat(40)]: [] },
    commitPulls: {},
    workflowRuns: [{ id: 1, name: 'Direct CI', path: '.github/workflows/direct.yml', status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) }],
    compares: { [`${'b'.repeat(40)}...${'e'.repeat(40)}`]: { status: 'ahead', ahead_by: 1, behind_by: 0, merge_base_commit: { sha: 'b'.repeat(40) } } },
  });
  writeFileSync(join(root, 'changed-files.txt'), 'scripts/verify-epic-3698-closure.mjs\nreceipts/epic-3698/README.md\n');
  return head;
}
