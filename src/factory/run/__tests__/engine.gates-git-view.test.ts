/**
 * Gate checkouts get a usable git (git-view.ts): the base calibration's
 * plain export gets a one-commit view at <dir>/.git, the prepare checkout in
 * the OS sandbox keeps its own link, and with isolation "container" every
 * request carries a view of the checked commit. The fake runner runs real
 * git in the request's dir with GIT_CEILING_DIRECTORIES at its parent, as
 * the sandbox's job-root ceiling does, so it can never find your repository
 * above the checkout.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveShipConfig } from '../../../ship/config.js';
import { GATE_SANDBOX_INCOMPATIBLE_GATE, runFactoryEngine } from '../engine.js';
import type { GateConfigLoader } from '../prepare.js';
import type { SandboxRunRequest, SandboxRunResult, SandboxRunner } from '../sandbox-exec.js';
import { BASE, lanesFor, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';
import { commitFile, gitIn, review } from './fake-lanes.js';

const T = 300_000;
let w: LocalWorld;
let scratch: string | undefined;
afterEach(() => {
  rmSync(w.dir, { recursive: true, force: true });
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

const greet = () => commitFile('src/greet.js', 'export const greet = () => "hi";\n');
const gateConfig: GateConfigLoader = () => ({
  config: { ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [], prepareChecks: [['node', 'check.js']] } as ReturnType<GateConfigLoader>['config'],
  known: [],
});
const userContainer = { factory: { run: { sandbox: { isolation: 'container' } } } };

/** git as the gate's code runs it: no discovery above `cwd`, no GIT_* of the test process. */
function gateGit(cwd: string, args: string[]): { status: number; out: string } {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  try {
    return { status: 0, out: execFileSync('git', args, { cwd, env: { ...env, GIT_CEILING_DIRECTORIES: dirname(cwd) }, encoding: 'utf8', stdio: 'pipe' }).trim() };
  } catch (error) {
    return { status: (error as { status?: number }).status ?? 1, out: String((error as { stderr?: string }).stderr ?? '') };
  }
}

interface Seen { purpose: string; head: { status: number; out: string }; files: string[]; ancestor: number; hostHead: string; gitView?: string; viewEntries?: string[] }

/** What the inventory generator needs of git, run where the gate's code would run it. */
function probe(cwd: string, req: SandboxRunRequest, hostHead: string): Seen {
  const head = gateGit(cwd, ['rev-parse', 'HEAD']);
  const files = gateGit(cwd, ['ls-files', '-z']).out.split('\0').filter(Boolean).sort();
  const ancestor = head.status === 0 ? gateGit(cwd, ['merge-base', '--is-ancestor', head.out, 'HEAD']).status : -1;
  return { purpose: req.purpose, head, files, ancestor, hostHead, ...(req.gitView ? { gitView: req.gitView, viewEntries: readdirSync(req.gitView).sort() } : {}) };
}

/** The host's own reading of the commit a dir holds (the base export has none: the calibration's base). */
const hostHeadOf = (cwd: string): string => (existsSync(join(cwd, '.git')) ? execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() : '');

