import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ARGS = ['costs $$5', 'pid=$$', 'use $& here', "it's $' x", 'a $` b', 'keep $1 and $<x>'];

describe('$ARGUMENTS is substituted literally', () => {
  const originalConfigDir = process.env.COPILOT_HOME;
  let configDir: string;

  beforeEach(() => {
    vi.resetModules();
    configDir = join(tmpdir(), `omc-args-literal-${process.pid}-${Date.now()}`);
    mkdirSync(join(configDir, 'commands'), { recursive: true });
    writeFileSync(
      join(configDir, 'commands', 'argsfixture.md'),
      '---\ndescription: fixture\n---\nBEFORE <$ARGUMENTS> AFTER\n',
    );
    process.env.COPILOT_HOME = configDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = originalConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  it.each(ARGS)('expandCommand keeps %j', async (args) => {
    const { expandCommand } = await import('../commands/index.js');
    expect(expandCommand('argsfixture', args)?.prompt).toBe(`BEFORE <${args}> AFTER`);
  });

  it.each(ARGS)('executeSlashCommand keeps %j', async (args) => {
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');
    const result = executeSlashCommand({ command: 'argsfixture', args, raw: `/argsfixture ${args}` });
    expect(result.success).toBe(true);
    expect(result.replacementText).toContain(`BEFORE <${args}> AFTER`);
  });
});
