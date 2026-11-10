/**
 * F59 (dogfood round 3): a cancel mid-lane leaves the lane's partial edits in
 * its worktree. `run clean` keeps that dirty tree (and names --discard);
 * `run reset` gives the uncommitted changes up itself and starts the item
 * over. Junction targets and the main checkout are never touched.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { createForge } from '../../../forge/index.js';
import { getOmcRoot } from '../../../lib/worktree-paths.js';
import { cleanFactoryRun } from '../clean.js';
import { runFactoryEngine } from '../engine.js';
import { factoryForgeOptions } from '../forge-roots.js';
import { resetFactoryRun } from '../reset.js';
import { factoryStatePath, FactoryBusyError, readFactoryState, requestFactoryCancel, updateFactoryState } from '../state.js';
import { EngineLedger } from '../ledger.js';
import { FakeLanes, gitIn } from './fake-lanes.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { LOCAL_ISSUE, localOpts, localWorld } from './engine-local-harness.js';
vi.setConfig({ testTimeout: scaleTiming(300_000) });
let w;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));
const OWNER = { pid: 4242, hostname: 'test-host', isAlive: () => false };
describe('F59: reset after a cancel mid-lane', () => {
    it('clean keeps the dirty lane worktree; reset removes it (uncommitted changes given up) and starts the item over', async () => {
        w = localWorld();
        const outside = join(w.dir, 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'keep.txt'), 'keep\n');
        // The implement lane is still running when the human cancels; it has edited a tracked file and added one.
        const lanes = new FakeLanes(w.root, [() => ({ finalText: 'never read' })], [2]);
        let worktree = '';
        lanes.onRunningPoll = () => {
            worktree = join(w.root, '.omg', 'team', 'copilot-run', 'worktrees', 'cr-fake1');
            writeFileSync(join(worktree, 'README.md'), 'partial edit\n');
            writeFileSync(join(worktree, 'new.js'), 'export {};\n');
            if (!existsSync(join(worktree, 'linked')))
                symlinkSync(outside, join(worktree, 'linked'), 'junction');
            requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
        };
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.phase, out.message).toBe('cancelled');
        expect(existsSync(join(worktree, 'new.js'))).toBe(true);
        const cleaned = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner: OWNER });
        expect(cleaned.kept.map((k) => k.reason).join('\n')).toMatch(/worktree_dirty/);
        expect(existsSync(worktree)).toBe(true);
        const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
        const reset = resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER });
        expect(reset.removedWorktrees).toContain(worktree);
        expect(existsSync(worktree)).toBe(false);
        expect(readFactoryState(w.root, LOCAL_ISSUE)).toBeNull();
        // The junction went as a link: its target is untouched. The main checkout is untouched too.
        expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
        expect(gitIn(w.root, 'status', '--porcelain')).toBe('');
    });
    it('a lane whose cancel failed refuses while its child may run (busy); a worktree holding a commit refuses the reset', async () => {
        w = localWorld();
        const lanes = new FakeLanes(w.root, [() => ({ finalText: 'never read' })], [2]);
        lanes.cancelFails = true;
        let worktree = '';
        lanes.onRunningPoll = () => {
            worktree = join(w.root, '.omg', 'team', 'copilot-run', 'worktrees', 'cr-fake1');
            writeFileSync(join(worktree, 'README.md'), 'partial edit\n');
            requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
        };
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.phase, out.message).toBe('cancelled');
        expect(readFactoryState(w.root, LOCAL_ISSUE).lanes[0].note).toMatch(/the cancel failed/);
        const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
        const reset = (o = {}) => resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER, ...o });
        // The child still runs: busy, before any removal; clean --discard says the same.
        expect(() => reset({ processState: () => 'live' })).toThrow(FactoryBusyError);
        // N1: a child seen alive with its recorded start identity refuses even with --lane-stopped.
        expect(() => reset({ processState: () => 'live', laneStopped: true })).toThrow(/still runs \(its start identity matches\).*rerun omg factory run reset 7 \(a child seen alive/);
        expect(() => cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner: OWNER, discard: true, processState: () => 'live' })).toThrow(/stop was not confirmed, so no worktree is discarded/);
        expect(existsSync(join(worktree, 'README.md'))).toBe(true);
        // N2: the pid now belongs to another process (its start identity differs): the child counts as gone. The lane
        // committed, though: the reset refuses and changes nothing.
        gitIn(worktree, 'commit', '-qam', 'lane work');
        expect(() => reset({ processState: () => 'mismatch' })).toThrow(/hold unpushed commits or other work: .*worktree_unmerged_commits/);
        expect(existsSync(worktree)).toBe(true);
        expect(readFactoryState(w.root, LOCAL_ISSUE)?.phase).toBe('cancelled');
    });
    it('reset keeps a worktree whose lane note records tamper problems; clean --discard removes it', async () => {
        w = localWorld();
        const lanes = new FakeLanes(w.root, [() => ({ finalText: 'never read' })], [2]);
        let worktree = '';
        lanes.onRunningPoll = () => {
            worktree = join(w.root, '.omg', 'team', 'copilot-run', 'worktrees', 'cr-fake1');
            writeFileSync(join(worktree, 'new.js'), 'export {};\n');
            // Shared git state outside the lane's own branch: the cancel's tamper check records it.
            if (!gitIn(w.root, 'branch', '--list', 'planted'))
                gitIn(w.root, 'branch', 'planted');
            requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
        };
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.phase, out.message).toBe('cancelled');
        expect(readFactoryState(w.root, LOCAL_ISSUE).lanes[0].note).toMatch(/tamper check: /);
        const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
        expect(() => resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER })).toThrow(/still has worktrees kept as tamper evidence: .*tamper_evidence/);
        expect(existsSync(join(worktree, 'new.js'))).toBe(true);
        expect(readFactoryState(w.root, LOCAL_ISSUE)?.phase).toBe('cancelled');
        const cleaned = cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner: OWNER, discard: true });
        expect(cleaned.removed).toContain(worktree);
        expect(existsSync(worktree)).toBe(false);
    });
    it('N1: a lane with an unconfirmed stop and no recorded pid is busy, naming its worktree and --lane-stopped; with the flag reset proceeds and records it', async () => {
        w = localWorld();
        const lanes = new FakeLanes(w.root, [() => ({ finalText: 'never read' })], [2]);
        lanes.cancelFails = true;
        lanes.onRunningPoll = () => requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
        const out = await runFactoryEngine(localOpts(w, lanes));
        expect(out.phase, out.message).toBe('cancelled');
        const worktree = join(w.root, '.omg', 'team', 'copilot-run', 'worktrees', 'cr-fake1');
        expect(existsSync(worktree)).toBe(true);
        // As an engine that never saw the job's child (a cancel finished by a later engine): no pid recorded.
        const ledger = EngineLedger.open(w.ledgerDir, w.root, LOCAL_ISSUE);
        updateFactoryState(w.root, LOCAL_ISSUE, (s) => ({ ...s, lanes: s.lanes.map(({ process: _p, ...l }) => l) }), { onWrite: (p, c) => ledger.record(p, c) });
        const lane = readFactoryState(w.root, LOCAL_ISSUE).lanes[0];
        expect(lane.process).toBeUndefined();
        const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
        const reset = (o = {}) => resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER, ...o });
        const message = (fn) => { try {
            fn();
        }
        catch (e) {
            expect(e).toBeInstanceOf(FactoryBusyError);
            return e.message;
        } throw new Error('expected busy'); };
        const busy = message(() => reset());
        expect(busy).toContain(`lane ${lane.id} (cr-fake1): its stop was not confirmed`);
        expect(busy).toContain('no pid of its Copilot child was recorded');
        expect(busy).toContain(`look for Copilot CLI processes whose command line names its worktree ${worktree}`);
        expect(busy).toContain('rerun omg factory run reset 7 --lane-stopped');
        expect(message(() => cleanFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, ledgerDir: w.ledgerDir, owner: OWNER, discard: true }))).toContain('rerun omg factory run clean 7 --discard --lane-stopped');
        expect(existsSync(worktree)).toBe(true);
        const done = reset({ laneStopped: true, now: '2026-11-10T12:00:00.000Z' });
        expect(done.acknowledgedLanes).toEqual([lane.id]);
        expect(done.removedWorktrees).toContain(worktree);
        expect(existsSync(worktree)).toBe(false);
        // The acknowledgement is in the history of the state the reset moved aside.
        const moved = JSON.parse(readFileSync(done.stateMovedTo, 'utf8'));
        expect(moved.history.map((h) => h.note).join('\n')).toMatch(new RegExp(`lane ${lane.id} \\(cr-fake1\\): --lane-stopped: a human confirmed that its Copilot child stopped`));
        expect(moved.lanes[0].stopUnconfirmed).toBe(false);
        expect(existsSync(factoryStatePath(w.root, LOCAL_ISSUE))).toBe(false);
    });
    it('N3: a wall-time lane whose cancel later confirmed its stop is no longer unconfirmed: reset proceeds', async () => {
        w = localWorld();
        let t = 1_000_000;
        const lanes = new FakeLanes(w.root, [() => ({ finalText: 'never read' })], [10_000]);
        lanes.cancelFails = true;
        const first = await runFactoryEngine(localOpts(w, lanes, { limits: { ...DEFAULT_FACTORY_RUN_LIMITS, laneTimeoutMs: 60_000 }, now: () => (t += 61_000) }));
        expect(first.gate?.name, first.message).toBe('lane-unconfirmed');
        expect(readFactoryState(w.root, LOCAL_ISSUE).lanes[0]).toMatchObject({ status: 'running', note: expect.stringMatching(/cancel was not confirmed/) });
        // The job stops after all: the cancel confirms it.
        lanes.cancelFails = false;
        requestFactoryCancel(w.root, LOCAL_ISSUE, new Date().toISOString());
        const second = await runFactoryEngine(localOpts(w, lanes));
        expect(second.phase, second.message).toBe('cancelled');
        const lane = readFactoryState(w.root, LOCAL_ISSUE).lanes[0];
        // The rerun settles the running lane first (settleLost: the cancel is confirmed now) and records its new note.
        expect(lane.status, JSON.stringify(lane)).toBe('lost');
        expect(lane.stopUnconfirmed).not.toBe(true);
        expect(lane.note ?? '').not.toMatch(/not confirmed|may still run/);
        const forge = createForge(w.exec, w.root, w.config, { ...factoryForgeOptions(w.root), stateDir: w.stateDir, local: { omgRoot: getOmcRoot(w.root) } });
        const worktree = join(w.root, '.omg', 'team', 'copilot-run', 'worktrees', 'cr-fake1');
        // Even a pid that looks alive (reused) no longer matters: the stop is confirmed.
        const done = resetFactoryRun({ root: w.root, issue: LOCAL_ISSUE, exec: w.exec, forge, mirror: w.config.repo.url, ledgerDir: w.ledgerDir, owner: OWNER, processState: () => 'live' });
        expect(done.removedWorktrees).toContain(worktree);
        expect(done.acknowledgedLanes).toBeUndefined();
    });
});
//# sourceMappingURL=engine.local.reset-discard.test.js.map