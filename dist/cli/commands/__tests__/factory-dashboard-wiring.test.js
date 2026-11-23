/**
 * The real `omg factory dashboard` wiring (factoryCommand in factory.ts, not
 * a hand-built command): without --forge no forge reader and no human-merge
 * hook is reached, so re-adding one to the default path fails here. With
 * --forge the same spies are reached, which shows they can see it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const spies = vi.hoisted(() => ({ board: vi.fn(), candidate: vi.fn(), record: vi.fn(), createForge: vi.fn() }));
vi.mock('../../../factory/board/collect.js', async (orig) => {
    const o = await orig();
    return { ...o, runFactoryBoard: spies.board.mockImplementation(async () => { throw new Error('no tracker in this test'); }) };
});
vi.mock('../../../factory/run/human-merged.js', async (orig) => {
    const o = await orig();
    return {
        ...o,
        humanMergeCandidate: spies.candidate.mockImplementation(o.humanMergeCandidate),
        recordHumanMerges: spies.record.mockImplementation(() => []),
    };
});
vi.mock('../../../forge/index.js', async (orig) => {
    const o = await orig();
    return { ...o, createForge: spies.createForge.mockImplementation(() => { throw new Error('no forge in this test'); }) };
});
const { factoryCommand } = await import('../factory.js');
const { EngineLedger, defaultLedgerDir } = await import('../../../factory/run/ledger.js');
const st = await import('../../../factory/run/state.js');
let dir;
let root;
let cwd;
let logs;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-dash-wiring-'));
    root = join(dir, 'repo');
    mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    vi.stubEnv('OMC_STATE_DIR', join(dir, 'state-root'));
    cwd = process.cwd();
    process.chdir(root);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((l) => { logs.push(String(l)); });
    vi.spyOn(console, 'error').mockImplementation(() => { });
    for (const s of Object.values(spies))
        s.mockClear();
    // A cancelled run with a PR: a human-merge candidate, what a hook on the default path would act on.
    const t = '2026-11-20T10:00:00.000Z';
    let s = st.moveTo(st.createFactoryState({ issue: 1, repoUrl: 'https://github.com/o/r', base: 'main' }, t), 'implement', 'go', t);
    s = { ...st.moveTo(s, 'cancelled', 'cancelled', t), pr: 101, head: 'c'.repeat(40) };
    const l = EngineLedger.open(defaultLedgerDir(), root, 1);
    st.updateFactoryState(root, 1, () => s, { onWrite: (p, c) => l.record(p, c) });
});
afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
});
const dashboard = async (args) => {
    process.exitCode = 0;
    await factoryCommand().parseAsync(['dashboard', ...args], { from: 'user' });
};
describe('omg factory dashboard (the CLI as wired)', () => {
    it('without --forge: no board read, no forge, no human-merge check or record', async () => {
        await dashboard(['--json']);
        await dashboard([]);
        expect(process.exitCode).toBe(0);
        expect(JSON.parse(logs[0]).schemaVersion).toBe(2);
        expect(spies.board).not.toHaveBeenCalled();
        expect(spies.candidate).not.toHaveBeenCalled();
        expect(spies.record).not.toHaveBeenCalled();
        expect(spies.createForge).not.toHaveBeenCalled();
    });
    it('with --forge: the board read is tried and the human-merge check runs (the spies see the forge path)', async () => {
        await dashboard(['--forge', '--json']);
        expect(spies.board).toHaveBeenCalledTimes(1);
        expect(spies.candidate).toHaveBeenCalled();
    });
});
//# sourceMappingURL=factory-dashboard-wiring.test.js.map