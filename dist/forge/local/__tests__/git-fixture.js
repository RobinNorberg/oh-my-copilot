/**
 * Test helper: a temp repository with a bare mirror under a temp stateDir,
 * and a real Exec that records every argv the adapter runs.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { resolveForgeConfig } from '../../config.js';
import { localMirrorPath, mirrorInitArgs, mirrorPushArgs, mirrorRemoteAddArgs } from '../mirror.js';
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
export function git(cwd, ...args) {
    const r = spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0)
        throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
}
export function recordingExec() {
    const calls = [];
    const exec = (cmd, args, opts = {}) => {
        calls.push({ cmd, args, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.env ? { env: opts.env } : {}) });
        const r = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: 'utf8' });
        return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    return { exec, calls };
}
export function makeFixture() {
    const tmp = mkdtempSync(join(tmpdir(), 'omg-local-forge-'));
    const root = join(tmp, 'repo');
    const stateDir = join(tmp, 'state');
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    const config = resolveForgeConfig({ factory: { forge: { kind: 'local' }, intake: { source: { type: 'local-backlog' } } } }, undefined, undefined, undefined, { root, stateDir }).config;
    const mirror = localMirrorPath(stateDir, root);
    const write = (path, text) => {
        const file = join(root, ...path.split('/'));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
    };
    const commit = (message) => {
        git(root, 'add', '-A');
        git(root, 'commit', '-q', '--allow-empty', '-m', message);
        return git(root, 'rev-parse', 'HEAD');
    };
    mkdirSync(dirname(mirror), { recursive: true });
    git(tmp, ...mirrorInitArgs(mirror));
    git(root, ...mirrorRemoteAddArgs(mirror));
    return {
        tmp, root, stateDir, omgRoot: join(root, '.omg'), mirror, config, write, commit,
        push: (sha, branch) => void git(root, ...mirrorPushArgs(sha, branch)),
        cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
}
//# sourceMappingURL=git-fixture.js.map