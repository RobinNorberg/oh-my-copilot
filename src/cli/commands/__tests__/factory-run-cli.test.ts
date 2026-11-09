import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { factoryCommand, factoryRunCommand, type FactoryRunDeps } from '../factory.js';
import { resolveFactoryRunLimits } from '../../../factory/run/budget.js';
import { factoryClaimPath } from '../../../factory/run/claims.js';
import { EXIT_AWAITING_HUMAN, EXIT_BUSY } from '../../../factory/run/engine.js';
import { factoryCancelRequested, factoryOwnerPath, factoryRepoOwnerPath, readFactoryState } from '../../../factory/run/state.js';
import { resolveForgeConfig } from '../../../forge/config.js';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import type { Exec } from '../../../ship/exec.js';
import { commitFile, FakeLanes, harness, ISSUE, review, testGateConfig, type Harness } from '../../../factory/run/__tests__/fake-lanes.js';

// The full engine flows below run dozens of real git commands. Alone they take 40-120 s on a
// loaded win32 host, at the 120 s suite default; nothing in them asserts timing, so this is
// only a hang guard.
const ENGINE_FLOW_TIMEOUT_MS = scaleTiming(60_000);

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
    gateConfig: testGateConfig,
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

  it('run parks at the human merge (exit 0, JSON, the merge command), status reads it back, clean refuses it, cancel sets the flag', async () => {
    lanes = new FakeLanes(h.root, [commitFile('a.ts'), review('approve')]);
    const d = deps();
    expect(await cli(d, String(ISSUE), '--json')).toBe(0);
    const result = JSON.parse(out.join('\n')) as { ok: boolean; gate: { name: string }; state: { pr: number; head: string }; mergeCommand: string };
    expect(result).toMatchObject({ ok: true, gate: { name: 'merge' }, state: { pr: 42 } });
    expect(result.mergeCommand).toBe(`gh pr merge 42 --admin --merge --match-head-commit ${result.state.head}`);

    out = [];
    expect(await cli(d, 'status', String(ISSUE), '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ phase: 'merge', integrityOk: true, runCredits: 8 });

    out = [];
    expect(await cli(d, 'status', String(ISSUE))).toBe(0);
    expect(out.join('\n')).toMatch(/awaiting-human: merge/);

    out = [];
    expect(await cli(d, 'clean', String(ISSUE))).toBe(1);
    expect(out.join('\n')).toMatch(/merged or cancelled run only/);

    out = [];
    expect(await cli(d, 'cancel', String(ISSUE))).toBe(0);
    expect(factoryCancelRequested(h.root, ISSUE)).toBe(true);
    out = [];
    expect(await cli(d, 'status', String(ISSUE))).toBe(0);
    expect(out.join('\n')).toMatch(/cancel requested/);
  }, ENGINE_FLOW_TIMEOUT_MS);

  it('a gate other than merge exits 4', async () => {
    h.gh.issue.body = 'no plan';
    lanes = new FakeLanes(h.root, []);
    expect(await cli(deps(), String(ISSUE))).toBe(4);
    expect(out.join('\n')).toMatch(/awaiting-human: needs-plan/);
    // F35: the parked run prints the gate line once (the final message), not again in the state block.
    // (The history block below the state keeps its own dated entry.)
    expect(out.join('\n').split('\n').filter((l) => l.startsWith('awaiting-human: needs-plan')), out.join('\n')).toHaveLength(1);
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

  describe('--next (shipyard ↔ factory design §3.5)', () => {
    /** Tracker items by id; #7 keeps the harness issue's title and body unless given. */
    let items: Record<number, { body?: string; labels?: string[]; state?: string }>;
    /** Factory branches whose PR merged into dev. */
    let merged: string[];
    /** The intake source's open items (`gh issue list --label factory-ready`). */
    let listed: number[];

    beforeEach(() => {
      items = {};
      merged = [];
      listed = [];
    });

    function nextDeps(): FactoryRunDeps {
      const base = deps({
        forge: () => resolveForgeConfig(undefined, undefined, { factory: { intake: { source: { type: 'label', label: 'factory-ready' } } } }, 'https://github.com/o/r.git'),
      });
      const exec: Exec = (cmd, args, o) => {
        const key = `${cmd} ${args.join(' ')}`;
        const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
        const view = /^gh issue view (\d+) --json /.exec(key);
        if (view && items[Number(view[1])]) {
          const id = Number(view[1]);
          const it = items[id];
          return ok(JSON.stringify({ ...h.gh.issue, ...(id === ISSUE ? {} : { title: `item ${id}`, body: '' }), ...it, labels: (it.labels ?? []).map((name) => ({ name })), state: it.state ?? 'OPEN', url: `https://github.com/o/r/issues/${id}` }));
        }
        if (key.startsWith('gh issue list --label factory-ready --state open --json number')) return ok(JSON.stringify(listed.map((number) => ({ number }))));
        const m = /^gh pr list --head (factory\/issue-\d+) --base dev --state merged --json number$/.exec(key);
        if (m) return ok(JSON.stringify(merged.includes(m[1]) ? [{ number: 90 }] : []));
        return base.exec(cmd, args, o);
      };
      return { ...base, exec };
    }

    it('picks the first runnable item by priority, then id, and runs it', async () => {
      const ac = '## Acceptance criteria\n\n- `greet()` returns hi\n';
      items = {
        2: { body: ac },
        4: {},
        7: { labels: ['priority:p1'] },
        9: { body: `Blocked by #4\n\n${ac}`, labels: ['priority:p0'] },
        12: { body: ac, labels: ['priority:p1'] },
      };
      listed = [12, 9, 2, 7];
      lanes = new FakeLanes(h.root, [commitFile('a.ts'), review('approve')]);
      expect(await cli(nextDeps(), '--next', '--json')).toBe(0);
      const result = JSON.parse(out.join('\n')) as { next: number; gate: { name: string }; state: { issue: number } };
      expect(result).toMatchObject({ next: 7, gate: { name: 'merge' }, state: { issue: 7 } });
      expect(readFactoryState(h.root, 12)).toBeNull();
      expect(readFactoryState(h.root, 2)).toBeNull();
      expect(readFactoryState(h.root, 9)).toBeNull();
    }, ENGINE_FLOW_TIMEOUT_MS);

    it('nothing runnable exits 0 with the bucket counts; an item whose own factory PR merged is never re-run', async () => {
      items = { 100: { body: '- [ ] #7\n- [ ] #9\n' }, 7: {}, 9: { body: 'Blocked by #4\n' }, 4: {} };
      merged = ['factory/issue-7'];
      lanes = new FakeLanes(h.root, []);
      expect(await cli(nextDeps(), '--next', '--parent', '100', '--json')).toBe(0);
      expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: true, next: null, message: 'nothing runnable', counts: { runnable: 0, blocked: 2 } });
      expect(readFactoryState(h.root, 7)).toBeNull();

      out = [];
      expect(await cli(nextDeps(), '--next', '--parent', '100')).toBe(0);
      expect(out.join('\n')).toMatch(/nothing runnable \(0 runnable, 0 needs-plan, 2 blocked\)/);
    });

    it('an item parked at blocked-by is picked and resumed once its dependency\'s factory PR merged', async () => {
      const ac = '## Acceptance criteria\n\n- `greet()` returns hi\n';
      items = { [ISSUE]: { body: `Blocked by #4\n\n${ac}` }, 4: {} };
      listed = [ISSUE];
      lanes = new FakeLanes(h.root, [commitFile('a.ts'), review('approve')]);
      expect(await cli(nextDeps(), String(ISSUE))).toBe(EXIT_AWAITING_HUMAN);
      expect(readFactoryState(h.root, ISSUE)).toMatchObject({ phase: 'intake', gate: { name: 'blocked-by' } });

      out = [];
      expect(await cli(nextDeps(), '--next', '--json')).toBe(0);
      expect(JSON.parse(out.join('\n'))).toMatchObject({ next: null, counts: { blocked: 1 } });

      merged = ['factory/issue-4'];
      out = [];
      expect(await cli(nextDeps(), '--next', '--json')).toBe(0);
      expect(JSON.parse(out.join('\n'))).toMatchObject({ next: ISSUE, gate: { name: 'merge' }, state: { issue: ISSUE } });
    }, ENGINE_FLOW_TIMEOUT_MS);

    it('the per-repository run lock still refuses a second engine', async () => {
      items = { 7: {} };
      listed = [7];
      const owner = factoryRepoOwnerPath(h.root);
      mkdirSync(dirname(owner), { recursive: true });
      writeFileSync(owner, JSON.stringify({ pid: process.ppid, hostname: hostname(), startedAt: new Date().toISOString(), run: '12' }));
      lanes = new FakeLanes(h.root, []);
      expect(await cli(nextDeps(), '--next')).toBe(EXIT_BUSY);
      expect(out.join('\n')).toMatch(/another omg factory engine runs in this repository/);
      expect(readFactoryState(h.root, 7)).toBeNull();
    });

    it('an item claimed by a live engine in another clone is skipped by --next and refused by run (busy, exit 6); a dead claim is taken over and released', async () => {
      items = { 7: { body: '## Acceptance criteria\n\n- `greet()` returns hi\n' } };
      listed = [7];
      lanes = new FakeLanes(h.root, []);
      const claim = factoryClaimPath(h.ledgerDir, 'https://github.com/o/r.git', h.root, 7);
      const other = join(h.dir, 'other-clone');
      mkdirSync(dirname(claim), { recursive: true });
      writeFileSync(claim, JSON.stringify({ pid: process.ppid, hostname: hostname(), startedAt: '2026-11-09T00:00:00.000Z', run: '7', root: other }));

      expect(await cli(nextDeps(), '--next', '--json')).toBe(0);
      expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: true, next: null, claimed: [7], counts: { runnable: 1 } });
      out = [];
      expect(await cli(nextDeps(), '--next')).toBe(0);
      expect(out.join('\n')).toMatch(/nothing runnable .*; held by another engine: #7/);

      out = [];
      expect(await cli(nextDeps(), '7', '--json')).toBe(EXIT_BUSY);
      const busy = JSON.parse(out.join('\n')) as { ok: boolean; busy: boolean; error: string };
      expect(busy).toMatchObject({ ok: false, busy: true });
      expect(busy.error).toContain(`factory run #7 is claimed by an engine in ${other}`);
      // Refused before anything was touched: no state, no owner files left.
      expect(readFactoryState(h.root, 7)).toBeNull();
      expect(existsSync(factoryRepoOwnerPath(h.root))).toBe(false);
      expect(existsSync(factoryOwnerPath(h.root, 7))).toBe(false);

      out = [];
      expect(await cli(nextDeps(), '7', '--dry-run', '--json')).toBe(EXIT_BUSY);
      expect(JSON.parse(out.join('\n'))).toMatchObject({ exitCode: EXIT_BUSY, message: expect.stringMatching(/^dry run: the cross-clone claim on #7 is held/) });

      // A claim whose pid is dead is taken over; the run releases it when it ends (no plan: it parks at once).
      writeFileSync(claim, JSON.stringify({ pid: 4_999_999, hostname: hostname(), startedAt: '2026-11-09T00:00:00.000Z', run: '7', root: other }));
      items = { 7: { body: 'no plan yet' } };
      out = [];
      expect(await cli(nextDeps(), '7', '--json')).toBe(EXIT_AWAITING_HUMAN);
      expect(JSON.parse(out.join('\n'))).toMatchObject({ gate: { name: 'needs-plan' } });
      expect(existsSync(claim)).toBe(false);
    }, ENGINE_FLOW_TIMEOUT_MS);

    it('run status without an issue lists the live engines of this checkout', async () => {
      lanes = new FakeLanes(h.root, []);
      expect(await cli(deps(), 'status')).toBe(0);
      expect(out.join('\n')).toMatch(/no factory engine runs in this checkout/);
      const live = { pid: process.ppid, hostname: hostname(), startedAt: '2026-11-09T00:00:00.000Z' };
      mkdirSync(dirname(factoryRepoOwnerPath(h.root)), { recursive: true });
      writeFileSync(factoryRepoOwnerPath(h.root), JSON.stringify({ ...live, run: '12' }));
      writeFileSync(factoryOwnerPath(h.root, 12), JSON.stringify(live));
      writeFileSync(factoryOwnerPath(h.root, 13), JSON.stringify({ ...live, pid: 4_999_999 }));
      out = [];
      expect(await cli(deps(), 'status', '--json')).toBe(0);
      expect(JSON.parse(out.join('\n'))).toEqual({ ok: true, engine: { ...live, run: '12' }, runs: [{ ...live, key: 12 }] });
      out = [];
      expect(await cli(deps(), 'status')).toBe(0);
      expect(out.join('\n')).toMatch(/engine lock: 12, pid \d+[\s\S]*live #12: pid/);
    });

    it('usage: --next takes no issue, --parent needs --next and an id, --next needs a forge config', async () => {
      lanes = new FakeLanes(h.root, []);
      expect(await cli(nextDeps(), '--next', '7')).toBe(2);
      expect(await cli(nextDeps(), '--parent', '100')).toBe(2);
      expect(await cli(nextDeps(), '--next', '--parent', 'x')).toBe(2);
      expect(await cli(deps(), '--next')).toBe(2);
    });
  });
});
