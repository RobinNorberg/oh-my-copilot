/**
 * Units of the engine's local forge support (offline forge plan §1.1, lane B):
 * the exec guard's local shapes, the pack programs pinned on `omg-local`,
 * the local gate and its record, and the sealed `remote` of the run state.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLocalCheckRecord, writeLocalCheckRecord } from '../../../forge/local/index.js';
import { isProcessAlive } from '../../../platform/process-utils.js';
import { assertFactoryCommand, FactorySafetyError, hardenedGitExec, LOCAL_REMOTE_PACK_ARGS, localRemoteRefusedKeys, localTransportArgs, mirrorRewriteKeys } from '../exec.js';
import { assertLocalGateCommand, defaultLocalGateRunner, LOCAL_GATE_STALE_GRACE_MS, LOCAL_GATE_TAIL_CHARS, localGateDue, localGateRecord, resolveLocalGateArgv, runLocalGate, } from '../local-gate.js';
import { createFactoryState, parseFactoryState, runRemote } from '../state.js';
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const MIRROR = resolve(tmpdir(), 'forge', 'local', 'repo-0123456789ab.git');
const LOCAL = { mirror: MIRROR, baseSha: SHA };
const ok = (cmd, args, extra = [], local = LOCAL) => () => assertFactoryCommand(cmd, args, extra, undefined, undefined, undefined, local ?? undefined);
describe('the factory guard on the local forge shapes', () => {
    it.each([
        ['a factory branch to the mirror', ['push', 'omg-local', `${SHA}:refs/heads/factory/issue-7`], []],
        ['the synced base sha to the mirror base (fast-forward base sync)', ['push', 'omg-local', `${SHA}:refs/heads/main`], ['main']],
        ['ls-remote of a factory branch on the mirror', ['ls-remote', 'omg-local', 'refs/heads/factory/issue-7'], []],
        ['the bare mirror init', ['init', '--bare', '--quiet', MIRROR], []],
        ['the omg-local remote add', ['remote', 'add', 'omg-local', MIRROR], []],
        ['the backlog list at a commit', ['ls-tree', '-z', '--name-only', SHA, '--', '.copilot/backlog/'], []],
        ['one backlog file at a commit', ['show', `${SHA}:.copilot/backlog/1-add-remove.md`], []],
        ['the merged check', ['merge-base', '--is-ancestor', SHA, SHA2], []],
        ['the local base branch', ['rev-parse', '--verify', 'refs/heads/main'], []],
        ['the mirror fetch', ['fetch', 'omg-local', 'main'], []],
        ['the refused omg-local config read', ['config', '--get-regexp', '^remote\\.omg-local\\.(vcs|mirror|fetch)$'], []],
        ['the url rewrite config read', ['config', '-z', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'], []],
    ])('allows %s', (_what, args, extra) => {
        expect(ok('git', args, extra)).not.toThrow();
    });
    // Same layout, another mirror: a case variant where the file system is case-sensitive, another state dir elsewhere.
    const variant = process.platform === 'linux' ? MIRROR.replace('repo-', 'Repo-') : resolve(tmpdir(), 'forge2', 'local', 'repo-0123456789ab.git');
    it.each([
        ['a protected branch that is not the run base', ['push', 'omg-local', `${SHA}:refs/heads/dev`], ['main'], LOCAL],
        ['the base to origin', ['push', 'origin', `${SHA}:refs/heads/main`], ['main'], LOCAL],
        ['a forced push to the mirror', ['push', 'omg-local', `+${SHA}:refs/heads/main`], ['main'], LOCAL],
        ['another sha than the synced base to the mirror base', ['push', 'omg-local', `${SHA2}:refs/heads/main`], ['main'], LOCAL],
        ['a base push before a sync read the base', ['push', 'omg-local', `${SHA}:refs/heads/main`], ['main'], { mirror: MIRROR }],
        ['a base push with no local forge context', ['push', 'omg-local', `${SHA}:refs/heads/main`], ['main'], null],
        ['another remote name', ['push', 'evil', `${SHA}:refs/heads/factory/issue-7`], [], LOCAL],
        ['an init outside the forge state layout', ['init', '--bare', '--quiet', resolve(tmpdir(), 'elsewhere.git')], [], LOCAL],
        ['an init of another mirror in the same layout', ['init', '--bare', '--quiet', variant], [], LOCAL],
        ['an init with no local forge context', ['init', '--bare', '--quiet', MIRROR], [], null],
        ['a relative mirror path', ['init', '--bare', '--quiet', 'local/repo-0123456789ab.git'], [], LOCAL],
        ['a non-bare init', ['init', MIRROR], [], LOCAL],
        ['a remote add of another name', ['remote', 'add', 'origin', MIRROR], [], LOCAL],
        ['a remote add of another url', ['remote', 'add', 'omg-local', 'https://github.com/o/r.git'], [], LOCAL],
        ['a remote add of another mirror in the same layout', ['remote', 'add', 'omg-local', variant], [], LOCAL],
        ['a remote set-url', ['remote', 'set-url', 'omg-local', MIRROR], [], LOCAL],
        ['a backlog list that climbs out', ['ls-tree', '-z', '--name-only', SHA, '--', '../x/'], [], LOCAL],
        ['a backlog list without the trailing slash', ['ls-tree', '-z', '--name-only', SHA, '--', '.copilot/backlog'], [], LOCAL],
    ])('refuses %s', (_what, args, extra, local) => {
        expect(ok('git', args, extra, local)).toThrow(FactorySafetyError);
    });
});
describe('hardenedGitExec on omg-local', () => {
    const seen = [];
    let refusedOut = '';
    const inner = (_cmd, args) => {
        seen.push(args);
        if (args.includes('--get-regexp'))
            return refusedOut ? { status: 0, stdout: refusedOut, stderr: '' } : { status: 1, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
    };
    let dir;
    afterEach(() => { seen.length = 0; refusedOut = ''; rmSync(dir, { recursive: true, force: true }); });
    const commands = () => seen.filter((a) => !a.includes('--get-regexp'));
    it('pins the stock pack programs for push, fetch and ls-remote on omg-local, and only there', () => {
        dir = mkdtempSync(join(tmpdir(), 'omg-hooks-'));
        const exec = hardenedGitExec(inner, dir, () => MIRROR);
        exec('git', ['push', 'omg-local', `${SHA}:refs/heads/factory/issue-7`]);
        exec('git', ['fetch', 'omg-local', 'main']);
        exec('git', ['ls-remote', 'omg-local', 'refs/heads/factory/issue-7']);
        exec('git', ['push', 'origin', `${SHA}:refs/heads/factory/issue-7`]);
        exec('git', ['remote', 'get-url', 'omg-local']);
        const pinned = (args) => args.join(' ').includes(LOCAL_REMOTE_PACK_ARGS.join(' '));
        expect(commands().map(pinned)).toEqual([true, true, true, false, false]);
        expect(LOCAL_REMOTE_PACK_ARGS).toEqual(['-c', 'remote.omg-local.receivepack=git-receive-pack', '-c', 'remote.omg-local.uploadpack=git-upload-pack']);
        // The pins come after the hardening and before the command, so they win over the repository config.
        const first = commands()[0];
        const at = first.indexOf('push');
        expect(first.slice(at - LOCAL_REMOTE_PACK_ARGS.length, at)).toEqual(LOCAL_REMOTE_PACK_ARGS);
        // The push names the mirror path, so no fetch refspec of the named remote moves a local ref after it.
        expect(first.slice(at)).toEqual(['push', MIRROR, `${SHA}:refs/heads/factory/issue-7`]);
    });
    it('refuses a push on omg-local when the mirror path is unknown', () => {
        dir = mkdtempSync(join(tmpdir(), 'omg-hooks-'));
        expect(() => hardenedGitExec(inner, dir)('git', ['push', 'omg-local', `${SHA}:refs/heads/factory/issue-7`])).toThrow(/mirror path is unknown/);
        expect(commands()).toEqual([]);
    });
    it('fetches omg-local with an explicit tracking refspec and no configured refmap or tags', () => {
        dir = mkdtempSync(join(tmpdir(), 'omg-hooks-'));
        hardenedGitExec(inner, dir)('git', ['fetch', 'omg-local', 'main']);
        const fetch = commands()[0];
        expect(fetch.slice(fetch.indexOf('fetch'))).toEqual(['fetch', '--no-tags', '--refmap=', 'omg-local', '+refs/heads/main:refs/remotes/omg-local/main']);
        expect(localTransportArgs(['fetch', 'origin', 'main'])).toEqual(['fetch', 'origin', 'main']);
        expect(localTransportArgs(['push', 'omg-local', `${SHA}:refs/heads/main`], MIRROR)).toEqual(['push', MIRROR, `${SHA}:refs/heads/main`]);
    });
    it('refuses every omg-local transport while remote.omg-local.vcs or .mirror is set (the backstop)', () => {
        dir = mkdtempSync(join(tmpdir(), 'omg-hooks-'));
        refusedOut = 'remote.omg-local.vcs ext\n';
        const exec = hardenedGitExec(inner, dir, () => MIRROR);
        expect(() => exec('git', ['fetch', 'omg-local', 'main'])).toThrow(/sets remote\.omg-local\.vcs/);
        expect(() => exec('git', ['push', 'omg-local', `${SHA}:refs/heads/factory/issue-7`])).toThrow(FactorySafetyError);
        expect(commands()).toEqual([]);
        // Other git commands are not concerned.
        exec('git', ['status']);
        expect(commands()).toHaveLength(1);
    });
    it('accepts only the default omg-local fetch refspec; vcs, mirror and any other refspec are refused', () => {
        expect(localRemoteRefusedKeys('remote.omg-local.fetch +refs/heads/*:refs/remotes/omg-local/*\n')).toEqual([]);
        expect(localRemoteRefusedKeys('')).toEqual([]);
        expect(localRemoteRefusedKeys('remote.omg-local.fetch +refs/heads/*:refs/remotes/omg-local/*\nremote.omg-local.fetch +refs/heads/*:refs/heads/x/*\n'))
            .toEqual(['remote.omg-local.fetch=+refs/heads/*:refs/heads/x/*']);
        expect(localRemoteRefusedKeys('remote.omg-local.vcs ext\r\nremote.omg-local.mirror true\n')).toEqual(['remote.omg-local.vcs=ext', 'remote.omg-local.mirror=true']);
    });
    it('mirrorRewriteKeys: a url rewrite whose value prefixes the mirror path (either slash form) is refused, others are not', () => {
        const fwd = MIRROR.replace(/\\/g, '/');
        const rec = (key, value) => (value === undefined ? `${key}\0` : `${key}\n${value}\0`);
        expect(mirrorRewriteKeys('', MIRROR)).toEqual([]);
        // A user's ordinary rewrites never touch a local path.
        expect(mirrorRewriteKeys(rec('url.git@github.com:.insteadof', 'https://github.com/') + rec('url.ssh://x/.pushinsteadof', 'https://dev.azure.com/'), MIRROR)).toEqual([]);
        // The literal mirror, a parent directory of it, and the other slash form; a subsection with spaces stays one key.
        expect(mirrorRewriteKeys(rec('url./evil repo.insteadof', MIRROR), MIRROR)).toEqual([`url./evil repo.insteadof=${MIRROR}`]);
        expect(mirrorRewriteKeys(rec('url./evil.pushinsteadof', resolve(MIRROR, '..', '..')), MIRROR)).toHaveLength(1);
        expect(mirrorRewriteKeys(rec('url./evil.insteadof', fwd), MIRROR)).toHaveLength(1);
        expect(mirrorRewriteKeys(rec('url./evil.insteadof', MIRROR.replace(/\//g, '\\')), fwd)).toHaveLength(1);
        // No value: an empty prefix matches everything.
        expect(mirrorRewriteKeys(rec('url./evil.insteadof'), MIRROR)).toEqual(['url./evil.insteadof=']);
        // Longer than the mirror, or another path: not a prefix.
        expect(mirrorRewriteKeys(rec('url./evil.insteadof', `${MIRROR}x`) + rec('url./evil.insteadof', resolve(tmpdir(), 'other')), MIRROR)).toEqual([]);
        // Another case: refused only where the file system is case-insensitive.
        expect(mirrorRewriteKeys(rec('url./evil.insteadof', MIRROR.toUpperCase()), MIRROR)).toHaveLength(process.platform === 'linux' ? 0 : 1);
    });
    it('the backstop refuses an omg-local transport while a url rewrite of the mirror path is configured', () => {
        dir = mkdtempSync(join(tmpdir(), 'omg-hooks-'));
        const rewrite = (_cmd, args) => {
            seen.push(args);
            if (args.includes('-z'))
                return { status: 0, stdout: `url./evil.git.insteadof\n${MIRROR}\0`, stderr: '' };
            if (args.includes('--get-regexp'))
                return { status: 1, stdout: '', stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
        };
        const exec = hardenedGitExec(rewrite, dir, () => MIRROR);
        expect(() => exec('git', ['push', 'omg-local', `${SHA}:refs/heads/factory/issue-7`])).toThrow(/rewrites the local forge mirror .*url\.\/evil\.git\.insteadof/);
        expect(() => exec('git', ['fetch', 'omg-local', 'main'])).toThrow(FactorySafetyError);
        expect(commands()).toEqual([]);
    });
});
describe('the local gate', () => {
    let dir;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const world = () => {
        dir = mkdtempSync(join(tmpdir(), 'omg-local-gate-'));
        return { stateDir: join(dir, 'forge'), root: join(dir, 'repo'), checkout: join(dir, 'checkout') };
    };
    it('runs the configured argv once in the checkout and records SUCCESS for exactly that head', async () => {
        const w = world();
        const runs = [];
        const runner = async (argv, cwd, timeoutMs) => {
            runs.push({ argv, cwd, timeoutMs });
            // While the gate runs, the head reads PENDING (a crash leaves no pass behind).
            expect(localGateRecord(w.stateDir, w.root, SHA)?.state).toBe('PENDING');
            return { status: 0, stdout: 'ok 1\n', stderr: '', timedOut: false };
        };
        const out = await runLocalGate({ ...w, head: SHA, gate: ['npm', 'test'], timeoutMinutes: 3, runner });
        expect(runs).toEqual([{ argv: ['npm', 'test'], cwd: w.checkout, timeoutMs: 180_000 }]);
        if (!out.started)
            throw new Error('the gate did not start');
        expect(out.record).toMatchObject({ name: 'local-gate', head: SHA, state: 'SUCCESS', exitCode: 0, argv: ['npm', 'test'] });
        expect(readLocalCheckRecord(w.stateDir, w.root, SHA)).toEqual(out.record);
        expect(localGateRecord(w.stateDir, w.root, SHA2)).toBeUndefined();
    });
    it('a failing or timed-out gate records FAILURE with the output tail', async () => {
        const w = world();
        const failed = await runLocalGate({ ...w, head: SHA, gate: ['node', '--test'], timeoutMinutes: 1, runner: async () => ({ status: 1, stdout: 'x'.repeat(LOCAL_GATE_TAIL_CHARS + 50), stderr: 'not ok 1', timedOut: false }) });
        if (!failed.started)
            throw new Error('the gate did not start');
        expect(failed.record.state).toBe('FAILURE');
        expect(failed.record.exitCode).toBe(1);
        expect(failed.record.tail.length).toBe(LOCAL_GATE_TAIL_CHARS);
        expect(failed.record.tail.endsWith('not ok 1')).toBe(true);
        const timedOut = await runLocalGate({ ...w, head: SHA2, gate: ['node', '--test'], timeoutMinutes: 1, runner: async () => ({ status: 1, stdout: '', stderr: '', timedOut: true }) });
        if (!timedOut.started)
            throw new Error('the gate did not start');
        expect(timedOut.record).toMatchObject({ state: 'FAILURE', exitCode: 124 });
        expect(timedOut.record.tail).toContain('timed out after 1 min');
    });
    it('a gate that cannot start records nothing (no FAILURE) and names the executable', async () => {
        const w = world();
        const out = await runLocalGate({ ...w, head: SHA, gate: ['npm', 'test'], timeoutMinutes: 1, runner: async () => ({ status: 127, stdout: '', stderr: '', timedOut: false, startError: 'the local gate executable npm is not on PATH' }) });
        expect(out).toEqual({ started: false, reason: 'the local gate executable npm is not on PATH' });
        expect(localGateRecord(w.stateDir, w.root, SHA)).toBeUndefined();
    });
    it('the default runner reports a missing executable as not started, never as a failed gate', async () => {
        const w = world();
        mkdirSync(w.checkout, { recursive: true });
        const r = await defaultLocalGateRunner(['omg-no-such-gate-exe-4711', 'test'], w.checkout, 10_000);
        expect(r.startError).toMatch(/omg-no-such-gate-exe-4711/);
        const out = await runLocalGate({ ...w, head: SHA, gate: ['omg-no-such-gate-exe-4711'], timeoutMinutes: 1 });
        expect(out.started).toBe(false);
        expect(localGateRecord(w.stateDir, w.root, SHA)).toBeUndefined();
    });
    it('the default runner runs node without a shell and returns its exit status and output', async () => {
        const w = world();
        mkdirSync(w.checkout, { recursive: true });
        const r = await defaultLocalGateRunner([process.execPath, '-e', 'console.log("gate-out"); process.exit(3)'], w.checkout, 30_000);
        expect(r).toMatchObject({ status: 3, timedOut: false });
        expect(r.startError).toBeUndefined();
        expect(r.stdout).toContain('gate-out');
    });
    it('the timeout kills the whole tree: a grandchild that sleeps is gone, and the verdict does not wait for it', async () => {
        const w = world();
        mkdirSync(w.checkout, { recursive: true });
        const pidFile = join(w.checkout, 'grandchild.pid');
        // The child starts a grandchild sharing its stdout (as a test runner's workers do), then both sleep.
        writeFileSync(join(w.checkout, 'grandchild.js'), 'setTimeout(() => {}, 120000);\n');
        writeFileSync(join(w.checkout, 'gate.js'), [
            "const { spawn } = require('child_process');",
            "const g = spawn(process.execPath, [require('path').join(__dirname, 'grandchild.js')], { stdio: ['ignore', 'inherit', 'inherit'] });",
            `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
            "console.log('started');",
            'setTimeout(() => {}, 120000);',
        ].join('\n'));
        const started = Date.now();
        const r = await defaultLocalGateRunner([process.execPath, join(w.checkout, 'gate.js')], w.checkout, 2_000);
        expect(r.timedOut).toBe(true);
        expect(r.status).toBe(124);
        expect(Date.now() - started).toBeLessThan(60_000);
        const grandchild = Number(readFileSync(pidFile, 'utf8'));
        const deadline = Date.now() + 10_000;
        while (isProcessAlive(grandchild) && Date.now() < deadline)
            await new Promise((res) => setTimeout(res, 100));
        expect(isProcessAlive(grandchild)).toBe(false);
    }, 90_000);
    it('a removed record (checks.rerun) reads as never run, so the engine runs the gate again', () => {
        const w = world();
        writeLocalCheckRecord(w.stateDir, w.root, { name: 'local-gate', head: SHA, state: 'FAILURE', argv: ['x'], runId: 5, startedAt: 'now' });
        expect(localGateRecord(w.stateDir, w.root, SHA)?.state).toBe('FAILURE');
        expect(localGateDue(w.stateDir, w.root, SHA, 20, new Date())).toBe(false);
        rmSync(join(w.stateDir), { recursive: true, force: true });
        expect(localGateRecord(w.stateDir, w.root, SHA)).toBeUndefined();
        expect(localGateDue(w.stateDir, w.root, SHA, 20, new Date())).toBe(true);
    });
    it('a PENDING record is due again once older than the gate timeout plus the grace (a crashed gate), not before', () => {
        const w = world();
        const startedAt = new Date('2026-11-07T10:00:00.000Z');
        writeLocalCheckRecord(w.stateDir, w.root, { name: 'local-gate', head: SHA, state: 'PENDING', argv: ['node', '--test'], runId: 5, startedAt: startedAt.toISOString() });
        const at = (ms) => new Date(startedAt.getTime() + ms);
        expect(localGateDue(w.stateDir, w.root, SHA, 20, at(60_000))).toBe(false);
        expect(localGateDue(w.stateDir, w.root, SHA, 20, at(20 * 60_000 + LOCAL_GATE_STALE_GRACE_MS))).toBe(false);
        expect(localGateDue(w.stateDir, w.root, SHA, 20, at(20 * 60_000 + LOCAL_GATE_STALE_GRACE_MS + 1))).toBe(true);
        // A finished record never goes stale.
        writeLocalCheckRecord(w.stateDir, w.root, { name: 'local-gate', head: SHA, state: 'SUCCESS', argv: ['node', '--test'], runId: 5, startedAt: startedAt.toISOString(), completedAt: startedAt.toISOString(), exitCode: 0 });
        expect(localGateDue(w.stateDir, w.root, SHA, 20, at(24 * 3600_000))).toBe(false);
    });
    it('assertLocalGateCommand: the run\'s recorded gate must still be configured, in the real engine checkout', () => {
        const w = world();
        mkdirSync(w.checkout, { recursive: true });
        expect(() => assertLocalGateCommand(['npm', 'test'], ['npm', 'test'], w.checkout, w.checkout)).not.toThrow();
        // The trusted config changed the gate after this run recorded it.
        expect(() => assertLocalGateCommand(['npm', 'test'], ['npm', 'run', 'lint'], w.checkout, w.checkout)).toThrow(/this run recorded `npm test`/);
        expect(() => assertLocalGateCommand(['npm', 'test', '--', 'x'], ['npm', 'test'], w.checkout, w.checkout)).toThrow(FactorySafetyError);
        expect(() => assertLocalGateCommand(['npm', 'test'], ['npm', 'test'], w.root, w.checkout)).toThrow(/only in the engine's prepare checkout/);
        expect(() => assertLocalGateCommand(['npm', 'test'], undefined, w.checkout, w.checkout)).toThrow(/not set in a trusted config layer/);
    });
    it('assertLocalGateCommand refuses a checkout path that is a link to another directory', () => {
        const w = world();
        mkdirSync(w.root, { recursive: true });
        // A junction (Windows, no admin needed) or symlink at the checkout path pointing at the user's checkout.
        symlinkSync(w.root, w.checkout, process.platform === 'win32' ? 'junction' : 'dir');
        expect(existsSync(w.checkout)).toBe(true);
        expect(() => assertLocalGateCommand(['npm', 'test'], ['npm', 'test'], w.checkout, w.checkout)).toThrow(/really/);
        expect(() => assertLocalGateCommand(['npm', 'test'], ['npm', 'test'], w.checkout, w.checkout)).toThrow(/is a junction or symlink/);
    });
    it('assertLocalGateCommand allows the real checkout of a root reached through a junction or symlink', () => {
        world();
        const realRoot = join(dir, 'real-root');
        mkdirSync(join(realRoot, 'checkout'), { recursive: true });
        const linkedRoot = join(dir, 'linked-root');
        symlinkSync(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
        const checkout = join(linkedRoot, 'checkout');
        // The engine names its checkout under the linked root on both sides: the gate runs.
        expect(() => assertLocalGateCommand(['npm', 'test'], ['npm', 'test'], checkout, checkout)).not.toThrow();
        expect(() => assertLocalGateCommand(['npm', 'test'], ['npm', 'test'], join(realRoot, 'checkout'), checkout)).not.toThrow();
        // Another directory under the same linked root is still refused.
        mkdirSync(join(realRoot, 'other'));
        expect(() => assertLocalGateCommand(['npm', 'test'], ['npm', 'test'], join(linkedRoot, 'other'), checkout)).toThrow(/only in the engine's prepare checkout/);
    });
    it('a root that exits while a grandchild holds its output settles with the real exit status after a short drain', async () => {
        const w = world();
        mkdirSync(w.checkout, { recursive: true });
        const pidFile = join(w.checkout, 'grandchild.pid');
        writeFileSync(join(w.checkout, 'grandchild.js'), 'setTimeout(() => {}, 120000);\n');
        writeFileSync(join(w.checkout, 'gate.js'), [
            "const { spawn } = require('child_process');",
            "const g = spawn(process.execPath, [require('path').join(__dirname, 'grandchild.js')], { stdio: ['ignore', 'inherit', 'inherit'] });",
            `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
            "console.log('done');",
            'process.exit(0);',
        ].join('\n'));
        const started = Date.now();
        try {
            const r = await defaultLocalGateRunner([process.execPath, join(w.checkout, 'gate.js')], w.checkout, 60_000);
            expect(r).toMatchObject({ status: 0, timedOut: false });
            expect(r.stdout).toContain('done');
            expect(Date.now() - started).toBeLessThan(30_000);
        }
        finally {
            // POSIX killed the group; on Windows the orphan is ours to stop.
            try {
                process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
            }
            catch { /* gone */ }
        }
    }, 90_000);
});
describe('resolveLocalGateArgv', () => {
    const NODE = 'C:\\Program Files\\nodejs\\node.exe';
    const NPM_CLI = win32.join(win32.dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const NPX_CLI = win32.join(win32.dirname(NODE), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    const PNPM_JS = win32.join(win32.dirname(NODE), 'node_modules', 'corepack', 'dist', 'pnpm.js');
    const win = (files, path = 'C:\\Program Files\\nodejs') => ({
        cwd: 'C:\\checkout', platform: 'win32', env: { PATH: path, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, execPath: NODE,
        exists: (p) => files.includes(p),
    });
    it('on Windows runs npm and npx as node with npm\'s own CLI script, never npm.cmd', () => {
        const files = [NPM_CLI, NPX_CLI, win32.join('C:\\Program Files\\nodejs', 'npm.cmd')];
        expect(resolveLocalGateArgv(['npm', 'test'], win(files))).toEqual({ exe: NODE, args: [NPM_CLI, 'test'] });
        expect(resolveLocalGateArgv(['npx', 'vitest', 'run'], win(files))).toEqual({ exe: NODE, args: [NPX_CLI, 'vitest', 'run'] });
        expect(resolveLocalGateArgv(['npm.cmd', 'test'], win(files))).toEqual({ exe: NODE, args: [NPM_CLI, 'test'] });
    });
    it('on Windows runs pnpm/yarn from a real .exe on PATH, else corepack\'s script beside node', () => {
        const exe = win32.join('C:\\tools', 'pnpm.EXE');
        expect(resolveLocalGateArgv(['pnpm', 'test'], win([exe], 'C:\\tools'))).toEqual({ exe, args: ['test'] });
        expect(resolveLocalGateArgv(['pnpm', 'test'], win([PNPM_JS, win32.join('C:\\Program Files\\nodejs', 'pnpm.cmd')]))).toEqual({ exe: NODE, args: [PNPM_JS, 'test'] });
    });
    it('on Windows a missing npm script, a .cmd gate or a .cmd-only tool is not started, with a node-argv hint', () => {
        const missing = resolveLocalGateArgv(['npm', 'test'], win([win32.join('C:\\Program Files\\nodejs', 'npm.cmd')]));
        expect('missing' in missing && missing.missing).toMatch(/npm\.cmd is never run.*npm-cli\.js/);
        const cmd = resolveLocalGateArgv(['run-tests.cmd'], win([]));
        expect('missing' in cmd && cmd.missing).toMatch(/cmd\.exe script/);
        const shimOnly = resolveLocalGateArgv(['vitest', 'run'], win([win32.join('C:\\Program Files\\nodejs', 'vitest.cmd')]));
        expect('missing' in shimOnly && shimOnly.missing).toMatch(/not on PATH as an \.exe/);
    });
    it('off Windows a bare name must be on PATH and a path must exist; nothing is rewritten', () => {
        const onLinux = (files) => ({ cwd: '/work/checkout', platform: 'linux', env: { PATH: '/usr/bin' }, execPath: '/usr/bin/node', exists: (p) => files.includes(p) });
        expect(resolveLocalGateArgv(['npm', 'test'], onLinux(['/usr/bin/npm']))).toEqual({ exe: 'npm', args: ['test'] });
        expect('missing' in resolveLocalGateArgv(['npm', 'test'], onLinux([]))).toBe(true);
        expect(resolveLocalGateArgv(['./run.sh'], onLinux([posix.resolve('/work/checkout', 'run.sh')]))).toEqual({ exe: './run.sh', args: [] });
        expect('missing' in resolveLocalGateArgv(['./run.sh'], onLinux([]))).toBe(true);
    });
});
describe('the sealed run remote', () => {
    const at = '2026-11-07T00:00:00.000Z';
    const parse = (s) => () => parseFactoryState('state.json', 7, JSON.stringify(s));
    it('is absent (origin) on GitHub and ADO runs, so older states parse unchanged', () => {
        const s = createFactoryState({ issue: 7, repoUrl: '', base: 'dev' }, at);
        expect('remote' in s).toBe(false);
        expect(runRemote(s)).toBe('origin');
        expect(parse({ ...s, forgeKind: 'azure-devops' })).not.toThrow();
    });
    it('is omg-local exactly on a local run; any other pairing is malformed', () => {
        const s = { ...createFactoryState({ issue: 7, repoUrl: '', base: 'main', remote: 'omg-local' }, at), forgeKind: 'local' };
        expect(runRemote(s)).toBe('omg-local');
        expect(parse(s)).not.toThrow();
        expect(parse({ ...s, remote: undefined })).toThrow(/field remote/);
        expect(parse({ ...s, forgeKind: 'github' })).toThrow(/field remote/);
        expect(parse({ ...s, remote: 'origin' })).toThrow(/field remote/);
    });
    it('the recorded local gate is a non-empty argv on a local run only', () => {
        const s = { ...createFactoryState({ issue: 7, repoUrl: '', base: 'main', remote: 'omg-local' }, at), forgeKind: 'local' };
        expect(parse({ ...s, localGate: ['npm', 'test'] })).not.toThrow();
        expect(parse({ ...s, localGate: [] })).toThrow(/field localGate/);
        expect(parse({ ...s, localGate: ['npm', 3] })).toThrow(/field localGate/);
        const gh = createFactoryState({ issue: 7, repoUrl: '', base: 'dev' }, at);
        expect(parse({ ...gh, localGate: ['npm', 'test'] })).toThrow(/field localGate/);
    });
});
//# sourceMappingURL=local-forge-units.test.js.map