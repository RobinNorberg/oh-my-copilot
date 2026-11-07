/**
 * `omg factory poll`'s base sync on the local forge (pollLocalBaseSync): the
 * local base is pushed fast-forward only to the engine-owned mirror through
 * the engine's guarded, hardened exec, and the tick reports the synced base.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveForgeConfig } from '../../../forge/config.js';
import { readMirrorRef } from '../../../forge/local/index.js';
import { defaultExec } from '../../../ship/exec.js';
import { gitIn } from '../../../factory/run/__tests__/fake-lanes.js';
import { pollLocalBaseSync } from '../factory.js';
let dir;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
describe('omg factory poll: local forge base sync', () => {
    it('creates and syncs the mirror base, reports it, and pins the pack programs; a rewritten base refuses', () => {
        dir = mkdtempSync(join(tmpdir(), 'omg-poll-local-'));
        const root = join(dir, 'repo');
        mkdirSync(root);
        gitIn(root, 'init', '-q', '-b', 'main');
        writeFileSync(join(root, 'README.md'), 'hi\n');
        gitIn(root, 'add', '.');
        gitIn(root, 'commit', '-q', '-m', 'init');
        const { config } = resolveForgeConfig({ factory: { forge: { kind: 'local' } } }, undefined, undefined, undefined, { root, stateDir: join(dir, 'forge') });
        const raw = [];
        const exec = (cmd, args, opts) => { raw.push(args); return defaultExec(cmd, args, opts); };
        const sync = pollLocalBaseSync(exec, join(dir, 'ledger'));
        const head = gitIn(root, 'rev-parse', 'main');
        expect(sync({ root, base: 'main', config })).toBe(`synced main ${head.slice(0, 12)} to the local forge mirror`);
        expect(readMirrorRef(config.repo.url, 'main')).toBe(head);
        const push = raw.find((a) => a.includes('push'));
        expect(push).toContain('remote.omg-local.receivepack=git-receive-pack');
        expect(push).toContain('core.fsmonitor=false');
        // A human merge moves the base forward: the next tick fast-forwards the mirror.
        gitIn(root, 'commit', '-q', '--allow-empty', '-m', 'merged');
        const next = gitIn(root, 'rev-parse', 'main');
        expect(sync({ root, base: 'main', config })).toContain(next.slice(0, 12));
        expect(readMirrorRef(config.repo.url, 'main')).toBe(next);
        // A rewritten base is not a fast-forward: the tick refuses instead of overwriting the mirror.
        gitIn(root, 'commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten');
        expect(() => sync({ root, base: 'main', config })).toThrow(/fast-forward only/);
        expect(readMirrorRef(config.repo.url, 'main')).toBe(next);
    });
});
//# sourceMappingURL=factory-poll-local-sync.test.js.map