import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { resolveSkillSlash, setSkillListProbe, type CopilotSkillEntry, type SkillListProbe } from '../skill-registry.js';
import { skillSlash } from '../skill-slash.js';

const ROOT = join(__dirname, '..', '..', '..');
// `copilot --plugin-dir <repo> skill list --json` on Copilot CLI 1.0.105, plugin entries only.
const SKILL_LIST: CopilotSkillEntry[] = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'copilot-skill-list.json'), 'utf8'));
const LISTED = new Set(SKILL_LIST.map((entry) => entry.name));

function useProbe(entries: CopilotSkillEntry[] | null) {
  const probe = vi.fn<SkillListProbe>(() => entries);
  const previous = setSkillListProbe(probe);
  const warnings: string[] = [];
  return { probe, warnings, warn: (message: string) => warnings.push(message), restore: () => setSkillListProbe(previous) };
}

describe('skillSlash', () => {
  it('is the bare name on Copilot CLI and the plugin namespace on Claude Code', () => {
    expect(skillSlash('ralph', 'copilot')).toBe('/ralph');
    expect(skillSlash('ralph', 'claude')).toBe('/oh-my-copilot:ralph');
  });

  it('has a hook-script twin keyed on the Copilot hook signal', async () => {
    const twin = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'skill-slash.mjs')).href) as { skillSlash: (name: string, env: NodeJS.ProcessEnv) => string };
    expect(twin.skillSlash('cancel', { OMC_HOOK_EVENT: 'Stop' })).toBe(skillSlash('cancel', 'copilot'));
    expect(twin.skillSlash('cancel', {})).toBe(skillSlash('cancel', 'claude'));
  });
});

describe('resolveSkillSlash', () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  it('never probes for a Claude Code session', () => {
    const fake = useProbe([]);
    restore = fake.restore;
    expect(resolveSkillSlash('harbor', { cwd: '/repo', host: 'claude', warn: fake.warn })).toBe('/oh-my-copilot:harbor');
    expect(fake.probe).not.toHaveBeenCalled();
  });

  it('uses the bare name when the plugin skill is listed under it', () => {
    const fake = useProbe([{ name: 'harbor', source: 'plugin' }]);
    restore = fake.restore;
    expect(resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', warn: fake.warn })).toBe('/harbor');
    expect(fake.warnings).toEqual([]);
  });

  it('uses the namespaced name when a plugin-name collision leaves only that form', () => {
    const fake = useProbe([{ name: 'oh-my-copilot:harbor', source: 'plugin' }, { name: 'other-plugin:harbor', source: 'plugin' }]);
    restore = fake.restore;
    expect(resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', warn: fake.warn })).toBe('/oh-my-copilot:harbor');
    expect(fake.warnings).toEqual([]);
  });

  it('warns when a project skill shadows the bundled one', () => {
    const fake = useProbe([{ name: 'harbor', source: 'project' }]);
    restore = fake.restore;
    expect(resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', warn: fake.warn })).toBe('/harbor');
    expect(fake.warnings).toEqual([expect.stringMatching(/project skill named "harbor" shadows the bundled skill/)]);
  });

  it('warns when the name is missing from the registry', () => {
    const fake = useProbe([{ name: 'ralph', source: 'plugin' }]);
    restore = fake.restore;
    expect(resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', warn: fake.warn })).toBe('/harbor');
    expect(fake.warnings).toEqual([expect.stringMatching(/no skill named "harbor"/)]);
  });

  it('falls back to the bare name without a warning when the probe fails', () => {
    const fake = useProbe(null);
    restore = fake.restore;
    expect(resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', warn: fake.warn })).toBe('/harbor');
    expect(fake.warnings).toEqual([]);
  });

  it('probes once per process for each cwd and probe args', () => {
    const fake = useProbe([{ name: 'harbor', source: 'plugin' }]);
    restore = fake.restore;
    resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', probeArgs: ['--plugin-dir', '/p'] });
    resolveSkillSlash('ralph', { cwd: '/repo', host: 'copilot', probeArgs: ['--plugin-dir', '/p'], warn: fake.warn });
    resolveSkillSlash('harbor', { cwd: '/other', host: 'copilot' });
    expect(fake.probe.mock.calls).toEqual([['/repo', ['--plugin-dir', '/p']], ['/other', []]]);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

describe('Copilot skill registry (stubbed `copilot skill list --json`)', () => {
  const skillDirs = readdirSync(join(ROOT, 'skills')).filter((dir) => {
    try {
      return statSync(join(ROOT, 'skills', dir, 'SKILL.md')).isFile();
    } catch {
      return false;
    }
  });

  it('lists every bundled skill under its frontmatter name and every command file', () => {
    const expected = new Set(skillDirs.map((dir) => {
      const match = /^name:\s*(.+)$/m.exec(readFileSync(join(ROOT, 'skills', dir, 'SKILL.md'), 'utf8'));
      return match ? match[1].trim().replace(/^["']|["']$/g, '') : dir;
    }));
    for (const file of readdirSync(join(ROOT, 'commands'))) expected.add(file.replace(/\.md$/, ''));
    expect([...LISTED].sort()).toEqual([...expected].sort());
  });

  it('lists every skill the runtime emitters name', () => {
    const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))]
      .filter((file) => /\.(ts|mjs|cjs)$/.test(file) && !/__tests__|\.test\./.test(file));
    const named = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/(?:skillSlash|resolveSkillSlash)\(['"]([a-z][a-z0-9-]*)['"]/g)) named.add(match[1]);
    }
    expect(named.size).toBeGreaterThan(5);
    expect([...named].filter((name) => !LISTED.has(name) && name !== 'learner')).toEqual([]);
  });

  it('docs and agent text never name a skill by a directory name Copilot does not register', () => {
    // `plan` and `review` register as omc-plan / omc-review: a bare `/plan` is Copilot's native command.
    const unregistered = skillDirs.filter((dir) => !LISTED.has(dir));
    expect(unregistered.length).toBeGreaterThan(0);
    const pattern = new RegExp(`(?<![\\w./:~-])/(${unregistered.join('|')})(?![\\w/.:-])`, 'g');
    const docs = [
      join(ROOT, 'README.md'),
      join(ROOT, 'AGENTS.md'),
      join(ROOT, 'docs', 'CLAUDE.md'),
      join(ROOT, 'docs', 'GETTING-STARTED.md'),
      join(ROOT, 'docs', 'REFERENCE.md'),
      ...walk(join(ROOT, 'skills')).filter((file) => file.endsWith('.md')),
      ...walk(join(ROOT, 'agents')).filter((file) => file.endsWith('.md')),
    ];
    const hits: string[] = [];
    for (const file of docs) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        for (const match of line.matchAll(pattern)) {
          // A line about Copilot's own command, not the skill.
          if (/not `\/[a-z-]+`|native|'s own/i.test(line)) continue;
          hits.push(`${relative(ROOT, file)}:${index + 1}: /${match[1]}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
