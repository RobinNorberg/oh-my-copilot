import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginConfig } from '../../shared/types.js';
import { resolveSdkTeamSettings, startTeamV2 } from '../runtime-v2.js';

describe('team.sdk settings', () => {
  const previous = process.env.OMC_TEAM_SDK_MAX_CREDITS;
  afterEach(() => {
    if (previous === undefined) delete process.env.OMC_TEAM_SDK_MAX_CREDITS;
    else process.env.OMC_TEAM_SDK_MAX_CREDITS = previous;
  });

  const withCap = (value: unknown): PluginConfig => ({ team: { sdk: { maxCreditsPerWorker: value as number } } } as PluginConfig);

  it.each([['abc'], [0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], [null]])(
    'rejects maxCreditsPerWorker=%s as a config error',
    (value) => {
      delete process.env.OMC_TEAM_SDK_MAX_CREDITS;
      expect(() => resolveSdkTeamSettings(withCap(value))).toThrow(/^invalid_team_sdk_config:maxCreditsPerWorker/);
    },
  );

  it('accepts a positive cap below the runtime floor (the host enforces it; the runtime floors its own flag)', () => {
    delete process.env.OMC_TEAM_SDK_MAX_CREDITS;
    expect(resolveSdkTeamSettings(withCap(2.5)).maxCreditsPerWorker).toBe(2.5);
    expect(resolveSdkTeamSettings({} as PluginConfig).maxCreditsPerWorker).toBe(10);
  });

  it('lets a valid env value override the config cap', () => {
    process.env.OMC_TEAM_SDK_MAX_CREDITS = '7';
    expect(resolveSdkTeamSettings(withCap(3)).maxCreditsPerWorker).toBe(7);
  });
});

describe('startTeamV2 --transport sdk guards', () => {
  let cwd: string | undefined;
  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
  });

  it.each([
    ['an explicit critic role', { subject: 'Critique the plan', description: 'critique', role: 'critic' }],
    ['a role inferred from the task text', { subject: 'fix the failing tests', description: 'fix the failing tests' }],
  ])('rejects reviewer-contract roles (%s) before any side effect', async (_label, task) => {
    cwd = mkdtempSync(join(tmpdir(), 'sdk-team-contract-guard-'));
    const pluginConfig = { team: { roleRouting: { critic: { provider: 'copilot' } } } } as unknown as PluginConfig;
    await expect(startTeamV2({
      teamName: 'sdk-guard',
      workerCount: 1,
      agentTypes: ['copilot'],
      tasks: [task],
      cwd,
      transport: 'sdk',
      pluginConfig,
    })).rejects.toThrow(/^sdk_transport_unsupported:contract_roles:(critic|test-engineer) /);
    expect(existsSync(join(cwd, '.omg', 'state', 'team', 'sdk-guard'))).toBe(false);
  });
});
