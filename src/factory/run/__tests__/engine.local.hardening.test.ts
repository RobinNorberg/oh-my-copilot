/**
 * The local forge side of the git store hardening (item 3): the mirror's
 * hooks never run on the engine's pushes (H1), the trusted base is the sha
 * the engine synced, not the mirror's ref (H2), and the prepare checkout is
 * read through the git links recorded at its creation (M5). Real git, fake
 * lanes and gate, no gh / az / copilot.
 */
import { closeSync, cpSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveForgeConfig } from '../../../forge/config.js';
import { readMirrorRef } from '../../../forge/local/index.js';
import { forgetWorktreeGitLinks } from '../../../team/git-worktree.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
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
    // Parks at the budget right after the publish: the base sync push and the branch push both went to the mirror.
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet()]), { limits: { ...DEFAULT_FACTORY_RUN_LIMITS, maxRunCredits: 34 } }));
    expect(out.gate?.name, out.message).toBe('budget');
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(readMirrorRef(mirror, `factory/issue-${LOCAL_ISSUE}`)).toBe(state.head);
    expect(readMirrorRef(mirror, BASE)).toBe(gitIn(w.root, 'rev-parse', BASE));
    expect(existsSync(marker)).toBe(false);
  }, 300_000);

  it('H2: a mirror base moved after the engine synced it parks at lane-tampered; the PR is not read as merged', async () => {
    w = localWorld();
    const mirror = w.config.repo.url;
    const inner = w.exec;
    let planted = false;
    w.exec = (cmd, args, opts) => {
      const res = inner(cmd, args, opts);
      // Right after the base sync of prepare's PR read (its last git call reads the tracking ref): something else rewrites the mirror's base.
      if (!planted && cmd === 'git' && args.includes('rev-parse') && args.includes(`refs/remotes/omg-local/${BASE}`) && readFactoryState(w.root, LOCAL_ISSUE)?.phase === 'prepare') {
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
      // Git for Windows hides the `.git` file, and a hidden file cannot be opened with `w`: rewrite it in place.
      if (isNode(cmd) && opts?.cwd === checkout) {
        const fd = openSync(join(checkout, '.git'), 'r+');
        try { ftruncateSync(fd); writeSync(fd, `gitdir: ${join(w.root, '.git')}\n`); } finally { closeSync(fd); }
      }
      return inner(cmd, args, opts);
    };
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), withCheck));
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    // Either the shared-state compare or the read through the recorded links stops it; never the checkout's `.git`.
    expect(out.gate?.reason).toMatch(/^prepare's checks \(the PR's own code\)/);
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
    expect(out.gate?.reason).toMatch(/working tree differs from it, ignored files included \(planted\.test\.js\)/);
    expect(w.gateRuns).toEqual([]);
  }, 300_000);

  it.each([
    ['a skip-worktree edit', (checkout: string) => {
      writeFileSync(join(checkout, 'src', 'greet.js'), 'export const greet = () => "pwned";\n');
      gitIn(checkout, 'update-index', '--skip-worktree', 'src/greet.js');
      expect(gitIn(checkout, 'status', '--porcelain')).toBe('');
    }, /src\/greet\.js/],
    ['an edit that keeps the size and the mtime', (checkout: string) => {
      const file = join(checkout, 'src', 'greet.js');
      const { atime, mtime } = statSync(file);
      writeFileSync(file, 'export const greet = () => "HI";\n');
      utimesSync(file, atime, mtime);
    }, /src\/greet\.js/],
    ['an ignored file', (checkout: string) => {
      mkdirSync(join(checkout, '.omg'), { recursive: true });
      writeFileSync(join(checkout, '.omg', 'setup.js'), 'process.exit(0)\n');
    }, /\.omg\//],
  ])('M-A: %s a prepare check leaves in the checkout parks before the gate runs', async (_what, plant, listed) => {
    w = localWorld();
    const inner = w.exec;
    const checkout = checkoutPath(w.root, LOCAL_ISSUE);
    let planted = false;
    w.exec = (cmd, args, opts) => {
      const res = inner(cmd, args, opts);
      if (!planted && isNode(cmd) && opts?.cwd === checkout) {
        planted = true;
        plant(checkout);
      }
      return res;
    };
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), withCheck));
    expect(planted).toBe(true);
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(/working tree differs from it, ignored files included/);
    expect(out.gate?.reason).toMatch(listed);
    expect(w.gateRuns).toEqual([]);
  }, 300_000);

  it("M-E: the user's own git gc, commit-graph and multi-pack-index writes during prepare do not park; the run reaches the merge gate", async () => {
    w = localWorld();
    const inner = w.exec;
    const checkout = checkoutPath(w.root, LOCAL_ISSUE);
    let wrote = false;
    w.exec = (cmd, args, opts) => {
      if (!wrote && isNode(cmd) && opts?.cwd === checkout) {
        wrote = true;
        // What a user's `git gc` (pack-refs, repack with update-server-info, commit-graph) and maintenance write.
        gitIn(w.root, 'gc', '--quiet');
        gitIn(w.root, 'commit-graph', 'write', '--reachable');
        gitIn(w.root, 'multi-pack-index', 'write', '--bitmap');
      }
      return inner(cmd, args, opts);
    };
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), withCheck));
    expect(wrote).toBe(true);
    expect(existsSync(join(w.root, '.git', 'objects', 'pack', 'multi-pack-index'))).toBe(true);
    expect(out.gate?.name, out.message).toBe('merge');
    expect(w.gateRuns).toHaveLength(1);
  }, 300_000);

  it('M-B: a sibling admin dir the checkout `.git` names in a later invocation parks; the gate never runs', async () => {
    w = localWorld(null);
    const first = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
    expect(first.gate?.reason, first.message).toMatch(/no local gate/);
    const checkout = checkoutPath(w.root, LOCAL_ISSUE);
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    const admin = join(w.root, '.git', 'worktrees', state.checkoutAdmin!);
    expect(existsSync(admin)).toBe(true);
    // Between invocations: a copy of the admin dir (its own HEAD and index) that the checkout's `.git` now names.
    const sibling = `${admin}-x`;
    cpSync(admin, sibling, { recursive: true });
    const fd = openSync(join(checkout, '.git'), 'r+');
    try { ftruncateSync(fd); writeSync(fd, `gitdir: ${sibling}\n`); } finally { closeSync(fd); }
    // A new process: nothing recorded in memory.
    forgetWorktreeGitLinks(checkout);
    w.config = resolveForgeConfig({ factory: { forge: { kind: 'local', local: { gate: ['node', '--test'] } } } }, undefined, undefined, undefined, { root: w.root, stateDir: w.stateDir }).config;
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [])));
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(new RegExp(`names the admin dir .*-x, but the engine's \`worktree add\` made ${state.checkoutAdmin}`));
    expect(w.gateRuns).toEqual([]);
  }, 300_000);

  it('M-C: a PR store set to MERGED while your base does not contain the head parks; the run is not merged', async () => {
    w = localWorld();
    const prs = join(w.config.repo.url.replace(/\.git$/, ''), 'prs.json');
    const inner = w.exec;
    let planted = false;
    w.exec = (cmd, args, opts) => {
      if (!planted && cmd === 'git' && existsSync(prs) && readFactoryState(w.root, LOCAL_ISSUE)?.phase === 'prepare') {
        planted = true;
        const store = JSON.parse(readFileSync(prs, 'utf8')) as { prs: Array<Record<string, unknown>> };
        for (const p of store.prs) Object.assign(p, { state: 'MERGED', mergedHead: readFactoryState(w.root, LOCAL_ISSUE)!.head, mergedAt: new Date().toISOString() });
        writeFileSync(prs, JSON.stringify(store));
      }
      return inner(cmd, args, opts);
    };
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')])));
    expect(planted).toBe(true);
    expect(out.gate?.name, out.message).toBe('lane-tampered');
    expect(out.gate?.reason).toMatch(new RegExp(`reports PR #\\d+ merged, but your ${BASE} [0-9a-f]{12} does not contain the head the engine pushed`));
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.phase).not.toBe('merged');
    expect(w.gateRuns).toEqual([]);
  }, 300_000);
});
