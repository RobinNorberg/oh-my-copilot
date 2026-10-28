/**
 * gh argv-parity baseline, ship side (factory forges design §A.6): the exact
 * ordered gh sequence of `src/ship/gates.ts` (evaluateGates, watchGates),
 * `src/ship/merge.ts` (mergeCommand) and `src/cli/commands/ship.ts`, recorded
 * below the real guard. PR 2 moves these calls behind the Forge layer and must
 * pass this file unchanged.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shipCommand, type ShipConfigLoader } from '../../cli/commands/ship.js';
import { DEFAULT_SHIP_CONFIG, loadTrustedShipConfig, parseKnownFlaky, resolveShipConfig } from '../../ship/config.js';
import { guardExec, type Exec, type ExecResult } from '../../ship/exec.js';
import { evaluateGates, watchGates, type GhCheck, type WorkflowRun } from '../../ship/gates.js';
import { mergeCommand } from '../../ship/merge.js';
import { recordingExec } from './recording-exec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const SHIP_FIXTURES = join(HERE, '..', '..', 'ship', '__tests__', 'fixtures');
const fixture = (name: string) => readFileSync(join(SHIP_FIXTURES, name), 'utf8');
const GREEN: GhCheck[] = JSON.parse(fixture('checks-pr233-green.json'));
const KNOWN_TEXT = readFileSync(join(REPO_ROOT, DEFAULT_SHIP_CONFIG.knownFlakyFile), 'utf8');
const KNOWN = parseKnownFlaky(KNOWN_TEXT, DEFAULT_SHIP_CONFIG.knownFlakyFile);
const CONFIG = resolveShipConfig(undefined);

const PR = 233;
const HEAD = 'f'.repeat(40);
const MOVED = 'd'.repeat(40);
const RUN = '38006018811';
const JOB = '114080000001';
const CWD = 'C:/checkout';
const RUNS: WorkflowRun[] = [{ databaseId: 1, status: 'completed', conclusion: 'success', workflowName: 'CI' }];
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const withTest = (patch: Partial<GhCheck>): GhCheck[] => GREEN.map((c) => (c.name === 'Test' ? { ...c, ...patch } : c));
const FAILED_TEST = withTest({ state: 'FAILURE', link: `https://github.com/RobinNorberg/oh-my-copilot/actions/runs/${RUN}/job/${JOB}` });

/** Scripted gh: successive `pr checks` payloads and head shas, job logs by id. */
function scriptedGh(checks: GhCheck[][], heads: string[] = [HEAD], logs: Record<string, string> = {}): Exec {
  let c = 0;
  let h = 0;
  return (_cmd, args) => {
    const a = args.join(' ');
    if (a.startsWith('pr checks ')) return ok(JSON.stringify(checks[Math.min(c++, checks.length - 1)]));
    if (a.startsWith('pr view ')) return ok(JSON.stringify({ headRefOid: heads[Math.min(h++, heads.length - 1)] }));
    if (a.startsWith('run list ')) return ok(JSON.stringify(RUNS));
    if (a.startsWith('run view --job ')) return ok(logs[args[3]] ?? '');
    if (a.startsWith('run rerun ')) return ok('');
    throw new Error(`unscripted gh ${a}`);
  };
}

/** The recorder sits below the guard, where production spawns. */
function recorded(inner: Exec) {
  const r = recordingExec(inner);
  return { exec: guardExec(r.exec), calls: r.calls };
}

const VIEW_HEAD = `gh ["pr","view","${PR}","--json","headRefOid"] cwd=${CWD}`;
const CHECKS = `gh ["pr","checks","${PR}","--json","name,state,bucket,link,workflow,event,startedAt,completedAt"] cwd=${CWD}`;
const RUN_LIST = `gh ["run","list","--commit","${HEAD}","--json","databaseId,status,conclusion,workflowName,headSha","--limit","100"] cwd=${CWD}`;
const JOB_LOG = `gh ["run","view","--job","${JOB}","--log"] cwd=${CWD}`;

