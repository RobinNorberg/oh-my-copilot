import { describe, expect, it } from 'vitest';
import { deriveTeamLeaderGuidance } from '../leader-nudge-guidance.js';
describe('deriveTeamLeaderGuidance', () => {
    it('returns shutdown when all tasks are terminal', () => {
        const guidance = deriveTeamLeaderGuidance({
            tasks: { pending: 0, blocked: 0, inProgress: 0, completed: 3, failed: 0 },
            workers: { total: 2, alive: 2, idle: 2, nonReporting: 0 },
        });
        expect(guidance.nextAction).toBe('shutdown');
        expect(guidance.reason).toContain('all_tasks_terminal');
    });
    it('returns reuse-current-team when alive workers are idle but active tasks remain', () => {
        const guidance = deriveTeamLeaderGuidance({
            tasks: { pending: 2, blocked: 0, inProgress: 0, completed: 0, failed: 0 },
            workers: { total: 2, alive: 2, idle: 2, nonReporting: 0 },
        });
        expect(guidance.nextAction).toBe('reuse-current-team');
        expect(guidance.reason).toContain('all_alive_workers_idle');
    });
    it('returns launch-new-team when no workers are alive', () => {
        const guidance = deriveTeamLeaderGuidance({
            tasks: { pending: 1, blocked: 0, inProgress: 1, completed: 0, failed: 0 },
            workers: { total: 2, alive: 0, idle: 0, nonReporting: 0 },
        });
        expect(guidance.nextAction).toBe('launch-new-team');
        expect(guidance.reason).toContain('no_alive_workers');
    });
    it('returns keep-checking-status when workers are still active', () => {
        const guidance = deriveTeamLeaderGuidance({
            tasks: { pending: 0, blocked: 0, inProgress: 2, completed: 0, failed: 0 },
            workers: { total: 2, alive: 2, idle: 0, nonReporting: 1 },
        });
        expect(guidance.nextAction).toBe('keep-checking-status');
        expect(guidance.reason).toContain('workers_still_active');
    });
    it('returns answer-blocker over every relaunch advice while a worker waits on the leader', () => {
        const guidance = deriveTeamLeaderGuidance({
            tasks: { pending: 0, blocked: 0, inProgress: 1, completed: 0, failed: 0 },
            workers: { total: 1, alive: 1, idle: 0, nonReporting: 1 },
            leaderInbox: { unread: 2 },
        });
        expect(guidance.nextAction).toBe('answer-blocker');
        expect(guidance.reason).toBe('leader_inbox_unread:unread=2,active=1');
        expect(guidance.message).toContain('omg team api send-message');
        expect(guidance.message).toContain('"from_worker":"leader-fixed"');
    });
    it('does not ask to answer a blocker once nothing is active', () => {
        const guidance = deriveTeamLeaderGuidance({
            tasks: { pending: 0, blocked: 0, inProgress: 0, completed: 1, failed: 0 },
            workers: { total: 1, alive: 1, idle: 1, nonReporting: 0 },
            leaderInbox: { unread: 1 },
        });
        expect(guidance.nextAction).toBe('shutdown');
    });
    it('returns reassign-capped when a task is capped, offering reassign or a raised cap', () => {
        const guidance = deriveTeamLeaderGuidance({
            tasks: { pending: 0, blocked: 0, inProgress: 0, completed: 1, failed: 0, capped: 1 },
            workers: { total: 2, alive: 1, idle: 1, nonReporting: 0 },
        });
        expect(guidance.nextAction).toBe('reassign-capped');
        expect(guidance.reason).toBe('tasks_capped:capped=1,active=0');
        expect(guidance.message).toContain('Reassign');
        expect(guidance.message).toContain('team.sdk.maxCreditsPerWorker');
    });
    it('ranks answer-blocker above reassign-capped', () => {
        const guidance = deriveTeamLeaderGuidance({
            tasks: { pending: 1, blocked: 0, inProgress: 0, completed: 0, failed: 0, capped: 1 },
            workers: { total: 2, alive: 1, idle: 1, nonReporting: 0 },
            leaderInbox: { unread: 1 },
        });
        expect(guidance.nextAction).toBe('answer-blocker');
    });
    it('returns shutdown when every task is terminal including failed ones', () => {
        const guidance = deriveTeamLeaderGuidance({
            tasks: { pending: 0, blocked: 0, inProgress: 0, completed: 2, failed: 1, capped: 0 },
            workers: { total: 2, alive: 2, idle: 2, nonReporting: 0 },
        });
        expect(guidance.nextAction).toBe('shutdown');
        expect(guidance.reason).toBe('all_tasks_terminal:completed=2,failed=1,workers=2');
    });
});
//# sourceMappingURL=leader-nudge-guidance.test.js.map