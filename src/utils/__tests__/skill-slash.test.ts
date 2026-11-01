import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { defaultSkillListProbe, resolveSkillSlash, setSkillListProbe, type CopilotSkillEntry, type SkillListProbe } from '../skill-registry.js';
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

  describe('unattended', () => {
    const ourPath = join(ROOT, 'skills', 'harbor');
    let tmp: string | undefined;
    afterEach(() => { vi.unstubAllEnvs(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = undefined; });
    // Our plugin is the dev plugin root; a plugin elsewhere is not, whatever its plugin.json says.
    beforeEach(() => { vi.stubEnv('OMC_PLUGIN_ROOT', ROOT); });

    function otherPlugin(): string {
      tmp = mkdtempSync(join(tmpdir(), 'skill-registry-'));
      mkdirSync(join(tmp, 'skills', 'harbor'), { recursive: true });
      writeFileSync(join(tmp, 'plugin.json'), JSON.stringify({ name: 'other-plugin' }));
      return join(tmp, 'skills', 'harbor');
    }

    it('returns the bare name for our plugin skill', () => {
      const fake = useProbe([{ name: 'harbor', source: 'plugin', path: ourPath }]);
      restore = fake.restore;
      expect(resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', unattended: true, warn: fake.warn })).toBe('/harbor');
    });

    it.each([
      ['a project skill', { name: 'harbor', source: 'project', path: '/repo/.github/skills/harbor' }],
      ['a user skill', { name: 'harbor', source: 'personal-copilot', path: '/home/u/.copilot/skills/harbor' }],
      ['a plugin entry without a path', { name: 'harbor', source: 'plugin' }],
    ])('throws skill-shadowed for %s', (_label, entry) => {
      const fake = useProbe([entry, { name: 'oh-my-copilot:harbor', source: 'plugin', path: ourPath }]);
      restore = fake.restore;
      expect(() => resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', unattended: true, warn: fake.warn })).toThrow(/^skill-shadowed:harbor/);
    });

    it("throws skill-shadowed for another plugin's same-named skill", () => {
      const fake = useProbe([{ name: 'harbor', source: 'plugin', path: otherPlugin() }]);
      restore = fake.restore;
      expect(() => resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', unattended: true, warn: fake.warn })).toThrow(/^skill-shadowed:harbor/);
    });

    it("throws skill-shadowed for a plugin named oh-my-copilot outside OMC_PLUGIN_ROOT and the installed-plugins dir", () => {
      const impostor = otherPlugin();
      writeFileSync(join(tmp as string, 'plugin.json'), JSON.stringify({ name: 'oh-my-copilot' }));
      const fake = useProbe([{ name: 'harbor', source: 'plugin', path: impostor }]);
      restore = fake.restore;
      expect(() => resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', unattended: true, warn: fake.warn })).toThrow(/^skill-shadowed:harbor/);
    });

    it('returns the bare name for our plugin under the installed-plugins dir', () => {
      const home = mkdtempSync(join(tmpdir(), 'skill-registry-home-'));
      tmp = home;
      const root = join(home, 'installed-plugins', '_direct', 'oh-my-copilot');
      mkdirSync(join(root, 'skills', 'harbor'), { recursive: true });
      writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-copilot' }));
      vi.stubEnv('OMC_PLUGIN_ROOT', '');
      vi.stubEnv('COPILOT_HOME', home);
      const fake = useProbe([{ name: 'harbor', source: 'plugin', path: join(root, 'skills', 'harbor') }]);
      restore = fake.restore;
      expect(resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', unattended: true, warn: fake.warn })).toBe('/harbor');
    });

    it('throws skill-unverifiable when the registry cannot be probed, and interactive callers keep the bare name', () => {
      const fake = useProbe(null);
      restore = fake.restore;
      expect(() => resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', unattended: true, warn: fake.warn })).toThrow(/^skill-unverifiable:harbor/);
      expect(resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', warn: fake.warn })).toBe('/harbor');
    });

    it('strips control characters from the source it prints', () => {
      const fake = useProbe([{ name: 'harbor', source: 'pro\u001b[2Jject\r\n' }]);
      restore = fake.restore;
      resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', warn: fake.warn });
      expect(fake.warnings).toEqual([expect.stringMatching(/^a pro\[2Jject skill named "harbor"/)]);
      expect(() => resolveSkillSlash('harbor', { cwd: '/repo', host: 'copilot', unattended: true })).toThrow(/^skill-shadowed:harbor: a pro\[2Jject skill/);
    });
  });
});

describe('defaultSkillListProbe', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('never runs a copilot planted in the cwd when the host binary is not on PATH', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skill-probe-cwd-'));
    const emptyPath = mkdtempSync(join(tmpdir(), 'skill-probe-path-'));
    try {
      const marker = join(cwd, 'ran');
      writeFileSync(join(cwd, 'copilot.cmd'), `@echo off\r\necho x> "${marker}"\r\necho []\r\n`);
      writeFileSync(join(cwd, 'copilot'), `#!/bin/sh\ntouch "${marker}"\necho []\n`, { mode: 0o755 });
      vi.stubEnv('COPILOT_CLI', '1');
      vi.stubEnv('PATH', emptyPath);
      expect(defaultSkillListProbe(cwd, [])).toBe('unresolved');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });

  it('probes an npm-style copilot.cmd shim on PATH, never the one planted in the cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skill-probe-cwd-'));
    const binDir = mkdtempSync(join(tmpdir(), 'skill-probe-bin-'));
    try {
      const marker = join(cwd, 'ran');
      writeFileSync(join(cwd, 'copilot.cmd'), `@echo off\r\necho x> "${marker}"\r\necho []\r\n`);
      writeFileSync(join(cwd, 'copilot'), `#!/bin/sh\ntouch "${marker}"\necho []\n`, { mode: 0o755 });
      // The shim echoes its second argument back as a skill name: the quoted plugin dir must arrive whole.
      writeFileSync(join(binDir, 'copilot.cmd'), '@echo off\r\necho [{"name":"%~2","source":"plugin"}]\r\n');
      writeFileSync(join(binDir, 'copilot'), '#!/bin/sh\necho "[{\\"name\\":\\"$2\\",\\"source\\":\\"plugin\\"}]"\n', { mode: 0o755 });
      vi.stubEnv('COPILOT_CLI', '1');
      vi.stubEnv('PATH', binDir);
      expect(defaultSkillListProbe(cwd, ['--plugin-dir', 'plugin root'])).toEqual([{ name: 'plugin root', source: 'plugin' }]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  describe('a probe that runs and fails', () => {
    const win = process.platform === 'win32';
    const cases: Array<[string, string, string]> = [
      ['a non-zero exit', '@echo off\r\nexit /b 3\r\n', '#!/bin/sh\nexit 3\n'],
      ['unparseable JSON', '@echo off\r\necho not json\r\n', '#!/bin/sh\necho not json\n'],
      ['the timeout', '@echo off\r\n%SystemRoot%\\System32\\ping.exe -n 8 127.0.0.1 >nul\r\n', '#!/bin/sh\n/bin/sleep 8\n'],
    ];
    it.each(cases)('throws skill-unverifiable unattended and keeps the bare name interactive on %s', { timeout: 30_000 }, (_label, cmd, sh) => {
      const binDir = mkdtempSync(join(tmpdir(), 'skill-probe-bin-'));
      const previous = setSkillListProbe(defaultSkillListProbe);
      try {
        writeFileSync(join(binDir, 'copilot.cmd'), cmd);
        writeFileSync(join(binDir, 'copilot'), sh, { mode: 0o755 });
        vi.stubEnv('COPILOT_CLI', '1');
        vi.stubEnv('PATH', binDir);
        expect(() => resolveSkillSlash('harbor', { cwd: binDir, host: 'copilot', unattended: true })).toThrow(/^skill-unverifiable:harbor/);
        expect(resolveSkillSlash('harbor', { cwd: binDir, host: 'copilot', warn: () => {} })).toBe('/harbor');
      } finally {
        setSkillListProbe(previous);
        // The timed-out probe's orphaned grandchild can still hold the dir open on Windows.
        try { rmSync(binDir, { recursive: true, force: true }); } catch { /* removed with the OS temp dir */ }
      }
    });

    it.skipIf(!win)('throws skill-unverifiable unattended for a refused token (a % in a shim argument)', () => {
      const binDir = mkdtempSync(join(tmpdir(), 'skill-probe-bin-'));
      const previous = setSkillListProbe(defaultSkillListProbe);
      try {
        writeFileSync(join(binDir, 'copilot.cmd'), '@echo off\r\necho []\r\n');
        vi.stubEnv('COPILOT_CLI', '1');
        vi.stubEnv('PATH', binDir);
        const probeArgs = ['--plugin-dir', 'C:\\p%TEMP%'];
        expect(() => resolveSkillSlash('harbor', { cwd: binDir, host: 'copilot', probeArgs, unattended: true })).toThrow(/^skill-unverifiable:harbor/);
        expect(resolveSkillSlash('harbor', { cwd: binDir, host: 'copilot', probeArgs, warn: () => {} })).toBe('/harbor');
      } finally {
        setSkillListProbe(previous);
        rmSync(binDir, { recursive: true, force: true });
      }
    });
  });

  it('refuses an unattended slash with skill-unverifiable when no copilot resolves on PATH', () => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'skill-probe-path-'));
    const previous = setSkillListProbe(defaultSkillListProbe);
    try {
      vi.stubEnv('COPILOT_CLI', '1');
      vi.stubEnv('PATH', emptyPath);
      expect(() => resolveSkillSlash('harbor', { cwd: emptyPath, host: 'copilot', unattended: true })).toThrow(/^skill-unverifiable:harbor/);
      expect(resolveSkillSlash('harbor', { cwd: emptyPath, host: 'copilot', warn: () => {} })).toBe('/harbor');
    } finally {
      setSkillListProbe(previous);
      rmSync(emptyPath, { recursive: true, force: true });
    }
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
