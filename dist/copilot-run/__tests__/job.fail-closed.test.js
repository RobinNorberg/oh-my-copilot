/** A failed host git read must never read as "nothing there" (untracked files, leader status). */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const failing = vi.hoisted(() => ({ match: null }));
vi.mock('../../team/git-worktree.js', async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        runHostGit: (cwd, args, ...rest) => {
            if (failing.match?.(args))
                throw new Error('git failed (injected)');
            return real.runHostGit(cwd, args, ...rest);
        },
    };
});
import { CopilotRunManager, summarizeChanges } from '../job.js';
import { fakeDeps, gitIn, newCalls, scratchRepo } from './fake-sdk.js';
const plainUntracked = (args) => args.includes('ls-files') && args.includes('--others') && !args.includes('--ignored');
const leaderStatus = (args) => args.includes('status') && args.includes('--untracked-files=no');
let root;
let repo;
let calls;
beforeEach(() => {
    calls = newCalls();
    ({ root, repo } = scratchRepo('omg-copilot-run-failclosed-'));
});
afterEach(() => {
    failing.match = null;
    rmSync(root, { recursive: true, force: true });
});
describe('summarizeChanges fails closed', () => {
    it('returns null when the untracked-files read fails', () => {
        const base = gitIn(repo, 'rev-parse', 'HEAD');
        writeFileSync(join(repo, 'new.txt'), 'x\n');
        expect(summarizeChanges(repo, base)?.untrackedFiles).toEqual(['new.txt']);
        failing.match = plainUntracked;
        expect(summarizeChanges(repo, base)).toBeNull();
    });
    it('fails a worktree job with the existing summary error when the untracked read fails', async () => {
        const m = new CopilotRunManager(fakeDeps(root, 'idle', calls, { OMG_COPILOT_RUN_ALLOW: '1' }));
        const started = m.start({ prompt: 'x', cwd: repo });
        failing.match = plainUntracked;
        const done = await m.wait(started.jobId, 10_000);
        expect(done.status).toBe('failed');
        expect(done.error).toContain('the change summary could not be read');
    });
});
describe('leader dirty check fails closed', () => {
    it('notes possible uncommitted changes when git status fails', async () => {
        failing.match = leaderStatus;
        const m = new CopilotRunManager(fakeDeps(root, 'idle', calls, { OMG_COPILOT_RUN_ALLOW: '1' }));
        const started = m.start({ prompt: 'x', cwd: repo });
        failing.match = null;
        const done = await m.wait(started.jobId, 10_000);
        expect(done.notes).toEqual(expect.arrayContaining([expect.stringMatching(/git status failed in .*may have uncommitted changes/)]));
    });
    it('adds no note for a clean leader', async () => {
        const m = new CopilotRunManager(fakeDeps(root, 'idle', calls, { OMG_COPILOT_RUN_ALLOW: '1' }));
        const done = await m.wait(m.start({ prompt: 'x', cwd: repo }).jobId, 10_000);
        expect(done.notes ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining('uncommitted changes')]));
    });
});
//# sourceMappingURL=job.fail-closed.test.js.map