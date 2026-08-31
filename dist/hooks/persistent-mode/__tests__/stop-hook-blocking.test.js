import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeModeState } from '../../../lib/mode-state-io.js';
import { checkPersistentModes } from '../index.js';
async function initRepo() {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-stop-hook-'));
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '--initial-branch=main'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd, stdio: 'ignore' });
    await writeFile(join(cwd, 'README.md'), '# test\n');
    execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
    return cwd;
}
describe('checkPersistentModes - autoresearch stop-hook blocking', () => {
    let repo;
    beforeEach(async () => {
        repo = await initRepo();
    });
    afterEach(async () => {
        await rm(repo, { recursive: true, force: true });
    });
    it('blocks stop hook when autoresearch is active with future deadline', async () => {
        const deadlineAt = new Date(Date.now() + 60_000).toISOString();
        writeModeState('autoresearch', {
            active: true,
            current_phase: 'running',
            mission_slug: 'test-mission',
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deadline_at: deadlineAt,
        }, repo);
        const result = await checkPersistentModes(undefined, repo);
        expect(result.shouldBlock).toBe(true);
        expect(result.mode).toBe('autoresearch');
        expect(result.message).toContain('AUTORESEARCH - STATEFUL MISSION ACTIVE');
        expect(result.message).toContain('test-mission');
    });
    it('does not block when autoresearch deadline has passed', async () => {
        const deadlineAt = new Date(Date.now() - 1000).toISOString();
        writeModeState('autoresearch', {
            active: true,
            current_phase: 'running',
            mission_slug: 'test-mission',
            started_at: new Date(Date.now() - 120_000).toISOString(),
            updated_at: new Date().toISOString(),
            deadline_at: deadlineAt,
        }, repo);
        const result = await checkPersistentModes(undefined, repo);
        expect(result.shouldBlock).toBe(false);
        expect(result.mode).toBe('autoresearch');
    });
    it('does not block when autoresearch is inactive', async () => {
        writeModeState('autoresearch', {
            active: false,
            current_phase: 'stopped',
        }, repo);
        const result = await checkPersistentModes(undefined, repo);
        expect(result.mode).toBe('none');
    });
    it('reads legacy shared state when session-scoped state is absent', async () => {
        const deadlineAt = new Date(Date.now() + 60_000).toISOString();
        // Write without session id (legacy path)
        writeModeState('autoresearch', {
            active: true,
            current_phase: 'running',
            mission_slug: 'legacy-mission',
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deadline_at: deadlineAt,
        }, repo);
        const result = await checkPersistentModes('some-session', repo);
        expect(result.shouldBlock).toBe(true);
        expect(result.mode).toBe('autoresearch');
    });
});
//# sourceMappingURL=stop-hook-blocking.test.js.map