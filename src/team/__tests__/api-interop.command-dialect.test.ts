import { describe, expect, it } from 'vitest';
import {
  buildLegacyTeamDeprecationHint,
  resolveTeamApiCliCommand,
} from '../api-interop.js';

describe('team api command dialect resolution', () => {
  it('defaults to omcp team api', () => {
    expect(resolveTeamApiCliCommand({} as NodeJS.ProcessEnv)).toBe('omcp team api');
  });

  it('returns omcp team api when running in OMC worker context', () => {
    expect(resolveTeamApiCliCommand({
      OMC_TEAM_WORKER: 'demo-team/worker-1',
    } as NodeJS.ProcessEnv)).toBe('omcp team api');

    expect(resolveTeamApiCliCommand({
      OMC_TEAM_STATE_ROOT: '/tmp/project/.omcp/state',
    } as NodeJS.ProcessEnv)).toBe('omcp team api');
  });

  it('builds legacy deprecation hint with omc command', () => {
    const hint = buildLegacyTeamDeprecationHint(
      'team_claim_task',
      { team_name: 'demo', task_id: '1', worker: 'worker-1' },
      { OMC_TEAM_WORKER: 'demo/worker-1' } as NodeJS.ProcessEnv,
    );
    expect(hint).toContain('Use CLI interop: omcp team api claim-task');
  });
});