describe('git views for gate checkouts', () => {
  it('OS sandbox: the base calibration\'s export answers rev-parse HEAD (the base), ls-files and is-ancestor; the prepare checkout uses its own link; the view leaves with the dir', async () => {
    w = localWorld();
    const base = gitIn(w.root, 'rev-parse', BASE);
    const baseFiles = gitIn(w.root, 'ls-tree', '-r', '--name-only', base).split('\n').filter(Boolean).sort();
    const seen: Seen[] = [];
    const run: SandboxRunner = async (req): Promise<SandboxRunResult> => {
      const s = probe(req.cwd, req, req.purpose === 'calibrate' ? base : hostHeadOf(req.cwd));
      seen.push(s);
      if (req.purpose === 'prepare') return { ran: true, status: 1, output: 'drift', timedOut: false };
      return { ran: true, status: s.head.status === 0 ? 0 : 1, output: s.head.out, timedOut: false };
    };
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), { gateSandbox: run, gateConfig, gateSandboxUserConfig: {} }));
    expect(out.gate?.name, out.message).not.toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
    const [prep, cal] = seen;
    expect(seen.map((s) => s.purpose).slice(0, 2)).toEqual(['prepare', 'calibrate']);
    // The prepare checkout's own link (no view is made for the OS sandbox).
    expect(prep.head).toEqual({ status: 0, out: prep.hostHead });
    expect(prep.gitView).toBeUndefined();
    // The base export: exactly the base commit and its files, no request field needed.
    expect(cal.head).toEqual({ status: 0, out: base });
    expect(cal.files).toEqual(baseFiles);
    expect(cal.ancestor).toBe(0);
    expect(cal.gitView).toBeDefined();
    const calDir = dirname(cal.gitView!);
    expect(existsSync(calDir)).toBe(false);
  }, T);

  it('isolation "container": prepare, the local gate and the calibration each get a view of exactly their commit, copied in as .git, removed after', async () => {
    w = localWorld();
    scratch = mkdtempSync(join(tmpdir(), 'omg-gitview-ctr-'));
    const base = gitIn(w.root, 'rev-parse', BASE);
    const seen: Seen[] = [];
    let n = 0;
    const run: SandboxRunner = async (req): Promise<SandboxRunResult> => {
      // The container's copy: the checkout without .git, then the view as .git (container-gate.ts copyScript).
      const copy = join(scratch!, `c${n++}`, 'src');
      cpSync(req.cwd, copy, { recursive: true, filter: (p) => !/[\\/]\.git$/.test(p) });
      if (req.gitView) cpSync(req.gitView, join(copy, '.git'), { recursive: true });
      const s = probe(copy, req, req.purpose === 'calibrate' ? base : hostHeadOf(req.cwd));
      seen.push(s);
      return { ran: true, status: req.purpose === 'gate' ? 1 : 0, output: s.head.out, timedOut: false };
    };
    await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), { gateSandbox: run, gateConfig, gateSandboxUserConfig: userContainer }));
    expect(seen.map((s) => s.purpose)).toEqual(['prepare', 'gate', 'calibrate']);
    for (const s of seen) {
      expect(s.head, s.purpose).toEqual({ status: 0, out: s.hostHead });
      expect(s.ancestor, s.purpose).toBe(0);
      expect(s.files, s.purpose).toContain('README.md');
      // No hooks dir, no info/, no description: only what git-view.ts writes.
      expect(s.viewEntries, s.purpose).toEqual(['HEAD', 'config', 'index', 'objects', 'refs', 'shallow']);
      expect(existsSync(s.gitView!), s.purpose).toBe(false);
    }
    expect(seen[0].files).toContain('src/greet.js');
    expect(seen[2].files).not.toContain('src/greet.js');
    expect(seen[2].hostHead).toBe(base);
  }, T);

  it('isolation "container" in the private layout: the prepare checkout\'s commit comes from the run\'s private repository', async () => {
    w = localWorld();
    appendFileSync(join(w.root, '.gitignore'), 'node_modules/\n');
    gitIn(w.root, 'add', '.gitignore');
    gitIn(w.root, 'commit', '-q', '-m', 'ignore node_modules');
    const seen: Seen[] = [];
    scratch = mkdtempSync(join(tmpdir(), 'omg-gitview-priv-'));
    let n = 0;
    const run: SandboxRunner = async (req): Promise<SandboxRunResult> => {
      const copy = join(scratch!, `c${n++}`, 'src');
      mkdirSync(dirname(copy), { recursive: true });
      cpSync(req.cwd, copy, { recursive: true, filter: (p) => !/[\\/]\.git$/.test(p) });
      if (req.gitView) cpSync(req.gitView, join(copy, '.git'), { recursive: true });
      seen.push(probe(copy, req, req.purpose === 'install' ? '' : hostHeadOf(req.cwd)));
      return { ran: true, status: 0, output: '', timedOut: false };
    };
    const user = { factory: { run: { layout: 'private', workDir: join(w.dir, 'fw') } } };
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [greet(), review('approve')]), { gateSandbox: run, gateConfig, gateSandboxUserConfig: userContainer, runUserConfig: user }));
    const prep = seen.find((s) => s.purpose === 'prepare');
    expect(prep, out.message).toBeDefined();
    expect(prep!.head).toEqual({ status: 0, out: prep!.hostHead });
    expect(prep!.files).toContain('src/greet.js');
    // The greet commit exists only in the private repository until it is imported: the view was built from there.
    expect(prep!.gitView).toBeDefined();
  }, T);
});
