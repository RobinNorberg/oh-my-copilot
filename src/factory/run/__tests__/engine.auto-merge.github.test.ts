/**
 * Opt-in auto-merge on GitHub (auto-merge.ts): fake lanes, real git, scripted
 * gh. The engine's one merge is the head-pinned REST PUT, admitted by the
 * factory guard only inside its auto-merge step; `gh pr merge` never runs. A
 * refused merge (GitHub's 409 for a moved head) or a manual-merge label keeps
 * the human park.
 */
import { describe, expect, it } from 'vitest';
import type { Exec } from '../../../ship/exec.js';
import { readShipState } from '../../../ship/state.js';
import { readFactoryState } from '../state.js';
import { commitFile, ISSUE, PR, REPO_URL, review } from './fake-lanes.js';
import { h, run, useEngineHarness } from './engine-harness.js';

useEngineHarness();

const docs = () => commitFile('docs/guide.md', '# Guide\n\nHow to greet.\n');
const user = { factory: { merge: { auto: { [REPO_URL]: { enabled: true, tiers: ['docs'] } } } } };
const PUT = `gh api --hostname github.com --method PUT repos/o/r/pulls/${PR}/merge -f sha=`;

/** Answers the REST merge (and optionally the PR's labels); everything else goes to the harness. */
function scriptMerge(answer: (sha: string) => { status: number; stdout: string; stderr: string }, prLabels: string[] = []): void {
  const inner: Exec = h.exec;
  h.exec = (cmd, args, opts) => {
    if (cmd === 'gh' && args[0] === 'api' && args[4] === 'PUT') {
      h.calls.push(`gh ${args.join(' ')}`);
      const res = answer(args[7].slice('sha='.length));
      if (res.status === 0) h.gh.merged = true;
      return res;
    }
    if (cmd === 'gh' && args.join(' ') === `pr view ${PR} --json labels`) return { status: 0, stdout: JSON.stringify({ labels: prLabels.map((name) => ({ name })) }), stderr: '' };
    return inner(cmd, args, opts);
  };
}

describe('factory run on GitHub: opt-in auto-merge', () => {
  it('a docs-only PR with every condition met merges through the head-pinned REST merge and the run finishes merged', async () => {
    scriptMerge(() => ({ status: 0, stdout: JSON.stringify({ sha: 'c'.repeat(40), merged: true, message: 'Pull Request successfully merged' }), stderr: '' }));
    const { done } = run([docs(), review('approve')], { autoMergeUserConfig: user });
    const out = await done;

    expect(out.exitCode, out.message).toBe(0);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.phase).toBe('merged');
    expect(h.calls.filter((c) => c.startsWith('gh api') && c.includes('PUT'))).toEqual([`${PUT}${state.head} -f merge_method=merge`]);
    expect(h.calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
    expect(readShipState(h.root, PR)!.phase).toBe('merged');
    expect(state.history.some((x) => /^auto-merged by tier docs at [0-9a-f]{12}: .*CI green/.test(x.note))).toBe(true);
    expect(h.calls.filter((c) => c.startsWith(`gh pr comment ${PR}`)).length).toBeGreaterThan(0);
  });

  it('GitHub refuses the merge (the head moved: 409): the run parks at the human merge and says why', async () => {
    scriptMerge(() => ({ status: 1, stdout: '', stderr: 'gh: Head branch was modified. Review and try the merge again. (HTTP 409)' }));
    const { done } = run([docs(), review('approve')], { autoMergeUserConfig: user });
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(out.gate?.reason).toMatch(/auto-merge \(factory\.merge\.auto\) not taken: GitHub refused the head-pinned merge: .*409/);
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('merge');
  });

  it('a factory:manual-merge label on the PR keeps the merge human; no merge call is made', async () => {
    scriptMerge(() => { throw new Error('must not merge'); }, ['factory:manual-merge']);
    const { done } = run([docs(), review('approve')], { autoMergeUserConfig: user });
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(out.gate?.reason).toMatch(/not taken: the issue or PR carries factory:manual-merge/);
    expect(h.calls.some((c) => c.includes('PUT'))).toBe(false);
  });

  it('off by default (no user config): the same PR parks at the human merge with no merge call', async () => {
    const { done } = run([docs(), review('approve')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(h.calls.some((c) => c.includes('PUT'))).toBe(false);
  });
});
