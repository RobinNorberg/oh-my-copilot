/**
 * F59 (dogfood round 3): a cancel mid-lane leaves the lane's partial edits in
 * its worktree. `run clean` keeps that dirty tree (and names --discard);
 * `run reset` gives the uncommitted changes up itself and starts the item
 * over. Junction targets and the main checkout are never touched.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { createForge } from '../../../forge/index.js';
import { getOmcRoot } from '../../../lib/worktree-paths.js';
import { cleanFactoryRun } from '../clean.js';
import { runFactoryEngine } from '../engine.js';
import { factoryForgeOptions } from '../forge-roots.js';
import { resetFactoryRun } from '../reset.js';
import { readFactoryState, requestFactoryCancel } from '../state.js';
import { FakeLanes, gitIn } from './fake-lanes.js';
import { LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';

vi.setConfig({ testTimeout: scaleTiming(300_000) });

let w: LocalWorld;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

const OWNER = { pid: 4242, hostname: 'test-host', isAlive: () => false };

describe('F59: reset after a cancel mid-lane', () => {
  it('clean keeps the dirty lane worktree; reset removes it (uncommitted changes given up) and starts the item over', async () => {
    w = localWorld();
    const outside = join(w.dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep\n');
    // The implement lane is still running when the human cancels; it has edited a tracked file and added one.
    const lanes = new FakeLanes(w.root, [() => ({ finalText: 'never read' })], [2]);
    let worktree = '';
    lanes.onRunningPoll = () => {
      worktree = join(w.root, '.omg', 'team', 'copilot-run', 'worktrees', 'cr-fake1');
      writeFileSync(join(worktree, 'README.md'), 'partial edit\n');
      writeFileSync(join(worktree, 'new.js'), 'export {};\n');
      if (!existsSync(join(worktree, 'linked'))) symlinkSync(outside, join(worktree, 'linked'), 'junction');
      requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
    };
    const out = await runFactoryEngine(localOpts(w, lanes));
    expect(out.phase, out.message).toBe('cancelled');
    expect(existsSync(join(worktree, 'new.js'))).toBe(true);

    const cleaned = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner: OWNER });
    expect(cleaned.kept.map((k) => k.reason).join('\n')).toMatch(/worktree_dirty/);
    expect(existsSync(worktree)).toBe(true);

    const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
    const reset = resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER });
    expect(reset.removedWorktrees).toContain(worktree);
    expect(existsSync(worktree)).toBe(false);
    expect(readFactoryState(w.root, LOCAL_ISSUE)).toBeNull();
    // The junction went as a link: its target is untouched. The main checkout is untouched too.
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(gitIn(w.root, 'status', '--porcelain')).toBe('');
  });
});
