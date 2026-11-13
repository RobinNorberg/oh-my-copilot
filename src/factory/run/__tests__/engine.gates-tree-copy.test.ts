/**
 * The copied gate tree: a check whose base calibration fails in the OS
 * sandbox on Windows with esbuild's refused open of a package dir through the
 * gate tree's junction (`Cannot read directory "node_modules/<pkg>": Access
 * is denied.`) runs again in the sandbox on a copy of your node_modules; the
 * run keeps copying from then on. Elsewhere, or with another output, the run
 * parks as before. The engine on the local forge with fake lanes and a
 * recording fake sandbox that looks at the checkout's tree.
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveShipConfig } from '../../../ship/config.js';
import { GATE_SANDBOX_INCOMPATIBLE_GATE, runFactoryEngine, type FactoryEngineOptions } from '../engine.js';
import type { GateConfigLoader } from '../prepare.js';
import type { SandboxRunRequest, SandboxRunResult, SandboxRunner } from '../sandbox-exec.js';
import { readFactoryState } from '../state.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';
import { commitFile, gitIn, review } from './fake-lanes.js';

const T = 300_000;
let w: LocalWorld;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');
const buildConfig: GateConfigLoader = () => ({
  config: { ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [], prepareChecks: [], prepareBuild: { command: ['node', 'build.js'], outputs: ['dist'] } } as ReturnType<GateConfigLoader>['config'],
  known: [],
});
const DENIED: SandboxRunResult = {
  ran: true,
  status: 1,
  output: 'Error: Build failed with 2 errors:\nerror: Cannot read directory "node_modules/zod": Access is denied.\nerror: Cannot read directory "node_modules/commander": Access is denied.',
  timedOut: false,
};
const PASS: SandboxRunResult = { ran: true, status: 0, output: 'ok', timedOut: false };
const FAIL: SandboxRunResult = { ran: true, status: 1, output: 'error TS2322: nope', timedOut: false };

/** A repository whose (ignored) node_modules holds one package, as yours. */
function world(): LocalWorld {
  w = localWorld();
  appendFileSync(join(w.root, '.gitignore'), 'node_modules/\n');
  gitIn(w.root, 'commit', '-q', '-am', 'ignore node_modules');
  mkdirSync(join(w.root, 'node_modules', 'zod'), { recursive: true });
  writeFileSync(join(w.root, 'node_modules', 'zod', 'index.js'), 'yours\n');
  return w;
}

/** How the checkout's `node_modules/zod` looks when a request runs: a link, a copy, or none. */
const treeKind = (cwd: string): 'link' | 'copy' | 'none' => {
  const p = join(cwd, 'node_modules', 'zod');
  if (!existsSync(p)) return 'none';
  return lstatSync(p).isSymbolicLink() ? 'link' : 'copy';
};

/** A recording sandbox: purpose and tree kind per request; `answer` decides from both. */
function sandbox(answer: (req: SandboxRunRequest, tree: 'link' | 'copy' | 'none', n: number) => SandboxRunResult) {
  const seen: string[] = [];
  const run: SandboxRunner = async (req) => {
    const build = req.argv.includes('build.js');
    const tree = treeKind(req.cwd);
    if (build) seen.push(`${req.purpose}:${tree}`);
    return build ? answer(req, tree, seen.length) : PASS;
  };
  return { seen, run };
}

const win32: FactoryEngineOptions['gitTransportHost'] = { platform: 'win32', shell: () => null };
const opts = (lanes: ReturnType<typeof lanesFor>, over: Partial<FactoryEngineOptions>): FactoryEngineOptions => localOpts(w, lanes, { gateConfig: buildConfig, gateSandboxUserConfig: {}, gitTransportHost: win32, ...over });

