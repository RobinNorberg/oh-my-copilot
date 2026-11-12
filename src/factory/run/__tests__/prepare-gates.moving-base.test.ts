/**
 * A base that moved after the PR was opened (factory run 508): GitHub's PR
 * baseRefOid stays at the base of the PR's last update, so the engine takes
 * the base branch's live tip (GET branches/<base>) and the trusted config
 * load still checks the fetched ref against it, fail closed.
 */
import { describe, expect, it, vi } from 'vitest';

import { loadTrustedShipConfig } from '../../../ship/config.js';
import type { ExecResult } from '../../../ship/exec.js';
import { readFactoryState } from '../state.js';
import type { GateConfigLoader } from '../prepare.js';
import { commitFile, gitIn, ISSUE, review } from './fake-lanes.js';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { h, usePrepareGatesHarness, run, moveBase, PREPARE_VIEW, before } from './prepare-gates-harness.js';

vi.setConfig({ testTimeout: scaleTiming(90_000) });

usePrepareGatesHarness();

/** The real trusted load (strict: the fetched ref must equal the base sha), with empty user and project layers. */
const trustedLoad: GateConfigLoader = (i) => {
  const config = loadTrustedShipConfig({ exec: i.exec, root: i.root, base: i.base, baseSha: i.baseSha, repoUrl: i.repoUrl, strict: true, user: {}, trustedUser: {}, project: {}, warn: () => {} });
  return { config: { ...config, requiredChecks: ['Test'], advisoryChecks: [] }, known: [] };
};

const BRANCH_READ = 'gh api --hostname github.com --method GET repos/o/r/branches/dev';
const branch = (sha: string): ExecResult => ({ status: 0, stdout: JSON.stringify({ name: 'dev', commit: { sha } }), stderr: '' });

describe('a base that moved after the PR was opened', () => {
  it('the PR\'s recorded baseRefOid is older than dev: prepare loads the config at the live tip, merges it, and reaches the merge park', async () => {
    let stale = '';
    let live = '';
    before(PREPARE_VIEW, () => {
      stale = gitIn(h.root, 'rev-parse', 'refs/remotes/origin/dev');
      h.gh.baseRefOid = stale;
      live = moveBase('docs/other.md', 'another PR merged\n');
    });
    const out = await run([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')], { gateConfig: trustedLoad }).done;
    expect(out.gate?.name, out.message).toBe('merge');
    expect(stale).not.toBe(live);
    expect(h.calls).toContain(BRANCH_READ);
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.baseSha).toBe(live);
    // Prepare merged the live tip into the PR branch (git merge-base --is-ancestor exits 0).
    expect(gitIn(h.root, 'merge-base', '--is-ancestor', live, state.head!)).toBe('');
    expect(gitIn(h.root, 'show', `${state.head}:docs/other.md`)).toBe('another PR merged');
  });

  it('review-518 L1: the gates read base suites at the recorded base: an app queued with 0 runs on the head and the fresh tip, but run on the recorded base, is not exempted', async () => {
    let stale = '';
    let live = '';
    before(PREPARE_VIEW, () => {
      stale = gitIn(h.root, 'rev-parse', 'refs/remotes/origin/dev');
      h.gh.baseRefOid = stale;
      live = moveBase('docs/other.md', 'another PR merged\n');
    });
    const suiteReads: string[] = [];
    h.gh.api = (path) => {
      const m = /^repos\/o\/r\/commits\/([0-9a-f]{40})\/check-suites\?per_page=100&page=1$/.exec(path);
      if (!m) return undefined;
      suiteReads.push(m[1]);
      // A third-party app: settled on the recorded base, queued with no run on the head and on the tip that just landed.
      const suite = m[1] === stale ? { status: 'completed', app: { slug: 'ext-ci' }, latest_check_runs_count: 2 } : { status: 'queued', app: { slug: 'ext-ci' }, latest_check_runs_count: 0 };
      return { status: 0, stdout: JSON.stringify({ total_count: 1, check_suites: [suite] }), stderr: '' };
    };
    const out = await run([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')], { gateConfig: trustedLoad }).done;
    expect(stale).not.toBe(live);
    expect(out.gate?.name, out.message).not.toBe('merge');
    expect(out.message).toContain('check suite ext-ci (queued)');
    expect(suiteReads).toContain(stale);
    expect(suiteReads).not.toContain(live);
  });

  it('a live tip that is not the fetched ref refuses (fail closed): nothing is merged or pushed', async () => {
    let stale = '';
    let moved = '';
    before(PREPARE_VIEW, () => {
      stale = gitIn(h.root, 'rev-parse', 'refs/remotes/origin/dev');
      moved = moveBase('docs/other.md', 'another PR merged\n');
      // GitHub's branch read answers an old tip while the fetch sees the new one.
      h.gh.api = (path) => (path === 'repos/o/r/branches/dev' ? branch(stale) : undefined);
    });
    const out = await run([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')], { gateConfig: trustedLoad }).done;
    expect(out.gate?.name).not.toBe('merge');
    expect(out.message).toContain(`refs/remotes/origin/dev is ${moved}, but GitHub reports dev at ${stale}; refusing (fail closed)`);
    // Nothing was merged into the PR: its head is still the implement lane's commit, and the moved base is not recorded.
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.head).toBe(state.lanes[0].endSha);
    expect(state.baseSha).not.toBe(moved);
  });

  it('a failed branch read refuses (fail closed) before any base is used', async () => {
    before(PREPARE_VIEW, () => {
      h.gh.api = (path) => (path === 'repos/o/r/branches/dev' ? { status: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' } : undefined);
    });
    const out = await run([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')], { gateConfig: trustedLoad }).done;
    expect(out.gate?.name).not.toBe('merge');
    expect(out.message).toContain('gh api repos/o/r/branches/dev did not return dev\'s tip (exit 1: HTTP 502: Bad Gateway); refusing (fail closed)');
    expect(h.calls.some((c) => c.startsWith('git worktree add -B '))).toBe(false);
  });

  it('a branch read naming another branch (a renamed base redirects) refuses', async () => {
    before(PREPARE_VIEW, () => {
      h.gh.api = (path) => (path === 'repos/o/r/branches/dev'
        ? { status: 0, stdout: JSON.stringify({ name: 'main', commit: { sha: gitIn(h.root, 'rev-parse', 'refs/remotes/origin/dev') } }), stderr: '' }
        : undefined);
    });
    const out = await run([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')], { gateConfig: trustedLoad }).done;
    expect(out.gate?.name).not.toBe('merge');
    expect(out.message).toContain('did not return dev\'s tip (no branch of that name with a commit sha)');
  });
});
