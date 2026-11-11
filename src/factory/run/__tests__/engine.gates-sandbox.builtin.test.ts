/**
 * Built-in prepare checks in the OS sandbox (review 482 #1): a built-in
 * eslint or vitest argv holds the PR's changed file names, so a refusal of
 * it never gets the --allow-unsandboxed-gates offer. One changed file name
 * too long for the sandbox shell is a plain FAILURE of that check, decided
 * before any sandbox call. A name of that length cannot be checked out on
 * every CI host (Linux caps a path far below the 120 000-character shell
 * limit), so the sizing alone is replaced here for one marked file name; the
 * split, the engine and prepare run as they are.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderFactoryRunState } from '../../../cli/commands/factory.js';
import type { BoardRow } from '../../board/collect.js';
import { runLine } from '../../board/render.js';
import { outcomePosts } from '../outcome.js';

import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { BUILT_IN_FILE_NAME_TOO_LONG, GATE_NO_VERDICT_GATE, GATE_SANDBOX_INCOMPATIBLE_GATE, runFactoryEngine } from '../engine.js';
import { ESLINT_SCRIPT, TSC_SCRIPT } from '../../../ship/prepare.js';
import type { SandboxRunRequest, SandboxRunResult, SandboxRunner } from '../sandbox-exec.js';
import { readFactoryState } from '../state.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';
import { commitFile, gitIn, review } from './fake-lanes.js';

const LONG_FILE = 'src/over-long-name.ts';

vi.mock('../sandbox-exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sandbox-exec.js')>();
  return {
    ...real,
    sandboxCommandTooLong: (platform: NodeJS.Platform, argv: readonly string[], cwd: string) => argv.includes(LONG_FILE) || real.sandboxCommandTooLong(platform, argv, cwd),
  };
});

/** M2: when set, the removal of a base calibration dir's node_modules tree throws (a busy file on win32). */
const removal = vi.hoisted(() => ({ fail: false }));
vi.mock('../prepare.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../prepare.js')>();
  return {
    ...real,
    unlinkNodeModules: (root: string, checkout: string) => {
      if (removal.fail && /^base-/.test(basename(checkout))) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${checkout}'`), { code: 'EBUSY' });
      return real.unlinkNodeModules(root, checkout);
    },
  };
});

const MULTI_RUN_MS = 300_000;
let w: LocalWorld;
afterEach(() => { removal.fail = false; rmSync(w.dir, { recursive: true, force: true }); });

const PASS: SandboxRunResult = { ran: true, status: 0, output: 'ok', timedOut: false };

function sandbox(answer: (req: SandboxRunRequest) => SandboxRunResult) {
  const reqs: SandboxRunRequest[] = [];
  const run: SandboxRunner = async (req) => { reqs.push(req); return answer(req); };
  return { reqs, run };
}

