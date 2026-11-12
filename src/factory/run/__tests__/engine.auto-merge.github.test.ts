/**
 * Opt-in auto-merge on GitHub (auto-merge.ts): fake lanes, real git, scripted
 * gh. The engine's one merge is the head-pinned REST PUT, admitted by the
 * factory guard only inside its auto-merge step; `gh pr merge` never runs. A
 * refused merge (GitHub's 409 for a moved head) or a manual-merge label keeps
 * the human park.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTrustedShipConfig } from '../../../ship/config.js';
import type { Exec } from '../../../ship/exec.js';
import type { GateConfigLoader } from '../prepare.js';
import { readShipState } from '../../../ship/state.js';
import { readFactoryState } from '../state.js';
import { commitFile, gitIn, ISSUE, PR, REPO_URL, review } from './fake-lanes.js';
import { h, run, useEngineHarness } from './engine-harness.js';

useEngineHarness();

const docs = () => commitFile('docs/guide.md', '# Guide\n\nHow to greet.\n');
const user = { factory: { merge: { auto: { [REPO_URL]: { enabled: true, tiers: ['docs'] } } } } };
const PUT = `gh api --hostname github.com --method PUT repos/o/r/pulls/${PR}/merge -f sha=`;

const MERGE_SHA = 'c'.repeat(40);

/**
 * Answers the REST merge, the merge commit read (its first parent: the base
 * the PR view reported, or `firstParent`), and optionally the PR's labels;
 * everything else goes to the harness.
 */
function scriptMerge(answer: (sha: string) => { status: number; stdout: string; stderr: string }, prLabels: string[] = [], firstParent?: string): void {
  const inner: Exec = h.exec;
  let base = '';
  h.exec = (cmd, args, opts) => {
    if (cmd === 'gh' && args[0] === 'api' && args[4] === 'PUT') {
      h.calls.push(`gh ${args.join(' ')}`);
      const res = answer(args[7].slice('sha='.length));
      if (res.status === 0) h.gh.merged = true;
      return res;
    }
    if (cmd === 'gh' && args.join(' ') === `api --hostname github.com repos/o/r/commits/${MERGE_SHA}`) {
      h.calls.push(`gh ${args.join(' ')}`);
      return { status: 0, stdout: JSON.stringify({ sha: MERGE_SHA, parents: [{ sha: firstParent ?? base }, { sha: 'd'.repeat(40) }] }), stderr: '' };
    }
    if (cmd === 'gh' && args.join(' ') === `pr view ${PR} --json labels`) return { status: 0, stdout: JSON.stringify({ labels: prLabels.map((name) => ({ name })) }), stderr: '' };
    const res = inner(cmd, args, opts);
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && res.status === 0) {
      try { base = (JSON.parse(res.stdout) as { baseRefOid?: string }).baseRefOid ?? base; } catch { /* not a view */ }
    }
    return res;
  };
}
const merged = () => ({ status: 0, stdout: JSON.stringify({ sha: MERGE_SHA, merged: true, message: 'Pull Request successfully merged' }), stderr: '' });