describe('gh argv baseline: src/ship/gates.ts evaluateGates', () => {
  it('without a head sha: head, checks, runs for the head, then the head again (the double fetchHeadSha)', () => {
    const { exec, calls } = recorded(scriptedGh([GREEN]));
    expect(evaluateGates(exec, PR, CONFIG, KNOWN, CWD).verdict).toBe('green');
    expect(calls).toEqual([VIEW_HEAD, CHECKS, RUN_LIST, VIEW_HEAD]);
  });

  it('with a head sha: the first head read is skipped, the re-read stays', () => {
    const { exec, calls } = recorded(scriptedGh([GREEN]));
    evaluateGates(exec, PR, CONFIG, KNOWN, CWD, HEAD);
    expect(calls).toEqual([CHECKS, RUN_LIST, VIEW_HEAD]);
  });

  it('a failed Actions check with known-flaky entries reads its job log after the head re-read', () => {
    const { exec, calls } = recorded(scriptedGh([FAILED_TEST], [HEAD], { [JOB]: fixture('job-log-flaky.txt') }));
    expect(evaluateGates(exec, PR, CONFIG, KNOWN, CWD).verdict).toBe('flaky');
    expect(calls).toEqual([VIEW_HEAD, CHECKS, RUN_LIST, VIEW_HEAD, JOB_LOG]);
  });

  it('a head that moved during the read stops before any job log', () => {
    const { exec, calls } = recorded(scriptedGh([FAILED_TEST], [HEAD, MOVED]));
    expect(evaluateGates(exec, PR, CONFIG, KNOWN, CWD).verdict).toBe('pending');
    expect(calls).toEqual([VIEW_HEAD, CHECKS, RUN_LIST, VIEW_HEAD]);
  });

  it('without a cwd no cwd reaches the child', () => {
    const { exec, calls } = recorded(scriptedGh([GREEN]));
    evaluateGates(exec, PR, CONFIG, KNOWN);
    expect(calls).toEqual([
      `gh ["pr","view","${PR}","--json","headRefOid"]`,
      `gh ["pr","checks","${PR}","--json","name,state,bucket,link,workflow,event,startedAt,completedAt"]`,
      `gh ["run","list","--commit","${HEAD}","--json","databaseId,status,conclusion,workflowName,headSha","--limit","100"]`,
      `gh ["pr","view","${PR}","--json","headRefOid"]`,
    ]);
  });
});

describe('gh argv baseline: src/ship/gates.ts watchGates', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };
  const budget = () => {
    const spent: Record<string, number> = {};
    return { count: (id: string) => spent[id] ?? 0, record: (id: string) => { spent[id] = (spent[id] ?? 0) + 1; } };
  };

  it('flaky -> one rerun -> pending -> green: every poll re-reads the head twice', async () => {
    const pending = withTest({ state: 'IN_PROGRESS' });
    const { exec, calls } = recorded(scriptedGh([FAILED_TEST, pending, GREEN], [HEAD], { [JOB]: fixture('job-log-flaky.txt') }));
    const r = await watchGates({ exec, pr: PR, config: CONFIG, known: KNOWN, cwd: CWD, watch: true, reruns: budget(), ...clock() });
    expect(r.report.verdict).toBe('green');
    expect(calls).toEqual([
      VIEW_HEAD, CHECKS, RUN_LIST, VIEW_HEAD, JOB_LOG,
      `gh ["run","rerun","${RUN}","--failed"] cwd=${CWD}`,
      VIEW_HEAD, CHECKS, RUN_LIST, VIEW_HEAD,
      VIEW_HEAD, CHECKS, RUN_LIST, VIEW_HEAD,
    ]);
  });

  it('a fixed head sha that moved returns after one read', async () => {
    const { exec, calls } = recorded(scriptedGh([withTest({ state: 'IN_PROGRESS' })], [MOVED]));
    await watchGates({ exec, pr: PR, config: CONFIG, known: KNOWN, cwd: CWD, headSha: HEAD, watch: true, ...clock() });
    expect(calls).toEqual([CHECKS, RUN_LIST, `gh ["pr","view","${PR}","--json","headRefOid"] cwd=${CWD}`]);
  });
});

describe('gh argv baseline: src/ship/merge.ts mergeCommand', () => {
  it('builds the head-pinned admin merge argv', () => {
    expect(mergeCommand(42, HEAD)).toEqual(['gh', 'pr', 'merge', '42', '--admin', '--merge', '--match-head-commit', HEAD]);
  });
});

