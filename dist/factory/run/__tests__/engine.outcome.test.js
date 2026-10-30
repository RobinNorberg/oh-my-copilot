/**
 * Outcome write-back (shipyard ↔ factory design §3.6, §9 PR 6): the engine
 * posts one outcome comment on the item per terminal phase and one rollup
 * line on the parent spec, exactly once per (child, phase, head), through the
 * real factory guard; a comment failure never blocks a transition and the
 * spec body is never edited.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../budget.js';
import { runFactoryEngine } from '../engine.js';
import { outcomeMarker, outcomePosts, postedBefore } from '../outcome.js';
import { EngineLedger } from '../ledger.js';
import { createFactoryState, factoryStatePath, readFactoryState, requestFactoryCancel, updateFactoryState } from '../state.js';
import { commitFile, FakeLanes, FakeProcesses, harness, ISSUE, PR, REPO_URL, review, testGateConfig } from './fake-lanes.js';
const SPEC = 12;
let h;
/** Every issue comment the engine posted: target and body. */
let posted;
/** The parent spec's comments as `gh issue view` reports them. */
let specComments;
/** Answer for `gh issue comment <n>` (posting still records nothing on failure). */
let commentResult;
let warnings;
beforeEach(() => {
    h = harness('omg-factory-outcome-');
    h.gh.issue.body = `${h.gh.issue.body}\nPart of #${SPEC}\n`;
    posted = [];
    specComments = [];
    commentResult = () => ({ status: 0, stdout: '', stderr: '' });
    warnings = [];
});
afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true });
});
const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
const exec = (cmd, args, o) => {
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        const n = Number(args[2]);
        const res = commentResult(n);
        if (res.status !== 0)
            return res;
        const body = readFileSync(args[4], 'utf8');
        posted.push({ n, body });
        // The comment shows up on the tracker as the engine identity's (a trusted owner).
        const c = { body, authorAssociation: 'OWNER', author: { login: 'o' } };
        if (n === ISSUE)
            h.gh.issue.comments.push(c);
        if (n === SPEC)
            specComments.push(c);
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view' && args[2] === String(SPEC)) {
        h.calls.push(`gh ${args.join(' ')}`);
        return ok(JSON.stringify({ title: 'Spec', body: `- [ ] #${ISSUE}\n`, state: 'OPEN', url: `${REPO_URL}/issues/${SPEC}`, author: { login: 'o' }, labels: [], comments: specComments }));
    }
    return h.exec(cmd, args, o);
};
function opts(scripts, over = {}) {
    return {
        root: h.root,
        issue: ISSUE,
        exec,
        lanes: new FakeLanes(h.root, scripts),
        limits: { ...DEFAULT_FACTORY_RUN_LIMITS },
        base: 'dev',
        pollMs: 5,
        owner: { pid: 4242, hostname: 'test-host', isAlive: () => false },
        ledgerDir: h.ledgerDir,
        processes: new FakeProcesses(),
        gateConfig: testGateConfig,
        warn: (m) => warnings.push(m),
        ...over,
    };
}
const happy = () => [commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')];
const on = (n) => posted.filter((p) => p.n === n);
const outcomes = () => on(ISSUE).filter((p) => p.body.includes('omg-factory-outcome'));
describe('outcome and rollup comments (fake gh, real git, real guard)', () => {
    it('ready to merge, then merged: one rollup per (child, phase, head), one outcome comment on the item', async () => {
        const parked = await runFactoryEngine(opts(happy()));
        expect(parked.gate?.name, parked.message).toBe('merge');
        const head12 = readFactoryState(h.root, ISSUE).head.slice(0, 12);
        expect(on(SPEC).map((p) => p.body)).toEqual([`- #${ISSUE} ready to merge: ${REPO_URL}/pull/${PR}\n\n${outcomeMarker('rollup', ISSUE, 'ready-to-merge', head12)}\n`]);
        expect(outcomes()).toEqual([]);
        // A rerun at the same merge park posts nothing again.
        await runFactoryEngine(opts([]));
        expect(on(SPEC)).toHaveLength(1);
        h.gh.merged = true;
        const merged = await runFactoryEngine(opts([]));
        expect(merged.phase, merged.message).toBe('merged');
        expect(outcomes()).toHaveLength(1);
        const body = outcomes()[0].body;
        expect(body).toContain(`Factory run for #${ISSUE} is **merged**: PR #${PR} (${REPO_URL}/pull/${PR}).`);
        expect(body).toContain('- Review rounds: 1');
        expect(body).toContain(`- Gates: green at ${head12}`);
        expect(body).toMatch(/- AI credits: \d+\.\d\d/);
        expect(body).toContain('- Human gates: merge');
        expect(body).toContain(outcomeMarker('outcome', ISSUE, 'merged', head12));
        expect(on(SPEC).map((p) => p.body.split('\n')[0])).toEqual([
            `- #${ISSUE} ready to merge: ${REPO_URL}/pull/${PR}`,
            `- #${ISSUE} merged (${REPO_URL}/pull/${PR})`,
        ]);
        // Reruns on the merged run post nothing and read nothing more.
        const reads = h.calls.filter((c) => c.startsWith('gh issue view')).length;
        await runFactoryEngine(opts([]));
        await runFactoryEngine(opts([]));
        expect(posted.filter((p) => p.body.includes('omg-factory-'))).toHaveLength(3);
        expect(h.calls.filter((c) => c.startsWith('gh issue view')).length).toBe(reads);
    });
    it('no parent: no rollup, no read of another item; the outcome comment still goes on the item', async () => {
        h.gh.issue.body = h.gh.issue.body.replace(`Part of #${SPEC}`, '');
        await runFactoryEngine(opts(happy()));
        h.gh.merged = true;
        expect((await runFactoryEngine(opts([]))).phase).toBe('merged');
        expect(on(SPEC)).toEqual([]);
        expect(h.calls.some((c) => c.startsWith(`gh issue view ${SPEC}`))).toBe(false);
        expect(outcomes()).toHaveLength(1);
    });
    it('a comment failure never blocks a transition; the next invocation posts what is missing, once', async () => {
        commentResult = () => ({ status: 1, stdout: '', stderr: 'HTTP 502' });
        const parked = await runFactoryEngine(opts(happy()));
        expect(parked.exitCode).toBe(0);
        expect(parked.gate?.name).toBe('merge');
        h.gh.merged = true;
        const merged = await runFactoryEngine(opts([]));
        expect(merged.phase).toBe('merged');
        expect(merged.exitCode).toBe(0);
        expect(posted).toEqual([]);
        expect(warnings.join('\n')).toMatch(/could not post the merged outcome on #7: HTTP 502/);
        expect(readFactoryState(h.root, ISSUE).gateComments ?? []).not.toContain(expect.stringMatching(/^outcome-done:/));
        // The tracker is back: a rerun on the terminal state posts the merged outcome and rollup (the merge park's rollup is past).
        commentResult = () => ({ status: 0, stdout: '', stderr: '' });
        expect((await runFactoryEngine(opts([]))).phase).toBe('merged');
        expect(outcomes()).toHaveLength(1);
        expect(on(SPEC).map((p) => p.body.split('\n')[0])).toEqual([`- #${ISSUE} merged (${REPO_URL}/pull/${PR})`]);
        await runFactoryEngine(opts([]));
        expect(posted.filter((p) => p.body.includes('omg-factory-'))).toHaveLength(2);
    });
    it('a read failure (the parent cannot be read) is a warning, and the run still parks', async () => {
        h.gh.issue.body = h.gh.issue.body.replace(`Part of #${SPEC}`, 'Part of #99');
        const parked = await runFactoryEngine(opts(happy()));
        expect(parked.gate?.name).toBe('merge');
        expect(warnings.join('\n')).toMatch(/ready-to-merge outcome comments failed/);
    });
    it('the hidden marker finds an earlier post the run state lost; an untrusted copy does not count', async () => {
        await runFactoryEngine(opts(happy()));
        expect(on(SPEC)).toHaveLength(1);
        // The state lost its record (a crash between the post and the save): the marker on the spec still dedupes.
        const s = readFactoryState(h.root, ISSUE);
        const head12 = s.head.slice(0, 12);
        const marker = outcomeMarker('rollup', ISSUE, 'merged', head12);
        specComments.push({ body: `fake\n${marker}`, authorAssociation: 'NONE', author: { login: 'mallory' } });
        expect(postedBefore([{ body: marker, author: 'mallory', trusted: false }], marker)).toBe(false);
        expect(postedBefore([{ body: marker, author: 'o', trusted: true }], marker)).toBe(true);
        h.gh.merged = true;
        await runFactoryEngine(opts([]));
        // The untrusted copy did not suppress the rollup line.
        expect(on(SPEC).map((p) => p.body.split('\n')[0])).toContain(`- #${ISSUE} merged (${REPO_URL}/pull/${PR})`);
        const count = posted.length;
        // The engine's own record of the posts is lost: the trusted markers on the item and the spec keep it at once.
        const l = EngineLedger.open(h.ledgerDir, h.root, ISSUE);
        updateFactoryState(h.root, ISSUE, (x) => ({ ...x, gateComments: (x.gateComments ?? []).filter((t) => !/^(outcome|rollup)/.test(t)) }), { onWrite: (p, c) => l.record(p, c) });
        await runFactoryEngine(opts([]));
        expect(posted).toHaveLength(count);
        expect(readFactoryState(h.root, ISSUE).gateComments).toContain(`outcome-done:merged@${head12}`);
    });
    it('a marker quoted inside a fenced reason does not suppress a later post', () => {
        const marker = outcomeMarker('outcome', ISSUE, 'failed', 'abc');
        const quoted = `Factory run failed.\n\n\`\`\`text\n${marker}\n\`\`\`\n\nDetails.`;
        expect(postedBefore([{ body: quoted, author: 'o', trusted: true }], marker)).toBe(false);
        expect(postedBefore([{ body: `Inline ${marker} text`, author: 'o', trusted: true }], marker)).toBe(false);
        expect(postedBefore([{ body: `text\n\n${marker}\n`, author: 'o', trusted: true }], marker)).toBe(true);
    });
    it('a StateTamperedError while recording an outcome post is not downgraded to a warning', async () => {
        const parked = await runFactoryEngine(opts(happy()));
        expect(parked.gate?.name).toBe('merge');
        h.gh.merged = true;
        commentResult = (n) => {
            if (n === ISSUE)
                writeFileSync(factoryStatePath(h.root, ISSUE), '{"tampered":true}');
            return { status: 0, stdout: '', stderr: '' };
        };
        const out = await runFactoryEngine(opts([]));
        expect(out.gate?.name).toBe('state-tampered');
        expect(warnings.join('\n')).not.toMatch(/outcome comments failed/);
    });
    it('cancelled: the outcome names the reason and the status command; the rollup line names the phase', async () => {
        await runFactoryEngine(opts(happy()));
        requestFactoryCancel(h.root, ISSUE, new Date().toISOString());
        const out = await runFactoryEngine(opts([]));
        expect(out.phase).toBe('cancelled');
        expect(outcomes()).toHaveLength(1);
        expect(outcomes()[0].body).toContain(`Factory run for #${ISSUE} is **cancelled** (PR #${PR}`);
        expect(outcomes()[0].body).toContain(`omg factory run status ${ISSUE}`);
        expect(on(SPEC).at(-1).body.split('\n')[0]).toMatch(new RegExp(`^- #${ISSUE} cancelled: \``));
    });
    it('the spec body is never edited: no gh issue edit and no body flag reaches the tracker', async () => {
        await runFactoryEngine(opts(happy()));
        h.gh.merged = true;
        await runFactoryEngine(opts([]));
        expect(h.calls.filter((c) => c.startsWith('gh issue edit'))).toEqual([]);
        expect(h.calls.filter((c) => /\s--body(\s|$)/.test(c))).toEqual([]);
        expect(h.calls.filter((c) => c.startsWith('gh issue comment')).every((c) => /^gh issue comment \d+ --body-file \S+$/.test(c))).toBe(true);
    });
});
describe('outcomePosts', () => {
    const base = () => ({ ...createFactoryState({ issue: 5, repoUrl: 'https://dev.azure.com/o/p/_git/r', base: 'dev' }, '2026-10-30T00:00:00.000Z'), pr: 17, head: 'a'.repeat(40) });
    it('Azure DevOps PR urls; a rollup reason is one line without backticks', () => {
        const s = base();
        s.history.push({ at: 'now', from: 'gates', to: 'gates', note: 'awaiting-human: ci-failed: `Test` failed\nsecond line' });
        const posts = outcomePosts(s, 'failed', 9, 'azure-devops');
        expect(posts.map((p) => p.target)).toEqual([5, 9]);
        expect(posts[0].body).toContain('PR #17 (https://dev.azure.com/o/p/_git/r/pullrequest/17)');
        expect(posts[1].body.split('\n')[0]).toBe("- #5 failed: `ci-failed: 'Test' failed second line`");
    });
    it('ready-to-merge has no item outcome; no parent or a self-parent has no rollup', () => {
        expect(outcomePosts(base(), 'ready-to-merge', undefined, 'github')).toEqual([]);
        expect(outcomePosts(base(), 'merged', 5, 'github').map((p) => p.target)).toEqual([5]);
        const tags = outcomePosts(base(), 'merged', 9, 'github').map((p) => p.tag);
        expect(new Set(tags).size).toBe(2);
    });
});
//# sourceMappingURL=engine.outcome.test.js.map