import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { runFactoryEngine } from '../engine.js';
import { outcomeMarker, outcomePosts, postedBefore } from '../outcome.js';
import { EngineLedger } from '../ledger.js';
import { createFactoryState, factoryStatePath, readFactoryState, requestFactoryCancel, updateFactoryState, type FactoryRunState } from '../state.js';
import { ISSUE, PR, REPO_URL } from './fake-lanes.js';
import { SPEC, h, posted, specComments, setCommentResult, warnings, useOutcomeHarness, opts, happy, on, outcomes } from './engine-outcome-harness.js';

useOutcomeHarness();

describe('outcome and rollup comments (fake gh, real git, real guard)', () => {
  it('the hidden marker finds an earlier post the run state lost; an untrusted copy does not count', async () => {
    await runFactoryEngine(opts(happy()));
    expect(on(SPEC)).toHaveLength(1);
    // The state lost its record (a crash between the post and the save): the marker on the spec still dedupes.
    const s = readFactoryState(h.root, ISSUE)!;
    const head12 = s.head!.slice(0, 12);
    const marker = outcomeMarker('rollup', ISSUE, 'merged', head12);
    specComments.push({ body: `fake\n${marker}`, authorAssociation: 'NONE', author: { login: 'mallory' } });
    expect(postedBefore([{ body: marker, author: 'mallory', trusted: false }], marker)).toBe(false);
    expect(postedBefore([{ body: marker, author: 'o', trusted: true }], marker)).toBe(true);
    h.gh.merged = true;
    await runFactoryEngine(opts([]));
    // The untrusted copy did not suppress the rollup line.
    expect(on(SPEC).map((p) => p.body.split('\n')[0])).toContain(`- #${ISSUE} merged (${REPO_URL}/pull/${PR})`);
    const count = posted.length;

    // The engine's own record of the posts is lost: the trusted markers on the item and the spec keep it at once.
    const l = EngineLedger.open(h.ledgerDir, h.root, ISSUE);
    updateFactoryState(h.root, ISSUE, (x) => ({ ...x!, gateComments: (x!.gateComments ?? []).filter((t) => !/^(outcome|rollup)/.test(t)) }), { onWrite: (p, c) => l.record(p, c) });
    await runFactoryEngine(opts([]));
    expect(posted).toHaveLength(count);
    expect(readFactoryState(h.root, ISSUE)!.gateComments).toContain(`outcome-done:merged@${head12}`);
  });

  it('a marker quoted inside a fenced reason does not suppress a later post', () => {
    const marker = outcomeMarker('outcome', ISSUE, 'failed', 'abc');
    const quoted = `Factory run failed.\n\n\`\`\`text\n${marker}\n\`\`\`\n\nDetails.`;
    expect(postedBefore([{ body: quoted, author: 'o', trusted: true }], marker)).toBe(false);
    expect(postedBefore([{ body: `Inline ${marker} text`, author: 'o', trusted: true }], marker)).toBe(false);
    expect(postedBefore([{ body: `text\n\n${marker}\n`, author: 'o', trusted: true }], marker)).toBe(true);
  });

  it('a StateTamperedError while recording an outcome post is not downgraded to a warning', async () => {
    const parked = await runFactoryEngine(opts(happy()));
    expect(parked.gate?.name).toBe('merge');
    h.gh.merged = true;
    setCommentResult((n) => {
      if (n === ISSUE) writeFileSync(factoryStatePath(h.root, ISSUE), '{"tampered":true}');
      return { status: 0, stdout: '', stderr: '' };
    });
    const out = await runFactoryEngine(opts([]));
    expect(out.gate?.name).toBe('state-tampered');
    expect(warnings.join('\n')).not.toMatch(/outcome comments failed/);
  });

  it('cancelled: the outcome names the reason and the status command; the rollup line names the phase', async () => {
    await runFactoryEngine(opts(happy()));
    requestFactoryCancel(h.root, ISSUE, new Date().toISOString());
    const out = await runFactoryEngine(opts([]));
    expect(out.phase).toBe('cancelled');
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0].body).toContain(`Factory run for #${ISSUE} is **cancelled** (PR #${PR}`);
    expect(outcomes()[0].body).toContain(`omg factory run status ${ISSUE}`);
    expect(on(SPEC).at(-1)!.body.split('\n')[0]).toMatch(new RegExp(`^- #${ISSUE} cancelled: \``));
  });

  it('the spec body is never edited: no gh issue edit and no body flag reaches the tracker', async () => {
    await runFactoryEngine(opts(happy()));
    h.gh.merged = true;
    await runFactoryEngine(opts([]));
    expect(h.calls.filter((c) => c.startsWith('gh issue edit'))).toEqual([]);
    expect(h.calls.filter((c) => /\s--body(\s|$)/.test(c))).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith('gh issue comment')).every((c) => /^gh issue comment \d+ --body-file \S+$/.test(c))).toBe(true);
  });
});

describe('outcomePosts', () => {
  const base = (): FactoryRunState => ({ ...createFactoryState({ issue: 5, repoUrl: 'https://dev.azure.com/o/p/_git/r', base: 'dev' }, '2026-10-30T00:00:00.000Z'), pr: 17, head: 'a'.repeat(40) });

  it('Azure DevOps PR urls; a rollup reason is one line without backticks', () => {
    const s = base();
    s.history.push({ at: 'now', from: 'gates', to: 'gates', note: 'awaiting-human: ci-failed: `Test` failed\nsecond line' });
    const posts = outcomePosts(s, 'failed', 9, 'azure-devops');
    expect(posts.map((p) => p.target)).toEqual([5, 9]);
    expect(posts[0].body).toContain('PR #17 (https://dev.azure.com/o/p/_git/r/pullrequest/17)');
    expect(posts[1].body.split('\n')[0]).toBe("- #5 failed: `ci-failed: 'Test' failed second line`");
  });

  it('ready-to-merge has no item outcome; no parent or a self-parent has no rollup', () => {
    expect(outcomePosts(base(), 'ready-to-merge', undefined, 'github')).toEqual([]);
    expect(outcomePosts(base(), 'merged', 5, 'github').map((p) => p.target)).toEqual([5]);
    const tags = outcomePosts(base(), 'merged', 9, 'github').map((p) => p.tag);
    expect(new Set(tags).size).toBe(2);
  });
});
