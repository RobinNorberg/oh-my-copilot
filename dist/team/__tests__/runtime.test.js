import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { monitorTeam } from '../runtime.js';
describe('runtime types', () => {
    it('TeamConfig has required fields', () => {
        const config = {
            teamName: 'test',
            workerCount: 2,
            agentTypes: ['codex', 'gemini'],
            tasks: [{ subject: 'Task 1', description: 'Do something' }],
            cwd: '/tmp',
        };
        expect(config.teamName).toBe('test');
        expect(config.workerCount).toBe(2);
    });
    it('monitorTeam returns performance telemetry', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'team-runtime-monitor-'));
        const previousHome = process.env.HOME;
        const previousUserProfile = process.env.USERPROFILE;
        process.env.HOME = cwd;
        process.env.USERPROFILE = cwd;
        const teamName = 'monitor-team';
        const tasksDir = join(cwd, '.omc', 'state', 'team', teamName, 'tasks');
        mkdirSync(tasksDir, { recursive: true });
        writeFileSync(join(tasksDir, 'task-1.json'), JSON.stringify({ status: 'pending' }), 'utf-8');
        writeFileSync(join(tasksDir, 'task-2.json'), JSON.stringify({ status: 'completed' }), 'utf-8');
        const snapshot = await monitorTeam(teamName, cwd, []);
        expect(snapshot.taskCounts.pending).toBe(1);
        expect(snapshot.taskCounts.completed).toBe(1);
        expect(snapshot.monitorPerformance.listTasksMs).toBeGreaterThanOrEqual(0);
        expect(snapshot.monitorPerformance.workerScanMs).toBeGreaterThanOrEqual(0);
        expect(snapshot.monitorPerformance.totalMs).toBeGreaterThanOrEqual(snapshot.monitorPerformance.listTasksMs);
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousUserProfile;
        rmSync(cwd, { recursive: true, force: true });
    });
    it('monitorTeam rejects invalid team names before path usage', async () => {
        await expect(monitorTeam('Bad-Team', '/tmp', [])).rejects.toThrow('Invalid team name');
    });
});
//# sourceMappingURL=runtime.test.js.map