describe('gh argv baseline: src/cli/commands/ship.ts', () => {
  const SHIP_HEAD = '1234567890abcdef1234567890abcdef12345678';
  const BASE = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const PR_URL = 'https://github.com/RobinNorberg/oh-my-copilot/pull/42';
  let root: string;
  let checks: string;
  let shipBlock: Record<string, unknown>;
  let trusted: boolean;

  const world: Exec = (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (key === 'git rev-parse --show-toplevel') return ok(`${root}\n`);
    if (key.startsWith('gh pr view 42 --json headRefName')) return ok(JSON.stringify({ headRefName: 'feat/x', baseRefName: 'dev', baseRefOid: BASE, url: PR_URL }));
    if (key.startsWith('gh pr view 42 --json number')) {
      return ok(JSON.stringify({ number: 42, state: 'OPEN', isDraft: false, baseRefName: 'dev', baseRefOid: BASE, headRefName: 'feat/x', headRefOid: SHIP_HEAD, url: PR_URL }));
    }
    if (key === 'gh pr view 42 --json baseRefName,baseRefOid,url') return ok(JSON.stringify({ baseRefName: 'dev', baseRefOid: BASE, url: PR_URL }));
    if (key === 'git remote get-url origin' || key === 'git remote get-url --push --all origin') return ok('https://github.com/RobinNorberg/oh-my-copilot.git\n');
    if (key.startsWith('gh pr view 42 --json headRefOid')) return ok(JSON.stringify({ headRefOid: SHIP_HEAD }));
    if (key.startsWith(`gh run list --commit ${SHIP_HEAD}`)) return ok('[{"databaseId":1,"status":"completed","conclusion":"success","workflowName":"CI"}]');
    if (key.startsWith('git rev-parse --verify refs/remotes/')) return ok(`${BASE}\n`);
    if (key.startsWith('git rev-parse --verify')) return ok(`${SHIP_HEAD}\n`);
    if (key.startsWith('gh pr checks 42')) return ok(checks);
    if (key === 'git rev-parse --abbrev-ref HEAD') return ok('feat/x\n');
    if (key.startsWith('git rev-parse -q --verify')) return { status: 1, stdout: '', stderr: '' };
    if (key.startsWith('git rev-parse --git-path')) return ok(`.git/${args[2]}\n`);
    if (key === 'git rev-parse HEAD') return ok(`${SHIP_HEAD}\n`);
    if (key === `git show ${BASE}:${DEFAULT_SHIP_CONFIG.knownFlakyFile}`) return ok(KNOWN_TEXT);
    if (key.startsWith('git show ')) return { status: 128, stdout: '', stderr: `fatal: path does not exist in '${BASE}'` };
    if (key === `git diff --name-only --no-renames -z ${BASE}...${SHIP_HEAD}`) return ok('src/a.ts\0');
    return ok();
  };

  /** The gh calls of one subcommand; `trusted` runs the real trust-model loader (base-branch config and known-flaky list). */
  async function ship(...argv: string[]): Promise<string[]> {
    const r = recordingExec(world, { '<root>': root }, ['gh']);
    const loader: ShipConfigLoader = trusted ? (ctx) => loadTrustedShipConfig({ ...ctx, user: null, warn: () => {} }) : () => resolveShipConfig(shipBlock);
    process.exitCode = undefined;
    await shipCommand(r.exec, loader).parseAsync(argv, { from: 'user' });
    process.exitCode = undefined;
    return r.calls;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-gh-baseline-ship-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    checks = JSON.stringify(GREEN);
    shipBlock = {};
    trusted = false;
    delete process.env.OMG_SHIP_HUMAN;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const SHIP_CHECKS = `gh ["pr","checks","42","--json","name,state,bucket,link,workflow,event,startedAt,completedAt"] cwd=<root>`;
  const SHIP_VIEW_HEAD = `gh ["pr","view","42","--json","headRefOid"] cwd=<root>`;
  const SHIP_RUN_LIST = `gh ["run","list","--commit","${SHIP_HEAD}","--json","databaseId,status,conclusion,workflowName,headSha","--limit","100"] cwd=<root>`;
  const BASE_INFO = 'gh ["pr","view","42","--json","baseRefName,baseRefOid,url"]';

  it('init -> verdict -> prepare -> gates -> merge: the gh sequence of each subcommand', async () => {
    expect(await ship('init', '42', '--implementer', 'executor-1')).toEqual(['gh ["pr","view","42","--json","headRefName,baseRefName,baseRefOid,url"]']);
    expect(await ship('verdict', '42', '--reviewer', 'verifier-1', '--sha', SHIP_HEAD, '--approve')).toEqual([]);
    expect(await ship('prepare', '42', '--no-checks')).toEqual([BASE_INFO]);
    expect(await ship('gates', '42')).toEqual([BASE_INFO, SHIP_VIEW_HEAD, SHIP_CHECKS, SHIP_RUN_LIST, SHIP_VIEW_HEAD]);
    const MERGE_VIEW = 'gh ["pr","view","42","--json","number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,url"]';
    // Printed only by default; owner config runs it with cwd at the checkout.
    expect(await ship('merge', '42')).toEqual([MERGE_VIEW, SHIP_CHECKS, SHIP_RUN_LIST, SHIP_VIEW_HEAD]);
    shipBlock = { allowAdminMerge: true };
    expect(await ship('merge', '42')).toEqual([
      MERGE_VIEW, SHIP_CHECKS, SHIP_RUN_LIST, SHIP_VIEW_HEAD,
      `gh ["pr","merge","42","--admin","--merge","--match-head-commit","${SHIP_HEAD}"] cwd=<root>`,
    ]);
  });

  it('gates under the trusted loader: a failed Test check gets its job log read (known-flaky list from the base)', async () => {
    trusted = true;
    await ship('init', '42', '--implementer', 'executor-1');
    await ship('verdict', '42', '--reviewer', 'verifier-1', '--sha', SHIP_HEAD, '--approve');
    await ship('prepare', '42', '--no-checks');
    checks = JSON.stringify(FAILED_TEST);
    expect(await ship('gates', '42')).toEqual([
      BASE_INFO, SHIP_VIEW_HEAD, SHIP_CHECKS, SHIP_RUN_LIST, SHIP_VIEW_HEAD,
      `gh ["run","view","--job","${JOB}","--log"] cwd=<root>`,
    ]);
  });
});
