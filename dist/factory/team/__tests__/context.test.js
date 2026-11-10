import { describe, expect, it } from 'vitest';
import { decisionsViolation, loadTeamContext, pathsInDiff, pathsInText, resolveTeamConfig, TEAM_DECISIONS_PATH, TEAM_ROUTING_PATH, TeamConfigError } from '../context.js';
const files = (m) => (p) => m[p];
const ROUTING = '| src/** | executor | core | @robin |\n| docs/** | writer | docs | - |';
describe('loadTeamContext', () => {
    it('routes the paths and lists the newest decisions', () => {
        const c = loadTeamContext(files({ [TEAM_ROUTING_PATH]: ROUTING, [TEAM_DECISIONS_PATH]: '- a\n- b\n' }), ['src/x.ts']);
        expect(c.routes.map((r) => r.owner)).toEqual(['core']);
        expect(c.decisions.lines).toEqual(['- b', '- a']);
    });
    it('is undefined with neither file', () => {
        expect(loadTeamContext(files({}), ['src/x.ts'])).toBeUndefined();
    });
    it('reads only through the callback (the base commit)', () => {
        const asked = [];
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
    it('reads quoted, spaced and renamed diff headers', () => {
        const diff = [
            'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
            'diff --git "a/src/tab\\there.ts" "b/src/tab\\there.ts"',
            'diff --git a/docs/x b/y.md b/docs/x b/y.md',
            'diff --git a/old.ts "b/docs/new\\"q.md"',
            'diff --git "a/old name.ts" b/src/renamed.ts',
            'diff --git a/old.ts b/docs/moved.md',
            'diff --git a/x b/../etc/passwd',
        ].join('\n');
        expect(pathsInDiff(diff)).toEqual(['src/café.ts', 'src/tab\there.ts', 'docs/x b/y.md', 'docs/new"q.md', 'src/renamed.ts', 'docs/moved.md']);
    });
    it('stays linear on long headers made of repeated quote-b-slash', () => {
        const header = (n) => `diff --git a/${'\\"b/'.repeat(4000)}${n}.ts b/${'\\"b/'.repeat(4000)}${n}.ts"`;
        const timeParse = (count) => {
            const diff = Array.from({ length: count }, (_, i) => header(i)).join('\n');
            const started = performance.now();
            pathsInDiff(diff);
            return performance.now() - started;
        };
        timeParse(50); // warm up
        const small = timeParse(100);
        const large = timeParse(400);
        // Linear parsing grows ~4x for 4x input; a quadratic parser would grow ~16x.
        expect(large).toBeLessThan(Math.max(small, 1) * 10);
        expect(large).toBeLessThan(20000);
    });
    it('resolves quoted, renamed, escaped and space-b-slash names', () => {
        const diff = [
            'diff --git "a/src/q\\"b/x.ts" "b/src/q\\"b/x.ts"',
            'diff --git a/old.ts b/new b/name.ts',
            'similarity index 90%',
            'rename from old.ts',
            'rename to new b/name.ts',
            'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
            'diff --git a/a b/a b/a b/a',
            '--- a/a b/a',
            '+++ b/a b/a',
            '@@ -1 +1 @@',
            '++ b/not-a-header.ts',
            'diff --git "a/\\360\\237\\230\\200.ts" "b/\\360\\237\\230\\200.ts"',
        ].join('\n');
        expect(pathsInDiff(diff)).toEqual(['src/q"b/x.ts', 'new b/name.ts', 'café.ts', 'a b/a', '\u{1F600}.ts']);
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
        for (const bad of [-1, 1.5, '3', 99999])
            expect(() => resolveTeamConfig([{ factory: { poll: { remindAfterHours: bad } } }])).toThrow(TeamConfigError);
        expect(() => resolveTeamConfig([{ factory: { poll: 3 } }])).toThrow(TeamConfigError);
    });
});
//# sourceMappingURL=context.test.js.map