/**
 * Focused unit test for scripts/lib/agent-model-config.mjs, the per-agent
 * model resolver used by the PreToolUse hook (see
 * src/__tests__/pre-tool-enforcer.test.ts for the full injection behavior).
 * This file isolates just the project-config file-naming precedence so it
 * stays independent of the larger pre-tool-enforcer suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const MODULE_PATH = join(__dirname, '..', '..', 'scripts', 'lib', 'agent-model-config.mjs');

describe('scripts/lib/agent-model-config.mjs resolveConfiguredAgentModel', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'agent-model-config-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  async function resolve(subagentType: string): Promise<unknown> {
    const { resolveConfiguredAgentModel } = await import(pathToFileURL(MODULE_PATH).href);
    return resolveConfiguredAgentModel(subagentType, project);
  }

  it('prefers the canonical .copilot/omg.jsonc over a legacy .copilot/omc.jsonc project config', async () => {
    mkdirSync(join(project, '.copilot'), { recursive: true });
    writeFileSync(
      join(project, '.copilot', 'omg.jsonc'),
      JSON.stringify({ agents: { explore: { model: 'sonnet' } } }),
    );
    writeFileSync(
      join(project, '.copilot', 'omc.jsonc'),
      JSON.stringify({ agents: { explore: { model: 'haiku' } } }),
    );
    expect(await resolve('explore')).toBe('sonnet');
  });

  it('falls back to the legacy .copilot/omc.jsonc when the canonical file is absent', async () => {
    mkdirSync(join(project, '.copilot'), { recursive: true });
    writeFileSync(
      join(project, '.copilot', 'omc.jsonc'),
      JSON.stringify({ agents: { explore: { model: 'haiku' } } }),
    );
    expect(await resolve('explore')).toBe('haiku');
  });

  it('returns null when no project or user config carries an override', async () => {
    expect(await resolve('explore')).toBeNull();
  });
});