describe('copied gate tree (esbuild through a junction in the Windows OS sandbox)', () => {
  it('the build runs again in the sandbox on a copied tree and passes; the run copies from then on; yours is untouched', async () => {
    world();
    const s = sandbox((_req, tree) => (tree === 'link' ? DENIED : PASS));
    const warnings: string[] = [];
    const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, warn: (m) => warnings.push(m) }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(s.seen).toEqual(['prepare:link', 'calibrate:link', 'prepare:copy']);
    // Nothing ran without the sandbox.
    expect(w.gateRuns.filter((r) => r.argv.includes('build.js'))).toEqual([]);
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(state.gateTreeCopy).toBe(true);
    expect(state.gitTransportPlainHead).toBeUndefined();
    expect(Object.values(state.gateCalibration ?? {})).toEqual([expect.objectContaining({ ok: false, junctionRead: true })]);
    expect(state.history.some((h) => /node_modules trees are copies of yours from now on/.test(h.note ?? ''))).toBe(true);
    expect(warnings.join('\n')).toContain('denies opening a package dir through the gate tree\'s junction');
    expect(readFileSync(join(w.root, 'node_modules', 'zod', 'index.js'), 'utf-8')).toBe('yours\n');
  }, T);

  it('a failure on the copied tree counts only against the base on a copied tree: the base passes there, a ci-fix lane starts', async () => {
    world();
    const s = sandbox((req, tree) => (tree === 'link' ? DENIED : req.purpose === 'calibrate' ? PASS : FAIL));
    const lanes = lanesFor(w, [greet(), review('approve'), commitFile('src/greet.js', 'export const greet = () => "hi!";\n'), review('approve')]);
    await runFactoryEngine(opts(lanes, { gateSandbox: s.run }));
    expect(s.seen.slice(0, 4)).toEqual(['prepare:link', 'calibrate:link', 'prepare:copy', 'calibrate:copy']);
    expect(lanes.started.map((l) => l.laneId)).toContain(`issue-${LOCAL_ISSUE}-ci-fix-1`);
  }, T);

  it('the base fails on the copied tree too: the run parks at gate-sandbox-incompatible, once, no loop', async () => {
    world();
    const s = sandbox((_req, tree) => (tree === 'link' ? DENIED : FAIL));
    const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run }));
    expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
    expect(s.seen).toEqual(['prepare:link', 'calibrate:link', 'prepare:copy', 'calibrate:copy']);
  }, T);

  it('the local gate: runs again in the sandbox on a copied tree and passes', async () => {
    world();
    const seen: string[] = [];
    const run: SandboxRunner = async (req) => {
      if (!req.argv.includes('--test')) return PASS;
      const tree = treeKind(req.cwd);
      seen.push(`${req.purpose}:${tree}`);
      return tree === 'link' ? DENIED : PASS;
    };
    const noChecks: GateConfigLoader = () => ({
      config: { ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [], prepareChecks: [] } as ReturnType<GateConfigLoader>['config'],
      known: [],
    });
    const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateConfig: noChecks, gateSandbox: run }));
    expect(out.gate?.name, out.message).toBe('merge');
    expect(seen).toEqual(['gate:link', 'calibrate:link', 'gate:copy']);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.gateTreeCopy).toBe(true);
  }, T);

  it('not Windows: the same output parks, nothing is copied', async () => {
    world();
    const s = sandbox(() => DENIED);
    const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run, gitTransportHost: { platform: 'linux', shell: () => null } }));
    expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
    expect(s.seen).toEqual(['prepare:link', 'calibrate:link']);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.gateTreeCopy).toBeUndefined();
  }, T);

  it('another sandbox failure on the base parks as before: no copy', async () => {
    world();
    const s = sandbox(() => FAIL);
    const out = await runFactoryEngine(opts(lanesFor(w, [greet(), review('approve')]), { gateSandbox: s.run }));
    expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
    expect(s.seen).toEqual(['prepare:link', 'calibrate:link']);
    expect(readFactoryState(w.root, LOCAL_ISSUE)!.gateTreeCopy).toBeUndefined();
  }, T);
});
