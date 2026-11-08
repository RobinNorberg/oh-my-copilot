/**
 * F29 (dogfood round 2): `omg factory run --next` on the local (offline)
 * forge builds its forge like check does (runtime root, working tree, the
 * local base) and never fetches. A real repository with no origin.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryRunCommand } from '../factory.js';
import { resolveFactoryRunLimits } from '../../../factory/run/budget.js';
import { readFactoryState } from '../../../factory/run/state.js';
import { resolveForgeConfig } from '../../../forge/config.js';
import { getGlobalOmcStatePath } from '../../../utils/paths.js';
import { backlogItem, commitAll, localRepo, LOCAL_PROJECT_CONFIG, programs, writeFile } from '../../../factory/check/__tests__/local-repo.js';
let repo;
let ledger;
let out;
beforeEach(() => {
    repo = localRepo();
    ledger = mkdtempSync(join(tmpdir(), 'omg-next-ledger-'));
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { out.push(a.join(' ')); });
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(repo.home, { recursive: true, force: true });
    rmSync(ledger, { recursive: true, force: true });
});
function deps(base = 'main') {
    return {
        exec: repo.exec,
        lanes: () => { throw new Error('run --next --dry-run starts no lanes'); },
        limits: () => resolveFactoryRunLimits(undefined, undefined),
        base: () => base,
        ledgerDir: ledger,
        forge: (root) => resolveForgeConfig(undefined, undefined, LOCAL_PROJECT_CONFIG, undefined, { root, stateDir: getGlobalOmcStatePath('forge') }),
    };
}
async function cli(d, ...argv) {
    process.exitCode = undefined;
    await factoryRunCommand(d).parseAsync(argv, { from: 'user' });
    const code = Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return code;
}
describe('omg factory run --next on the local forge (F29)', () => {
    it('nothing runnable exits 0 (text and JSON); a closed and an uncommitted item are never picked', async () => {
        writeFile(repo, '.copilot/backlog/1-done.md', backlogItem('done', 'closed'));
        commitAll(repo);
        writeFile(repo, '.copilot/backlog/2-draft.md', backlogItem('draft'));
        expect(await cli(deps(), '--next', '--dry-run'), out.join('\n')).toBe(0);
        // --next reads committed items only: the closed #1 is not intake, the uncommitted #2 is not read at all.
        expect(out.join('\n')).toMatch(/nothing runnable \(0 runnable, 0 needs-plan, 0 blocked\)/);
        expect(out.join('\n')).not.toMatch(/omgRoot/);
        out = [];
        expect(await cli(deps(), '--next', '--json'), out.join('\n')).toBe(0);
        expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: true, next: null, message: 'nothing runnable' });
        // Offline: git only, and never a fetch.
        expect(programs(repo)).toEqual(['git']);
        expect(repo.calls.some((c) => c.args.includes('fetch'))).toBe(false);
    });
    it('picks the one runnable committed item (--dry-run: no state, no lanes)', async () => {
        writeFile(repo, '.copilot/backlog/3-version-flag.md', backlogItem('add a --version flag'));
        writeFile(repo, '.copilot/backlog/4-later.md', backlogItem('later', 'closed'));
        commitAll(repo);
        expect(await cli(deps(), '--next', '--dry-run', '--json'), out.join('\n')).toBe(0);
        const result = JSON.parse(out.join('\n'));
        expect(result).toMatchObject({ next: 3, plan: { next: 'implement' } });
        expect(readFactoryState(repo.root, 3)).toBeNull();
        expect(repo.calls.some((c) => c.args.includes('fetch'))).toBe(false);
    });
    it('reads committed items only: a dependency closed only in the working tree leaves its dependent blocked', async () => {
        writeFile(repo, '.copilot/backlog/4-flags.md', backlogItem('CLI flags'));
        writeFile(repo, '.copilot/backlog/5-parser.md', backlogItem('a flag parser'));
        writeFile(repo, '.copilot/backlog/6-version-flag.md', backlogItem('add a --version flag', 'open', 'Part of #4\nDepends on #5\n\n'));
        commitAll(repo);
        // #5 closed on disk, not committed: --parent 4 has nothing runnable.
        writeFile(repo, '.copilot/backlog/5-parser.md', backlogItem('a flag parser', 'closed'));
        expect(await cli(deps(), '--next', '--parent', '4', '--dry-run', '--json'), out.join('\n')).toBe(0);
        expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: true, next: null });
        // Committed on main, the dependency is met.
        commitAll(repo);
        out = [];
        expect(await cli(deps(), '--next', '--parent', '4', '--dry-run', '--json'), out.join('\n')).toBe(0);
        expect(JSON.parse(out.join('\n'))).toMatchObject({ next: 6 });
    });
    it('a missing base exits 2 naming ship.base', async () => {
        expect(await cli(deps('dev'), '--next', '--dry-run'), out.join('\n')).toBe(2);
        expect(out.join('\n')).toMatch(/the base branch dev does not exist.*set ship\.base/);
    });
});
//# sourceMappingURL=factory-run-next-local.test.js.map