/**
 * Element visibility on the Copilot host: the config overlay (readHudConfig)
 * and render's own enforcement of the dropped elements. Claude is the control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { render } from '../../hud/render.js';
import { readHudConfig } from '../../hud/state.js';
import {
  COPILOT_HOST_DEFAULTS,
  COPILOT_HOST_DROPPED,
  DEFAULT_HUD_CONFIG,
  type HudConfig,
  type HudRenderContext,
} from '../../hud/types.js';

vi.mock('../../hud/elements/git.js', () => ({
  renderGitRepo: vi.fn(() => null),
  renderGitBranch: vi.fn(() => null),
  renderGitStatus: vi.fn(() => null),
}));

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/** A context with data for every element the Copilot host drops. */
function contextWithDroppedData(host: 'claude' | 'copilot'): HudRenderContext {
  return {
    host,
    contextPercent: 10,
    modelName: 'Claude Sonnet 5.5',
    ralph: null,
    ultrawork: null,
    prd: null,
    autopilot: null,
    activeAgents: [],
    todos: [{ content: 'write tests', status: 'in_progress', activeForm: 'Writing tests' }],
    backgroundTasks: [],
    cwd: '/home/user/project',
    lastSkill: null,
    rateLimitsResult: { rateLimits: { fiveHourPercent: 42, weeklyPercent: 7 } },
    customBuckets: null,
    pendingPermission: null,
    thinkingState: { active: true, lastSeen: new Date() },
    sessionHealth: null,
    omcVersion: null,
    updateAvailable: null,
    toolCallCount: 0,
    agentCallCount: 0,
    skillCallCount: 0,
    promptTime: null,
    apiKeySource: 'env',
    profileName: null,
    sessionSummary: { summary: 'hud lane', turnCount: 10, generatedAt: new Date().toISOString() },
    payloadEstimate: { estimatedBytes: 27_000_000, limitBytes: 32_000_000, pressure: 'critical', label: 'payload ~27MB est' },
  } as HudRenderContext;
}

const ALL_ON: HudConfig = {
  ...DEFAULT_HUD_CONFIG,
  elements: {
    ...DEFAULT_HUD_CONFIG.elements,
    rateLimits: true,
    apiKeySource: true,
    thinking: true,
    todos: true,
    sessionSummary: true,
    enterpriseMode: false,
    contextBar: false,
    safeMode: false,
  },
};

describe('Copilot host element visibility', () => {
  it('render drops the Copilot-invalid elements even when the config enables them', async () => {
    const claude = strip(await render(contextWithDroppedData('claude'), ALL_ON));
    const copilot = strip(await render(contextWithDroppedData('copilot'), ALL_ON));

    for (const marker of ['5h:', 'key:env', 'thinking', 'todos:', 'summary:', 'payload ~27MB']) {
      expect(claude, marker).toContain(marker);
      expect(copilot, marker).not.toContain(marker);
    }
  });

  describe('readHudConfig', () => {
    let root: string;
    const savedHome = process.env.COPILOT_HOME;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'hud-copilot-config-'));
      process.env.COPILOT_HOME = root;
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = savedHome;
      rmSync(root, { recursive: true, force: true });
    });

    function writeSettings(omcHud: unknown): void {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'settings.json'), JSON.stringify({ omcHud }));
    }

    it('keeps the Claude defaults without a host', () => {
      expect(readHudConfig()).toEqual(readHudConfig('claude'));
      const elements = readHudConfig().elements;
      expect(elements.model).toBe(true);
      expect(elements.effort).toBe(true);
      expect(elements.gitBranch).toBe(true);
      expect(elements.rateLimits).toBe(true);
    });

    it('hides model, effort, cwd and branch on Copilot, and a user true turns them back on', () => {
      expect(readHudConfig('copilot').elements).toMatchObject(COPILOT_HOST_DEFAULTS);
      writeSettings({ elements: { model: true, gitBranch: true } });
      const elements = readHudConfig('copilot').elements;
      expect(elements.model).toBe(true);
      expect(elements.gitBranch).toBe(true);
      expect(elements.effort).toBe(false);
    });

    it('forces the dropped elements off on Copilot whatever the user sets', () => {
      writeSettings({ preset: 'full', elements: { rateLimits: true, apiKeySource: true, todos: true, thinking: true } });
      expect(readHudConfig('copilot').elements).toMatchObject(COPILOT_HOST_DROPPED);
      expect(readHudConfig().elements).toMatchObject({ rateLimits: true, apiKeySource: true, todos: true, thinking: true });
    });
  });
});
