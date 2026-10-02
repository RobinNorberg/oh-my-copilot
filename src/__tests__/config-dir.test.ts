import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, join, normalize } from 'path';
import { getCopilotConfigDir } from '../utils/config-dir.js'
import { isValidTranscriptPath } from '../lib/worktree-paths.js';
import { findRuleFiles } from '../hooks/rules-injector/finder.js';

const originalConfigDir = process.env.COPILOT_HOME;

describe('getCopilotConfigDir', () => {
  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.COPILOT_HOME;
    } else {
      process.env.COPILOT_HOME = originalConfigDir;
    }
  });

  it('falls back to ~/.copilot when COPILOT_HOME is unset', () => {
    delete process.env.COPILOT_HOME;
    expect(getCopilotConfigDir()).toBe(normalize(join(homedir(), '.copilot')));
  });

  it('falls back to ~/.copilot when COPILOT_HOME is empty', () => {
    process.env.COPILOT_HOME = '   ';
    expect(getCopilotConfigDir()).toBe(normalize(join(homedir(), '.copilot')));
  });

  it('returns an absolute custom path unchanged aside from normalization', () => {
    process.env.COPILOT_HOME = join(tmpdir(), 'custom-claude-config', '..', 'custom-claude-config');
    expect(getCopilotConfigDir()).toBe(normalize(join(tmpdir(), 'custom-claude-config', '..', 'custom-claude-config')));
  });

  it('expands a bare tilde to the home directory', () => {
    process.env.COPILOT_HOME = '~';
    expect(getCopilotConfigDir()).toBe(normalize(homedir()));
  });

  it('expands a ~-prefixed config path', () => {
    process.env.COPILOT_HOME = '~/.claude-alt';
    expect(getCopilotConfigDir()).toBe(normalize(join(homedir(), '.claude-alt')));
  });

  it('strips a trailing separator from custom paths', () => {
    process.env.COPILOT_HOME = join(tmpdir(), 'custom-claude-config') + '/';
    expect(getCopilotConfigDir()).toBe(normalize(join(tmpdir(), 'custom-claude-config')));
    expect(getCopilotConfigDir().endsWith('/')).toBe(false);
  });

  it('preserves a Windows drive root when trimming separators', async () => {
    process.env.COPILOT_HOME = 'C:\\';

    vi.resetModules();
    vi.doMock('node:os', () => ({
      homedir: () => 'C:\\Users\\tester',
    }));
    vi.doMock('node:path', async () => import('node:path/win32'));

    try {
      const { getCopilotConfigDir: getWindowsConfigDir } = await import('../utils/config-dir.js');
      expect(getWindowsConfigDir()).toBe('C:\\');
    } finally {
      vi.doUnmock('node:os');
      vi.doUnmock('node:path');
      vi.resetModules();
    }
  });

  it('keeps every surface on the same default when COPILOT_HOME is unset', () => {
    // The .mjs and .cjs mirrors silently drifted to ~/.claude while the
    // TypeScript and shell surfaces used ~/.copilot, so the bash setup
    // lifecycle wrote .omc-config.json where the Node hooks never looked.
    // Only the tilde branch was covered, which is why the drift survived.
    delete process.env.COPILOT_HOME;
    const expected = normalize(join(homedir(), '.copilot'));
    const env = { ...process.env };
    delete env.COPILOT_HOME;

    const mjs = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { getCopilotConfigDir } from './scripts/lib/config-dir.mjs'; process.stdout.write(getCopilotConfigDir());",
      ],
      { cwd: process.cwd(), env, encoding: 'utf-8' },
    );
    const cjsPath = join(process.cwd(), 'scripts', 'lib', 'config-dir.cjs');
    const cjs = execFileSync(
      process.execPath,
      ['-e', `const { getCopilotConfigDir } = require(${JSON.stringify(cjsPath)}); process.stdout.write(getCopilotConfigDir());`],
      { cwd: process.cwd(), env, encoding: 'utf-8' },
    );

    expect(getCopilotConfigDir()).toBe(expected);
    expect(mjs).toBe(expected);
    expect(cjs).toBe(expected);
  });

  it('keeps the script helper aligned with the TypeScript helper', async () => {
    process.env.COPILOT_HOME = '~/.claude-alt';
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { getCopilotConfigDir } from './scripts/lib/config-dir.mjs'; process.stdout.write(getCopilotConfigDir());",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf-8',
      },
    );
    expect(output).toBe(normalize(join(homedir(), '.claude-alt')));
  });

  it('find-node.sh resolves a ~-prefixed COPILOT_HOME before reading .omc-config.json', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-find-node-home-'));
    const configDir = join(homeDir, '.claude-alt');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.omc-config.json'), JSON.stringify({ nodeBinary: process.execPath }));

    const output = execFileSync(
      '/bin/sh',
      [join(process.cwd(), 'scripts', 'find-node.sh'), '-e', "process.stdout.write('ok')"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: homeDir,
          PATH: '/bin:/usr/bin',
          COPILOT_HOME: '~/.claude-alt',
        },
        encoding: 'utf-8',
      },
    );

    expect(output).toBe('ok');
  });

  it('shared shell helper expands a ~-prefixed COPILOT_HOME', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-uninstall-home-'));
    const output = execFileSync('bash', ['-lc', `. "${join(process.cwd(), 'scripts', 'lib', 'config-dir.sh')}"; resolve_claude_config_dir`], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: homeDir,
        COPILOT_HOME: '~/.claude-alt',
      },
      encoding: 'utf-8',
    });

    expect(output.trim()).toBe(join(homeDir, '.claude-alt'));
  });

  it('shared shell helper expands a backslash-tilde-prefixed COPILOT_HOME', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-uninstall-home-'));
    const output = execFileSync('bash', ['-lc', `. "${join(process.cwd(), 'scripts', 'lib', 'config-dir.sh')}"; resolve_claude_config_dir`], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: homeDir,
        COPILOT_HOME: '~\\.claude-alt',
      },
      encoding: 'utf-8',
    });

    expect(output.trim()).toBe(join(homeDir, '.claude-alt'));
  });

  it('ignores the retired COPILOT_CONFIG_DIR on every surface', () => {
    const legacyDir = join(tmpdir(), 'legacy-config-dir');
    const env: NodeJS.ProcessEnv = { ...process.env, COPILOT_CONFIG_DIR: legacyDir };
    delete env.COPILOT_HOME;
    const expected = normalize(join(homedir(), '.copilot'));

    delete process.env.COPILOT_HOME;
    vi.stubEnv('COPILOT_CONFIG_DIR', legacyDir);
    try {
      expect(getCopilotConfigDir()).toBe(expected);
    } finally {
      vi.unstubAllEnvs();
    }

    const mjs = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { getCopilotConfigDir } from './scripts/lib/config-dir.mjs'; process.stdout.write(getCopilotConfigDir());",
      ],
      { cwd: process.cwd(), env, encoding: 'utf-8' },
    );
    const cjsPath = join(process.cwd(), 'scripts', 'lib', 'config-dir.cjs');
    const cjs = execFileSync(
      process.execPath,
      ['-e', `const { getCopilotConfigDir } = require(${JSON.stringify(cjsPath)}); process.stdout.write(getCopilotConfigDir());`],
      { cwd: process.cwd(), env, encoding: 'utf-8' },
    );
    expect(mjs).toBe(expected);
    expect(cjs).toBe(expected);

    const homeDir = mkdtempSync(join(tmpdir(), 'omc-legacy-home-'));
    const sh = execFileSync('bash', ['-lc', `. "${join(process.cwd(), 'scripts', 'lib', 'config-dir.sh')}"; resolve_claude_config_dir`], {
      cwd: process.cwd(),
      env: { ...env, HOME: homeDir },
      encoding: 'utf-8',
    });
    // Git Bash rewrites HOME to a POSIX path, so compare the tail only.
    expect(sh.trim().endsWith(`${basename(homeDir)}/.copilot`)).toBe(true);
  });

  it('treats a blank COPILOT_HOME as unset on every surface', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, COPILOT_HOME: '   ' };
    const expected = normalize(join(homedir(), '.copilot'));
    const mjs = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { getCopilotConfigDir } from './scripts/lib/config-dir.mjs'; process.stdout.write(getCopilotConfigDir());",
      ],
      { cwd: process.cwd(), env, encoding: 'utf-8' },
    );
    const cjsPath = join(process.cwd(), 'scripts', 'lib', 'config-dir.cjs');
    const cjs = execFileSync(
      process.execPath,
      ['-e', `const { getCopilotConfigDir } = require(${JSON.stringify(cjsPath)}); process.stdout.write(getCopilotConfigDir());`],
      { cwd: process.cwd(), env, encoding: 'utf-8' },
    );
    expect(mjs).toBe(expected);
    expect(cjs).toBe(expected);

    const homeDir = mkdtempSync(join(tmpdir(), 'omc-blank-home-'));
    const sh = execFileSync('bash', ['-lc', `. "${join(process.cwd(), 'scripts', 'lib', 'config-dir.sh')}"; resolve_claude_config_dir`], {
      cwd: process.cwd(),
      env: { ...env, HOME: homeDir },
      encoding: 'utf-8',
    });
    // Git Bash rewrites HOME to a POSIX path, so compare the tail only.
    expect(sh.trim().endsWith(`${basename(homeDir)}/.copilot`)).toBe(true);
  });

  it('keeps the CJS helper aligned with the TypeScript helper', () => {
    process.env.COPILOT_HOME = '~/.claude-alt';
    const cjsPath = join(process.cwd(), 'scripts', 'lib', 'config-dir.cjs');
    const output = execFileSync(
      process.execPath,
      ['-e', `const { getCopilotConfigDir } = require(${JSON.stringify(cjsPath)}); process.stdout.write(getCopilotConfigDir());`],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf-8',
      },
    );
    expect(output).toBe(normalize(join(homedir(), '.claude-alt')));
  });
});

