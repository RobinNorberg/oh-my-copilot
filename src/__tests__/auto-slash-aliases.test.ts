import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('auto-slash command skill aliases', () => {
  const originalCwd = process.cwd();
  const originalClaudeConfigDir = process.env.COPILOT_CONFIG_DIR;

  let tempRoot: string;
  let tempConfigDir: string;
  let tempProjectDir: string;

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

    writeFileSync(
      join(tempConfigDir, 'skills', 'team', 'SKILL.md'),
      `---
name: team
description: Team orchestration
---

Team body`
    );

    writeFileSync(
      join(tempConfigDir, 'skills', 'project-session-manager', 'SKILL.md'),
      `---
name: project-session-manager
description: Project session management
---

PSM body`
    );

    process.env.COPILOT_CONFIG_DIR = tempConfigDir;
    process.chdir(tempProjectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalClaudeConfigDir === undefined) {
      delete process.env.COPILOT_CONFIG_DIR;
    } else {
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
});
