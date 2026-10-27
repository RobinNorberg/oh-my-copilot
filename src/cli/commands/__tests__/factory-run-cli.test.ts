import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { factoryCommand, factoryRunCommand, type FactoryRunDeps } from '../factory.js';
import { resolveFactoryRunLimits } from '../../../factory/run/budget.js';
import { factoryCancelRequested, readFactoryState } from '../../../factory/run/state.js';
import type { Exec } from '../../../ship/exec.js';
import { commitFile, FakeLanes, harness, ISSUE, review, type Harness } from '../../../factory/run/__tests__/fake-lanes.js';

let h: Harness;
let out: string[];
let lanes: FakeLanes;

beforeEach(() => {
  h = harness('omg-factory-cli-');
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(h.dir, { recursive: true, force: true });
});

function deps(over: Partial<FactoryRunDeps> = {}): FactoryRunDeps {
  // The repository root comes from git in the CLI's cwd; point it at the harness repo.
  const exec: Exec = (cmd, args, opts) => (cmd === 'git' && args.join(' ') === 'rev-parse --show-toplevel'
    ? { status: 0, stdout: `${h.root}\n`, stderr: '' }
    : h.exec(cmd, args, opts));
  return {
    exec,
    lanes: () => lanes,
    limits: () => resolveFactoryRunLimits(undefined, undefined),
    base: () => 'dev',
    ledgerDir: h.ledgerDir,
    ...over,
  };
}

async function cli(d: FactoryRunDeps, ...argv: string[]): Promise<number> {
  process.exitCode = undefined;
  await factoryRunCommand(d).parseAsync(argv, { from: 'user' });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}

describe('omg factory run CLI', () => {
  it('is registered under omg factory', () => {
    expect(factoryCommand().commands.map((c) => c.name())).toContain('run');
  });

  it('run parks at prepare (exit 0, JSON), status reads it back, cancel sets the flag', async () => {
    lanes = new FakeLanes(h.root, [commitFile('a.ts'), review('approve')]);
    const d = deps();
    expect(await cli(d, String(ISSUE), '--json')).toBe(0);
    const result = JSON.parse(out.join('\n')) as { ok: boolean; gate: { name: string }; state: { pr: number } };
    expect(result).toMatchObject({ ok: true, gate: { name: 'prepare' }, state: { pr: 42 } });

    out = [];
    expect(await cli(d, 'status', String(ISSUE), '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ phase: 'prepare', integrityOk: true, runCredits: 8 });

    out = [];
    expect(await cli(d, 'status', String(ISSUE))).toBe(0);
    expect(out.join('\n')).toMatch(/awaiting-human: prepare/);

    out = [];
    expect(await cli(d, 'cancel', String(ISSUE))).toBe(0);
    expect(factoryCancelRequested(h.root, ISSUE)).toBe(true);
    out = [];
    expect(await cli(d, 'status', String(ISSUE))).toBe(0);
    expect(out.join('\n')).toMatch(/cancel requested/);
  });

  it('a gate other than prepare exits 4', async () => {
    h.gh.issue.body = 'no plan';
    lanes = new FakeLanes(h.root, []);
    expect(await cli(deps(), String(ISSUE))).toBe(4);
    expect(out.join('\n')).toMatch(/awaiting-human: needs-plan/);
  });

  it('--dry-run never constructs the live lane backend and writes no state', async () => {
    const d = deps({ lanes: () => { throw new Error('lanes must not be built for --dry-run'); } });
    expect(await cli(d, String(ISSUE), '--dry-run', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ plan: { next: 'implement', laneMaxCredits: 30 } });
    expect(readFactoryState(h.root, ISSUE)).toBeNull();
  });

  it('usage errors exit 2; a refused cap exits 1 before anything runs', async () => {
    lanes = new FakeLanes(h.root, []);
    expect(await cli(deps(), 'abc')).toBe(2);
    expect(await cli(deps(), 'status', '9')).toBe(2);
    const low = deps({ limits: () => ({ limits: { ...resolveFactoryRunLimits(undefined, undefined).limits, laneMaxCredits: 5 }, warnings: [] }) });
    expect(await cli(low, String(ISSUE))).toBe(1);
    expect(out.join('\n')).toMatch(/below the Copilot CLI minimum/);
    expect(readFactoryState(h.root, ISSUE)).toBeNull();
  });
});
