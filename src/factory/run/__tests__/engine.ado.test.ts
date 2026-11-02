/**
 * `omg factory run` on Azure DevOps (factory forges design §9 PR 6): the
 * engine with real git and fake lanes, every forge call an `az devops
 * invoke` through the real factory guard and the ADO adapter, answered by a
 * small Azure DevOps model whose bodies are the PR 5 fixtures (heads and
 * ids joined to the run's real commits).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readShipState } from '../../../ship/state.js';
import { defaultExec } from '../../../ship/exec.js';
import { readFactoryState } from '../state.js';
import { ISSUE, remoteHead } from './fake-lanes.js';
import { ADO_URL, PR_ID, h, ado, sleeps, useAdoHarness, happy, run, expectNoMerge } from './engine-ado-harness.js';

useAdoHarness();

describe('omg factory run on Azure DevOps (fake ADO, real git)', () => {
  it('intake -> plan -> implement -> draft PR -> review -> prepare -> gates -> awaiting-human: merge with the head-pinned body path and SHA', async () => {
    const out = await run(happy());

    expect(out.exitCode, out.message).toBe(0);
    expect(out.gate?.name).toBe('merge');
    const state = readFactoryState(h.root, ISSUE)!;
    expect(state.forgeKind).toBe('azure-devops');
    expect(state.repoUrl).toBe(ADO_URL);
    expect(state.pr).toBe(PR_ID);
    expect(state.head).toBe(remoteHead(h));
    // The trusted owner's omg-plan line wins over the newer lookalike's (uniqueName, not display name).
    expect(state.plan).toMatchObject({ source: 'link', path: 'docs/plan.md' });
    expect(state.issueBody).toContain('## Acceptance criteria');
    expect(state.issueBody).toContain('greet() returns hi');

    // The draft PR: the run's branch onto the base, linked to the work item.
    const created = ado.calls.find((c) => c.route === 'git.pullRequests.POST')!;
    expect(created.body).toMatchObject({ sourceRefName: `refs/heads/factory/issue-${ISSUE}`, targetRefName: 'refs/heads/dev', isDraft: true, workItemRefs: [{ id: String(ISSUE) }] });
    expect(created.body.description).toContain(`Work item #${ISSUE}`);
    expect(ado.calls.some((c) => c.route === 'git.pullRequests.PATCH')).toBe(true);
    expect(readShipState(h.root, PR_ID)!.phase).toBe('ready');
    // The gates read the branch policies and the exact-head builds of refs/pull/17/merge.
    const routes = new Set(ado.calls.map((c) => c.route));
    for (const r of ['policy.evaluations.GET', 'build.builds.GET', 'git.pullRequestThreads.POST', 'wit.comments.POST']) expect(routes.has(r), r).toBe(true);
    expect(readShipState(h.root, PR_ID)!.lastGates).toMatchObject({ verdict: 'green', failed: [], pending: [] });

    // The merge comment: the command a human runs, the body file it reads and that file's SHA-256.
    const merge = ado.threads().find((t) => t.includes('Merge is a human step'))!;
    expect(merge).toBeDefined();
    const bodyFile = /reads its body from `([^`]+)`/.exec(merge)![1];
    const sha = /SHA-256 `([0-9a-f]{64})`/.exec(merge)![1];
    expect(bodyFile.startsWith(join(h.dir, 'forge-state'))).toBe(true);
    expect(merge).toContain(`--in-file ${bodyFile}`);
    const content = readFileSync(bodyFile, 'utf8');
    expect(createHash('sha256').update(content, 'utf8').digest('hex')).toBe(sha);
    expect(JSON.parse(content)).toEqual({ status: 'completed', lastMergeSourceCommit: { commitId: state.head }, completionOptions: { mergeStrategy: 'noFastForward' } });
    expect(out.mergeCommand).toBe(`az devops invoke --area git --resource pullRequests --route-parameters project=Web repositoryId=web-app pullRequestId=${PR_ID} --http-method PATCH --api-version 7.1 --in-file ${bodyFile} --org https://dev.azure.com/contoso --detect false --output json`);
    // The gate comment went to the work item.
    expect(ado.calls.some((c) => c.route === 'wit.comments.POST' && /awaiting a human: \*\*merge\*\*/.test(c.body.text))).toBe(true);
    expectNoMerge();
  });

  it('a PR head the engine did not push stops the run at head-moved-externally', async () => {
    ado.headOverride = 'e'.repeat(40);
    const out = await run(happy());

    expect(out.gate?.name, out.message).toBe('head-moved-externally');
    expect(out.gate?.reason).toMatch(/PR #17 head is eeeeeeeeeeee/);
    expect(readFactoryState(h.root, ISSUE)!.phase).toBe('review');
    expectNoMerge();
  });

  it('a lagging lastMergeSourceCommit that is an ancestor of the engine push is pending: re-read, then the run goes on', async () => {
    ado.lag = { sha: defaultExec('git', ['ls-remote', h.bare, 'refs/heads/dev']).stdout.split(/\s+/)[0], reads: 3 };
    const out = await run(happy());

    expect(out.exitCode, out.message).toBe(0);
    expect(out.gate?.name).toBe('merge');
    expect(sleeps.filter((ms) => ms === 5).length).toBeGreaterThanOrEqual(3);
    expect(readFactoryState(h.root, ISSUE)!.history.some((e) => /head-moved/.test(e.note))).toBe(false);
  });
});
