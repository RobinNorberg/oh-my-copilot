/**
 * Leader-nudge staleness for SDK teams (F2, F3, F5): an idle SDK session
 * counts as idle, an unanswered worker message to the leader asks for an
 * answer, and a capped task asks for a reassign or a raised cap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkLeaderStaleness } from '../../hooks/team-leader-nudge-hook.js';
const TEAM = 'demo-team';
const WORKER = 'worker-1';
function writeJsonSync(path, value) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}
function seedSdkTeam(cwd, options) {
    const stateDir = join(cwd, '.omg', 'state');
    const teamDir = join(stateDir, 'team', TEAM);
    const nowIso = new Date().toISOString();
    writeJsonSync(join(teamDir, 'config.json'), { workers: [{ name: WORKER }], leader_pane_id: '' });
    // The SDK worker's own status file still says "working": only the host
    // session knows it went idle.
    writeJsonSync(join(teamDir, 'workers', WORKER, 'status.json'), { state: 'working', updated_at: nowIso });
    writeJsonSync(join(teamDir, 'workers', WORKER, 'heartbeat.json'), { alive: true, last_turn_at: nowIso });
    writeJsonSync(join(teamDir, 'workers', WORKER, 'sdk-session.json'), { state: options.sdkState, queued: options.queued ?? 0 });
    writeJsonSync(join(teamDir, 'tasks', 'task-1.json'), { status: options.taskStatus });
    if (options.leaderMessage) {
        writeJsonSync(join(teamDir, 'mailbox', 'leader-fixed.json'), {
            worker: 'leader-fixed',
            messages: [{ message_id: 'm1', from_worker: WORKER, to_worker: 'leader-fixed', body: 'BLOCKER', created_at: nowIso }],
        });
    }
    return stateDir;
}
describe('team leader nudge: sdk idle, blockers and capped tasks', () => {
    let cwd;
    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), 'omc-leader-nudge-sdk-'));
    });
    afterEach(() => {
        rmSync(cwd, { recursive: true, force: true });
    });
    it('counts an idle sdk session with nothing queued as idle', async () => {
        const stateDir = seedSdkTeam(cwd, { sdkState: 'idle', taskStatus: 'pending' });
        const staleness = await checkLeaderStaleness({ stateDir, teamName: TEAM, nowMs: Date.now() });
        expect(staleness.idleWorkerCount).toBe(1);
        expect(staleness.reason).toBe('all_workers_idle_with_active_tasks:idle=1,active=1');
    });
    it('does not count an sdk session with queued prompts as idle', async () => {
        const stateDir = seedSdkTeam(cwd, { sdkState: 'idle', queued: 1, taskStatus: 'pending' });
        const staleness = await checkLeaderStaleness({ stateDir, teamName: TEAM, nowMs: Date.now() });
        expect(staleness.idleWorkerCount).toBe(0);
    });
    it('is stale with leader_inbox_unread while a worker waits on the leader', async () => {
        const stateDir = seedSdkTeam(cwd, { sdkState: 'busy', taskStatus: 'in_progress', leaderMessage: true });
        const staleness = await checkLeaderStaleness({ stateDir, teamName: TEAM, nowMs: Date.now() });
        expect(staleness.stale).toBe(true);
        expect(staleness.leaderInboxUnread).toBe(1);
        expect(staleness.reason).toBe('leader_inbox_unread:unread=1,active=1');
    });
    it('is stale with tasks_capped when a capped task waits for a leader decision', async () => {
        const stateDir = seedSdkTeam(cwd, { sdkState: 'capped', taskStatus: 'capped' });
        const staleness = await checkLeaderStaleness({ stateDir, teamName: TEAM, nowMs: Date.now() });
        expect(staleness.cappedTaskCount).toBe(1);
        expect(staleness.stale).toBe(true);
        expect(staleness.reason).toBe('tasks_capped:capped=1,active=0');
    });
});
//# sourceMappingURL=team-leader-nudge-sdk-blocker.test.js.map