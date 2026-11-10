/**
 * The local forge side of the git store hardening (item 3): the mirror's
 * hooks never run on the engine's pushes (H1), the trusted base is the sha
 * the engine synced, not the mirror's ref (H2), and the prepare checkout is
 * read through the git links recorded at its creation (M5). Real git, fake
 * lanes and gate, no gh / az / copilot.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readMirrorRef } from '../../../forge/local/index.js';
import { runFactoryEngine } from '../engine.js';
import { checkoutPath } from '../prepare.js';
import { readFactoryState } from '../state.js';
import { commitFile, gitIn, review } from './fake-lanes.js';
import { BASE, lanesFor, LOCAL_ISSUE, localOpts, localTestGateConfig, localWorld, type LocalWorld } from './engine-local-harness.js';

/** A configured prepare check, so prepare runs the PR's code (a `node` the harness answers) in the checkout. */
const withCheck = {
  gateConfig: (...a: Parameters<typeof localTestGateConfig>) => {
    const g = localTestGateConfig(...a);
    return { ...g, config: { ...g.config, prepareChecks: [['node', 'check.mjs']] } };
  },
};

let w: LocalWorld;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');
const isNode = (cmd: string) => cmd === process.execPath || /(^|[\\/])node(\.exe)?$/i.test(cmd);

describe('factory run on the local forge: git hardening', () => {
  it('H1: hooks planted in the mirror run on none of the engine pushes', async () => {
    w = localWorld();
    const mirror = w.config.repo.url;
    mkdirSync(dirname(mirror), { recursive: true });
    gitIn(w.dir, 'init', '-q', '--bare', mirror);
    const marker = join(w.dir, 'mirror-hook-ran');
    for (const hook of ['pre-receive', 'update', 'post-receive', 'post-update', 'reference-transaction']) {
      writeFileSync(join(mirror, 'hooks', hook), `#!/bin/sh\necho "$0" >> "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    }
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
    expect(out.gate?.name, out.message).toBe('merge');
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(readMirrorRef(mirror, `factory/issue-${LOCAL_ISSUE}`)).toBe(state.head);
    expect(existsSync(marker)).toBe(false);
  }, 300_000);

  it('H2: a mirror base moved after the engine synced it parks at lane-tampered; the PR is not read as merged', async () => {
    w = localWorld();
    const mirror = w.config.repo.url;
    const inner = w.exec;
    let planted = false;
    w.exec = (cmd, args, opts) => {
      const res = inner(cmd, args, opts);
      // Right after a base sync in prepare: something else rewrites the mirror's base.
      if (!planted && cmd === 'git' && args.includes(`+refs/heads/${BASE}:refs/remotes/omg-local/${BASE}`) && readFactoryState(w.root, LOCAL_ISSUE)?.phase === 'prepare') {
        planted = true;
        writeFileSync(join(mirror, 'refs', 'heads', BASE), `${readFactoryState(w.root, LOCAL_ISSUE)!.head}\n`);
      }
      return res;
    };
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
    expect(planted).toBe(true);
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(new RegExp(`mirror's ${BASE} is at [0-9a-f]{12}, but the engine synced it to your ${BASE}`));
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.phase).not.toBe('merged');
    expect(w.gateRuns).toEqual([]);
  }, 300_000);

  it('M5: a prepare check that rewrites the checkout `.git` file parks; no git follows it and the gate never runs', async () => {
    w = localWorld();
    const inner = w.exec;
    const checkout = checkoutPath(w.root, LOCAL_ISSUE);
    w.exec = (cmd, args, opts) => {
      // The PR's own code in prepare: point the checkout at the main repository's git dir.
      if (isNode(cmd) && opts?.cwd === checkout) writeFileSync(join(checkout, '.git'), `gitdir: ${join(w.root, '.git')}\n`);
      return inner(cmd, args, opts);
    };
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), withCheck));
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/git links (recorded at its creation|or config\.worktree)/);
    expect(w.gateRuns).toEqual([]);
  }, 300_000);

  it('M5: an untracked file a prepare check leaves in the checkout parks before the gate runs', async () => {
    w = localWorld();
    const inner = w.exec;
    const checkout = checkoutPath(w.root, LOCAL_ISSUE);
    w.exec = (cmd, args, opts) => {
      if (isNode(cmd) && opts?.cwd === checkout) writeFileSync(join(checkout, 'planted.test.js'), 'process.exit(0)\n');
      return inner(cmd, args, opts);
    };
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), withCheck));
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/working tree differs from it \(planted\.test\.js\)/);
    expect(w.gateRuns).toEqual([]);
  }, 300_000);
});
