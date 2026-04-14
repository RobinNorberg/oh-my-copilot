import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
describe('auto-slash command skill aliases', () => {
    const originalCwd = process.cwd();
    const originalClaudeConfigDir = process.env.COPILOT_CONFIG_DIR;
    let tempRoot;
    let tempConfigDir;
    let tempProjectDir;
    async function loadExecutor() {
        vi.resetModules();
        return import('../hooks/auto-slash-command/executor.js');
    }
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'omc-auto-slash-aliases-'));
        tempConfigDir = join(tempRoot, 'copilot-config');
        tempProjectDir = join(tempRoot, 'project');
        mkdirSync(join(tempConfigDir, 'skills', 'team'), { recursive: true });
        mkdirSync(join(tempConfigDir, 'skills', 'project-session-manager'), { recursive: true });
        mkdirSync(join(tempProjectDir, '.copilot', 'commands'), { recursive: true });
        writeFileSync(join(tempConfigDir, 'skills', 'team', 'SKILL.md'), `---
name: team
description: Team orchestration
---

Team body`);
        writeFileSync(join(tempConfigDir, 'skills', 'project-session-manager', 'SKILL.md'), `---
name: project-session-manager
description: Project session management
---

PSM body`);
        process.env.COPILOT_CONFIG_DIR = tempConfigDir;
        process.chdir(tempProjectDir);
    });
    afterEach(() => {
        process.chdir(originalCwd);
        if (originalClaudeConfigDir === undefined) {
            delete process.env.COPILOT_CONFIG_DIR;
        }
        else {
            process.env.COPILOT_CONFIG_DIR = originalClaudeConfigDir;
        }
        vi.resetModules();
        rmSync(tempRoot, { recursive: true, force: true });
    });
    it('discovers skill commands from skill frontmatter', async () => {
        const { discoverAllCommands, listAvailableCommands } = await loadExecutor();
        const commands = discoverAllCommands();
        const names = commands.map((command) => command.name);
        expect(names).toContain('team');
        expect(names).not.toContain('swarm'); // alias removed in #1131
        expect(names).toContain('project-session-manager');
        expect(names).not.toContain('psm'); // psm alias removed in Phase 4 cleanup
        const listedNames = listAvailableCommands().map((command) => command.name);
        expect(listedNames).toContain('team');
        expect(listedNames).toContain('project-session-manager');
        expect(listedNames).not.toContain('psm');
    });
    it('applies deep-interview threshold runtime injection in slash/materialized output', async () => {
        mkdirSync(join(tempConfigDir, 'skills', 'deep-interview'), { recursive: true });
        writeFileSync(join(tempConfigDir, 'skills', 'deep-interview', 'SKILL.md'), `---
name: deep-interview
description: Deep interview
---

Purpose default: (default: 20%)
Policy default: (default 0.2)
State:
"threshold": 0.2,
"ambiguityThreshold": 0.2,
4. **Initialize state** via \`state_write(mode="deep-interview")\`:
Announcement: We'll proceed to execution once ambiguity drops below 20%.
Diagram: Gate: ≤20% ambiguity
Warning: (threshold: 20%).
Advanced: ambiguity ≤ 20%
`);
        writeFileSync(join(tempConfigDir, 'settings.json'), JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.15 } } }));
        const { executeSlashCommand } = await loadExecutor();
        const result = executeSlashCommand({
            command: 'deep-interview',
            args: 'improve onboarding',
            raw: '/deep-interview improve onboarding',
        });
        expect(result.success).toBe(true);
        expect(result.replacementText).toContain('ambiguityThreshold = 0.15');
        expect(result.replacementText).toContain('(default: 15%)');
        expect(result.replacementText).toContain('(default 0.15)');
        expect(result.replacementText).toContain('"threshold": 0.15,');
        expect(result.replacementText).toContain('drops below 15%.');
        expect(result.replacementText).toContain('Gate: ≤15% ambiguity');
        expect(result.replacementText).toContain('(threshold: 15%).');
        expect(result.replacementText).toContain('ambiguity ≤ 15%');
        expect(result.replacementText).toContain('"ambiguityThreshold": 0.15,');
        expect(result.replacementText).not.toContain('(default: 20%)');
        expect(result.replacementText).not.toContain('(default 0.2)');
        expect(result.replacementText).not.toContain('"threshold": 0.2,');
        expect(result.replacementText).not.toContain('drops below 20%.');
        expect(result.replacementText).not.toContain('Gate: ≤20% ambiguity');
        expect(result.replacementText).not.toContain('(threshold: 20%).');
        expect(result.replacementText).not.toContain('ambiguity ≤ 20%');
        expect(result.replacementText).not.toContain('"ambiguityThreshold": 0.2,');
    });
});
//# sourceMappingURL=auto-slash-aliases.test.js.map