import { describe, expect, it } from 'vitest';
import { DEFAULT_ADO_ITEM_TYPES, DEFAULT_CHECK_CONFIG } from '../../../forge/config.js';
import { GhCommandError } from '../../../forge/github/gh.js';
import { acceptanceItems, acceptanceSection, isVague } from '../rules.js';
import { checkItems, factoryCheckPreview, itemPriority, plainText } from '../score.js';
const AC = '## Acceptance criteria\n- `omg factory check --json` prints schemaVersion 1\n- exit code 2 on a bad id\n';
const PLAN_BASE = 'origin/dev at 0123456789ab';
function item(id, over = {}) {
    return {
        id,
        url: `https://github.com/o/r/issues/${id}`,
        title: `item ${id}`,
        body: AC,
        open: true,
        rawState: 'OPEN',
        authorTrusted: false,
        comments: [],
        labels: [],
        dependsOn: [],
        children: [],
        repoUrl: 'https://github.com/o/r',
        ...over,
    };
}
function fakeForge(w) {
    const reads = [];
    const byId = new Map(w.items.map((i) => [i.id, i]));
    const forge = {
        kind: w.kind ?? 'github',
        reads,
        tracker: {
            viewItem: (id) => {
                reads.push(id);
                if (w.failing?.[id])
                    throw w.failing[id];
                if (w.prStates?.[id])
                    throw new GhCommandError(`gh issue view ${id} returned no issue url`);
                const found = byId.get(id);
                if (!found)
                    throw new Error(`no item ${id}`);
                return found;
            },
            queryItems: () => w.items.map((i) => i.id),
            comment: () => { throw new Error('check never comments'); },
            setProgress: () => { throw new Error('check never sets progress'); },
            addMarker: () => { throw new Error('rules never mark'); },
        },
        reviews: {
            findOpenPrForBranch: (branch) => w.prs?.[branch],
            findMergedPrForBranch: (branch, base) => {
                if (w.mergedFails?.includes(branch))
                    throw new Error('gh pr list failed');
                return w.merged?.[`${branch} -> ${base}`];
            },
            viewPr: (pr) => {
                const state = w.prStates?.[pr];
                if (!state)
                    throw new Error(`no PR ${pr}`);
                return { number: pr, state };
            },
        },
    };
    return forge;
}
function env(w) {
    return {
        config: { intake: { itemTypes: w.itemTypes ?? [...DEFAULT_ADO_ITEM_TYPES], limit: 50, marker: 'factory-ready' }, check: { ...DEFAULT_CHECK_CONFIG } },
        runState: (id) => w.runs?.[id] ?? null,
        remoteBranch: (branch) => w.branches?.includes(branch) ?? false,
        readPlan: (path) => w.plans?.[path] ?? null,
        planBase: PLAN_BASE,
        base: 'dev',
    };
}
const check = (w) => checkItems(fakeForge(w), w.items.map((i) => i.id).filter((id) => id < 100), env(w));
const trustedPlan = (path) => ({ body: `omg-plan: ${path}`, author: 'owner', trusted: true });
const ROWS = [
    { rule: 'closed', world: { items: [item(1, { open: false, rawState: 'CLOSED' })] }, bucket: 'blocked', reasons: ['closed'], detail: 'the item is CLOSED' },
    {
        rule: 'wrong-type (ADO type not in itemTypes)',
        world: { kind: 'azure-devops', items: [item(1, { type: 'Task' })] },
        bucket: 'blocked', reasons: ['wrong-type'],
        detail: 'work item type "Task" is not in factory.intake.itemTypes (User Story, Bug, Product Backlog Item)',
    },
    {
        rule: 'wrong-type (GitHub id is a PR)',
        world: { items: [item(1)], failing: { 1: new GhCommandError('gh issue view 1 returned no issue url') } },
        bucket: 'blocked', reasons: ['wrong-type'],
    },
    { rule: 'run-active', world: { items: [item(1)], runs: { 1: { phase: 'review' } } }, bucket: 'blocked', reasons: ['run-active:review'] },
    { rule: 'run-active with a gate', world: { items: [item(1)], runs: { 1: { phase: 'merge', gate: { name: 'merge' } } } }, bucket: 'blocked', reasons: ['run-active:merge/merge'] },
    { rule: 'run-finished (merged: the engine never restarts it)', world: { items: [item(1)], runs: { 1: { phase: 'merged' } } }, bucket: 'blocked', reasons: ['run-finished:merged'] },
    { rule: 'run-finished (cancelled)', world: { items: [item(1)], runs: { 1: { phase: 'cancelled' } } }, bucket: 'blocked', reasons: ['run-finished:cancelled'] },
    { rule: 'run-finished (failed)', world: { items: [item(1)], runs: { 1: { phase: 'failed' } } }, bucket: 'blocked', reasons: ['run-finished:failed'] },
    {
        rule: 'branch-exists (a leftover origin branch without a PR)',
        world: { items: [item(1)], branches: ['factory/issue-1'] },
        bucket: 'blocked', reasons: ['branch-exists'], detail: 'origin/factory/issue-1 exists without an open PR; the engine would stop at head-moved-externally',
    },
    { rule: 'a dependency that is a merged or closed PR is satisfied', world: { items: [item(1, { dependsOn: [150, 151] })], prStates: { 150: 'MERGED', 151: 'CLOSED' } }, bucket: 'runnable', reasons: [] },
    { rule: 'a dependency that is an open PR blocks', world: { items: [item(1, { dependsOn: [150, 152] })], prStates: { 150: 'MERGED', 152: 'OPEN' } }, bucket: 'blocked', reasons: ['depends-on:#152'] },
    {
        rule: 'read-failed (the item read fails)',
        world: { items: [item(1)], failing: { 1: new Error('gh: HTTP 502\u001b[31m') } },
        bucket: 'blocked', reasons: ['read-failed'], detail: '#1 could not be read: gh: HTTP 502',
    },
    { rule: 'pr-exists', world: { items: [item(1)], prs: { 'factory/issue-1': 57 } }, bucket: 'blocked', reasons: ['pr-exists'], detail: 'open PR #57 already uses factory/issue-1' },
    {
        rule: 'depends-on (closed dependencies are resolved)',
        world: { items: [item(1, { dependsOn: [120, 121, 122] }), item(120), item(121), item(122, { open: false })] },
        bucket: 'blocked', reasons: ['depends-on:#120,#121'],
    },
    {
        rule: 'depends-on (an unreadable dependency counts as open)',
        world: { items: [item(1, { dependsOn: [130] })], failing: { 130: new Error('boom') } },
        bucket: 'blocked', reasons: ['depends-on:#130'],
    },
    {
        rule: 'depends-on is satisfied by a factory PR merged into the base while the issue is still open',
        world: { items: [item(1, { dependsOn: [160] }), item(160)], merged: { 'factory/issue-160 -> dev': 88 } },
        bucket: 'runnable', reasons: [],
    },
    {
        rule: 'depends-on is not satisfied by a factory PR merged into another base',
        world: { items: [item(1, { dependsOn: [160] }), item(160)], merged: { 'factory/issue-160 -> main': 88 } },
        bucket: 'blocked', reasons: ['depends-on:#160'],
    },
    {
        rule: 'depends-on is satisfied by a merged factory run state',
        world: { items: [item(1, { dependsOn: [160] }), item(160)], runs: { 160: { phase: 'merged' } } },
        bucket: 'runnable', reasons: [],
    },
    {
        rule: 'depends-on (a failed merged-PR lookup counts as unsatisfied)',
        world: { items: [item(1, { dependsOn: [160] }), item(160)], mergedFails: ['factory/issue-160'] },
        bucket: 'blocked', reasons: ['depends-on:#160'],
    },
    {
        rule: 'children stay open while their factory PR merged (needs-split reads the item state only)',
        world: { items: [item(1, { children: [161] }), item(161)], merged: { 'factory/issue-161 -> dev': 89 } },
        bucket: 'blocked', reasons: ['needs-split'],
    },
    { rule: 'needs-split (open children)', world: { items: [item(1, { children: [140, 141] }), item(140, { open: false }), item(141)] }, bucket: 'blocked', reasons: ['needs-split'], detail: 'has open children #141' },
    {
        rule: 'needs-split (ADO Epic)',
        world: { kind: 'azure-devops', itemTypes: ['Epic', 'User Story'], items: [item(1, { type: 'Epic' })] },
        bucket: 'blocked', reasons: ['needs-split'],
    },
    { rule: 'needs-split (GitHub label epic)', world: { items: [item(1, { labels: ['Epic'] })] }, bucket: 'blocked', reasons: ['needs-split'] },
    { rule: 'no-plan', world: { items: [item(1, { body: 'please fix' })] }, bucket: 'needs-plan', reasons: ['no-plan'] },
    {
        rule: 'no-plan (an untrusted omg-plan comment does not count)',
        world: { items: [item(1, { body: 'please fix', comments: [{ body: 'omg-plan: docs/p.md', author: 'drive-by', trusted: false }] })], plans: { 'docs/p.md': 'x' } },
        bucket: 'needs-plan', reasons: ['no-plan'],
    },
    {
        rule: 'no-plan (empty ADO AC field, no heading)',
        world: { kind: 'azure-devops', items: [item(1, { type: 'Bug', body: 'text', acceptance: '  ' })] },
        bucket: 'needs-plan', reasons: ['no-plan'],
    },
    {
        rule: 'plan-missing (not a repo path)',
        world: { items: [item(1, { body: 'x', comments: [trustedPlan('../etc/passwd')] })] },
        bucket: 'needs-plan', reasons: ['plan-missing'], detail: 'omg-plan "../etc/passwd" is not a repo-relative path',
    },
    {
        rule: 'plan-missing (missing on the base)',
        world: { items: [item(1, { body: 'x', comments: [trustedPlan('docs/plan.md')] })] },
        bucket: 'needs-plan', reasons: ['plan-missing'], detail: `omg-plan docs/plan.md is missing or empty on ${PLAN_BASE}`,
    },
    {
        rule: 'plan-missing (empty on the base)',
        world: { items: [item(1, { body: 'x', comments: [trustedPlan('docs/plan.md')] })], plans: { 'docs/plan.md': ' \n' } },
        bucket: 'needs-plan', reasons: ['plan-missing'],
    },
    { rule: 'ac-not-testable', world: { items: [item(1, { body: '## Acceptance criteria\nIt works well.\n## Notes\n- not an AC item\n' })] }, bucket: 'needs-plan', reasons: ['ac-not-testable'] },
    {
        rule: 'too-big (AC items)',
        world: { items: [item(1, { body: `## Acceptance criteria\n${Array.from({ length: 13 }, (_, i) => `- [ ] step ${i}`).join('\n')}` })] },
        bucket: 'blocked', reasons: ['too-big'], detail: '13 acceptance items (max 12)',
    },
    { rule: 'too-big (size)', world: { items: [item(1, { size: 9 })] }, bucket: 'blocked', reasons: ['too-big'], detail: 'size 9 (max 8)' },
    { rule: 'too-big (body)', world: { items: [item(1, { body: `${AC}${'x'.repeat(20_001)}` })] }, bucket: 'blocked', reasons: ['too-big'] },
    {
        rule: 'ac-vague',
        world: { items: [item(1, { body: '## Acceptance criteria\n- it should work\n- [ ] clean up the UI as needed\n' })] },
        bucket: 'needs-plan', reasons: ['ac-vague'],
    },
    {
        rule: 'one concrete item is enough against ac-vague',
        world: { items: [item(1, { body: '## Acceptance criteria\n- it should work\n- improve `omg doctor` output\n' })] },
        bucket: 'runnable', reasons: [], planSource: 'issue-body',
    },
    { rule: 'runnable (issue body)', world: { items: [item(1)] }, bucket: 'runnable', reasons: [], detail: 'plan: 2 acceptance items (issue-body)', planSource: 'issue-body' },
    {
        rule: 'runnable (trusted omg-plan on the base)',
        world: { items: [item(1, { body: 'see plan', comments: [trustedPlan('docs/plan.md')] })], plans: { 'docs/plan.md': '# plan' } },
        bucket: 'runnable', reasons: [], detail: 'plan: omg-plan docs/plan.md', planSource: 'omg-plan',
    },
    {
        rule: 'runnable (ADO acceptance field)',
        world: { kind: 'azure-devops', items: [item(1, { type: 'User Story', body: 'desc', acceptance: '- returns HTTP 404 for a missing id' })] },
        bucket: 'runnable', reasons: [], planSource: 'ado-acceptance',
    },
];
describe('omg factory check rules (forges §5)', () => {
    it.each(ROWS)('$rule -> $bucket $reasons', (row) => {
        const [result] = check(row.world);
        expect(result.bucket).toBe(row.bucket);
        expect(result.reasons).toEqual(row.reasons);
        if (row.detail !== undefined)
            expect(result.detail).toBe(row.detail);
        if (row.planSource !== undefined)
            expect(result.planSource).toBe(row.planSource);
    });
    it('the first rule hit wins (closed beats pr-exists, pr-exists beats no-plan)', () => {
        expect(check({ items: [item(1, { open: false, body: '' })], prs: { 'factory/issue-1': 3 } })[0].reasons).toEqual(['closed']);
        expect(check({ items: [item(1, { body: '' })], prs: { 'factory/issue-1': 3 } })[0].reasons).toEqual(['pr-exists']);
    });
    it('a failed read marks that item read-failed and the batch goes on', () => {
        const results = check({ items: [item(1), item(2)], failing: { 1: new Error('gh: HTTP 502') } });
        expect(results.map((r) => [r.id, r.bucket, r.reasons])).toEqual([[2, 'runnable', []], [1, 'blocked', ['read-failed']]]);
        const lookup = checkItems({ ...fakeForge({ items: [item(3)] }), reviews: { findOpenPrForBranch: () => { throw new Error('gh pr list failed'); } } }, [3], env({ items: [] }));
        expect(lookup[0]).toMatchObject({ id: 3, title: 'item 3', bucket: 'blocked', reasons: ['read-failed'], detail: '#3 could not be checked: gh pr list failed' });
    });
    it('AC section helpers', () => {
        expect(acceptanceSection('intro\n### Acceptance Criteria\n- a\n1. b\n## Next\n- c')).toBe('- a\n1. b');
        expect(acceptanceItems('- a\n* [x] b\n2) c\ntext\n-nospace')).toEqual(['a', 'b', 'c']);
        expect(isVague('should work')).toBe(true);
        expect(isVague('should work for exit code 3')).toBe(false);
        expect(isVague('add a flag')).toBe(false);
    });
});
describe('ordering and output', () => {
    it('orders by bucket, then priority (ADO Priority / GitHub priority:pN), then id', () => {
        const items = [
            item(1, { labels: ['priority:p3'] }),
            item(2, { body: 'nothing' }),
            item(3, { labels: ['priority:p0'] }),
            item(4),
            item(5, { priority: 2 }),
            item(6, { open: false }),
            item(7, { body: 'nothing', priority: 1 }),
        ];
        const results = check({ items });
        expect(results.map((r) => [r.id, r.bucket, r.priority])).toEqual([
            [3, 'runnable', 1], [5, 'runnable', 2], [1, 'runnable', 4], [4, 'runnable', null],
            [7, 'needs-plan', 1], [2, 'needs-plan', null],
            [6, 'blocked', null],
        ]);
        expect(itemPriority(item(9, { labels: ['priority:p9'] }))).toBeNull();
    });
    it('strips ANSI sequences and control characters from titles', () => {
        const [r] = check({ items: [item(1, { title: '\u001b[31mred\u001b[0m\r\nnext‮bidi\u0007' })] });
        expect(r.title).toBe('red  next bidi ');
        expect(r.title).not.toMatch(/\p{Cc}/u);
        expect(plainText('\u001b]0;title\u0007ok')).toBe('ok');
    });
    it('checks each id once, reading items only through forge.tracker', () => {
        const forge = fakeForge({ items: [item(1), item(2)] });
        expect(checkItems(forge, [2, 1, 2], env({ items: [] })).map((r) => r.id)).toEqual([1, 2]);
        expect(forge.reads).toEqual([2, 1]);
    });
    it('factoryCheckPreview fits the setup wizard PreviewCheck hook', () => {
        const w = { items: [item(1), item(2, { body: 'x' })], prs: {} };
        const rows = factoryCheckPreview(env(w))(fakeForge(w), [2, 1]);
        expect(rows).toEqual([
            { id: 1, title: 'item 1', url: 'https://github.com/o/r/issues/1', readiness: 'runnable' },
            { id: 2, title: 'item 2', url: 'https://github.com/o/r/issues/2', readiness: 'needs-plan: no-plan' },
        ]);
    });
});
//# sourceMappingURL=rules.test.js.map