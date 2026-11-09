import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createForge } from '../../../forge/index.js';
import { readBaseFile } from '../../../ship/config.js';
import { runFactoryEnqueue } from '../../enqueue.js';
import { acquireFactoryRepoOwner, FactoryBusyError, factoryRepoOwnerPath, factoryStateDir, READ_SCAN_WAIT_MS, scanWait } from '../../run/state.js';
import { openReadForge, runFactoryCheck } from '../cli.js';
const SHA = 'a'.repeat(40);
const NOW = '2026-11-09T12:00:00.000Z';
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const live = (pid) => ({ pid, hostname: 'h', isAlive: () => true });
let root;
let fetches;
let fetchOpts;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-read-fetch-'));
    // A git repository: its factory state (the engine lock read commands take) lives in it, never in a home .omg.
    execFileSync('git', ['init', '-q', root]);
    fetches = [];
    fetchOpts = [];
    // A checkout an engine has used: its factory state dir exists (a fresh one fetches without the lock, L2).
    mkdirSync(factoryStateDir(root), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
/** The engine lock's run key right now (null: free). */
const lockRun = () => {
    const path = factoryRepoOwnerPath(root);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).run : null;
};
/** A GitHub checkout whose every `git fetch` is recorded with the engine lock's holder at that moment. */
function scripted(o = {}) {
    return (cmd, args, opts) => {
        const a = args.join(' ');
        if (cmd === 'git') {
            if (a === 'rev-parse --show-toplevel')
                return ok(`${root}\n`);
            if (a === 'remote get-url origin')
                return ok('https://github.com/o/r.git\n');
            if (args[0] === 'fetch') {
                fetches.push({ lockRun: lockRun() });
                fetchOpts.push(opts);
                if (o.fetchThrows)
                    throw new Error('fetch blew up');
                return ok();
            }
            if (a === 'rev-parse --verify refs/remotes/origin/dev')
                return o.tracking === false ? { status: 128, stdout: '', stderr: 'fatal: Needed a single revision' } : ok(`${SHA}\n`);
            if (a === `cat-file -e ${SHA}^{commit}`)
                return ok();
            // A localized git: "absent" must come from ls-tree, never from this message.
            if (args[0] === 'show')
                return { status: 128, stdout: '', stderr: 'fatal: sökvägen finns inte' };
            if (args[0] === 'ls-tree')
                return ok('');
        }
        if (cmd === 'gh')
            return ok('[]');
        throw new Error(`unscripted ${cmd} ${a}`);
    };
}
function deps(exec, owner) {
    return {
        exec, base: () => 'dev', trustedUser: () => undefined, projectConfig: () => undefined, createForge,
        isTTY: () => false, confirm: async () => false, out: () => undefined, err: () => undefined, owner,
    };
}
describe('read commands fetch the base under the engine lock, and never fail because an engine runs (review-459c M1)', () => {
    it('a live engine: check, board/poll start-up (openReadForge) and enqueue fetch nothing and read the last fetched base, with one warning', async () => {
        acquireFactoryRepoOwner(root, 7, NOW, live(1));
        const warnings = [];
        const read = openReadForge({}, deps(scripted(), live(2)), warnings, 'omg factory poll');
        expect(read.baseSha).toBe(SHA);
        expect(warnings).toContain(`engine busy: using the last fetched origin/dev (${SHA.slice(0, 12)})`);
        await runFactoryCheck({ ids: ['1'] }, deps(scripted(), live(2))).catch(() => undefined);
        const ticket = join(root, 'tickets.json');
        writeFileSync(ticket, '[]');
        await runFactoryEnqueue({ spec: '10', file: ticket, dryRun: true }, deps(scripted(), live(2))).catch(() => undefined);
        expect(fetches).toEqual([]);
        expect(lockRun()).toBe('7');
    });
    it('a live engine and no fetched base at all: busy (exit 6), nothing fetched', () => {
        acquireFactoryRepoOwner(root, 7, NOW, live(1));
        expect(() => openReadForge({}, deps(scripted({ tracking: false }), live(2)), [], 'omg factory check')).toThrow(FactoryBusyError);
        expect(() => openReadForge({}, deps(scripted({ tracking: false }), live(2)), [], 'omg factory check')).toThrow(/origin\/dev was never fetched in this checkout/);
        expect(fetches).toEqual([]);
    });
    it('free: the fetch runs under the `scan` lock, released after, also when the fetch throws', async () => {
        openReadForge({}, deps(scripted(), live(2)), [], 'omg factory board');
        const ticket = join(root, 'tickets.json');
        writeFileSync(ticket, '[]');
        await runFactoryEnqueue({ spec: '10', file: ticket, dryRun: true }, deps(scripted(), live(2))).catch(() => undefined);
        expect(fetches).toEqual([{ lockRun: 'scan' }, { lockRun: 'scan' }]);
        expect(lockRun()).toBeNull();
        expect(() => openReadForge({}, deps(scripted({ fetchThrows: true }), live(2)), [], 'omg factory check')).toThrow('fetch blew up');
        expect(fetches).toHaveLength(3);
        expect(lockRun()).toBeNull();
    });
    it('a read command\'s own lock is busy for an engine only briefly: it names the scan holder', () => {
        acquireFactoryRepoOwner(root, 'scan', NOW, live(2));
        expect(() => acquireFactoryRepoOwner(root, 7, NOW, live(1))).toThrow(/heal scan or base sync, or a factory read command's fetch, holds this checkout for a moment/);
    });
    it('M1 (review-472): the locked fetch never waits on a human (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never) and is bounded (120 s); the check guard lets exactly that through', () => {
        openReadForge({}, deps(scripted(), live(2)), [], 'omg factory check');
        expect(fetchOpts).toEqual([{ cwd: root, env: { GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, timeoutMs: 120_000 }]);
    });
    it('M1: the guards allow the fetch environment on exactly `git fetch origin <branch>`, nothing broader', async () => {
        const { assertSafeCommand, TRUSTED_FETCH_ENV } = await import('../../../ship/exec.js');
        const { assertFactoryCommand } = await import('../../run/exec.js');
        for (const guard of [(a, e) => assertSafeCommand('git', a, [], e), (a, e) => assertFactoryCommand('git', a, [], e)]) {
            expect(() => guard(['fetch', 'origin', 'dev'], { ...TRUSTED_FETCH_ENV })).not.toThrow();
            expect(() => guard(['fetch', 'origin', 'dev'], { ...TRUSTED_FETCH_ENV, GIT_SSH_COMMAND: 'x' })).toThrow();
            expect(() => guard(['fetch', 'origin', 'dev'], { GIT_TERMINAL_PROMPT: '0' })).toThrow();
            expect(() => guard(['show', `${SHA}:.copilot/omg.jsonc`], { ...TRUSTED_FETCH_ENV })).toThrow();
        }
    });
    it('M1: a fetch that fails or times out falls back to the last fetched base with the existing warning', () => {
        const timedOut = (cmd, args, opts) => (args[0] === 'fetch' ? { status: 1, stdout: '', stderr: 'spawnSync git ETIMEDOUT' } : scripted()(cmd, args, opts));
        const warnings = [];
        expect(openReadForge({}, deps(timedOut, live(2)), warnings, 'omg factory check').baseSha).toBe(SHA);
        expect(warnings).toContain('omg factory check: git fetch origin dev failed (spawnSync git ETIMEDOUT); using the local origin/dev');
    });
    it('L1 (review-472): another read\'s fetch (`scan`) is waited out briefly, then this read goes on WITHOUT fetching; it never exits 6 for a read', () => {
        acquireFactoryRepoOwner(root, 'scan', NOW, live(3));
        let t = 0;
        vi.spyOn(scanWait, 'clock').mockImplementation(() => t);
        vi.spyOn(scanWait, 'sleep').mockImplementation((ms) => { t += ms; });
        try {
            const warnings = [];
            expect(openReadForge({}, deps(scripted(), live(2)), warnings, 'omg factory check').baseSha).toBe(SHA);
            expect(t).toBe(READ_SCAN_WAIT_MS);
            expect(warnings).toContain(`another factory command is fetching: using the last fetched origin/dev (${SHA.slice(0, 12)})`);
            // Never fetched in this checkout: no base (the no-base-config path), still no exit 6.
            const none = [];
            t = 0;
            expect(openReadForge({}, deps(scripted({ tracking: false }), live(2)), none, 'omg factory check').baseSha).toBeNull();
            expect(none.join('\n')).toMatch(/another factory command is fetching and origin\/dev is not available yet; its committed config is not read/);
            expect(fetches).toEqual([]);
            expect(lockRun()).toBe('scan');
        }
        finally {
            vi.restoreAllMocks();
        }
    });
    it('L2 (review-472): omg factory check in a fresh clone with origin fetches without the lock and leaves no factory state (no .omg/) behind', async () => {
        rmSync(join(root, '.omg'), { recursive: true, force: true });
        rmSync(factoryStateDir(root), { recursive: true, force: true });
        await runFactoryCheck({ ids: ['1'] }, deps(scripted(), live(2))).catch(() => undefined);
        expect(fetches).toEqual([{ lockRun: null }]);
        expect(existsSync(factoryStateDir(root))).toBe(false);
        expect(existsSync(join(root, '.omg'))).toBe(false);
    });
});
describe('readBaseFile decides "absent" from ls-tree, whatever the locale (review-465b LOW 5)', () => {
    const at = (show, entry) => (_cmd, args) => (args[0] === 'cat-file' ? ok() : args[0] === 'show' ? show : args[0] === 'ls-tree' ? entry : ok());
    const missing = { status: 128, stdout: '', stderr: 'fatal: Pfad ".copilot/omg.jsonc" existiert nicht' };
    it('no entry is absent (null); an entry that cannot be shown (a tree, a gitlink) or a failed probe throws', () => {
        expect(readBaseFile(at(missing, ok('')), root, SHA, '.copilot/omg.jsonc')).toBeNull();
        expect(() => readBaseFile(at(missing, ok(`040000 tree ${SHA}\t.copilot/omg.jsonc\0`)), root, SHA, '.copilot/omg.jsonc')).toThrow(/git show .* failed \(exit 128\)/);
        expect(() => readBaseFile(at(missing, { status: 128, stdout: '', stderr: 'fatal' }), root, SHA, '.copilot/omg.jsonc')).toThrow(/failed/);
        // The English message alone no longer decides anything.
        expect(() => readBaseFile(at({ status: 128, stdout: '', stderr: "fatal: path 'x' does not exist in 'y'" }, { status: 1, stdout: '', stderr: '' }), root, SHA, 'x')).toThrow(/failed/);
        expect(readBaseFile(at(ok('{}'), ok('')), root, SHA, '.copilot/omg.jsonc')).toBe('{}');
    });
    it('the ship, check and factory guards allow exactly `ls-tree --full-tree -z <sha> -- <plain path>`', async () => {
        const { assertSafeCommand } = await import('../../../ship/exec.js');
        const { checkGuardExec } = await import('../cli.js');
        const { TRUSTED_READ_ENV } = await import('../../../ship/exec.js');
        expect(() => assertSafeCommand('git', ['ls-tree', '--full-tree', '-z', SHA, '--', '.copilot/omg.jsonc'], [], TRUSTED_READ_ENV)).not.toThrow();
        for (const bad of [['ls-tree', '--full-tree', '-z', SHA, '--', '../x'], ['ls-tree', '-z', 'HEAD', '--', 'x'], ['ls-tree', '-r', SHA, '--', 'x'], ['ls-tree', '--full-tree', '-z', SHA, 'x'], ['ls-tree', '-z', SHA, '--', 'x']]) {
            expect(() => assertSafeCommand('git', bad, [], TRUSTED_READ_ENV), bad.join(' ')).toThrow();
        }
        const guarded = checkGuardExec(() => ok(''));
        expect(guarded('git', ['ls-tree', '--full-tree', '-z', SHA, '--', '.copilot/omg.jsonc'], { env: TRUSTED_READ_ENV }).status).toBe(0);
        expect(() => guarded('git', ['ls-tree', '--full-tree', '-z', SHA, '--', '../etc/passwd'], { env: TRUSTED_READ_ENV })).toThrow();
        mkdirSync(dirname(factoryRepoOwnerPath(root)), { recursive: true });
    });
});
//# sourceMappingURL=read-fetch-lock.test.js.map