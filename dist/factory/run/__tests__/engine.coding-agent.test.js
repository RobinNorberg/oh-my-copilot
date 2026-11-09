/**
 * The Copilot coding agent as the implementer (night 3 goal 6, lane L6b):
 * fake lanes, real git with a local bare remote, the harness's scripted gh,
 * and a fixture GitHub for the agent (fake-coding-agent.ts). No live
 * assignment, no network, no credits.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ledgerPath, readLedger } from '../../../budget/ledger.js';
import { scaleTiming } from '../../../__tests__/helpers/platform.js';
import { recordCodingAgentSession } from '../coding-agent-lane.js';
import { EXIT_AWAITING_HUMAN } from '../engine.js';
import { readFactoryState } from '../state.js';
import { agentCommit, FakeAgentGithub, ghTime, installFakeAgent } from './fake-coding-agent.js';
import { gitIn, ISSUE, PR, remoteHead, review } from './fake-lanes.js';
import { h, run, useEngineHarness } from './engine-harness.js';
// Every run drives many real git processes (tamper snapshots, prepare); no assertion measures time.
vi.setConfig({ testTimeout: scaleTiming(180_000) });
useEngineHarness();
const AGENT_PR = 77;
const T0 = Date.parse('2026-11-09T10:00:00.000Z');
const ON = { implementer: 'coding-agent', maxWaitMinutes: 90, maxSessionsPerDay: 5 };
let t = T0;
let fake;
/** A fresh fixture GitHub at T0 for this test (useEngineHarness made a fresh harness). */
function setup() {
    t = T0;
    fake = new FakeAgentGithub(() => ghTime(t));
    installFakeAgent(h, fake);
    return fake;
}
const go = (scripts = [], over = {}) => run(scripts, { codingAgent: ON, now: () => t, sleep: async (ms) => { t += ms; }, ...over }).done;
const state = () => readFactoryState(h.root, ISSUE);
/** The agent opened PR #77 with one commit and requested a review: finished. */
function finishedPr(files = { 'src/greet.ts': 'export const greet = () => "hi";\n' }) {
    const head = agentCommit(h, AGENT_PR, files);
    const at = ghTime(t);
    fake.prs.push({ number: AGENT_PR, state: 'OPEN', head, linkedAt: ghTime(T0 + 30_000), commits: [{ oid: head, at }], reviewRequests: [at] });
    return head;
}
describe('omg factory run with the Copilot coding agent as implementer', () => {
    it('happy path: assign -> park -> finished -> adopt -> review -> gates -> merge park; the agent PR is linked and closed', async () => {
        setup();
        const first = await go();
        expect(first.exitCode, first.message).toBe(EXIT_AWAITING_HUMAN);
        expect(first.gate?.name).toBe('coding-agent-wait');
        let s = state();
        expect(s.codingAgent).toMatchObject({ laneId: `issue-${ISSUE}-coding-agent-1`, assign: 'posted', since: { at: ghTime(T0), source: 'github' } });
        expect(s.lanes).toEqual([expect.objectContaining({ kind: 'coding-agent', role: 'coding-agent', status: 'running', maxCredits: 0, usage: { credits: 0, premiumRequests: 1, source: 'estimated' } })]);
        expect(fake.assigns).toEqual([['api', '--hostname', 'github.com', '--method', 'POST', `repos/o/r/issues/${ISSUE}/assignees`, '-f', 'assignees[]=copilot-swe-agent[bot]', '-f', 'agent_assignment[base_branch]=dev']]);
        // One session in the budget ledger, tagged role coding-agent.
        const rec = readLedger(ledgerPath(h.root)).sessions[`factory-lane:issue-${ISSUE}-coding-agent-1`];
        expect(rec).toMatchObject({ credits: 0, premiumRequests: 1, source: 'estimated', tag: { kind: 'factory-lane', role: 'coding-agent', run: `issue-${ISSUE}` } });
        // Waiting is not a human gate: no issue comment.
        expect(h.calls.some((c) => c.startsWith('gh issue comment'))).toBe(false);
        t += 20 * 60_000;
        const head = finishedPr();
        const second = await run([review('approve')], { codingAgent: ON, now: () => t, sleep: async (ms) => { t += ms; } });
        const out = await second.done;
        expect(out.exitCode, out.message).toBe(0);
        expect(out.gate?.name).toBe('merge');
        s = state();
        expect(s.head).toBe(remoteHead(h));
        expect(s.head).toBe(head);
        expect(fake.assigns).toHaveLength(1);
        expect(s.lanes.map((l) => [l.kind, l.status])).toEqual([['coding-agent', 'completed'], ['review', 'completed']]);
        expect(s.lanes[0].endSha).toBe(head);
        expect(s.codingAgent).toMatchObject({ adopted: { pr: AGENT_PR, head }, linked: true, closed: true });
        // Fetched by exact PR ref, pushed as the factory's own branch and PR.
        expect(h.calls).toContain(`git fetch --no-tags --refmap= origin refs/pull/${AGENT_PR}/head`);
        expect(h.calls).toContain(`git push origin ${head}:refs/heads/factory/issue-${ISSUE}`);
        expect(readFileSync(h.calls.find((c) => c.startsWith('gh pr create')).split('--body-file ')[1], 'utf8')).toContain(`Closes #${ISSUE}`);
        // The factory's own review lane reviews exactly the adopted head, and is never told the author is trusted.
        expect(second.lanes.started[0]).toMatchObject({ profile: 'review', baseRef: head });
        expect(second.lanes.started[0].prompt).not.toMatch(/(?<!un)trusted/i);
        expect(second.lanes.started[0].prompt).not.toMatch(/copilot-swe-agent|coding agent/i);
        // D5: the link comment, then the close, each of exactly the adopted PR.
        expect(fake.comments.map((c) => c.args.slice(0, 5))).toEqual([['pr', 'comment', String(AGENT_PR), '--repo', 'github.com/o/r']]);
        expect(fake.comments[0].body).toContain(`#${PR}`);
        expect(fake.comments[0].body).toContain(head.slice(0, 12));
        expect(fake.closes).toEqual([['pr', 'close', String(AGENT_PR), '--repo', 'github.com/o/r']]);
    });
    it('posted but unconfirmed: the session is counted and the run parks; reruns read again and never assign again', async () => {
        setup();
        fake.onAssign = 'silent';
        const out = await go();
        expect(out.gate?.name, out.message).toBe('coding-agent-unconfirmed');
        expect(out.gate?.reason).toContain('returned success, but no read shows the agent assigned');
        expect(state().codingAgent).toMatchObject({ assign: 'posted' });
        expect(state().codingAgent?.since).toBeUndefined();
        expect(readLedger(ledgerPath(h.root)).sessions[`factory-lane:issue-${ISSUE}-coding-agent-1`]).toBeDefined();
        const reads = fake.reads;
        expect(reads).toBe(1 + 1 + 3); // pre-read, the assign's own read, three re-reads
        const again = await go();
        expect(again.gate?.name).toBe('coding-agent-unconfirmed');
        expect(fake.assigns).toHaveLength(1);
        // GitHub shows the assignment late (its own time, before the local clock): the next run confirms and waits.
        fake.events.push({ type: 'assigned', at: ghTime(T0 - 30_000) });
        const later = await go();
        expect(later.gate?.name, later.message).toBe('coding-agent-wait');
        expect(state().codingAgent?.since).toEqual({ at: ghTime(T0 - 30_000), source: 'github' });
        expect(fake.assigns).toHaveLength(1);
    });
    it('the daily session cap parks before any assign', async () => {
        setup();
        recordCodingAgentSession({ root: h.root, ledgerDir: h.ledgerDir, laneId: 'issue-3-coding-agent-1', run: 'issue-3', repo: 'github.com/o/r', at: new Date(T0 - 3_600_000).toISOString() });
        const out = await go([], { codingAgent: { ...ON, maxSessionsPerDay: 1 } });
        expect(out.gate?.name, out.message).toBe('coding-agent-sessions');
        expect(out.gate?.reason).toContain('factory.codingAgent.maxSessionsPerDay is 1');
        expect(fake.assigns).toHaveLength(0);
        expect(state().codingAgent).toBeUndefined();
    });
    it('refuses to assign while the agent is already assigned, or while an open agent PR exists for the issue', async () => {
        setup();
        fake.events.push({ type: 'assigned', at: ghTime(T0 - 86_400_000) });
        const busy = await go();
        expect(busy.gate?.name, busy.message).toBe('coding-agent');
        expect(busy.gate?.reason).toContain(`the agent is already assigned to issue #${ISSUE}`);
        fake.events = [{ type: 'assigned', at: ghTime(T0 - 86_400_000) }, { type: 'unassigned', at: ghTime(T0 - 80_000_000) }];
        fake.prs.push({ number: 70, state: 'OPEN', head: 'a'.repeat(40), linkedAt: ghTime(T0 - 85_000_000), commits: [], reviewRequests: [] });
        const open = await go();
        expect(open.gate?.name, open.message).toBe('coding-agent');
        expect(open.gate?.reason).toContain('open agent pull request(s) #70');
        expect(fake.assigns).toHaveLength(0);
    });
    it('truncated, ambiguous and not-assigned reads park and never assign again', async () => {
        setup();
        expect((await go()).gate?.name).toBe('coding-agent-wait');
        fake.truncate = true;
        const cut = await go();
        expect(cut.gate?.name, cut.message).toBe('coding-agent');
        expect(cut.gate?.reason).toContain(`issue-timeline of issue #${ISSUE}`);
        fake.truncate = false;
        const a = agentCommit(h, AGENT_PR, { 'a.ts': 'a\n' });
        const b = agentCommit(h, 78, { 'b.ts': 'b\n' });
        fake.prs.push({ number: AGENT_PR, state: 'OPEN', head: a, linkedAt: ghTime(T0 + 10_000), commits: [{ oid: a, at: ghTime(T0 + 9_000) }], reviewRequests: [] });
        fake.prs.push({ number: 78, state: 'OPEN', head: b, linkedAt: ghTime(T0 + 20_000), commits: [{ oid: b, at: ghTime(T0 + 19_000) }], reviewRequests: [] });
        const two = await go();
        expect(two.gate?.name, two.message).toBe('coding-agent');
        expect(two.gate?.reason).toContain('more than one open pull request of its own');
        fake.prs = [];
        fake.events.push({ type: 'unassigned', at: ghTime(T0 + 60_000) });
        const gone = await go();
        expect(gone.gate?.name, gone.message).toBe('coding-agent');
        expect(gone.gate?.reason).toContain('no longer assigned');
        expect(fake.assigns).toHaveLength(1);
    });
    it('a human re-assign (a later assignedAt) parks and is never adopted', async () => {
        setup();
        expect((await go()).gate?.name).toBe('coding-agent-wait');
        fake.events.push({ type: 'unassigned', at: ghTime(T0 + 300_000) }, { type: 'assigned', at: ghTime(T0 + 360_000) });
        t += 30 * 60_000;
        finishedPr();
        const out = await go();
        expect(out.gate?.name, out.message).toBe('coding-agent-reassigned');
        expect(out.gate?.reason).toContain(`again at ${ghTime(T0 + 360_000)}`);
        expect(state().pendingHead).toBeUndefined();
        expect(h.calls.some((c) => c.startsWith('git fetch --no-tags'))).toBe(false);
        expect(fake.closes).toHaveLength(0);
    });
    it('a commit not by the agent on its PR parks with the cause and the advice; nothing is fetched or closed', async () => {
        setup();
        expect((await go()).gate?.name).toBe('coding-agent-wait');
        t += 20 * 60_000;
        const head = finishedPr();
        fake.prs[0].commits = [{ oid: 'b'.repeat(40), at: ghTime(T0 + 60_000), byAgent: false }, { oid: head, at: ghTime(t) }];
        const out = await go();
        expect(out.gate?.name, out.message).toBe('coding-agent-adopt');
        expect(out.gate?.reason).toContain('has commits not by the agent (Update branch, applied suggestion or a human push');
        expect(out.gate?.reason).toContain('never click Update branch on agent pull requests while the factory owns them');
        expect(h.calls.some((c) => c.startsWith('git fetch --no-tags'))).toBe(false);
        expect(fake.closes).toHaveLength(0);
        expect(fake.comments).toHaveLength(0);
    });
    it('the PR head moving between the read and the fetch parks; nothing is adopted or pushed', async () => {
        setup();
        expect((await go()).gate?.name).toBe('coding-agent-wait');
        t += 20 * 60_000;
        const head = finishedPr();
        // The agent pushed again after GitHub answered the read: refs/pull/77/head is a newer commit.
        const moved = agentCommit(h, AGENT_PR, { 'src/more.ts': 'more\n' }, head);
        const out = await go();
        expect(out.gate?.name, out.message).toBe('coding-agent-head-moved');
        expect(out.gate?.reason).toContain(`(${head.slice(0, 12)}) and the fetch (${moved.slice(0, 12)})`);
        expect(state().pendingHead).toBeUndefined();
        expect(state().codingAgent?.adopted).toBeUndefined();
        expect(h.calls.some((c) => c.startsWith('git push '))).toBe(false);
    });
    it('maxWaitMinutes is measured from GitHub\'s assignedAt: a session still working past it parks at coding-agent-timeout', async () => {
        setup();
        expect((await go()).gate?.name).toBe('coding-agent-wait');
        t += 30 * 60_000;
        const head = agentCommit(h, AGENT_PR, { 'a.ts': 'a\n' });
        fake.prs.push({ number: AGENT_PR, state: 'OPEN', head, linkedAt: ghTime(T0 + 10_000), commits: [{ oid: head, at: ghTime(t) }], reviewRequests: [] });
        const working = await go();
        expect(working.gate?.name).toBe('coding-agent-wait');
        expect(working.gate?.reason).toContain(`still working on pull request #${AGENT_PR}`);
        t = T0 + 91 * 60_000;
        const late = await go();
        expect(late.gate?.name, late.message).toBe('coding-agent-timeout');
        expect(late.gate?.reason).toContain('91 min after GitHub recorded its assignment');
        expect(fake.assigns).toHaveLength(1);
    });
    it('without the opt-in the Copilot implement lane runs as before and nothing reads the agent', async () => {
        setup();
        // No lane script: the Copilot implement lane cannot start (its retry, then implement-failed), which shows that lane was chosen.
        const out = await go([], { codingAgent: { ...ON, implementer: 'copilot' } });
        expect(out.gate?.name, out.message).toBe('implement-failed');
        expect(fake.reads).toBe(0);
        expect(fake.assigns).toHaveLength(0);
        expect(state().codingAgent).toBeUndefined();
        expect(state().lanes.map((l) => l.kind)).toEqual(['implement', 'implement']);
    });
    it('records the assign base: the base sha the run fetched before assigning', async () => {
        setup();
        await go();
        expect(fake.reads).toBe(2);
        expect(state().baseSha).toBe(gitIn(h.root, 'rev-parse', 'origin/dev'));
        expect(state().lanes[0].startSha).toBe(state().baseSha);
    });
});
//# sourceMappingURL=engine.coding-agent.test.js.map