import { describe, expect, it } from 'vitest';
import { formatIntakeSpec, validateIntake } from '../intake-pick.js';
describe('intake-pick: the local-backlog source', () => {
    it('formats with and without a label', () => {
        expect(formatIntakeSpec({ type: 'local-backlog' })).toBe('local-backlog');
        expect(formatIntakeSpec({ type: 'local-backlog', label: 'factory' })).toBe('local-backlog:factory');
    });
    it('validates without any forge call', () => {
        const io = new Proxy({}, { get: () => { throw new Error('no forge access expected'); } });
        expect(validateIntake(io, { type: 'local-backlog', label: 'factory' })).toEqual({ missingLabels: [] });
    });
});
//# sourceMappingURL=intake-pick-local.test.js.map