import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueInboxInstruction, sendTmuxTrigger } from '../tmux-comm.js';
import { sendToWorker } from '../tmux-session.js';
vi.mock('../tmux-session.js', () => ({
    sendToWorker: vi.fn(),
}));
describe('sendTmuxTrigger', () => {
    it('delegates to sendToWorker robust path', async () => {
        vi.mocked(sendToWorker).mockResolvedValueOnce(true);
        const result = await sendTmuxTrigger('%1', 'check-inbox');
        expect(result).toBe(true);
        expect(sendToWorker).toHaveBeenCalledWith('', '%1', 'check-inbox');
    });
    it('returns false on tmux error (does not throw)', async () => {
        vi.mocked(sendToWorker).mockRejectedValueOnce(new Error('tmux not found'));
        const result = await sendTmuxTrigger('%99', 'check-inbox');
        expect(result).toBe(false);
    });
    it('rejects messages over 200 chars (security: no silent truncation)', async () => {
        vi.mocked(sendToWorker).mockClear();
        const longMsg = 'a'.repeat(300);
        const result = await sendTmuxTrigger('%1', longMsg);
        expect(result).toBe(false);
        expect(sendToWorker).not.toHaveBeenCalled();
    });
});
describe('queueInboxInstruction', () => {
    it('writes the worker inbox under the canonical team root before notifying', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'omc-tmux-comm-'));
        const previousHome = process.env.HOME;
        const previousUserProfile = process.env.USERPROFILE;
        const previousStateDir = process.env.OMC_STATE_DIR;
        process.env.HOME = cwd;
        process.env.USERPROFILE = cwd;
        delete process.env.OMC_STATE_DIR;
        vi.mocked(sendToWorker).mockResolvedValue(true);
        try {
            await queueInboxInstruction('queue-team', 'worker-1', 'hello', '%1', cwd);
            const inbox = join(cwd, '.omc', 'state', 'team', 'queue-team', 'workers', 'worker-1', 'inbox.md');
            expect(readFileSync(inbox, 'utf8')).toContain('hello');
            expect(sendToWorker).toHaveBeenCalledWith('', '%1', 'check-inbox');
        }
        finally {
            if (previousHome === undefined)
                delete process.env.HOME;
            else
                process.env.HOME = previousHome;
            if (previousUserProfile === undefined)
                delete process.env.USERPROFILE;
            else
                process.env.USERPROFILE = previousUserProfile;
            if (previousStateDir === undefined)
                delete process.env.OMC_STATE_DIR;
            else
                process.env.OMC_STATE_DIR = previousStateDir;
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=tmux-comm.test.js.map