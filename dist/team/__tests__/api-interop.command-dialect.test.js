import { describe, expect, it } from 'vitest';
import { buildLegacyTeamDeprecationHint, resolveTeamApiCliCommand, } from '../api-interop.js';
describe('team api command dialect resolution', () => {
    it('defaults to omc team api', () => {
        expect(resolveTeamApiCliCommand({})).toBe('omc team api');
    });
    it('returns omc team api when running in OMC worker context', () => {
        expect(resolveTeamApiCliCommand({
            OMC_TEAM_WORKER: 'demo-team/worker-1',
        })).toBe('omc team api');
        expect(resolveTeamApiCliCommand({
            OMC_TEAM_STATE_ROOT: '/tmp/project/.omg/state',
        })).toBe('omc team api');
    });
    it('builds legacy deprecation hint with omc command', () => {
        const hint = buildLegacyTeamDeprecationHint('team_claim_task', { team_name: 'demo', task_id: '1', worker: 'worker-1' }, { OMC_TEAM_WORKER: 'demo/worker-1' });
        expect(hint).toContain('Use CLI interop: omc team api claim-task');
    });
});
//# sourceMappingURL=api-interop.command-dialect.test.js.map