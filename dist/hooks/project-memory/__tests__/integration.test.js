/**
 * Integration Tests for Project Memory Hook
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { registerProjectMemoryContext, clearProjectMemorySession } from '../index.js';
import { loadProjectMemory, getMemoryPath } from '../storage.js';
import { learnFromToolOutput } from '../learner.js';
describe('Project Memory Integration', () => {
    let tempDir;
    beforeEach(async () => {
        delete process.env.OMC_STATE_DIR;
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-test-'));
    });
    afterEach(async () => {
        delete process.env.OMC_STATE_DIR;
        await fs.rm(tempDir, { recursive: true, force: true });
    });
    describe('End-to-end SessionStart flow', () => {
        it('should detect, persist, and inject context on first session', async () => {
            // Create a TypeScript project
            const packageJson = {
                name: 'test-app',
                scripts: {
                    build: 'tsc',
                    test: 'vitest',
                },
                dependencies: {
                    react: '^18.2.0',
                },
                devDependencies: {
                    typescript: '^5.0.0',
                },
            };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));
            await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}');
            await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
            // Simulate SessionStart hook
            const sessionId = 'test-session-1';
            const registered = await registerProjectMemoryContext(sessionId, tempDir);
            expect(registered).toBe(true);
            // Verify memory file was created
            const memory = await loadProjectMemory(tempDir);
            expect(memory).not.toBeNull();
            expect(memory?.techStack.packageManager).toBe('pnpm');
            expect(memory?.build.buildCommand).toBe('pnpm build');
            // Verify .omc directory structure (project memory lives under shared root)
            const omcDir = path.join(tempDir, '.omc');
            const omcStat = await fs.stat(omcDir);
            expect(omcStat.isDirectory()).toBe(true);
        });
        it('should persist to centralized state dir without creating local .omc when OMC_STATE_DIR is set', async () => {
            const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-state-'));
            try {
                process.env.OMC_STATE_DIR = stateDir;
                const packageJson = {
                    name: 'test-app',
                    scripts: { build: 'tsc' },
                    devDependencies: { typescript: '^5.0.0' },
                };
                await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));
                await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}');
                const registered = await registerProjectMemoryContext('test-session-centralized', tempDir);
                expect(registered).toBe(true);
                const memoryPath = getMemoryPath(tempDir);
                const content = await fs.readFile(memoryPath, 'utf-8');
                expect(JSON.parse(content).projectRoot).toBe(tempDir);
                await expect(fs.access(path.join(tempDir, '.omc', 'project-memory.json'))).rejects.toThrow();
            }
            finally {
                delete process.env.OMC_STATE_DIR;
                await fs.rm(stateDir, { recursive: true, force: true });
            }
        });
        it('should not inject duplicate context in same session', async () => {
            const packageJson = { name: 'test' };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
            const sessionId = 'test-session-2';
            // First registration
            const first = await registerProjectMemoryContext(sessionId, tempDir);
            expect(first).toBe(true);
            // Second registration in same session
            const second = await registerProjectMemoryContext(sessionId, tempDir);
            expect(second).toBe(false); // Should skip duplicate
        });
        it('should inject again for different session', async () => {
            const packageJson = { name: 'test' };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
            // Session 1
            const session1 = 'test-session-3a';
            const first = await registerProjectMemoryContext(session1, tempDir);
            expect(first).toBe(true);
            // Session 2
            const session2 = 'test-session-3b';
            const second = await registerProjectMemoryContext(session2, tempDir);
            expect(second).toBe(true);
        });
        it('should not inject if project has no useful info', async () => {
            // Empty directory with no config files — add .git so findProjectRoot
            // stops here instead of walking up to the real repo root
            await fs.mkdir(path.join(tempDir, '.git'));
            const sessionId = 'test-session-4';
            const registered = await registerProjectMemoryContext(sessionId, tempDir);
            expect(registered).toBe(false);
        });
    });
    describe('End-to-end PostToolUse learning flow', () => {
        it('should learn build command from Bash execution', async () => {
            // Create initial project
            const packageJson = { name: 'test', scripts: {} };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
            // Initial detection (no build command)
            const sessionId = 'test-session-5';
            await registerProjectMemoryContext(sessionId, tempDir);
            let memory = await loadProjectMemory(tempDir);
            expect(memory?.build.buildCommand).toBeNull();
            // Simulate user running build command
            await learnFromToolOutput('Bash', { command: 'npm run build' }, '', tempDir);
            // Verify learning
            memory = await loadProjectMemory(tempDir);
            expect(memory?.build.buildCommand).toBe('npm run build');
        });
        it('should learn environment hints from command output', async () => {
            // Create initial project
            const packageJson = { name: 'test' };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
            // Initial detection
            const sessionId = 'test-session-6';
            await registerProjectMemoryContext(sessionId, tempDir);
            // Simulate command with Node.js version in output
            const output = 'Node.js v20.10.0\nnpm v10.2.0';
            await learnFromToolOutput('Bash', { command: 'node --version' }, output, tempDir);
            // Verify learning
            const memory = await loadProjectMemory(tempDir);
            expect(memory?.customNotes.length).toBeGreaterThan(0);
            expect(memory?.customNotes[0].category).toBe('runtime');
            expect(memory?.customNotes[0].content).toContain('Node.js');
        });
    });
    describe('Session cleanup', () => {
        it('should clear session cache', async () => {
            const packageJson = { name: 'test' };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
            const sessionId = 'test-session-7';
            // Register
            await registerProjectMemoryContext(sessionId, tempDir);
            // Clear cache
            clearProjectMemorySession(sessionId);
            // Should register again (cache cleared)
            const registered = await registerProjectMemoryContext(sessionId, tempDir);
            expect(registered).toBe(true);
        });
    });
    describe('Cache expiry', () => {
        it('should rescan if cache is stale', async () => {
            const packageJson = { name: 'test', version: '1.0.0' };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
            // Initial scan
            const sessionId = 'test-session-8';
            await registerProjectMemoryContext(sessionId, tempDir);
            // Load and manually set lastScanned to 25 hours ago
            const memory = await loadProjectMemory(tempDir);
            expect(memory).not.toBeNull();
            memory.lastScanned = Date.now() - 25 * 60 * 60 * 1000;
            // Save with old timestamp
            const memoryPath = getMemoryPath(tempDir);
            await fs.writeFile(memoryPath, JSON.stringify(memory, null, 2));
            // Clear session cache to allow re-registration
            clearProjectMemorySession(sessionId);
            // Register again - should trigger rescan
            await registerProjectMemoryContext(sessionId, tempDir);
            // Verify lastScanned was updated
            const updated = await loadProjectMemory(tempDir);
            const age = Date.now() - updated.lastScanned;
            expect(age).toBeLessThan(5000); // Less than 5 seconds old
        });
    });
    describe('Rescan preserves unknown fields on disk', () => {
        it('should preserve fields not produced by detectProjectEnvironment across rescan in registerProjectMemoryContext', async () => {
            const packageJson = {
                name: 'test',
                scripts: { build: 'tsc' },
                devDependencies: { typescript: '^5.0.0' },
            };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
            await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}');
            const sessionId = 'test-session-unknown-register';
            await registerProjectMemoryContext(sessionId, tempDir);
            const memory = await loadProjectMemory(tempDir);
            expect(memory).not.toBeNull();
            const memoryPath = getMemoryPath(tempDir);
            const onDisk = JSON.parse(await fs.readFile(memoryPath, 'utf-8'));
            onDisk.customField = { written: 'by-mcp-tool', count: 7 };
            onDisk.anotherUnknownField = ['a', 'b'];
            onDisk.lastScanned = Date.now() - 25 * 60 * 60 * 1000;
            await fs.writeFile(memoryPath, JSON.stringify(onDisk, null, 2));
            clearProjectMemorySession(sessionId);
            await registerProjectMemoryContext(sessionId, tempDir);
            const after = JSON.parse(await fs.readFile(memoryPath, 'utf-8'));
            expect(after.customField).toEqual({ written: 'by-mcp-tool', count: 7 });
            expect(after.anotherUnknownField).toEqual(['a', 'b']);
            const age = Date.now() - after.lastScanned;
            expect(age).toBeLessThan(5000);
        });
        it('should preserve unknown fields across rescanProjectEnvironment', async () => {
            const packageJson = {
                name: 'test',
                scripts: { build: 'tsc' },
                devDependencies: { typescript: '^5.0.0' },
            };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
            await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}');
            const sessionId = 'test-session-unknown-rescan';
            await registerProjectMemoryContext(sessionId, tempDir);
            const memoryPath = getMemoryPath(tempDir);
            const onDisk = JSON.parse(await fs.readFile(memoryPath, 'utf-8'));
            onDisk.customField = { written: 'by-mcp-tool', count: 7 };
            await fs.writeFile(memoryPath, JSON.stringify(onDisk, null, 2));
            const { rescanProjectEnvironment } = await import('../index.js');
            await rescanProjectEnvironment(tempDir);
            const after = JSON.parse(await fs.readFile(memoryPath, 'utf-8'));
            expect(after.customField).toEqual({ written: 'by-mcp-tool', count: 7 });
        });
    });
    describe('Rescan replaces schema-known fields when removed', () => {
        it('should drop a stale language that is no longer present in the project', async () => {
            const packageJson = {
                name: 'test',
                scripts: { build: 'tsc' },
                devDependencies: { typescript: '^5.0.0' },
            };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
            await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}');
            const sessionId = 'test-session-stale-language';
            await registerProjectMemoryContext(sessionId, tempDir);
            const memoryPath = getMemoryPath(tempDir);
            const onDisk = JSON.parse(await fs.readFile(memoryPath, 'utf-8'));
            onDisk.techStack.languages.push({
                name: 'Python',
                version: null,
                confidence: 'high',
                markers: ['pyproject.toml'],
            });
            onDisk.lastScanned = Date.now() - 25 * 60 * 60 * 1000;
            await fs.writeFile(memoryPath, JSON.stringify(onDisk, null, 2));
            clearProjectMemorySession(sessionId);
            await registerProjectMemoryContext(sessionId, tempDir);
            const after = JSON.parse(await fs.readFile(memoryPath, 'utf-8'));
            const languageNames = after.techStack.languages.map((l) => l.name);
            expect(languageNames).not.toContain('Python');
        });
        it('should drop a stale npm script that is no longer in package.json', async () => {
            const packageJson = {
                name: 'test',
                scripts: { build: 'tsc' },
                devDependencies: { typescript: '^5.0.0' },
            };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
            await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}');
            const sessionId = 'test-session-stale-script';
            await registerProjectMemoryContext(sessionId, tempDir);
            const memoryPath = getMemoryPath(tempDir);
            const onDisk = JSON.parse(await fs.readFile(memoryPath, 'utf-8'));
            onDisk.build.scripts.removedScript = 'echo gone';
            onDisk.lastScanned = Date.now() - 25 * 60 * 60 * 1000;
            await fs.writeFile(memoryPath, JSON.stringify(onDisk, null, 2));
            clearProjectMemorySession(sessionId);
            await registerProjectMemoryContext(sessionId, tempDir);
            const after = JSON.parse(await fs.readFile(memoryPath, 'utf-8'));
            expect(after.build.scripts).not.toHaveProperty('removedScript');
        });
        it('should drop a stale workspace via rescanProjectEnvironment', async () => {
            const packageJson = {
                name: 'test',
                scripts: { build: 'tsc' },
                devDependencies: { typescript: '^5.0.0' },
            };
            await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
            await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}');
            const sessionId = 'test-session-stale-workspace';
            await registerProjectMemoryContext(sessionId, tempDir);
            const memoryPath = getMemoryPath(tempDir);
            const onDisk = JSON.parse(await fs.readFile(memoryPath, 'utf-8'));
            onDisk.structure.workspaces.push('apps/old-removed');
            await fs.writeFile(memoryPath, JSON.stringify(onDisk, null, 2));
            const { rescanProjectEnvironment } = await import('../index.js');
            await rescanProjectEnvironment(tempDir);
            const after = JSON.parse(await fs.readFile(memoryPath, 'utf-8'));
            expect(after.structure.workspaces).not.toContain('apps/old-removed');
        });
    });
});
//# sourceMappingURL=integration.test.js.map