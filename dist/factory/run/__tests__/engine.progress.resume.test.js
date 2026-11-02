import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseProgressLog } from '../../../lib/agent-progress.js';
import { runFactoryEngine } from '../engine.js';
import { factoryProgressFile } from '../progress.js';
import { readFactoryState } from '../state.js';
import { ISSUE } from './fake-lanes.js';
import { h, edits, setEditResult, clearEdits, useProgressHarness, opts, happy, added, expectExclusive, asEngine } from './engine-progress-harness.js';
useProgressHarness();
describe('progress sync on GitHub (fake gh, real git, real guard)', () => {
    it('a tracker write failure is warned and noted but never blocks or changes a transition', async () => {
        setEditResult(() => ({ status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration' }));
        const warnings = [];
        const out = await runFactoryEngine(opts(happy(), { warn: (m) => warnings.push(m) }));
        expect(out.exitCode, out.message).toBe(0);
        expect(out.gate?.name).toBe('merge');
        const state = readFactoryState(h.root, ISSUE);
        expect(state.phase).toBe('merge');
        expect(state.trackerStage).toBeUndefined();
        // Each stage was tried once, no retries within the run.
        expect(added()).toEqual(['factory:queued', 'factory:building', 'factory:reviewing', 'factory:verifying', 'factory:ready-to-merge']);
        expect(state.history.filter((e) => e.note.startsWith('tracker-sync fail: '))).toHaveLength(5);
        expect(warnings.filter((w) => /could not set the tracker stage .* HTTP 403/.test(w))).toHaveLength(5);
        const events = parseProgressLog(readFileSync(factoryProgressFile(h.root, ISSUE), 'utf8'));
        expect(events.filter((e) => e.phase === 'tracker-sync' && e.status === 'fail')).toHaveLength(5);
        // A throwing tracker is the same failure.
        setEditResult(() => { throw new Error('spawn gh ENOENT'); });
        clearEdits();
        const again = await runFactoryEngine(opts([]));
        expect(again.gate?.name).toBe('merge');
        expect(added()).toEqual(['factory:ready-to-merge']);
    });
    it('a missing label names omg factory setup, warned once per invocation, one history note per stage', async () => {
        setEditResult(() => ({ status: 1, stdout: '', stderr: "failed to update https://github.com/o/r/issues/7: 'factory:queued' not found\n" }));
        const warnings = [];
        const out = await runFactoryEngine(opts(happy(), { warn: (m) => warnings.push(m) }));
        expect(out.gate?.name, out.message).toBe('merge');
        const hints = warnings.filter((w) => w.includes('omg factory setup'));
        expect(hints).toHaveLength(1);
        expect(hints[0]).toMatch(/progress label is missing in the repository \(failed to update .*'factory:queued' not found\); run omg factory setup/);
        const notes = readFactoryState(h.root, ISSUE).history.filter((e) => e.note.startsWith('tracker-sync fail: '));
        expect(notes.map((e) => e.note.split(':')[1].trim())).toEqual(['queued', 'building', 'reviewing', 'verifying', 'ready-to-merge']);
        expect(notes.every((e) => e.note.includes('run omg factory setup'))).toBe(true);
    });
    it('a crash after the merged save and before the done write: the resume writes done once', async () => {
        await runFactoryEngine(opts(happy()));
        // The engine saved merged, then died before the tracker write (trackerStage still ready-to-merge).
        asEngine(({ gate: _g, ...s }) => ({ ...s, phase: 'merged' }));
        clearEdits();
        const out = await runFactoryEngine(opts([]));
        expect(out.phase, out.message).toBe('merged');
        expect(out.exitCode).toBe(0);
        expect(added()).toEqual(['factory:done']);
        expectExclusive();
        expect(readFactoryState(h.root, ISSUE).trackerStage).toBe('done');
        clearEdits();
        expect((await runFactoryEngine(opts([]))).phase).toBe('merged');
        expect(edits).toEqual([]);
    });
});
//# sourceMappingURL=engine.progress.resume.test.js.map