import { resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backlogItem, checkDeps, commitAll, localRepo, programs, writeFile } from '../check/__tests__/local-repo.js';
import { factoryPollCommand } from '../../cli/commands/factory-poll.js';
import { runFactoryPoll } from '../poll.js';
import { FactoryForgeUnavailableError } from '../run/forge-roots.js';
afterEach(() => {
    vi.unstubAllEnvs();
});
function deps(repo, localBaseSync) {
    return {
        ...checkDeps(repo),
        healScan: () => { throw new Error('the local forge has no heal'); },
        autoStart: async () => { throw new Error('no auto-start expected'); },
        onStop: () => () => undefined,
        ...(localBaseSync ? { localBaseSync } : {}),
    };
}
async function tick(repo, d) {
    repo.out.length = 0;
    const code = await runFactoryPoll({ once: true, json: true }, d);
    return { code, t: JSON.parse(repo.out[repo.out.length - 1]) };
}
describe('omg factory poll on the local (offline) forge', () => {
    it('reads the backlog with no origin, skips heal, and runs the wired base sync once per tick', async () => {
        const repo = localRepo();
        writeFile(repo, '.copilot/backlog/1-add-remove.md', backlogItem('Add remove'));
        commitAll(repo);
        const sync = vi.fn((o) => `${o.base} synced (${o.config.kind})`);
        const { code, t } = await tick(repo, deps(repo, sync));
        expect(code).toBe(0);
        expect(t.forge).toBe('local');
        expect(t.heal).toEqual({ ran: false, reason: 'the forge has no heal capability' });
        expect(t.intake).toMatchObject({ ran: true, items: 1, new: [{ id: 1, bucket: 'runnable' }] });
        expect(t.baseSync).toEqual({ ran: true, message: 'main synced (local)' });
        expect(sync).toHaveBeenCalledTimes(1);
        expect(resolve(sync.mock.calls[0][0].root)).toBe(resolve(repo.root));
        expect(sync.mock.calls[0][0].base).toBe('main');
        expect(programs(repo)).toEqual(['git']);
    });
    it('reports the sync as not run when nothing is wired, and a refused sync as an error', async () => {
        const repo = localRepo();
        writeFile(repo, '.copilot/backlog/1-add-remove.md', backlogItem('Add remove'));
        commitAll(repo);
        const unwired = await tick(repo, deps(repo));
        expect(unwired.t.baseSync).toEqual({ ran: false, reason: 'no base sync wired; omg factory run syncs the mirror base' });
        const refused = await tick(repo, deps(repo, () => { throw new Error('main diverged from the mirror'); }));
        expect(refused.code).toBe(1);
        expect(refused.t.baseSync).toEqual({ ran: false, reason: 'the base sync failed' });
        expect(refused.t.errors).toContain('base sync: main diverged from the mirror');
    });
    it('an unusable local forge (a refused git config) is not a tick error: omg factory poll exits 5 like omg factory run', async () => {
        const repo = localRepo();
        writeFile(repo, '.copilot/backlog/1-add-remove.md', backlogItem('Add remove'));
        commitAll(repo);
        const unusable = () => { throw new FactoryForgeUnavailableError('refusing the local forge: the git config sets url./evil.insteadof=/mirror'); };
        await expect(runFactoryPoll({ once: true, json: true }, deps(repo, unusable))).rejects.toBeInstanceOf(FactoryForgeUnavailableError);
        repo.out.length = 0;
        const before = process.exitCode;
        try {
            await factoryPollCommand(deps(repo, unusable)).parseAsync(['--once', '--json'], { from: 'user' });
            expect(process.exitCode).toBe(5);
            expect(JSON.parse(repo.out[repo.out.length - 1])).toMatchObject({ ok: false, error: expect.stringContaining('refusing the local forge') });
        }
        finally {
            process.exitCode = before;
        }
    });
});
//# sourceMappingURL=poll-local.test.js.map