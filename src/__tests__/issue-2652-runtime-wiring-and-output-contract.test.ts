import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ULTRAWORK_MESSAGE } from '../installer/hooks.js';
import { getUltraworkMessage } from '../hooks/keyword-detector/ultrawork/index.js';

describe('issue #2652 runtime wiring and output contract', () => {
  it('ships the agentStop hook through persistent-mode.cjs', () => {
    const hooksJsonPath = join(process.cwd(), 'hooks', 'hooks.json');
    const hooks = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks?: Record<string, Array<{ type?: string; bash?: string; hooks?: Array<{ bash?: string }> }>>;
    };

    const agentStopCommands = (hooks.hooks?.agentStop ?? [])
      .map((entry) => entry.bash ?? '')
      .concat(
        (hooks.hooks?.agentStop ?? []).flatMap((entry) => (entry.hooks ?? []).map((h) => h.bash ?? '')),
      );

    expect(agentStopCommands.some((command) => command.includes('/scripts/persistent-mode.cjs'))).toBe(true);
  });

  it('ultrawork mode instructs spawned agents to keep outputs concise', () => {
    expect(ULTRAWORK_MESSAGE).toBe(getUltraworkMessage());
    expect(ULTRAWORK_MESSAGE).toContain('CONCISE OUTPUTS');
    expect(ULTRAWORK_MESSAGE).toContain('under 100 words');
    expect(ULTRAWORK_MESSAGE).toContain('files touched');
    expect(ULTRAWORK_MESSAGE).toContain('verification status');
  });
});
