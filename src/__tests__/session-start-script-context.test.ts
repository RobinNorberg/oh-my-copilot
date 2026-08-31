import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'session-start.mjs');
const NODE = process.execPath;

describe('session-start.mjs regression #1386', () => {
  let tempDir: string;
  let fakeHome: string;
  let fakeProject: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-script-'));
    fakeHome = join(tempDir, 'home');
    fakeProject = join(tempDir, 'project');
    mkdirSync(fakeProject, { recursive: true });
    mkdirSync(join(fakeProject, '.omg', 'state', 'sessions', 'session-1386'), { recursive: true });
    // session-start validateCwd requires a real workspace anchor.
    execFileSync('git', ['init', '--quiet', fakeProject], { stdio: 'ignore' });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not restore retired ultrawork state', () => {
    writeFileSync(
      join(fakeProject, '.omg', 'state', 'sessions', 'session-1386', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-1386',
        started_at: '2026-03-06T00:00:00.000Z',
        original_prompt: 'Old task that should not override a new request',
      }),
    );

    const raw = execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-1386',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
      timeout: 15000,
    }).trim();

    const output = JSON.parse(raw) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    const context = output.hookSpecificOutput?.additionalContext || '';

    expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
    expect(context).not.toContain('Old task that should not override a new request');
  });

  it('injects persisted project memory into session-start additionalContext', () => {
    mkdirSync(join(fakeProject, '.omg'), { recursive: true });
    writeFileSync(
      join(fakeProject, '.omg', 'project-memory.json'),
      JSON.stringify({
        version: '1.0.0',
        lastScanned: Date.now(),
        projectRoot: fakeProject,
        techStack: {
          languages: [
            {
              name: 'TypeScript',
              version: '5.0.0',
              confidence: 'high',
              markers: ['tsconfig.json', 'package.json'],
            },
          ],
          frameworks: [],
          packageManager: 'pnpm',
          runtime: 'node',
        },
        build: {
          buildCommand: 'pnpm build',
          testCommand: 'pnpm test',
          lintCommand: null,
          devCommand: null,
          scripts: {},
        },
        conventions: {
          namingStyle: null,
          importStyle: null,
          testPattern: null,
          fileOrganization: null,
        },
        structure: {
          isMonorepo: false,
          workspaces: [],
          mainDirectories: ['src'],
          gitBranches: null,
        },
        customNotes: [
          {
            timestamp: Date.now(),
            source: 'manual',
            category: 'env',
            content: 'Requires LOCAL_API_BASE for smoke tests',
          },
        ],
        directoryMap: {},
        hotPaths: [],
        userDirectives: [
          {
            timestamp: Date.now(),
            directive: 'Preserve project memory directives at session start',
            context: '',
            source: 'explicit',
            priority: 'high',
          },
        ],
      }),
    );

    const raw = execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-1779',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
      timeout: 15000,
    }).trim();

    const output = JSON.parse(raw) as {
      continue: boolean;
      hookSpecificOutput?: { additionalContext?: string };
    };
    const context = output.hookSpecificOutput?.additionalContext || '';

    expect(output.continue).toBe(true);
    expect(context).toContain('<project-memory-context>');
    expect(context).toContain('[PROJECT MEMORY]');
    expect(context).toContain('Preserve project memory directives at session start');
    expect(context).toContain('[Project Environment]');
    expect(context).toContain('- TypeScript | pkg:pnpm | node');
    expect(context).toContain('- build=pnpm build | test=pnpm test');
    expect(context).toContain('[env] Requires LOCAL_API_BASE for smoke tests');
    expect(context).toContain('</project-memory-context>');
  });

  it('injects model routing override for non-standard providers before lower-priority context', () => {
    writeFileSync(
      join(fakeProject, 'AGENTS.md'),
      `# oh-my-copilot - Intelligent Multi-Agent Orchestration

<guidance_schema_contract>schema</guidance_schema_contract>

<operating_principles>
${'- oversized startup guidance\n'.repeat(700)}
</operating_principles>`,
    );

    const raw = execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-bedrock-script',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
      timeout: 15000,
    }).trim();

    const output = JSON.parse(raw) as {
      continue: boolean;
      hookSpecificOutput?: { additionalContext?: string };
    };
    const context = output.hookSpecificOutput?.additionalContext || '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MODEL ROUTING OVERRIDE');
    expect(context).toContain('tier alias');
    expect(context).toMatch(/\b(sonnet|opus|haiku)\b/);
    expect(context).not.toContain('Do NOT pass the `model` parameter');
    expect(context).not.toContain('Omit it entirely');
    expect(context.length).toBeLessThanOrEqual(6000);
  });

  it('surfaces update notices through systemMessage without injecting them into additionalContext', () => {
    const copilotDir = join(fakeHome, '.copilot');
    const pluginRoot = join(tempDir, 'plugin');
    mkdirSync(join(copilotDir, '.omg'), { recursive: true });
    mkdirSync(join(copilotDir, 'hud'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '1.0.0', type: 'module' }));
    writeFileSync(join(copilotDir, 'hud', 'omg-hud.mjs'), '');
    writeFileSync(join(copilotDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.copilot/hud/omg-hud.mjs' }));
    writeFileSync(
      join(copilotDir, '.omg', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '999.0.0',
        currentVersion: '1.0.0',
        updateAvailable: true,
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-update-script',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as {
      continue: boolean;
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(output.continue).toBe(true);
    expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage).toContain('v999.0.0');
    expect(output.systemMessage).toContain('/update');
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('999.0.0');
  });

  it('does not show update notice when stale CLAUDE_PLUGIN_ROOT is older than plugin cache', () => {
    const copilotDir = join(fakeHome, '.copilot');
    const stalePluginRoot = join(copilotDir, 'plugins', 'cache', 'omc', 'oh-my-copilot', '4.14.4');
    const latestPluginRoot = join(copilotDir, 'plugins', 'cache', 'omc', 'oh-my-copilot', '4.14.5');
    mkdirSync(join(copilotDir, '.omg'), { recursive: true });
    mkdirSync(join(copilotDir, 'hud'), { recursive: true });
    mkdirSync(stalePluginRoot, { recursive: true });
    mkdirSync(latestPluginRoot, { recursive: true });
    writeFileSync(join(stalePluginRoot, 'package.json'), JSON.stringify({ version: '4.14.4', type: 'module' }));
    writeFileSync(join(latestPluginRoot, 'package.json'), JSON.stringify({ version: '4.14.5', type: 'module' }));
    writeFileSync(join(copilotDir, 'hud', 'omg-hud.mjs'), '');
    writeFileSync(join(copilotDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.copilot/hud/omg-hud.mjs' }));
    writeFileSync(
      join(copilotDir, '.omg', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '4.14.5',
        currentVersion: '4.14.4',
        updateAvailable: true,
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-stale-plugin-root',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: stalePluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as {
      continue: boolean;
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(output.continue).toBe(true);
    expect(output.systemMessage ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage ?? '').not.toContain('4.14.4');
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
  });


  it('suppresses plugin update notices when npm latest is newer than the marketplace channel', () => {
    const copilotDir = join(fakeHome, '.copilot');
    const pluginRoot = join(copilotDir, 'plugins', 'cache', 'omc', 'oh-my-copilot', '4.15.4');
    const marketplaceRoot = join(copilotDir, 'plugins', 'marketplaces', 'omc');
    mkdirSync(join(copilotDir, '.omg'), { recursive: true });
    mkdirSync(join(copilotDir, 'hud'), { recursive: true });
    mkdirSync(join(pluginRoot), { recursive: true });
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.4', type: 'module' }));
    writeFileSync(join(marketplaceRoot, 'package.json'), JSON.stringify({ version: '4.15.4', type: 'module' }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'oh-my-copilot', version: '4.15.4' }],
      version: '4.15.4',
    }));
    writeFileSync(join(copilotDir, 'hud', 'omg-hud.mjs'), '');
    writeFileSync(join(copilotDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.copilot/hud/omg-hud.mjs' }));
    writeFileSync(
      join(copilotDir, '.omg', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '4.15.5',
        currentVersion: '4.15.4',
        updateAvailable: true,
        source: 'npm',
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-marketplace-channel-current',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };
    expect(output.systemMessage ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage ?? '').not.toContain('4.15.5');
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
  });

  it('does not fall back to npm notices when marketplace metadata is unavailable', () => {
    const copilotDir = join(fakeHome, '.copilot');
    const pluginRoot = join(copilotDir, 'plugins', 'cache', 'omc', 'oh-my-copilot', '4.15.4');
    const marketplaceRoot = join(copilotDir, 'plugins', 'marketplaces', 'omc');
    mkdirSync(join(copilotDir, '.omg'), { recursive: true });
    mkdirSync(join(copilotDir, 'hud'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.4', type: 'module' }));
    writeFileSync(join(marketplaceRoot, 'package.json'), JSON.stringify({ version: '999.0.0', type: 'module' }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'oh-my-copilot',
      version: '999.0.0',
    }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'oh-my-copilot', version: '999x.0.0' }],
    }));
    writeFileSync(join(copilotDir, 'hud', 'omg-hud.mjs'), '');
    writeFileSync(join(copilotDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.copilot/hud/omg-hud.mjs' }));
    writeFileSync(
      join(copilotDir, '.omg', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '4.15.5',
        currentVersion: '4.15.4',
        updateAvailable: true,
        source: 'npm',
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-marketplace-channel-unavailable',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage ?? '').not.toContain('4.15.5');
    expect(JSON.parse(readFileSync(join(copilotDir, '.omg', 'update-check.json'), 'utf-8'))).toMatchObject({
      latestVersion: '4.15.4',
      currentVersion: '4.15.4',
      updateAvailable: false,
      source: 'marketplace-unavailable',
    });
  });

  it('treats a stable marketplace version as newer than the matching prerelease', () => {
    const copilotDir = join(fakeHome, '.copilot');
    const pluginRoot = join(copilotDir, 'plugins', 'cache', 'omc', 'oh-my-copilot', '4.16.0-beta.1');
    const marketplaceRoot = join(copilotDir, 'plugins', 'marketplaces', 'omc');
    mkdirSync(join(copilotDir, 'hud'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.16.0-beta.1', type: 'module' }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'oh-my-copilot', version: '4.16.0' }],
    }));
    writeFileSync(join(copilotDir, 'hud', 'omg-hud.mjs'), '');
    writeFileSync(join(copilotDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.copilot/hud/omg-hud.mjs' }));

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-marketplace-stable-after-prerelease',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage).toContain('v4.16.0');
  });

  it('uses the marketplace clone version for plugin update notices instead of npm latest', () => {
    const copilotDir = join(fakeHome, '.copilot');
    const pluginRoot = join(copilotDir, 'plugins', 'cache', 'omc', 'oh-my-copilot', '4.15.3');
    const marketplaceRoot = join(copilotDir, 'plugins', 'marketplaces', 'omc');
    mkdirSync(join(copilotDir, '.omg'), { recursive: true });
    mkdirSync(join(copilotDir, 'hud'), { recursive: true });
    mkdirSync(join(pluginRoot), { recursive: true });
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.3', type: 'module' }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'oh-my-copilot', version: '4.15.4' }],
      version: '4.15.4',
    }));
    writeFileSync(join(copilotDir, 'hud', 'omg-hud.mjs'), '');
    writeFileSync(join(copilotDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.copilot/hud/omg-hud.mjs' }));
    writeFileSync(
      join(copilotDir, '.omg', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '4.15.5',
        currentVersion: '4.15.3',
        updateAvailable: true,
        source: 'npm',
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-marketplace-channel-update',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage).toContain('v4.15.4');
    expect(output.systemMessage).not.toContain('4.15.5');
    expect(output.systemMessage).toContain('/plugin marketplace update omc && /omc-setup');
    expect(output.systemMessage).not.toContain('/update');
  });

  it('does not emit npm-channel drift guidance when managed marketplace plugin is current', () => {
    const copilotDir = join(fakeHome, '.copilot');
    const pluginRoot = join(copilotDir, 'plugins', 'cache', 'omc', 'oh-my-copilot', '4.15.4');
    const marketplaceRoot = join(copilotDir, 'plugins', 'marketplaces', 'omc');
    mkdirSync(join(copilotDir, '.omg'), { recursive: true });
    mkdirSync(join(copilotDir, 'hud'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.4', type: 'module' }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'oh-my-copilot', version: '4.15.4' }],
    }));
    writeFileSync(join(copilotDir, '.omc-version.json'), JSON.stringify({ version: '4.15.5' }));
    writeFileSync(join(copilotDir, 'hud', 'omg-hud.mjs'), '');
    writeFileSync(join(copilotDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.copilot/hud/omg-hud.mjs' }));
    writeFileSync(
      join(copilotDir, '.omg', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '4.15.5',
        currentVersion: '4.15.4',
        updateAvailable: true,
        source: 'npm',
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-marketplace-current-npm-newer',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as {
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    const combined = `${output.systemMessage ?? ''}\n${output.hookSpecificOutput?.additionalContext ?? ''}`;
    expect(combined).not.toContain('[OMC VERSION DRIFT DETECTED]');
    expect(combined).not.toContain("Run 'omc update'");
    expect(combined).not.toContain('4.15.5');
  });

  it('shows an npm update from unmanaged 4.15.7 local plugin roots (#3867)', () => {
    const copilotDir = join(fakeHome, '.copilot');
    const pluginRoot = join(tempDir, 'local-plugin-4.15.7');
    mkdirSync(join(copilotDir, '.omg'), { recursive: true });
    mkdirSync(join(copilotDir, 'hud'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.7', type: 'module' }));
    writeFileSync(join(copilotDir, 'hud', 'omg-hud.mjs'), '');
    writeFileSync(join(copilotDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.copilot/hud/omg-hud.mjs' }));
    writeFileSync(
      join(copilotDir, '.omg', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '5.0.0',
        currentVersion: '4.15.7',
        updateAvailable: true,
        source: 'npm',
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-3867-unmanaged-4157',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        COPILOT_CONFIG_DIR: join(fakeHome, '.copilot'),
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage).toContain('v5.0.0');
    expect(output.systemMessage).toContain('current: v4.15.7');
    expect(output.systemMessage).not.toContain('4.15.7L');
  });

  it('does not advertise npm 5.0.0 when managed marketplace channel is still 4.15.7 (#3867)', () => {
    const copilotDir = join(fakeHome, '.copilot');
    const pluginRoot = join(copilotDir, 'plugins', 'cache', 'omc', 'oh-my-copilot', '4.15.7');
    const marketplaceRoot = join(copilotDir, 'plugins', 'marketplaces', 'omc');
    mkdirSync(join(copilotDir, '.omg'), { recursive: true });
    mkdirSync(join(copilotDir, 'hud'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '4.15.7', type: 'module' }));
    writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'oh-my-copilot', version: '4.15.7' }],
      version: '4.15.7',
    }));
    writeFileSync(join(copilotDir, 'hud', 'omg-hud.mjs'), '');
    writeFileSync(join(copilotDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.copilot/hud/omg-hud.mjs' }));
    writeFileSync(
      join(copilotDir, '.omg', 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '5.0.0',
        currentVersion: '4.15.7',
        updateAvailable: true,
        source: 'npm',
      }),
    );
    // COPILOT_CONFIG_DIR beats HOME. A leaked host/empty config dir would hide
    // the fixture marketplace clone and leave the npm 5.0.0 cache in place.
    const leakedHostConfigDir = join(tempDir, 'host-empty-claude-config');
    mkdirSync(leakedHostConfigDir, { recursive: true });
    const leakedHostEnv = {
      ...process.env,
      COPILOT_CONFIG_DIR: leakedHostConfigDir,
    };

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-3867-managed-4157',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...leakedHostEnv,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        COPILOT_CONFIG_DIR: join(fakeHome, '.copilot'),
        OMC_NOTIFY: '0',
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage ?? '').not.toContain('5.0.0');
    expect(JSON.parse(readFileSync(join(copilotDir, '.omg', 'update-check.json'), 'utf-8'))).toMatchObject({
      latestVersion: '4.15.7',
      currentVersion: '4.15.7',
      updateAvailable: false,
      source: 'marketplace',
    });
  });
});
