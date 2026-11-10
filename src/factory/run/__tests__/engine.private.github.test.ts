/**
 * The private layout on the GitHub forge path (item 2 B1b): the engine
 * imports the lane's commit and pushes it to origin from the user's
 * repository; the coding agent implementer is refused up front. Fake lanes,
 * a scripted gh, a local bare origin; no network, no credits.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LAYOUT_UNSUPPORTED_GATE, GATE_INSTALL_GATE } from '../private-run.js';
import { readFactoryState } from '../state.js';
import { commitFile, gitIn, ISSUE, remoteHead, review } from './fake-lanes.js';
import { h, run, useEngineHarness } from './engine-harness.js';

const T = 600_000;
useEngineHarness();

const privateUser = () => ({ factory: { run: { layout: 'private', workDir: join(h.dir, 'fw') } } });

describe('factory run with factory.run.layout "private" on GitHub', () => {
  it('imports the lane commit and pushes it to origin from your repository; with no lockfile on the base, prepare parks at gate-install-needed', async () => {
    const { lanes, done } = run([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')], { runUserConfig: privateUser() });
    const out = await done;
    expect(out.gate?.name, out.message).toBe(GATE_INSTALL_GATE);
    expect(out.gate?.reason).toMatch(/the base has no lockfile, so the prepare checkout .* cannot use your node_modules/);
    const s = readFactoryState(h.root, ISSUE)!;
    expect(s.layout).toBe(2);
    expect(remoteHead(h)).toBe(s.head);
    expect(lanes.started.every((l) => l.worktree?.path.startsWith(join(h.dir, 'fw')))).toBe(true);
    // The user's repository: no lane worktree or branch of the run, no import ref left.
    expect(gitIn(h.root, 'for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/omg-import/')).toBe('refs/heads/dev');
    expect(gitIn(h.root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  }, T);

  it('the coding agent implementer is not supported in the private layout yet: the run parks before anything is assigned', async () => {
    const agent = { factory: { run: { implementer: 'coding-agent' }, codingAgent: { repos: ['o/r'] } } };
    const { lanes, done } = run([], { runUserConfig: privateUser(), codingAgentUserConfig: agent });
    const out = await done;
    expect(out.gate?.name, out.message).toBe(LAYOUT_UNSUPPORTED_GATE);
    expect(out.gate?.reason).toMatch(/does not support factory\.run\.implementer "coding-agent" yet.*set factory\.run\.layout "shared" or the implementer back to the default, then rerun omg factory run 7/);
    expect(lanes.started).toEqual([]);
    expect(readFactoryState(h.root, ISSUE)!.layout).toBeUndefined();
    expect(h.calls.some((c) => c.startsWith('gh api') && c.includes('assignees'))).toBe(false);
  }, T);
});
