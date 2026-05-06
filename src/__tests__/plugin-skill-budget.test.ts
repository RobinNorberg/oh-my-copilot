import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const PLUGIN_JSON = join(REPO_ROOT, '.claude-plugin', 'plugin.json');
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const COMMANDS_DIR = join(REPO_ROOT, 'commands');

function readPluginJson(): { skills?: unknown; commands?: unknown } {
  return JSON.parse(readFileSync(PLUGIN_JSON, 'utf-8')) as { skills?: unknown; commands?: unknown };
}

function bundledSkillDirs(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function pluginSkillDirs(): string[] {
  const { skills } = readPluginJson();
  expect(Array.isArray(skills)).toBe(true);
  return (skills as string[])
    .map((skillPath) => skillPath.replace(/^\.\/skills\//, '').replace(/\/$/, ''))
    .sort();
}

describe('plugin skill context budget gate (issue #2943)', () => {
  it('loads only tier-0/core workflow skills by default through plugin.json', () => {
    const defaultSkillDirs = pluginSkillDirs();
    const allSkillDirs = bundledSkillDirs();

    expect(allSkillDirs.length).toBeGreaterThan(30);
    expect(defaultSkillDirs).toEqual([
      'ai-slop-cleaner',
      'autopilot',
      'cancel',
      'deep-interview',
      'omc-reference',
      'plan',
      'ralph',
      'ralplan',
      'setup',
      'team',
      'ultraqa',
      'ultrawork',
    ]);

    // Keep OMC well below Claude Code's skill-description context budget and
    // leave most slots for user/project skills.
    expect(defaultSkillDirs.length).toBeLessThanOrEqual(12);
    expect(defaultSkillDirs.length).toBeLessThan(allSkillDirs.length / 2);
  });

  it('keeps non-default bundled skills reachable as explicit plugin commands', () => {
    const defaultSkillDirs = new Set(pluginSkillDirs());
    const nonDefaultSkillDirs = bundledSkillDirs().filter((name) => !defaultSkillDirs.has(name));

    expect(readPluginJson().commands).toBe('./commands/');

    for (const skillDir of nonDefaultSkillDirs) {
      const skillContent = readFileSync(join(SKILLS_DIR, skillDir, 'SKILL.md'), 'utf-8');
      const frontmatterName = skillContent.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? skillDir;
      const commandPath = join(COMMANDS_DIR, `${frontmatterName}.md`);
      expect(existsSync(commandPath), `${frontmatterName} command wrapper exists`).toBe(true);
      const commandContent = readFileSync(commandPath, 'utf-8');
      const expectedSkillPath = skillDir === 'learner' ? 'skills/skillify/SKILL.md' : `skills/${skillDir}/SKILL.md`;
      expect(commandContent).toContain(expectedSkillPath);
      expect(commandContent).toContain('$ARGUMENTS');
    }
  });

  it('preserves deprecated slash aliases as command wrappers', () => {
    expect(readFileSync(join(COMMANDS_DIR, 'learner.md'), 'utf-8')).toContain('skills/skillify/SKILL.md');
    expect(readFileSync(join(COMMANDS_DIR, 'psm.md'), 'utf-8')).toContain('skills/project-session-manager/SKILL.md');
  });
});
