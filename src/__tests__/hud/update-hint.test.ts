import { describe, it, expect, vi } from 'vitest';
import { renderUpdateHints } from '../../hud/elements/update-hint.js';
import { render } from '../../hud/render.js';
import { DEFAULT_HUD_CONFIG } from '../../hud/types.js';
import type { HudRenderContext, HudConfig } from '../../hud/types.js';

// Keep the OMC banner deterministic: the test checkout would otherwise be
// detected as a local install and append an "L" suffix.
vi.mock('../../lib/version.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/version.js')>()),
  isRuntimePackageLocal: () => false,
}));

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

function createMinimalContext(overrides: Partial<HudRenderContext> = {}): HudRenderContext {
  return {
    contextPercent: 30,
    modelName: 'claude-sonnet-4.6',
    ralph: null,
    ultrawork: null,
    prd: null,
    autopilot: null,
    activeAgents: [],
    todos: [],
    backgroundTasks: [],
    cwd: '/tmp/test',
    lastSkill: null,
    rateLimitsResult: null,
    customBuckets: null,
    pendingPermission: null,
    thinkingState: null,
    sessionHealth: null,
    omcVersion: null,
    updateAvailable: null,
    toolCallCount: 0,
    agentCallCount: 0,
    skillCallCount: 0,
    promptTime: null,
    apiKeySource: null,
    profileName: null,
    sessionSummary: null,
    ...overrides,
  };
}

function createMinimalConfig(overrides: Partial<HudConfig['elements']> = {}): HudConfig {
  return {
    ...DEFAULT_HUD_CONFIG,
    elements: {
      ...DEFAULT_HUD_CONFIG.elements,
      rateLimits: false,
      ralph: false,
      autopilot: false,
      prdStory: false,
      activeSkills: false,
      lastSkill: false,
      contextBar: false,
      agents: false,
      backgroundTasks: false,
      todos: false,
      ...overrides,
    },
  };
}

describe('renderUpdateHints', () => {
  it('returns no lines when nothing is behind', () => {
    expect(
      renderUpdateHints({
        omcUpdateAvailable: null,
        omcUpdateSource: 'npm',
        claudeCodeUpdateAvailable: null,
      }),
    ).toEqual([]);
  });

  it('uses the plugin command for marketplace installs', () => {
    const [line] = renderUpdateHints({
      omcUpdateAvailable: '4.2.0',
      omcUpdateSource: 'marketplace',
      claudeCodeUpdateAvailable: null,
    }).map(stripAnsi);

    expect(line).toBe(
      '[!] omg 4.2.0 - paste: ! claude plugin marketplace update omc && claude plugin update oh-my-copilot@omc',
    );
    expect(line.length).toBeLessThan(110);
  });

  it('uses the npm command for npm installs', () => {
    const [line] = renderUpdateHints({
      omcUpdateAvailable: '4.2.0',
      omcUpdateSource: 'npm',
      claudeCodeUpdateAvailable: null,
    }).map(stripAnsi);

    expect(line).toBe('[!] omg 4.2.0 - paste: ! npm i -g oh-my-copilot@latest');
  });

  it('renders one line per product', () => {
    const lines = renderUpdateHints({
      omcUpdateAvailable: '4.2.0',
      omcUpdateSource: 'npm',
      claudeCodeUpdateAvailable: '2.1.240',
    }).map(stripAnsi);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('[!] claude 2.1.240 - paste: ! claude update');
    expect(lines[1].length).toBeLessThan(110);
  });
});

describe('Claude Code update label', () => {
  it('renders when the installed version is behind', async () => {
    const output = stripAnsi(
      await render(
        createMinimalContext({
          claudeCodeVersion: '2.1.230',
          claudeCodeUpdateAvailable: '2.1.240',
        }),
        createMinimalConfig(),
      ),
    );

    expect(output).toContain('[Claude#2.1.230] -> 2.1.240 claude update');
    expect(output).toContain('[!] claude 2.1.240 - paste: ! claude update');
  });

  it('renders nothing when up to date or unknown', async () => {
    const upToDate = stripAnsi(
      await render(
        createMinimalContext({ claudeCodeVersion: '2.1.240', claudeCodeUpdateAvailable: null }),
        createMinimalConfig(),
      ),
    );
    expect(upToDate).not.toContain('claude update');

    const unknown = stripAnsi(await render(createMinimalContext(), createMinimalConfig()));
    expect(unknown).not.toContain('[Claude');
  });

  it('is suppressed when updateNotification is disabled', async () => {
    const output = stripAnsi(
      await render(
        createMinimalContext({
          claudeCodeVersion: '2.1.230',
          claudeCodeUpdateAvailable: '2.1.240',
        }),
        createMinimalConfig({ updateNotification: false }),
      ),
    );

    expect(output).not.toContain('claude update');
  });
});

