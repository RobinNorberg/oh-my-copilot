import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryCommand, factoryRunCommand } from '../factory.js';
import { resolveFactoryRunLimits } from '../../../factory/run/budget.js';
import { EXIT_AWAITING_HUMAN } from '../../../factory/run/engine.js';
import { factoryCancelRequested, factoryRepoOwnerPath, readFactoryState } from '../../../factory/run/state.js';
import { resolveForgeConfig } from '../../../forge/config.js';
import { commitFile, FakeLanes, harness, ISSUE, review, testGateConfig } from '../../../factory/run/__tests__/fake-lanes.js';
let h;
let out;
let lanes;
beforeEach(() => {
    h = harness('omg-factory-cli-');
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { out.push(a.join(' ')); });
});
afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(h.dir, { recursive: true, force: true });
});
function deps(over = {}) {
    // The repository root comes from git in the CLI's cwd; point it at the harness repo.
    const exec = (cmd, args, opts) => (cmd === 'git' && args.join(' ') === 'rev-parse --show-toplevel'
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
async function cli(d, ...argv) {
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
        const result = JSON.parse(out.join('\n'));
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
    });
    it('a gate other than merge exits 4', async () => {
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
    describe('--next (shipyard ↔ factory design §3.5)', () => {
        /** Tracker items by id; #7 keeps the harness issue's title and body unless given. */
        let items;
        /** Factory branches whose PR merged into dev. */
        let merged;
        /** The intake source's open items (`gh issue list --label factory-ready`). */
        let listed;
        beforeEach(() => {
            items = {};
            merged = [];
            listed = [];
        });
        function nextDeps() {
            const base = deps({
                forge: () => resolveForgeConfig(undefined, undefined, { factory: { intake: { source: { type: 'label', label: 'factory-ready' } } } }, 'https://github.com/o/r.git'),
            });
            const exec = (cmd, args, o) => {
                const key = `${cmd} ${args.join(' ')}`;
                const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
                const view = /^gh issue view (\d+) --json /.exec(key);
                if (view && items[Number(view[1])]) {
                    const id = Number(view[1]);
                    const it = items[id];
                    return ok(JSON.stringify({ ...h.gh.issue, ...(id === ISSUE ? {} : { title: `item ${id}`, body: '' }), ...it, labels: (it.labels ?? []).map((name) => ({ name })), state: it.state ?? 'OPEN', url: `https://github.com/o/r/issues/${id}` }));
                }
                if (key.startsWith('gh issue list --label factory-ready --state open --json number'))
                    return ok(JSON.stringify(listed.map((number) => ({ number }))));
                const m = /^gh pr list --head (factory\/issue-\d+) --base dev --state merged --json number$/.exec(key);
                if (m)
                    return ok(JSON.stringify(merged.includes(m[1]) ? [{ number: 90 }] : []));
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
            const result = JSON.parse(out.join('\n'));
            expect(result).toMatchObject({ next: 7, gate: { name: 'merge' }, state: { issue: 7 } });
            expect(readFactoryState(h.root, 12)).toBeNull();
            expect(readFactoryState(h.root, 2)).toBeNull();
            expect(readFactoryState(h.root, 9)).toBeNull();
        });
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
        });
        it('the per-repository run lock still refuses a second engine', async () => {
            items = { 7: {} };
            listed = [7];
            const owner = factoryRepoOwnerPath(h.root);
            mkdirSync(dirname(owner), { recursive: true });
            writeFileSync(owner, JSON.stringify({ pid: process.ppid, hostname: hostname(), startedAt: new Date().toISOString(), run: '12' }));
            lanes = new FakeLanes(h.root, []);
            expect(await cli(nextDeps(), '--next')).toBe(1);
            expect(out.join('\n')).toMatch(/another omg factory engine runs in this repository/);
            expect(readFactoryState(h.root, 7)).toBeNull();
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
//# sourceMappingURL=factory-run-cli.test.js.map