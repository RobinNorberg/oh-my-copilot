import { describe, expect, it } from 'vitest';
import { decisionsViolation, loadTeamContext, pathsInDiff, pathsInText, resolveTeamConfig, TEAM_DECISIONS_PATH, TEAM_ROUTING_PATH, TeamConfigError, type ReadAt } from '../context.js';

const files = (m: Record<string, string>): ReadAt => (p) => m[p];
const ROUTING = '| src/** | executor | core | @robin |\n| docs/** | writer | docs | - |';

describe('loadTeamContext', () => {
  it('routes the paths and lists the newest decisions', () => {
    const c = loadTeamContext(files({ [TEAM_ROUTING_PATH]: ROUTING, [TEAM_DECISIONS_PATH]: '- a\n- b\n' }), ['src/x.ts'])!;
    expect(c.routes.map((r) => r.owner)).toEqual(['core']);
    expect(c.decisions.lines).toEqual(['- b', '- a']);
  });
  it('is undefined with neither file', () => {
    expect(loadTeamContext(files({}), ['src/x.ts'])).toBeUndefined();
  });
  it('reads only through the callback (the base commit)', () => {
    const asked: string[] = [];
    loadTeamContext((p) => { asked.push(p); return undefined; }, []);
    expect(asked.sort()).toEqual([TEAM_DECISIONS_PATH, TEAM_ROUTING_PATH].sort());
  });
});

describe('decisionsViolation', () => {
  it('compares the base text with the head text', () => {
    const base = files({ [TEAM_DECISIONS_PATH]: '- a\n' });
    expect(decisionsViolation(base, files({ [TEAM_DECISIONS_PATH]: '- a\n- b\n' }))).toBeUndefined();
    expect(decisionsViolation(base, files({ [TEAM_DECISIONS_PATH]: '- x\n' }))).toContain('changed');
    expect(decisionsViolation(base, files({}))).toContain('deleted');
    expect(decisionsViolation(files({}), files({ [TEAM_DECISIONS_PATH]: '- new\n' }))).toBeUndefined();
  });
});

describe('path extraction', () => {
  it('finds file paths in a plan', () => {
    expect(pathsInText('Edit `src/factory/poll.ts` and docs/a/b.md, not ../x/y.ts or version 1.2.3.')).toEqual(['src/factory/poll.ts', 'docs/a/b.md']);
  });
  it('finds changed paths in a diff', () => {
    expect(pathsInDiff('diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/old b/docs/n.md\n')).toEqual(['src/a.ts', 'docs/n.md']);
  });
});

describe('resolveTeamConfig', () => {
  it('defaults to 24 hours, later layers win, 0 is off', () => {
    expect(resolveTeamConfig([{}, undefined]).remindAfterHours).toBe(24);
    expect(resolveTeamConfig([{ factory: { poll: { remindAfterHours: 6 } } }, { factory: { poll: { remindAfterHours: 0 } } }]).remindAfterHours).toBe(0);
  });
  it('rejects bad values', () => {
    for (const bad of [-1, 1.5, '3', 99999]) expect(() => resolveTeamConfig([{ factory: { poll: { remindAfterHours: bad } } }])).toThrow(TeamConfigError);
    expect(() => resolveTeamConfig([{ factory: { poll: 3 } }])).toThrow(TeamConfigError);
  });
});