describe('factory run on GitHub: opt-in auto-merge', () => {
  it('a docs-only PR with every condition met merges through the head-pinned REST merge and the run finishes merged', async () => {
    scriptMerge(merged);
    const warnings: string[] = [];
    const { done } = run([docs(), review('approve')], { autoMergeUserConfig: user, warn: (m: string) => warnings.push(m) });
    const out = await done;

    expect(out.exitCode, out.message).toBe(0);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.phase).toBe('merged');
    expect(h.calls.filter((c) => c.startsWith('gh api') && c.includes('PUT'))).toEqual([`${PUT}${state.head} -f merge_method=merge`]);
    expect(h.calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
    expect(readShipState(h.root, PR)!.phase).toBe('merged');
    expect(state.history.some((x) => /^auto-merged by tier docs at [0-9a-f]{12}: .*CI green/.test(x.note))).toBe(true);
    expect(h.calls.filter((c) => c.startsWith(`gh pr comment ${PR}`)).length).toBeGreaterThan(0);
    // The merge commit's first parent is the base the gates checked: no warning.
    expect(h.calls).toContain(`gh api --hostname github.com repos/o/r/commits/${MERGE_SHA}`);
    expect(state.history.some((x) => x.note.startsWith('WARNING: auto-merge'))).toBe(false);
    expect(warnings.join('\n')).not.toMatch(/WARNING: auto-merge/);
  });

  it('review-498 L2: the base moved before the PUT: the run still finishes merged, with a loud history note, a PR comment and a warning', async () => {
    scriptMerge(merged, [], 'e'.repeat(40));
    const warnings: string[] = [];
    const { done } = run([docs(), review('approve')], { autoMergeUserConfig: user, warn: (m: string) => warnings.push(m) });
    const out = await done;
    expect(out.exitCode, out.message).toBe(0);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.phase).toBe('merged');
    const note = state.history.find((x) => x.note.startsWith('WARNING: auto-merge'))?.note ?? '';
    expect(note).toMatch(/GitHub merged into dev eeeeeeeeeeee, not [0-9a-f]{12} the gates checked/);
    expect(note).toMatch(/Require branches to be up to date before merging/);
    expect(warnings.join('\n')).toMatch(/WARNING: auto-merge/);
    // The warning comment is posted after the merge commit was read.
    const read = h.calls.indexOf(`gh api --hostname github.com repos/o/r/commits/${MERGE_SHA}`);
    expect(read).toBeGreaterThan(-1);
    expect(h.calls.slice(read).some((c) => c.startsWith(`gh pr comment ${PR}`))).toBe(true);
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

  it('review-518 L2: dev moved after prepare (the head does not contain the live tip): the merge stays human, no merge call', async () => {
    scriptMerge(() => { throw new Error('must not merge'); });
    let moved = '';
    h.onCall = (call) => {
      // The gates' first checks read: prepare is done, the merge phase's view will read the moved tip.
      if (moved || !call.startsWith(`gh pr checks ${PR} --json`)) return;
      const other = join(h.dir, 'other-l2');
      gitIn(h.dir, 'clone', '-q', '-b', 'dev', h.bare, other);
      writeFileSync(join(other, 'later.md'), 'another PR merged\n');
      gitIn(other, 'add', '--', 'later.md');
      gitIn(other, 'commit', '-q', '-m', 'base: later');
      gitIn(other, 'push', '-q', 'origin', 'dev');
      moved = gitIn(other, 'rev-parse', 'HEAD');
    };
    // The real strict trusted load: in the merge phase it fetches dev and checks it against the live tip (as a real run does).
    const trustedLoad: GateConfigLoader = (i) => {
      const config = loadTrustedShipConfig({ exec: i.exec, root: i.root, base: i.base, baseSha: i.baseSha, repoUrl: i.repoUrl, strict: true, user: {}, trustedUser: {}, project: {}, warn: () => {} });
      return { config: { ...config, requiredChecks: ['Test'], advisoryChecks: [] }, known: [] };
    };
    const { done } = run([docs(), review('approve')], { autoMergeUserConfig: user, gateConfig: trustedLoad });
    const out = await done;
    expect(moved).toMatch(/^[0-9a-f]{40}$/);
    expect(out.gate?.name, out.message).toBe('merge');
    const head = readFactoryState(h.root, ISSUE)!.head!;
    expect(out.gate?.reason).toContain(`not taken: dev moved after prepare (head ${head.slice(0, 12)} does not contain dev ${moved.slice(0, 12)}); rerun omg factory run`);
    expect(out.gate?.reason).toContain('to merge the new base');
    expect(h.calls.some((c) => c.includes('PUT'))).toBe(false);
  });

  it('off by default (no user config): the same PR parks at the human merge with no merge call', async () => {
    const { done } = run([docs(), review('approve')]);
    const out = await done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(h.calls.some((c) => c.includes('PUT'))).toBe(false);
  });
});
