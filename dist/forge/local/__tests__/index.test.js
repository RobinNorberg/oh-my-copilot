import { writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createForge } from '../../index.js';
import { createLocalForge, localForgeLimitations, writeLocalCheckRecord } from '../index.js';
import { localMerge } from '../merge.js';
import { git, makeFixture, recordingExec } from './git-fixture.js';
let fx;
beforeEach(() => {
    fx = makeFixture();
});
afterEach(() => fx.cleanup());
describe('createForge with a local config', () => {
    it('returns the local forge with no CI, heal, board or webhooks, and its limitations', () => {
        const forge = createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.root], stateDir: fx.stateDir, local: { omgRoot: fx.omgRoot } });
        expect(forge.kind).toBe('local');
        expect(forge.provider).toBe('unknown');
        expect(forge.repo).toEqual(fx.config.repo);
        expect(forge.ci).toBeUndefined();
        expect(forge.reviews.listThreads).toBeUndefined();
        expect(forge.capabilities).toEqual({ heal: false, projectsV2: false, boardColumns: false, webhookIntake: false });
        expect(forge.limitations?.()).toEqual(localForgeLimitations());
    });
    it('refuses a store under an untrusted root', () => {
        expect(() => createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.tmp], local: { omgRoot: fx.omgRoot } })).toThrow(/untrusted root/);
    });
    it('needs the caller to name the runtime root (src/forge cannot resolve it without spawning)', () => {
        expect(() => createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.root] })).toThrow(/omgRoot is required/);
    });
    it('refuses a non-local config', () => {
        expect(() => createLocalForge(recordingExec().exec, fx.root, { ...fx.config, kind: 'github' }, { untrustedRoots: [] })).toThrow(/local forge config/);
    });
    it('reads back the engine-written local-gate record for the PR head', () => {
        fx.write('a.txt', 'a');
        const base = fx.commit('base');
        fx.push(base, 'main');
        git(fx.root, 'checkout', '-q', '-b', 'factory/1-x');
        fx.write('b.txt', 'b');
        const head = fx.commit('b');
        fx.push(head, 'factory/1-x');
        const forge = createForge(recordingExec().exec, fx.root, fx.config, { untrustedRoots: [fx.root], local: { omgRoot: fx.omgRoot } });
        const body = join(fx.tmp, 'body.md');
        writeFileSync(body, 'x');
        const pr = forge.reviews.createDraftPr({ base: 'main', head: 'factory/1-x', title: 'x', bodyFile: body });
        expect(forge.checks.checks(pr, head)).toEqual([]);
        writeLocalCheckRecord(fx.stateDir, fx.root, { name: 'local-gate', head, state: 'SUCCESS', argv: ['node', '--test'], runId: 1, startedAt: 'now', completedAt: 'now', exitCode: 0 });
        expect(forge.checks.checks(pr, forge.reviews.prHead(pr).headRefOid)).toMatchObject([{ name: 'local-gate', state: 'SUCCESS' }]);
        expect(forge.merge.humanMergeCommand(pr, head)).toEqual(['git', '-C', fx.root, 'merge', '--no-ff', head]);
        expect(forge.merge.blockingPolicies(pr, head)).toEqual([]);
    });
});
describe('localMerge and limitations', () => {
    it('refuses a head that is not a 40-hex sha', () => {
        expect(() => localMerge('/r').humanMergeCommand(1, 'main')).toThrow(/40-hex/);
    });
    it('lists every offline limitation, naming the base', () => {
        const lines = localForgeLimitations('main').join('\n');
        for (const want of ['no CI', 'review threads', '.omg/factory/local/', 'listen', 'heal', 'board', 'git merge you run on main', 'between machines'])
            expect(lines).toContain(want);
    });
});
//# sourceMappingURL=index.test.js.map