/** A base with tsconfig.json and an eslint config committed, and the two tools in an ignored node_modules: built-in tsc and lint run. */
function builtInWorld(): LocalWorld {
  const world = localWorld();
  appendFileSync(join(world.root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(world.root, 'tsconfig.json'), '{}\n');
  writeFileSync(join(world.root, 'eslint.config.js'), 'export default [];\n');
  gitIn(world.root, 'add', '.');
  gitIn(world.root, 'commit', '-q', '-m', 'tooling');
  for (const script of [TSC_SCRIPT, ESLINT_SCRIPT]) {
    mkdirSync(join(world.root, script, '..'), { recursive: true });
    writeFileSync(join(world.root, script), '\n');
  }
  return world;
}

const walkFiles = (dir: string): string[] => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => (e.isDirectory() ? walkFiles(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
};

const opts = (file: string, run: SandboxRunner) =>
  localOpts(w, lanesFor(w, [commitFile(file, 'export const x = 1;\n'), review('approve')]), { gateSandbox: run, limits: { ...DEFAULT_FACTORY_RUN_LIMITS, maxCiFixRounds: 0 } });

describe('built-in prepare checks in the OS sandbox (review 482 #1)', () => {
  it('one changed file name too long for the sandbox shell, after a sandboxed tsc: a FAILURE of lint with the fixed text, no offer, no unsandboxed run', async () => {
    w = builtInWorld();
    const s = sandbox(() => PASS);
    const out = await runFactoryEngine(opts(LONG_FILE, s.run));
    expect(out.gate?.name, out.message).toBe('ci-failed');
    expect(out.gate?.reason).toContain('prepare lint');
    expect(out.gate?.reason).not.toContain('--allow-unsandboxed-gates');
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(state.ciFailure?.checks).toEqual(['prepare lint']);
    expect(state.ciFailure?.detail).toContain(BUILT_IN_FILE_NAME_TOO_LONG);
    // tsc ran in the sandbox; lint never reached it (decided before any sandbox call), and nothing ran plainly.
    expect(s.reqs.map((r) => r.args[0])).toEqual([TSC_SCRIPT]);
    expect(w.gateRuns).toEqual([]);
  }, MULTI_RUN_MS);

  it('H1 (review-490): a ci-failed park keeps the output tail and test names local: state, status and board show them, no forge write carries them', async () => {
    w = builtInWorld();
    const marker = 'LEAK-MARKER-7f3a';
    const blob = 'c0ffee'.repeat(12);
    const failing: SandboxRunResult = { ran: true, status: 1, output: `src/a.test.ts > reads ${marker}\n${marker} ${blob}\n`, timedOut: false };
    const s = sandbox((req) => (req.purpose === 'calibrate' || req.args[0] !== TSC_SCRIPT ? PASS : failing));
    const out = await runFactoryEngine(opts('src/short.ts', s.run));
    expect(out.gate?.name, out.message).toBe('ci-failed');
    const state = readFactoryState(w.root, LOCAL_ISSUE)!;
    expect(state.gate?.reason).toContain('prepare tsc');
    expect(state.gate?.reason).toContain(`omg factory run status ${LOCAL_ISSUE}`);
    expect(state.gate?.reason).not.toContain(marker);
    expect(state.gate?.reason).not.toContain(blob);
    expect(state.gate?.detail).toContain(marker);
    expect(state.gate?.detail).toContain(blob);
    expect(state.history.some((h) => h.note.includes(marker))).toBe(false);
    // The local forge's store (issue comments, PR notes, outcome posts) and the backlog: no copy of either.
    const forgeFiles = [...walkFiles(w.stateDir), ...walkFiles(join(w.root, '.copilot')), ...walkFiles(join(w.root, '.omg')).filter((f) => !f.startsWith(join(w.root, '.omg', 'state')))];
    expect(forgeFiles.length).toBeGreaterThan(0);
    expect(forgeFiles.some((f) => readFileSync(f, 'utf8').includes('awaiting a human: **ci-failed**'))).toBe(true);
    for (const f of forgeFiles) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toContain(marker);
      expect(text, f).not.toContain(blob);
    }
    // The outcome post of a failed run reads the history, never the detail.
    for (const post of outcomePosts({ ...state, phase: 'failed' }, 'failed', 1, 'github')) {
      expect(post.body).not.toContain(marker);
      expect(post.body).not.toContain(blob);
    }
    expect(renderFactoryRunState(state)).toContain(marker);
    expect(runLine({ id: LOCAL_ISSUE, flags: [], run: { phase: state.phase, credits: 0, gate: { name: 'ci-failed', reason: state.gate!.reason, detail: state.gate!.detail } } } as unknown as BoardRow, '#')).toContain(blob);
  }, MULTI_RUN_MS);

  it('M2 (review-490): a failing removal of the calibration tree warns and keeps the dir; the calibration verdict stands (no step error)', async () => {
    w = builtInWorld();
    removal.fail = true;
    const warnings: string[] = [];
    const failing: SandboxRunResult = { ran: true, status: 1, output: 'error TS2322: nope', timedOut: false };
    const s = sandbox((req) => (req.args[0] === TSC_SCRIPT ? failing : PASS));
    const out = await runFactoryEngine({ ...opts('src/short.ts', s.run), warn: (m: string) => warnings.push(m) });
    expect(out.exitCode, out.message).not.toBe(1);
    expect(out.gate?.name, out.message).toBe(GATE_SANDBOX_INCOMPATIBLE_GATE);
    expect(s.reqs.map((r) => r.purpose)).toContain('calibrate');
    expect(warnings.join(' | ')).toMatch(/could not remove the node_modules tree of the base calibration dir .*EBUSY/);
    expect(warnings.join(' | ')).toMatch(/still has its node_modules/);
    // The user's node_modules is untouched.
    expect(existsSync(join(w.root, TSC_SCRIPT))).toBe(true);
  }, MULTI_RUN_MS);

  it('any other refusal of a built-in part after the head\'s code ran parks gate-no-verdict, without the --allow-unsandboxed-gates offer', async () => {
    w = builtInWorld();
    const refused: SandboxRunResult = { ran: false, refused: true, reason: 'the command cannot be passed to the sandbox shell unchanged (a NUL, or on Windows an empty argument or a double quote)' };
    const s = sandbox((req) => (req.args[0] === ESLINT_SCRIPT ? refused : PASS));
    const out = await runFactoryEngine(opts('src/short.ts', s.run));
    expect(out.gate?.name, out.message).toBe(GATE_NO_VERDICT_GATE);
    expect(out.gate?.reason).toContain('--allow-unsandboxed-gates does not apply here');
    expect(out.gate?.reason).not.toContain('Acknowledging trusts');
    expect(s.reqs.map((r) => r.args[0])).toEqual([TSC_SCRIPT, ESLINT_SCRIPT]);
    expect(w.gateRuns).toEqual([]);
  }, MULTI_RUN_MS);
});
