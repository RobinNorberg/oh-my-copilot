import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { factoryCommand } from '../../cli/commands/factory.js';
import { createForge } from '../../forge/index.js';
import { assertFactoryCommand, FactorySafetyError } from '../run/exec.js';
import { runFactoryTriage, triageGuardExec, TRIAGE_JSON_SCHEMA_VERSION } from '../triage/cli.js';
const SHA = 'a'.repeat(40);
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const AC = '## Acceptance criteria\n- `omg x` exits 0\n';
/** A scripted gh + git. `edits` records every `gh issue edit`; `failEdit` makes one fail. */
function scripted(root, issues, o = {}) {
    return (cmd, args) => {
        const a = args.join(' ');
        if (cmd === 'git') {
            if (a === 'rev-parse --show-toplevel')
                return ok(`${root}\n`);
            if (a === 'remote get-url origin')
                return ok('https://github.com/o/r.git\n');
            if (a === 'fetch origin dev')
                return ok();
            if (a === 'rev-parse --verify refs/remotes/origin/dev')
                return ok(`${SHA}\n`);
            if (args[0] === 'cat-file')
                return ok();
            if (args[0] === 'ls-remote')
                return ok('');
            if (args[0] === 'show')
                return { status: 128, stdout: '', stderr: `fatal: path '${args[1].slice(41)}' does not exist in '${SHA}'` };
        }
        if (cmd === 'gh') {
            if (args[0] === 'issue' && args[1] === 'list')
                return ok(JSON.stringify(Object.keys(issues).map((n) => ({ number: Number(n) }))));
            if (args[0] === 'issue' && args[1] === 'view') {
                const n = Number(args[2]);
                const i = issues[n];
                if (!i)
                    return { status: 1, stdout: '', stderr: 'not found' };
                const labels = [...(i.labels ?? []), ...(i.epic ? ['epic'] : [])];
                return ok(JSON.stringify({ title: i.title, body: i.body, state: 'OPEN', url: `https://github.com/o/r/issues/${n}`, author: { login: 'o' }, comments: [], labels: labels.map((name) => ({ name })) }));
            }
            if (args[0] === 'pr' && args[1] === 'list') {
                const n = Number(/issue-(\d+)$/.exec(args[3])[1]);
                if (a.includes('--state merged'))
                    return ok('[]');
                return ok(JSON.stringify(o.prs?.[n] ? [{ number: o.prs[n], state: 'OPEN' }] : []));
            }
            if (args[0] === 'label' && args[1] === 'list')
                return ok(JSON.stringify((o.repoLabels ?? ['priority:p0', 'priority:p1', 'priority:p2', 'priority:p3', 'needs-plan', 'needs-split']).map((name) => ({ name }))));
            if (args[0] === 'issue' && args[1] === 'edit') {
                if (o.writesForbidden)
                    throw new Error(`WRITE ATTEMPTED: gh ${a}`);
                o.edits?.push(args);
                return o.failEdit?.includes(Number(args[2])) ? { status: 1, stdout: '', stderr: 'HTTP 403' } : ok();
            }
        }
        throw new Error(`unscripted ${cmd} ${a}`);
    };
}
let root;
let out;
let err;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-triage-'));
    out = [];
    err = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function deps(exec, over = {}) {
    return { exec, base: () => 'dev', trustedUser: () => undefined, projectConfig: () => undefined, createForge, isTTY: () => false, confirm: async () => false, out: (l) => out.push(l), err: (l) => err.push(l), ...over };
}
const run = (exec, o, over = {}) => runFactoryTriage({ ids: [], json: true, ...o }, deps(exec, over));
const json = () => JSON.parse(out.join('\n'));
const DEFAULT_P2 = { factory: { triage: { defaultPriority: 2 } } };
const ISSUES = {
    1: { title: 'ready, no priority', body: AC },
    2: { title: 'no plan', body: 'just do it', labels: ['priority:p1'] },
    3: { title: 'has a PR', body: AC },
    4: { title: 'two priorities, plan label a human set', body: AC, labels: ['priority:p3', 'Priority:P1', 'needs-plan'] },
    5: { title: 'an epic', body: 'big', epic: true, labels: ['priority:p2'] },
    6: { title: 'already triaged', body: AC, labels: ['priority:p2'] },
};
describe('omg factory triage (GitHub)', () => {
    it('is registered under omg factory', () => {
        expect(factoryCommand().commands.map((c) => c.name())).toContain('triage');
    });
    it('dry run performs no write (a fake that fails on any issue edit) and pins the --json shape', async () => {
        const exec = scripted(root, ISSUES, { prs: { 3: 9 }, writesForbidden: true });
        expect(await run(exec, { source: 'label:factory' })).toBe(0);
        const j = json();
        expect(Object.keys(j)).toEqual(['schemaVersion', 'ok', 'mode', 'forge', 'repo', 'source', 'config', 'counts', 'items', 'missingLabels', 'notes', 'warnings']);
        expect(j.schemaVersion).toBe(TRIAGE_JSON_SCHEMA_VERSION);
        expect(j).toMatchObject({ ok: true, mode: 'dry-run', forge: 'github', counts: { change: 3, unchanged: 2, skip: 1, applied: 0, failed: 0 } });
        expect(Object.keys(j.items[0])).toEqual(['id', 'title', 'url', 'action', 'skipReason', 'bucket', 'reasons', 'current', 'add', 'remove', 'priority', 'why']);
        const row = (id) => j.items.find((r) => r.id === id);
        expect(row(1)).toMatchObject({ action: 'unchanged', add: [], remove: [], priority: null });
        expect(row(2)).toMatchObject({ action: 'change', add: ['needs-plan'], remove: [] });
        expect(row(3)).toMatchObject({ action: 'skip', skipReason: 'pr-exists', add: [] });
        // check/score.ts ranks by the FIRST priority label (p3 here): keep it, never resolve the conflict upward; needs-plan is a human's to clear.
        expect(row(4)).toMatchObject({ action: 'change', add: [], remove: ['Priority:P1'] });
        expect(row(5)).toMatchObject({ action: 'change', add: ['needs-split'] });
        expect(row(6).action).toBe('unchanged');
    });
    it('--apply writes exactly the plan the dry run printed', async () => {
        const dry = scripted(root, ISSUES, { prs: { 3: 9 }, writesForbidden: true });
        await run(dry, { source: 'label:factory' });
        const plan = json().items;
        out.length = 0;
        const edits = [];
        expect(await run(scripted(root, ISSUES, { prs: { 3: 9 }, edits }), { source: 'label:factory', apply: true })).toBe(0);
        const applied = json();
        expect(applied.mode).toBe('apply');
        expect(applied.counts).toMatchObject({ change: 3, applied: 3, failed: 0 });
        // The apply output's rows are the dry run's rows plus the result.
        expect(applied.items.map(({ result: _r, ...rest }) => rest)).toEqual(plan);
        expect(edits).toEqual([
            ['issue', 'edit', '2', '--repo', 'github.com/o/r', '--add-label', 'needs-plan'],
            ['issue', 'edit', '4', '--repo', 'github.com/o/r', '--remove-label', 'Priority:P1'],
            ['issue', 'edit', '5', '--repo', 'github.com/o/r', '--add-label', 'needs-split'],
        ]);
    });
    it('is idempotent: applying, feeding the result back and applying again plans no change and runs no gh edit', async () => {
        const issues = JSON.parse(JSON.stringify(ISSUES));
        const edits = [];
        await run(scripted(root, issues, { prs: { 3: 9 }, edits }), { source: 'label:factory', apply: true });
        expect(json().counts.applied).toBe(3);
        // Feed the applied labels back into the tracker.
        for (const e of edits) {
            const i = issues[Number(e[2])];
            for (let k = 5; k < e.length; k += 2) {
                const l = e[k + 1];
                i.labels = e[k] === '--add-label' ? [...(i.labels ?? []), l] : (i.labels ?? []).filter((x) => x !== l);
            }
        }
        out.length = 0;
        edits.length = 0;
        expect(await run(scripted(root, issues, { prs: { 3: 9 }, edits }), { source: 'label:factory', apply: true })).toBe(0);
        expect(json().counts).toMatchObject({ change: 0, applied: 0, failed: 0 });
        expect(edits).toEqual([]);
    });
    it('reports a failed write per item and exits 1', async () => {
        const edits = [];
        expect(await run(scripted(root, ISSUES, { edits, failEdit: [2] }), { ids: ['5', '2'], apply: true })).toBe(1);
        const j = json();
        expect(j.ok).toBe(false);
        expect(j.counts).toMatchObject({ applied: 1, failed: 1 });
        expect(j.items.find((r) => r.id === 2).result).toEqual({ ok: false, detail: 'HTTP 403' });
    });
    it('skips (in both modes) the rows that would add a label the repository lacks', async () => {
        const repoLabels = ['priority:p0', 'priority:p1', 'priority:p3', 'needs-plan', 'needs-split'];
        expect(await run(scripted(root, ISSUES, { repoLabels, writesForbidden: true }), { ids: ['1', '2'] }, { trustedUser: () => DEFAULT_P2 })).toBe(0);
        const j = json();
        expect(j.warnings).toEqual(['label priority:p2 does not exist in https://github.com/o/r; rows needing it are skipped (omg factory triage never creates labels)']);
        expect(j.missingLabels).toEqual(['priority:p2']);
        expect(j.items.find((r) => r.id === 1)).toMatchObject({ action: 'skip', skipReason: 'label-missing:priority:p2', add: [] });
        expect(j.items.find((r) => r.id === 2).action).toBe('change');
    });
    it('a title or body never reaches a label name or an argv', async () => {
        const hostile = { 1: { title: '--add-label evil', body: `${AC}\n--remove-label x; rm -rf /` } };
        const edits = [];
        await run(scripted(root, hostile, { edits }), { ids: ['1'], apply: true }, { trustedUser: () => DEFAULT_P2 });
        expect(edits).toEqual([['issue', 'edit', '1', '--repo', 'github.com/o/r', '--add-label', 'priority:p2']]);
    });
    it('honours factory.triage from the user config, and refuses an unknown key or a priority-look-alike label', async () => {
        const cfg = { factory: { triage: { defaultPriority: false, labels: { needsPlan: 'needs-spec' } } } };
        await run(scripted(root, ISSUES, { writesForbidden: true, repoLabels: ['needs-spec'] }), { ids: ['1', '2'] }, { trustedUser: () => cfg });
        const j = json();
        expect(j.config).toMatchObject({ needsPlan: 'needs-spec', defaultPriority: null });
        expect(j.items.find((r) => r.id === 1).action).toBe('unchanged');
        expect(j.items.find((r) => r.id === 2)).toMatchObject({ add: ['needs-spec'] });
        for (const bad of [{ nope: 1 }, { labels: { needsPlan: 'priority:p1' } }, { labels: { needsPlan: 'factory:x' } }, { sizeSplitAt: 0 }]) {
            await expect(run(scripted(root, ISSUES), { ids: ['1'] }, { trustedUser: () => ({ factory: { triage: bad } }) })).rejects.toThrow();
        }
    });
});
describe('the triage write guard', () => {
    const ctx = { repo: 'o/r', bodyDir: '', labels: ['priority:p1', 'priority:p2', 'needs-plan'], purpose: 'triage' };
    const guard = (args, writes = ctx) => () => assertFactoryCommand('gh', args, [], undefined, undefined, writes ?? undefined);
    const edit = (...rest) => ['issue', 'edit', '7', '--repo', 'o/r', ...rest];
    it('passes label-only edits whose labels are on the allowlist', () => {
        expect(guard(edit('--add-label', 'priority:p1'))).not.toThrow();
        expect(guard(edit('--add-label', 'priority:p1', '--remove-label', 'priority:p2', '--remove-label', 'needs-plan'))).not.toThrow();
    });
    it('the enqueue context (no purpose) refuses the label-only edit, and the triage context refuses the enqueue title/body edit', () => {
        const { purpose: _p, ...enqueue } = ctx;
        expect(guard(edit('--add-label', 'priority:p1'), enqueue)).toThrow(FactorySafetyError);
        expect(guard(edit('--add-label', 'priority:p1'), { ...enqueue, purpose: 'enqueue' })).toThrow(FactorySafetyError);
        expect(guard(edit('--title', 't', '--body-file', 'x', '--add-label', 'priority:p1'))).toThrow(FactorySafetyError);
    });
    it('refuses everything else: no context, other repo, order, duplicates, off-list, reserved, flag-like and extra flags', () => {
        expect(guard(edit('--add-label', 'priority:p1'), null)).toThrow(FactorySafetyError);
        for (const args of [
            ['issue', 'edit', '7', '--repo', 'x/y', '--add-label', 'priority:p1'],
            edit('--remove-label', 'priority:p2', '--add-label', 'priority:p1'),
            edit('--add-label', 'priority:p1', '--add-label', 'PRIORITY:P1'),
            edit('--add-label', 'bug'),
            edit('--add-label', 'factory:running'),
            edit('--add-label', '--title'),
            edit('--add-label', 'priority:p1', '--add-assignee', 'someone'),
            edit('--add-label', 'priority:p1', '--title', 't'),
            ['issue', 'edit', '7', '--add-label', 'priority:p1'],
            ['issue', 'edit', '0', '--repo', 'o/r', '--add-label', 'priority:p1'],
            ['issue', 'close', '7'],
        ])
            expect(guard(args), args.join(' ')).toThrow(FactorySafetyError);
    });
    it('triageGuardExec refuses every write while not writing, and routes only edits while writing', () => {
        const seen = [];
        const inner = (cmd, args) => { seen.push(`${cmd} ${args.join(' ')}`); return ok('[]'); };
        let writing = false;
        const exec = triageGuardExec(inner, () => ctx, () => writing);
        expect(() => exec('gh', edit('--add-label', 'priority:p1'))).toThrow(FactorySafetyError);
        writing = true;
        expect(() => exec('gh', edit('--add-label', 'priority:p1'))).not.toThrow();
        expect(() => exec('gh', ['issue', 'comment', '7', '--body-file', 'x'])).toThrow(FactorySafetyError);
        expect(() => exec('gh', ['issue', 'create', '--repo', 'o/r', '--title', 't', '--body-file', 'x'])).toThrow(FactorySafetyError);
        expect(seen).toEqual(['gh issue edit 7 --repo o/r --add-label priority:p1']);
    });
});
//# sourceMappingURL=triage-github.test.js.map