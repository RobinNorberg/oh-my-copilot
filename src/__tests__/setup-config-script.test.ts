import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hosts such as lean-ctx refuse inline interpreter code (`node -e`), so the
// omc-setup skill must reach every check and config write through a script file.

const REPO_ROOT = join(__dirname, '..', '..');
const SETUP_CONFIG = join(REPO_ROOT, 'scripts', 'setup-config.mjs');
const SETUP_DIR = join(REPO_ROOT, 'skills', 'omc-setup');

const tempRoots: string[] = [];

function makeConfigDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'omc-setup-config-'));
  tempRoots.push(root);
  return root;
}

function run(configDir: string, args: string[], cwd = configDir) {
  return spawnSync(process.execPath, [SETUP_CONFIG, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, COPILOT_HOME: configDir },
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('omc-setup skill avoids inline interpreter code', () => {
  const docs = [
    join(SETUP_DIR, 'SKILL.md'),
    ...readdirSync(join(SETUP_DIR, 'phases')).map((f) => join(SETUP_DIR, 'phases', f)),
  ].filter((f) => f.endsWith('.md'));

  it('contains no node -e / node --eval invocation', () => {
    const offenders = docs.filter((doc) => /\bnode\s+(?:-e|--eval|-p|--print)\b/.test(readFileSync(doc, 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('only references setup-config subcommands that exist', () => {
    const used = new Set<string>();
    for (const doc of docs) {
      for (const match of readFileSync(doc, 'utf-8').matchAll(/scripts\/setup-config\.mjs" ([a-z-]+)/g)) {
        used.add(match[1]);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    for (const command of used) {
      const result = run(makeConfigDir(), [command, ...(command === 'merge-json' ? ['x.json', '{}'] : [])]);
      expect(result.stderr, `subcommand ${command}`).not.toContain('Usage: setup-config.mjs');
    }
  });
});

describe('setup-config.mjs', () => {
  it('reports configured state from .omc-config.json', () => {
    const configDir = makeConfigDir();
    expect(run(configDir, ['configured']).stdout).toContain('ALREADY_CONFIGURED=false');

    writeFileSync(join(configDir, '.omc-config.json'), JSON.stringify({ setupCompleted: '2026-01-01', setupVersion: '5.0.0' }));
    const done = run(configDir, ['configured']);
    expect(done.stdout).toContain('Setup version: 5.0.0');
    expect(done.stdout).toContain('ALREADY_CONFIGURED=true');
  });

  it('fails without touching an invalid config', () => {
    const configDir = makeConfigDir();
    writeFileSync(join(configDir, '.omc-config.json'), '{nope');
    expect(run(configDir, ['configured']).status).toBe(1);
    expect(run(configDir, ['set-task-tool', 'beads']).status).toBe(1);
    expect(readFileSync(join(configDir, '.omc-config.json'), 'utf-8')).toBe('{nope');
  });

  it('honours the claudeMdEnabled opt-out', () => {
    const configDir = makeConfigDir();
    expect(run(configDir, ['claude-md-enabled']).stdout.trim()).toBe('enabled');
    writeFileSync(join(configDir, '.omc-config.json'), JSON.stringify({ claudeMdEnabled: false }));
    expect(run(configDir, ['claude-md-enabled']).stdout.trim()).toBe('disabled');
  });

  it('reads the resume boundary from the setup state', () => {
    const configDir = makeConfigDir();
    expect(run(configDir, ['resume-boundary']).stdout).toContain('RESUMED_PHASE_TWO_BOUNDARY=false');

    mkdirSync(join(configDir, '.omg', 'state'), { recursive: true });
    writeFileSync(join(configDir, '.omg', 'state', 'setup-state.json'), JSON.stringify({ lastCompletedStep: 4 }));
    const resumed = run(configDir, ['resume-boundary']);
    expect(resumed.stdout).toContain('RESUME_LAST_COMPLETED_STEP=4');
    expect(resumed.stdout).toContain('RESUMED_PHASE_TWO_BOUNDARY=true');
  });

  it('clears only the retired defaultExecutionMode key', () => {
    const configDir = makeConfigDir();
    const file = join(configDir, '.omc-config.json');
    writeFileSync(file, JSON.stringify({ defaultExecutionMode: 'ultrawork', keep: 1 }));

    const result = run(configDir, ['clear-retired']);
    expect(result.stdout).toContain('Cleared retired defaultExecutionMode key');
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ keep: 1 });
  });

  it('stores the task tool and keeps existing keys', () => {
    const configDir = makeConfigDir();
    const file = join(configDir, '.omc-config.json');
    writeFileSync(file, JSON.stringify({ keep: 1 }));

    expect(run(configDir, ['set-task-tool', 'beads']).stdout).toContain('Task tool set to: beads');
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
      keep: 1,
      taskTool: 'beads',
      taskToolConfig: { injectInstructions: true, useMcp: false },
    });
  });

  it('deep-merges a patch into settings.json and verifies it', () => {
    const configDir = makeConfigDir();
    const file = join(configDir, 'settings.json');
    writeFileSync(file, JSON.stringify({ env: { A: '1' }, other: true }));

    const patch = JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } });
    expect(run(configDir, ['merge-json', 'settings.json', patch]).status).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
      env: { A: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
      other: true,
    });
    expect(run(configDir, ['verify-settings']).stdout).toContain('Agent teams: ENABLED');
  });

  it('refuses to merge outside the config directory', () => {
    const configDir = makeConfigDir();
    const result = run(configDir, ['merge-json', '..\\escape.json', '{}']);
    expect(result.status).toBe(1);
    expect(existsSync(join(configDir, '..', 'escape.json'))).toBe(false);
  });

  it('detects a 2.x upgrade and the installed plugin', () => {
    const configDir = makeConfigDir();
    expect(run(configDir, ['detect-upgrade']).stdout).toContain('IS_UPGRADE=false');
    mkdirSync(join(configDir, 'commands'), { recursive: true });
    writeFileSync(join(configDir, 'commands', 'ralph-loop.md'), '');
    expect(run(configDir, ['detect-upgrade']).stdout).toContain('IS_UPGRADE=true');

    expect(run(configDir, ['plugin-verify']).stdout).toContain('Plugin NOT found');
    writeFileSync(join(configDir, 'settings.json'), '{"enabledPlugins":{"oh-my-copilot@omc":true}}');
    expect(run(configDir, ['plugin-verify']).stdout).toContain('Plugin verified');
  });

  it('rejects an unknown subcommand', () => {
    const result = run(makeConfigDir(), ['nope']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: setup-config.mjs');
  });
});
