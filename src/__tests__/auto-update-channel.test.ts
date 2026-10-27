import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { formatUpdateNotification, getOmcUpdateChannel, REPO_OWNER, GITHUB_API_URL } from '../features/auto-update.js';
import { getCopilotConfigDir } from '../utils/config-dir.js';

const NPM_ROOT = join('/usr', 'lib', 'node_modules', 'oh-my-copilot');
const COPILOT_PLUGIN_ROOT = join(getCopilotConfigDir(), 'installed-plugins', 'omc', 'oh-my-copilot');

describe('getOmcUpdateChannel (same rule as session-start getUpdateChannel)', () => {
  it('is marketplace for a Claude Code plugin cache root', () => {
    const root = join(getCopilotConfigDir(), 'plugins', 'cache', 'omc', 'oh-my-copilot', '5.13.1');
    expect(getOmcUpdateChannel({ CLAUDE_PLUGIN_ROOT: root }, root)).toBe('marketplace');
  });

  it('is copilot-plugin for a Copilot installed-plugins root from the env', () => {
    expect(getOmcUpdateChannel({ PLUGIN_ROOT: COPILOT_PLUGIN_ROOT }, NPM_ROOT)).toBe('copilot-plugin');
  });

  it('is copilot-plugin from the package location alone, without env vars', () => {
    expect(getOmcUpdateChannel({}, COPILOT_PLUGIN_ROOT)).toBe('copilot-plugin');
    expect(getOmcUpdateChannel({}, 'C:\\Users\\u\\.copilot\\installed-plugins\\omc\\oh-my-copilot')).toBe('copilot-plugin');
  });

  it('is npm for anything else', () => {
    expect(getOmcUpdateChannel({}, NPM_ROOT)).toBe('npm');
  });
});

describe('formatUpdateNotification commands', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    for (const key of ['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT', 'COPILOT_CLI', 'COPILOT_AGENT_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const result = {
    currentVersion: '5.13.1',
    latestVersion: '5.13.2',
    updateAvailable: true,
    releaseInfo: { tag_name: 'v5.13.2', name: '', published_at: '', html_url: '', body: '', prerelease: false, draft: false },
    releaseNotes: 'No release notes available.',
  };

  it('gives the Copilot plugin update command for a Copilot plugin install', () => {
    process.env.PLUGIN_ROOT = COPILOT_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;

    const text = formatUpdateNotification(result);
    expect(text).toContain(
      'To update, run: copilot plugin marketplace update omc && copilot plugin update oh-my-copilot@omc',
    );
    expect(text).toContain('/plugin update oh-my-copilot@omc');
    expect(text).not.toContain('/plugin install');
  });

  it('never offers /update for the marketplace channel under Copilot', () => {
    const root = join(getCopilotConfigDir(), 'plugins', 'cache', 'omc', 'oh-my-copilot', '5.13.1');
    process.env.CLAUDE_PLUGIN_ROOT = root;
    delete process.env.PLUGIN_ROOT;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.COPILOT_CLI = '1';

    const text = formatUpdateNotification(result);
    expect(text).toContain('copilot plugin update oh-my-copilot@omc');
    expect(text).not.toContain('run: /update');
  });

  it('looks up releases in the fork repository', () => {
    expect(REPO_OWNER).toBe('RobinNorberg');
    expect(GITHUB_API_URL).toBe('https://api.github.com/repos/RobinNorberg/oh-my-copilot');
  });

  it('gives the npm command for an npm install under Copilot', () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.PLUGIN_ROOT;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.COPILOT_CLI = '1';

    const text = formatUpdateNotification(result);
    expect(text).toContain('To update, run: npm i -g oh-my-copilot@latest');
    expect(text).not.toContain('/update\n');
  });

  it('keeps the Claude Code wording under Claude Code', () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.PLUGIN_ROOT;
    delete process.env.COPILOT_CLI;
    delete process.env.COPILOT_AGENT_SESSION_ID;
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';

    const text = formatUpdateNotification(result);
    expect(text).toContain('  To update, run: /update\n  Or reinstall via: /plugin install oh-my-copilot\n');
  });
});
