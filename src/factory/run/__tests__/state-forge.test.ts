import { describe, expect, it } from 'vitest';
import { computeFactoryIntegrity, createFactoryState, forgeResumeProblem, parseFactoryState, verifyFactoryIntegrity } from '../state.js';

const NOW = '2026-10-28T10:00:00.000Z';
const sealed = <T extends object>(s: T) => ({ ...s, integrity: computeFactoryIntegrity(s as never) });

describe('FactoryRunState.forgeKind (critic amendments §A.9)', () => {
  it('a state written before forges (no forgeKind) still parses and its seal verifies', () => {
    const old = sealed(createFactoryState({ issue: 7, repoUrl: 'https://github.com/o/r', base: 'dev' }, NOW));
    expect('forgeKind' in old).toBe(false);
    const raw = JSON.stringify(old, null, 2);
    const parsed = parseFactoryState('run-7.json', 7, raw);
    expect(verifyFactoryIntegrity(parsed)).toBe(true);
  });

  it('forgeKind is covered by the seal', () => {
    const s = sealed({ ...createFactoryState({ issue: 7, repoUrl: 'https://github.com/o/r', base: 'dev' }, NOW), forgeKind: 'github' as const });
    expect(verifyFactoryIntegrity(s)).toBe(true);
    expect(verifyFactoryIntegrity({ ...s, forgeKind: 'azure-devops' })).toBe(false);
  });

  it('refuses an unknown forgeKind', () => {
    const s = { ...createFactoryState({ issue: 7, repoUrl: 'https://github.com/o/r', base: 'dev' }, NOW), forgeKind: 'gitlab' };
    expect(() => parseFactoryState('run-7.json', 7, JSON.stringify(s))).toThrow(/field forgeKind/);
  });
});

describe('forgeResumeProblem', () => {
  const base = createFactoryState({ issue: 7, repoUrl: 'https://github.com/o/r', base: 'dev' }, NOW);

  it('allows a resume on the recorded forge', () => {
    expect(forgeResumeProblem({ ...base, forgeKind: 'azure-devops' }, 'azure-devops')).toBeNull();
    expect(forgeResumeProblem({ ...base, forgeKind: 'github' }, 'github')).toBeNull();
  });

  it('treats a state without forgeKind as GitHub', () => {
    expect(forgeResumeProblem(base, 'github')).toBeNull();
    expect(forgeResumeProblem(base, 'azure-devops')).toMatch(/#7 started on github, but the forge now resolves to azure-devops/);
  });

  it('refuses a resume after the forge changed', () => {
    expect(forgeResumeProblem({ ...base, forgeKind: 'azure-devops' }, 'github')).toMatch(/started on azure-devops/);
  });
});
