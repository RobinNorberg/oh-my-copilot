import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateConfigSchema,
  loadConfig,
  validateAutopilotConfig,
  validateTeamConfig,
  validateWorkerPermissionsConfig,
} from '../config/loader.js';
import type { PluginConfig } from '../shared/types.js';

function withPerms(permissions: unknown): PluginConfig {
  return { permissions } as PluginConfig;
}

describe('permissions.workerDenyTools / workerDenyUrls validation', () => {
  it('accepts string arrays and absent keys', () => {
    expect(() => validateWorkerPermissionsConfig(withPerms({
      workerDenyTools: ['shell(git push)', 'shell(rm:*)', 'write(.env)'],
      workerDenyUrls: ['https://*.internal.example'],
    }))).not.toThrow();
    expect(() => validateWorkerPermissionsConfig(withPerms({ workerDenyTools: [] }))).not.toThrow();
    expect(() => validateWorkerPermissionsConfig(withPerms({ allowBash: true }))).not.toThrow();
    expect(() => validateWorkerPermissionsConfig({} as PluginConfig)).not.toThrow();
  });

  it.each([
    ['empty string', ['']],
    ['whitespace-only string', ['   ']],
    ['flag injection', ['--allow-all']],
    ['single-dash flag', ['-p']],
    ['NUL byte', ['shell(git\0push)']],
    ['newline', ['shell(git push)\n--allow-all']],
    ['carriage return', ['shell(git\rpush)']],
    ['tab', ['shell(git\tpush)']],
    ['escape sequence', ['shell(\u001b[31mgit)']],
    ['DEL', ['shell(git\u007fpush)']],
    ['non-string entry', [42]],
  ])('rejects %s in workerDenyTools', (_label, value) => {
    expect(() => validateWorkerPermissionsConfig(withPerms({ workerDenyTools: value })))
      .toThrow(/permissions\.workerDenyTools\[0\]/);
  });

  it('rejects control characters in workerDenyUrls with the control-character message', () => {
    expect(() => validateWorkerPermissionsConfig(withPerms({ workerDenyUrls: ['https://a.example\n'] })))
      .toThrow(/permissions\.workerDenyUrls\[0\].*contain control characters/);
  });

  it.each([
    ['string', 'shell(git push)'],
    ['object', { tool: 'shell' }],
    ['null', null],
  ])('rejects a non-array %s', (_label, value) => {
    expect(() => validateWorkerPermissionsConfig(withPerms({ workerDenyUrls: value })))
      .toThrow(/permissions\.workerDenyUrls: must be an array of strings/);
  });
});

describe('team provider validation accepts copilot', () => {
  it('accepts team.ops.defaultAgentType and roleRouting provider copilot', () => {
    expect(() => validateTeamConfig({
      team: { ops: { defaultAgentType: 'copilot' }, roleRouting: { executor: { provider: 'copilot' } } },
    } as PluginConfig)).not.toThrow();
  });

  it('accepts autopilot.team.agentTypes copilot and advertises it in the schema', () => {
    expect(() => validateAutopilotConfig({
      autopilot: { execution: 'team', team: { agentTypes: ['copilot'] } },
    } as PluginConfig)).not.toThrow();
    const schema = generateConfigSchema() as {
      properties: { autopilot: { properties: { team: { properties: { agentTypes: { items: { enum: string[] } } } } } } };
    };
    expect(schema.properties.autopilot.properties.team.properties.agentTypes.items.enum).toContain('copilot');
  });
});

describe('loadConfig() merges worker deny lists from omg.jsonc', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'omc-worker-perms-'));
    vi.stubEnv('COPILOT_HOME', join(tempDir, 'home'));
    mkdirSync(join(tempDir, '.copilot'), { recursive: true });
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults to empty lists', () => {
    const config = loadConfig();
    expect(config.permissions?.workerDenyTools).toEqual([]);
    expect(config.permissions?.workerDenyUrls).toEqual([]);
  });

  it('merges project lists and keeps other permission defaults', () => {
    writeFileSync(join(tempDir, '.copilot', 'omg.jsonc'), `{
      // deny wins over the worker allow flags
      "permissions": { "workerDenyTools": ["shell(git push)"], "workerDenyUrls": ["x.com"] }
    }`);
    const config = loadConfig();
    expect(config.permissions?.workerDenyTools).toEqual(['shell(git push)']);
    expect(config.permissions?.workerDenyUrls).toEqual(['x.com']);
    expect(config.permissions?.maxBackgroundTasks).toBe(5);
  });

  it('rejects a flag-shaped entry at load time', () => {
    writeFileSync(join(tempDir, '.copilot', 'omg.jsonc'), JSON.stringify({
      permissions: { workerDenyTools: ['--allow-all'] },
    }));
    expect(() => loadConfig()).toThrow(/permissions\.workerDenyTools\[0\]/);
  });
});
