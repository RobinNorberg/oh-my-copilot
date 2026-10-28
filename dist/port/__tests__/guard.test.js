/**
 * The port guard against a real repository: a planted hook and filter run
 * under plain git (the control) and never under the guard; shapes the port
 * engine never builds are refused.
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { PortSafetyError, portGuardExec } from '../guard.js';
const roots = [];
const raw = (cmd, args, opts) => {
    const r = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8' });
    return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
};
const ID = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false'];
function repo() {
    const root = mkdtempSync(join(tmpdir(), 'port-guard-'));
    roots.push(root);
    const dir = join(root, 'repo');
    mkdirSync(dir);
    raw('git', ['init', '-q', dir]);
    for (const [k, v] of [['user.name', 'fixture'], ['user.email', 'fixture@example.invalid'], ['core.autocrlf', 'false']])
        raw('git', ['config', k, v], { cwd: dir });
    const hooks = join(root, 'empty-hooks');
    mkdirSync(hooks);
    return { dir, hooks, sentinel: join(root, 'EXECUTED').replace(/\\/g, '/') };
}
afterAll(() => {
    for (const root of roots)
        rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});
describe('portGuardExec', () => {
    it('never runs a planted post-commit hook (plain git does)', () => {
        const r = repo();
        writeFileSync(join(r.dir, '.git/hooks/post-commit'), `#!/bin/sh\necho ran > "${r.sentinel}"\n`, { mode: 0o755 });
        writeFileSync(join(r.dir, 'a.txt'), 'a\n');
        const guarded = portGuardExec(raw, r.hooks);
        expect(guarded('git', ['add', '--', 'a.txt'], { cwd: r.dir }).status).toBe(0);
        expect(guarded('git', ['commit', '--no-verify', '-q', '-m', 'one'], { cwd: r.dir }).status).toBe(0);
        expect(existsSync(r.sentinel)).toBe(false);
        raw('git', [...ID, 'commit', '-q', '--allow-empty', '-m', 'control'], { cwd: r.dir });
        expect(existsSync(r.sentinel)).toBe(true);
    });
    it('never runs a filter driver the config defines (plain git does)', () => {
        const r = repo();
        raw('git', ['config', 'filter.evil.clean', `sh -c 'echo ran > "${r.sentinel}"; cat'`], { cwd: r.dir });
        raw('git', ['config', 'filter.evil.required', 'true'], { cwd: r.dir });
        writeFileSync(join(r.dir, '.git/info/attributes'), '* filter=evil\n');
        writeFileSync(join(r.dir, 'a.txt'), 'a\n');
        const guarded = portGuardExec(raw, r.hooks);
        expect(guarded('git', ['add', '--', 'a.txt'], { cwd: r.dir }).status).toBe(0);
        expect(existsSync(r.sentinel)).toBe(false);
        writeFileSync(join(r.dir, 'b.txt'), 'b\n');
        raw('git', ['add', '--', 'b.txt'], { cwd: r.dir });
        expect(existsSync(r.sentinel)).toBe(true);
    });
    it('refuses shapes the port engine never builds, and a non-empty hooks dir', () => {
        const r = repo();
        const guarded = portGuardExec(raw, r.hooks);
        const refused = [
            ['push', '--force', 'origin', 'HEAD:refs/heads/port/upstream-012345678'],
            ['push', 'origin', 'HEAD:refs/heads/dev'],
            ['push', 'origin', '+HEAD:refs/heads/port/upstream-012345678'],
            ['reset', '--hard', 'HEAD'],
            ['stash'],
            ['worktree', 'remove', 'x'],
            ['checkout', 'dev'],
            ['commit', '--amend', '-m', 'x'],
            ['switch', '-c', 'dev'],
        ];
        for (const args of refused)
            expect(() => guarded('git', args, { cwd: r.dir }), args.join(' ')).toThrow(PortSafetyError);
        expect(() => guarded('gh', ['pr', 'merge', '7'], { cwd: r.dir })).toThrow(PortSafetyError);
        writeFileSync(join(r.hooks, 'pre-push'), 'x');
        expect(() => guarded('git', ['status'], { cwd: r.dir })).toThrow(/missing or not empty/);
    });
});
//# sourceMappingURL=guard.test.js.map