describe('COPILOT_HOME downstream integration', () => {
  let origConfigDir: string | undefined;
  let tempDir: string;
  let tildeConfigDir: string;

  beforeEach(() => {
    origConfigDir = process.env.COPILOT_HOME;
    tempDir = join(tmpdir(), `omc-test-configdir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tildeConfigDir = join(homedir(), `.omc-test-configdir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (origConfigDir === undefined) {
      delete process.env.COPILOT_HOME;
    } else {
      process.env.COPILOT_HOME = origConfigDir;
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    try {
      rmSync(tildeConfigDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('accepts transcript paths under custom COPILOT_HOME', () => {
    process.env.COPILOT_HOME = '/opt/custom-claude-config';
    const transcriptPath = '/opt/custom-claude-config/projects/-foo/bar/session.jsonl';
    expect(isValidTranscriptPath(transcriptPath)).toBe(true);
  });

  it('accepts transcript paths when COPILOT_HOME uses a ~-prefixed path', () => {
    process.env.COPILOT_HOME = `~/${basename(tildeConfigDir)}`;
    const transcriptPath = join(tildeConfigDir, 'projects', '-foo', 'bar', 'session.jsonl');
    expect(isValidTranscriptPath(transcriptPath)).toBe(true);
  });

  it('discovers user rules from custom COPILOT_HOME/rules', () => {
    const customRulesDir = join(tempDir, 'rules');
    mkdirSync(customRulesDir, { recursive: true });
    writeFileSync(join(customRulesDir, 'my-rule.md'), '# My Rule\nRule content');

    process.env.COPILOT_HOME = tempDir;

    const candidates = findRuleFiles(null, '/some/file.ts');
    const globalRules = candidates.filter(c => c.isGlobal);

    expect(globalRules.length).toBeGreaterThanOrEqual(1);
    expect(globalRules.some(c => c.path.includes('my-rule.md'))).toBe(true);
  });

  it('uses the active config dir rather than default ~/.claude/rules for user rules', () => {
    const customRulesDir = join(tempDir, 'rules');
    mkdirSync(customRulesDir, { recursive: true });
    writeFileSync(join(customRulesDir, 'custom-rule.md'), '# Custom Rule');

    process.env.COPILOT_HOME = tempDir;

    const candidates = findRuleFiles(null, '/some/file.ts');
    const globalRules = candidates.filter(c => c.isGlobal);

    expect(globalRules.some(c => c.path.includes('custom-rule.md'))).toBe(true);
  });

  it('discovers user rules when COPILOT_HOME uses a ~-prefixed path', () => {
    const customRulesDir = join(tildeConfigDir, 'rules');
    mkdirSync(customRulesDir, { recursive: true });
    writeFileSync(join(customRulesDir, 'tilde-rule.md'), '# Tilde Rule');

    process.env.COPILOT_HOME = `~/${basename(tildeConfigDir)}`;

    const candidates = findRuleFiles(null, '/some/file.ts');
    const globalRules = candidates.filter(c => c.isGlobal);

    expect(globalRules.some(c => c.path.includes('tilde-rule.md'))).toBe(true);
  });
});