describe('update hints under the Copilot host', () => {
  it('uses the in-session Copilot plugin command for Copilot plugin installs', () => {
    const [line] = renderUpdateHints({
      omcUpdateAvailable: '5.13.2',
      omcUpdateSource: 'copilot-plugin',
      claudeCodeUpdateAvailable: null,
      host: 'copilot',
    }).map(stripAnsi);

    expect(line).toBe('[!] omg 5.13.2 - paste: /plugin update oh-my-copilot@omc');
  });

  it('never offers the claude plugin command under Copilot', () => {
    const [line] = renderUpdateHints({
      omcUpdateAvailable: '5.13.2',
      omcUpdateSource: 'marketplace',
      claudeCodeUpdateAvailable: null,
      host: 'copilot',
    }).map(stripAnsi);

    expect(line).toBe('[!] omg 5.13.2 - paste: /plugin update oh-my-copilot@omc');
  });

  it('uses the npm command for npm installs', () => {
    const [line] = renderUpdateHints({
      omcUpdateAvailable: '5.13.2',
      omcUpdateSource: 'npm',
      claudeCodeUpdateAvailable: null,
      host: 'copilot',
    }).map(stripAnsi);

    expect(line).toBe('[!] omg 5.13.2 - paste: ! npm i -g oh-my-copilot@latest');
  });

  it('drops the Claude Code line even when the cache reports one', () => {
    const lines = renderUpdateHints({
      omcUpdateAvailable: null,
      omcUpdateSource: 'npm',
      claudeCodeUpdateAvailable: '2.1.311',
      host: 'copilot',
    });

    expect(lines).toEqual([]);
  });
});

describe('update-available render golden', () => {
  const updateState = {
    omcVersion: '5.13.1',
    updateAvailable: '5.13.2',
    claudeCodeVersion: '2.1.230',
    claudeCodeUpdateAvailable: '2.1.240',
  } as const;

  it('renders the Claude host byte-for-byte (oh-my-copilot label, Claude label and line kept)', async () => {
    const output = await render(
      createMinimalContext({ ...updateState, omcUpdateSource: 'marketplace' }),
      createMinimalConfig({ model: false, sessionHealth: false, showCallCounts: false }),
    );

    expect(stripAnsi(output)).toBe([
      '[oh-my-copilot#5.13.1] -> 5.13.2 omg update | [Claude#2.1.230] -> 2.1.240 claude update',
      '[!] omg 5.13.2 - paste: ! claude plugin marketplace update omc && claude plugin update oh-my-copilot@omc',
      '[!] claude 2.1.240 - paste: ! claude update',
    ].join('\n'));
  });

  it('renders the Copilot host with no Claude label, line or command', async () => {
    const output = stripAnsi(await render(
      createMinimalContext({ ...updateState, host: 'copilot', omcUpdateSource: 'copilot-plugin' }),
      createMinimalConfig({ model: false, sessionHealth: false, showCallCounts: false }),
    ));

    expect(output).toBe([
      '[oh-my-copilot#5.13.1] -> 5.13.2',
      '[!] omg 5.13.2 - paste: /plugin update oh-my-copilot@omc',
    ].join('\n'));
    expect(output).not.toContain('claude');
  });

  it('accepts omgLabel as the config key and omcLabel as a layout alias', async () => {
    const config = createMinimalConfig({ omcLabel: false, omgLabel: true, model: false, sessionHealth: false, showCallCounts: false });
    const output = stripAnsi(await render(
      createMinimalContext({ omcVersion: '5.13.1' }),
      { ...config, layout: { main: ['omcLabel'] } },
    ));

    expect(output).toBe('[oh-my-copilot#5.13.1]');
  });
});
