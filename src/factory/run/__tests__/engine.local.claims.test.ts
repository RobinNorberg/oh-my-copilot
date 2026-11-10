/**
 * F60 (dogfood round 3): two clones of one repository on the local forge
 * share a claim keyed on the repository's root commit, so a clone does not
 * start an item another clone's run holds (parked included).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { resolveForgeConfig } from '../../../forge/config.js';
import { defaultExec } from '../../../ship/exec.js';
import { claimRepoKey, factoryClaimPath, LOCAL_CLAIM_PREFIX, localFactoryClaimRepo } from '../claims.js';
import { EXIT_BUSY, runFactoryEngine } from '../engine.js';
import { factoryForgeOptions } from '../forge-roots.js';
import { FactoryBusyError } from '../state.js';
import { commitFile, gitIn, review } from './fake-lanes.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';

vi.setConfig({ testTimeout: scaleTiming(300_000) });

let w: LocalWorld | undefined;
let extra: string | undefined;
afterEach(() => {
  if (w) rmSync(w.dir, { recursive: true, force: true });
  if (extra) rmSync(extra, { recursive: true, force: true });
  w = undefined;
  extra = undefined;
});

/** A clone of the world's repository with no remote, like a hand-made second checkout. */
function cloneOf(world: LocalWorld, name: string): string {
  const clone = join(world.dir, name);
  gitIn(world.dir, 'clone', '-q', world.root, clone);
  gitIn(clone, 'remote', 'remove', 'origin');
  return clone;
}

describe('F60: local-forge claims across clones', () => {
  it('the claim key is the root commit: equal for two clones, unequal for another history, never path-resolved', () => {
    w = localWorld();
    const b = cloneOf(w, 'b');
    const a = localFactoryClaimRepo(defaultExec, w.root);
    expect(a).toBe(`${LOCAL_CLAIM_PREFIX}${gitIn(w.root, 'rev-list', '--max-parents=0', 'HEAD')}`);
    expect(localFactoryClaimRepo(defaultExec, b)).toBe(a);
    expect(claimRepoKey(a!, w.root)).toBe(claimRepoKey(a!, b));
    expect(factoryClaimPath(w.ledgerDir, a!, w.root, 7)).toBe(factoryClaimPath(w.ledgerDir, a!, b, 7));

    extra = mkdtempSync(join(tmpdir(), 'omg-factory-other-'));
    gitIn(extra, 'init', '-q', '-b', 'main');
    gitIn(extra, 'commit', '-q', '--allow-empty', '-m', 'other');
    expect(localFactoryClaimRepo(defaultExec, extra)).not.toBe(a);
    // No commit yet: no key (no claim), as without an origin on GitHub.
    const empty = join(extra, 'empty');
    gitIn(extra, 'init', '-q', empty);
    expect(localFactoryClaimRepo(defaultExec, empty)).toBeNull();
  });

  it('a run parked in clone A makes the same item busy (exit 6) in clone B, dry run included', async () => {
    w = localWorld();
    const first = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')])));
    expect(first.gate?.name, first.message).toBe('merge');

    const b = cloneOf(w, 'b');
    const stateDirB = join(w.dir, 'forge-state-b');
    const { config } = resolveForgeConfig({ factory: { forge: { kind: 'local', local: { gate: ['node', '--test'] } } } }, undefined, undefined, undefined, { root: b, stateDir: stateDirB });
    expect(config.repo.url).not.toBe(w.config.repo.url);
    const inB = { ...localOpts(w, lanesFor(w, [])), root: b, forge: { config, options: { ...factoryForgeOptions(b), stateDir: stateDirB } } };

    const dry = await runFactoryEngine({ ...inB, dryRun: true });
    expect(dry.exitCode, dry.message).toBe(EXIT_BUSY);
    expect(dry.message).toMatch(new RegExp(`factory run #${LOCAL_ISSUE} is .*one engine runs an item at a time across clones`));
    // The real run refuses busy (the CLI exits 6) before any fetch, worktree or lane.
    await expect(runFactoryEngine(inB)).rejects.toThrow(FactoryBusyError);
  });
});
