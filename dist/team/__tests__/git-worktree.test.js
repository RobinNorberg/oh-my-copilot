import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { createWorkerWorktree, removeWorkerWorktree, listTeamWorktrees, cleanupTeamWorktrees, } from '../git-worktree.js';
describe('git-worktree', () => {
    let repoDir;
    const teamName = 'test-wt';
    beforeEach(() => {
        repoDir = mkdtempSync(join(tmpdir(), 'git-worktree-test-'));
        // Initialize a git repo with an initial commit
        execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
        writeFileSync(join(repoDir, 'README.md'), '# Test\n');
        execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'pipe' });
    });
    afterEach(() => {
        // Clean up worktrees first (git needs this before rmSync)
        try {
            cleanupTeamWorktrees(teamName, repoDir);
        }
        catch { /* ignore */ }
        rmSync(repoDir, { recursive: true, force: true });
    });
    describe('createWorkerWorktree', () => {
        it('creates worktree at correct path', () => {
            const info = createWorkerWorktree(teamName, 'worker1', repoDir);
            expect(info.path.split('\\').join('/')).toContain('.omcp/worktrees');
            expect(info.branch).toBe(`omc-team/${teamName}/worker1`);
            expect(info.workerName).toBe('worker1');
            expect(info.teamName).toBe(teamName);
            expect(existsSync(info.path)).toBe(true);
        });
        it('branch name is properly sanitized', () => {
            const info = createWorkerWorktree(teamName, 'worker-with-special', repoDir);
            expect(info.branch).toContain('omc-team/');
            expect(existsSync(info.path)).toBe(true);
        });
        it('handles recreation of stale worktree', () => {
            const info1 = createWorkerWorktree(teamName, 'worker1', repoDir);
            expect(existsSync(info1.path)).toBe(true);
            // Recreate the same worktree
            const info2 = createWorkerWorktree(teamName, 'worker1', repoDir);
            expect(existsSync(info2.path)).toBe(true);
            expect(info2.path).toBe(info1.path);
        });
    });
    describe('removeWorkerWorktree', () => {
        it('removes worktree and branch', () => {
            const info = createWorkerWorktree(teamName, 'worker1', repoDir);
            expect(existsSync(info.path)).toBe(true);
            removeWorkerWorktree(teamName, 'worker1', repoDir);
            // Worktree directory should be gone
            expect(existsSync(info.path)).toBe(false);
            // Branch should be deleted
            const branches = execFileSync('git', ['branch'], { cwd: repoDir, encoding: 'utf-8' });
            expect(branches).not.toContain('omc-team/');
        });
        it('does not throw for non-existent worktree', () => {
            expect(() => removeWorkerWorktree(teamName, 'nonexistent', repoDir)).not.toThrow();
        });
    });
    describe('worktree root AGENTS.md lifecycle', () => {
        it('installs a managed overlay and removes it on cleanup when no root AGENTS.md existed', () => {
            rmSync(join(repoDir, 'AGENTS.md'));
            execFileSync('git', ['add', '-u', 'AGENTS.md'], { cwd: repoDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'Remove root agents'], { cwd: repoDir, stdio: 'pipe' });
            const info = createWorkerWorktree(teamName, 'worker-agents-new', repoDir);
            const agentsPath = join(info.path, 'AGENTS.md');
            expect(existsSync(agentsPath)).toBe(false);
            installWorktreeRootAgents(teamName, 'worker-agents-new', repoDir, info.path, 'managed overlay\n');
            expect(readFileSync(agentsPath, 'utf-8')).toBe('managed overlay\n');
            const restored = restoreWorktreeRootAgents(teamName, 'worker-agents-new', repoDir, info.path);
            expect(restored).toEqual({ restored: true });
            expect(existsSync(agentsPath)).toBe(false);
        });
        it('backs up an existing root AGENTS.md and restores it before removal', () => {
            writeFileSync(join(repoDir, 'AGENTS.md'), 'original root instructions\n');
            execFileSync('git', ['add', 'AGENTS.md'], { cwd: repoDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'Add root agents'], { cwd: repoDir, stdio: 'pipe' });
            const info = createWorkerWorktree(teamName, 'worker-agents-existing', repoDir);
            const agentsPath = join(info.path, 'AGENTS.md');
            installWorktreeRootAgents(teamName, 'worker-agents-existing', repoDir, info.path, 'managed overlay\n');
            expect(readFileSync(agentsPath, 'utf-8')).toBe('managed overlay\n');
            removeWorkerWorktree(teamName, 'worker-agents-existing', repoDir);
            expect(existsSync(info.path)).toBe(false);
        });
        it('restores root AGENTS.md but preserves a worktree with other dirty edits', () => {
            writeFileSync(join(repoDir, 'AGENTS.md'), 'original root instructions\n');
            execFileSync('git', ['add', 'AGENTS.md'], { cwd: repoDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'Add root agents'], { cwd: repoDir, stdio: 'pipe' });
            const info = createWorkerWorktree(teamName, 'worker-agents-dirty', repoDir);
            const agentsPath = join(info.path, 'AGENTS.md');
            installWorktreeRootAgents(teamName, 'worker-agents-dirty', repoDir, info.path, 'managed overlay\n');
            writeFileSync(join(info.path, 'dirty.txt'), 'dirty');
            const result = cleanupTeamWorktrees(teamName, repoDir);
            expect(result.preserved).toHaveLength(1);
            expect(result.preserved[0]?.reason).toMatch(/worktree_dirty/);
            expect(existsSync(info.path)).toBe(true);
            expect(readFileSync(agentsPath, 'utf-8')).toBe('original root instructions\n');
        });
        it('preserves the worktree when AGENTS.md itself was modified by the worker', () => {
            const info = createWorkerWorktree(teamName, 'worker-agents-edited', repoDir);
            const agentsPath = join(info.path, 'AGENTS.md');
            installWorktreeRootAgents(teamName, 'worker-agents-edited', repoDir, info.path, 'managed overlay\n');
            writeFileSync(agentsPath, 'worker edited instructions\n');
            expect(() => removeWorkerWorktree(teamName, 'worker-agents-edited', repoDir)).toThrow(/agents_dirty/);
            expect(existsSync(info.path)).toBe(true);
            expect(readFileSync(agentsPath, 'utf-8')).toBe('worker edited instructions\n');
        });
    });
    describe('listTeamWorktrees', () => {
        it('returns empty for team with no worktrees', () => {
            const list = listTeamWorktrees(teamName, repoDir);
            expect(list).toEqual([]);
        });
        it('lists created worktrees', () => {
            createWorkerWorktree(teamName, 'worker1', repoDir);
            createWorkerWorktree(teamName, 'worker2', repoDir);
            const list = listTeamWorktrees(teamName, repoDir);
            expect(list).toHaveLength(2);
            expect(list.map(w => w.workerName)).toContain('worker1');
            expect(list.map(w => w.workerName)).toContain('worker2');
        });
    });
    describe('cleanupTeamWorktrees', () => {
        it('removes all worktrees for a team', () => {
            createWorkerWorktree(teamName, 'worker1', repoDir);
            createWorkerWorktree(teamName, 'worker2', repoDir);
            expect(listTeamWorktrees(teamName, repoDir)).toHaveLength(2);
            cleanupTeamWorktrees(teamName, repoDir);
            expect(listTeamWorktrees(teamName, repoDir)).toHaveLength(0);
        });
    });
});
//# sourceMappingURL=git-worktree.test.js.map