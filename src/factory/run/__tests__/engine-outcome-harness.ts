/**
 * The shared harness of the engine.outcome*.test.ts files: outcome and rollup
 * comments through the real factory guard, with fake gh and real git.
 */
import { readFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach } from 'vitest';

import type { Exec, ExecResult } from '../../../ship/exec.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import type { FactoryEngineOptions } from '../engine.js';
import { commitFile, FakeLanes, FakeProcesses, harness, ISSUE, REPO_URL, review, testGateConfig, type Harness, type LaneScript, withTestSandbox } from './fake-lanes.js';

export const SPEC = 12;

export let h: Harness;
/** Every issue comment the engine posted: target and body. */
export let posted: Array<{ n: number; body: string }>;
/** The parent spec's comments as `gh issue view` reports them. */
export let specComments: Array<{ body: string; authorAssociation?: string; author?: { login: string } }>;
/** Answer for `gh issue comment <n>` (posting still records nothing on failure). */
export let commentResult: (n: number) => ExecResult;
export let warnings: string[];

/** Answer every later `gh issue comment` with `result`. */
export function setCommentResult(result: (n: number) => ExecResult): void {
  commentResult = result;
}

/** A fresh harness per test; call once at the top of each test file that uses it. */
export function useOutcomeHarness(): void {
  beforeEach(() => {
    h = harness('omg-factory-outcome-');
    h.gh.issue.body = `${h.gh.issue.body}\nPart of #${SPEC}\n`;
    posted = [];
    specComments = [];
    commentResult = () => ({ status: 0, stdout: '', stderr: '' });
    warnings = [];
  });

  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true });
  });
}

export const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: '' });

export const exec: Exec = (cmd, args, o) => {
  if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
    const n = Number(args[2]);
    const res = commentResult(n);
    if (res.status !== 0) return res;
    const body = readFileSync(args[4], 'utf8');
    posted.push({ n, body });
    // The comment shows up on the tracker as the engine identity's (a trusted owner).
    const c = { body, authorAssociation: 'OWNER', author: { login: 'o' } };
    if (n === ISSUE) h.gh.issue.comments.push(c);
    if (n === SPEC) specComments.push(c);
  }
  if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view' && args[2] === String(SPEC)) {
    h.calls.push(`gh ${args.join(' ')}`);
    return ok(JSON.stringify({ title: 'Spec', body: `- [ ] #${ISSUE}\n`, state: 'OPEN', url: `${REPO_URL}/issues/${SPEC}`, author: { login: 'o' }, labels: [], comments: specComments }));
  }
  return h.exec(cmd, args, o);
};

export function opts(scripts: LaneScript[], over: Partial<FactoryEngineOptions> = {}): FactoryEngineOptions {
  return withTestSandbox({
    root: h.root,
    issue: ISSUE,
    exec,
    lanes: new FakeLanes(h.root, scripts),
    limits: { ...DEFAULT_FACTORY_RUN_LIMITS },
    base: 'dev',
    pollMs: 5,
    owner: { pid: 4242, hostname: 'test-host', isAlive: () => false },
    ledgerDir: h.ledgerDir,
    processes: new FakeProcesses(),
    gateConfig: testGateConfig,
    warn: (m) => warnings.push(m),
    ...over,
  }, over);
}

export const happy = (): LaneScript[] => [commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')];
export const on = (n: number) => posted.filter((p) => p.n === n);
export const outcomes = () => on(ISSUE).filter((p) => p.body.includes('omg-factory-outcome'));
