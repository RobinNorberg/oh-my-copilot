import { describe, expect, it } from 'vitest';
import type { SetupIo } from '../guard.js';
import { formatIntakeSpec, validateIntake } from '../intake-pick.js';

describe('intake-pick: the local-backlog source', () => {
  it('formats with and without a label', () => {
    expect(formatIntakeSpec({ type: 'local-backlog' })).toBe('local-backlog');
    expect(formatIntakeSpec({ type: 'local-backlog', label: 'factory' })).toBe('local-backlog:factory');
  });

  it('validates without any forge call', () => {
    const io = new Proxy({}, { get: () => { throw new Error('no forge access expected'); } }) as SetupIo;
    expect(validateIntake(io, { type: 'local-backlog', label: 'factory' })).toEqual({ missingLabels: [] });
  });
});
