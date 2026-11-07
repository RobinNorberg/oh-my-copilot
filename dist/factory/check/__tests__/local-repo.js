/**
 * A real git repository with no origin for the local (offline) forge tests of
 * setup, check, board and enqueue: the backlog is real files, git runs for
 * real, and every spawn is recorded so a test can assert no gh, az or
 * copilot ran. OMC_HOME is pointed at a temp dir, so the forge stateDir and
 * the mirror path never touch the real ~/.omg.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';
import { createForge } from '../../../forge/index.js';
import { defaultExec } from '../../../ship/exec.js';
const run = (root, ...args) => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
};
/** `git init -b main` with one commit; no origin. */
export function localRepo() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-local-surface-')));
    const home = mkdtempSync(join(tmpdir(), 'omg-local-home-'));
    vi.stubEnv('OMC_HOME', home);
    run(root, 'init', '-q', '-b', 'main');
    run(root, 'config', 'user.email', 'test@example.com');
    run(root, 'config', 'user.name', 'test');
    run(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'README.md'), '# r\n');
    run(root, 'add', '-A');
    run(root, 'commit', '-q', '-m', 'init');
    const calls = [];
    // check/board read the toplevel from process.cwd(): answer it for this repository.
    const exec = (cmd, args, opts) => {
        calls.push({ cmd, args: [...args] });
        const cwd = args.length === 2 && args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? root : opts?.cwd;
        return defaultExec(cmd, args, { ...opts, ...(cwd ? { cwd } : {}) });
    };
    return { root, home, calls, exec, out: [], err: [] };
}
export function writeFile(repo, path, text) {
    const file = join(repo.root, ...path.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
}
export function commitAll(repo, message = 'change') {
    run(repo.root, 'add', '-A');
    run(repo.root, 'commit', '-q', '-m', message);
}
/** The project config of a local-forge repository (what `setup --forge local` writes). */
export const LOCAL_PROJECT_CONFIG = { factory: { forge: { kind: 'local' }, intake: { source: { type: 'local-backlog' } } } };
export function backlogItem(title, state = 'open', extra = '') {
    return `---\ntitle: ${JSON.stringify(title)}\nstate: ${state}\n---\n${extra}Do it.\n\n## Acceptance\n- [ ] \`npm test\` passes\n`;
}
export function checkDeps(repo, project = LOCAL_PROJECT_CONFIG) {
    return {
        exec: repo.exec,
        base: () => 'main',
        trustedUser: () => ({ ship: { trustedBases: ['main'] } }),
        projectConfig: () => project,
        createForge,
        isTTY: () => false,
        confirm: async () => false,
        out: (line) => repo.out.push(line),
        err: (line) => repo.err.push(line),
    };
}
/** Every spawned program, by base name: the offline surfaces run git only. */
export function programs(repo) {
    return [...new Set(repo.calls.map((c) => c.cmd.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '')))];
}
/** Delete a working-tree file (it stays in the last commit). */
export function removeFile(repo, path) {
    rmSync(join(repo.root, ...path.split('/')));
}
//# sourceMappingURL=local-repo.js.map