/**
 * gh argv-parity baseline, CI self-heal side (factory forges design §A.6):
 * the exact ordered gh sequence of `src/factory/heal/history.ts` (listRuns,
 * viewRunJobs, jobLog) as `omg factory heal scan` (runHealScan) and the
 * evidence collection of `heal run` (collectEvidence) issue it, recorded below
 * healGuardExec. Recorded run and job fixtures of the heal tests.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHealScan } from '../../factory/heal/cli.js';
import { DEFAULT_HEAL_CONFIG } from '../../factory/heal/config.js';
import { collectEvidence } from '../../factory/heal/heal-evidence.js';
import { healGuardExec } from '../../factory/heal/history.js';
import { listHealStates } from '../../factory/heal/state.js';
import type { Exec } from '../../ship/exec.js';
import { recordingExec } from './recording-exec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HEAL_FIXTURES = join(HERE, '..', '..', 'factory', 'heal', '__tests__', 'fixtures');
const fixture = (name: string) => readFileSync(join(HEAL_FIXTURES, name), 'utf8');
const KNOWN_FILE = readFileSync(join(HERE, '..', '..', '..', '.github', 'known-flaky-tests.json'), 'utf8');
const NOW = new Date('2026-10-28T00:00:00Z');

interface RunFixture { databaseId: number; headSha: string; headBranch: string; event: string; conclusion: string; status: string; createdAt: string; jobs: unknown[] }
const RUNS = (JSON.parse(fixture('runs.json')) as { runs: RunFixture[] }).runs;
const run = (id: number) => RUNS.find((r) => r.databaseId === id)!;
/** A second PR branch failing with the same Test failure (cross-PR rule). */
const SECOND_PR: RunFixture = {
  ...run(40542274776), databaseId: 40551187199, headBranch: 'feat/other', createdAt: '2026-10-27T17:30:11Z',
  jobs: [{ databaseId: 500, name: 'Test', conclusion: 'failure', steps: [{ name: 'Run functional tests', conclusion: 'failure' }] }],
};
const LOGS: Record<string, string> = {
  122329975951: fixture('git256-red.log'),
  500: fixture('git256-red.log'),
  122329976558: fixture('policy-only.log'),
  122472797949: fixture('policy-only.log'),
  122472747061: fixture('git256-green.log'),
  122472798022: fixture('git256-green.log'),
};

let root: string;

/** Scripted gh and git answering from the run fixtures. */
function world(push: RunFixture[], pr: RunFixture[]): Exec {
  const all = [...push, ...pr];
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
  return (cmd, args) => {
    const a = args.join(' ');
    if (cmd === 'git') {
      if (a === 'show refs/remotes/origin/dev:.github/known-flaky-tests.json') return ok(KNOWN_FILE);
      if (args[0] === 'cat-file') return ok('');
      if (args[0] === 'rev-list') return ok('0\n');
      if (args[0] === 'diff') return ok('');
    }
    if (cmd === 'gh' && args[1] === 'list') return ok(JSON.stringify((args.includes('push') ? push : pr).map(({ jobs: _jobs, ...r }) => r)));
    if (cmd === 'gh' && args[1] === 'view' && args[4] === 'jobs') return ok(JSON.stringify({ jobs: all.find((r) => String(r.databaseId) === args[2])!.jobs }));
    if (cmd === 'gh' && args[2] === '--job') return ok(LOGS[args[3]] ?? '');
    return { status: 1, stdout: '', stderr: `unexpected ${cmd} ${a}` };
  };
}

const RUN_FIELDS = 'databaseId,conclusion,status,headSha,headBranch,event,createdAt';
const jobs = (id: number | string) => `gh ["run","view","${id}","--json","jobs"] cwd=<root>`;
const log = (id: number | string) => `gh ["run","view","--job","${id}","--log"] cwd=<root>`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-gh-baseline-heal-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('gh argv baseline: src/factory/heal/history.ts', () => {
  const fixtures = () => world([run(40584638028)], [run(40542274776), SECOND_PR, run(40584652986)]);

  it('heal scan: both run lists, then jobs and logs per run (each read once)', () => {
    const r = recordingExec(fixtures(), { '<root>': root }, ['gh']);
    runHealScan({ exec: r.exec, root, base: 'dev', config: DEFAULT_HEAL_CONFIG, now: NOW, dryRun: false, warn: () => {}, ledgerDir: join(root, '.omg', 'test-ledger') });
    expect(r.calls).toEqual([
      `gh ["run","list","--branch","dev","--workflow","ci.yml","--event","push","--json","${RUN_FIELDS}","--limit","30"] cwd=<root>`,
      `gh ["run","list","--workflow","ci.yml","--event","pull_request","--json","${RUN_FIELDS}","--limit","30"] cwd=<root>`,
      // The policy-only PR run: its jobs, no log (only an ignored PR-policy job failed).
      jobs(40584652986),
      jobs(40551187199), log(500),
      jobs(40542274776), log(122329975951),
      // The last green push run, for the env diff.
      jobs(40584638028), log(122472747061),
    ]);
  });

  it('heal run evidence: the red run\'s jobs and failed job logs, then the green run\'s', () => {
    runHealScan({ exec: fixtures(), root, base: 'dev', config: DEFAULT_HEAL_CONFIG, now: NOW, dryRun: false, warn: () => {}, ledgerDir: join(root, '.omg', 'test-ledger') });
    const [state] = listHealStates(root);
    const r = recordingExec(fixtures(), { '<root>': root }, ['gh']);
    collectEvidence(healGuardExec(r.exec), root, state.classification, DEFAULT_HEAL_CONFIG.ignoreJobs);
    expect(r.calls).toEqual([jobs(40542274776), log(122329975951), jobs(40584638028), log(122472747061)]);
  });
});
