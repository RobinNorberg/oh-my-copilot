import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveAzEntry } from '../../../forge/ado/az-binary.js';
import { getOmcRoot } from '../../../lib/worktree-paths.js';
import { factoryForgeOptions } from '../forge-roots.js';
const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'omg-forge-roots-')));
// A real checkout, so its omg root is <repo>/.omg (outside a repository it falls back to the user's).
execFileSync('git', ['init', '-q', repo]);
afterAll(() => rmSync(repo, { recursive: true, force: true }));
describe('factoryForgeOptions', () => {
    it('names the repository, its omg root, the lane worktrees, the copilot_run job dirs and the team job root', () => {
        const omc = getOmcRoot(repo);
        const { untrustedRoots, stateDir } = factoryForgeOptions(repo, { OMC_JOBS_DIR: join(repo, 'jobs') });
        expect(untrustedRoots).toEqual([repo, omc, join(omc, 'team'), join(omc, 'state', 'copilot-run'), join(repo, 'jobs')]);
        expect(stateDir).toBeTruthy();
        expect(untrustedRoots.some((r) => stateDir.toLowerCase().startsWith(r.toLowerCase()))).toBe(false);
    });
    it('a PATH entry under a lane root is skipped when resolving az', () => {
        const { untrustedRoots } = factoryForgeOptions(repo, {});
        const lane = join(getOmcRoot(repo), 'team', 'factory-run', 'worktrees', 'issue-1');
        const trusted = join(tmpdir(), 'omg-forge-roots-trusted-cli');
        mkdirSync(lane, { recursive: true });
        const win = process.platform === 'win32';
        // On Windows: an MSI layout in both places; on POSIX: an `az` in both places.
        const layout = (root) => (win ? [join(root, 'wbin', 'az.cmd'), join(root, 'python.exe'), join(root, 'Lib', 'site-packages', 'azure', 'cli', '__main__.py')] : [join(root, 'bin', 'az')]);
        const files = new Set([...layout(lane), ...layout(trusted)].map((p) => p.toLowerCase()));
        const bin = (root) => join(root, win ? 'wbin' : 'bin');
        const deps = {
            platform: process.platform,
            env: { PATH: [bin(lane), bin(trusted)].join(win ? ';' : ':') },
            isFile: (p) => files.has(p.toLowerCase()),
            realpath: (p) => p,
            untrustedRoots,
        };
        const entry = resolveAzEntry(deps);
        expect(entry.command).toBe(win ? join(trusted, 'python.exe') : join(trusted, 'bin', 'az'));
        expect(() => resolveAzEntry({ ...deps, env: { PATH: bin(lane) } })).toThrow(/Azure CLI not found/);
    });
});
//# sourceMappingURL=forge-roots.test.js.map