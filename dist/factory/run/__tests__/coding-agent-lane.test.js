/**
 * The coding agent lane's shared pieces (night 3 goal 6, lane L6b): the
 * factory guard's coding agent shapes with and without the step context,
 * the config keys, the sealed record's shape check, the session count and
 * the pre-assign read of open agent PRs. Fixtures only.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codingAgentAssignArgs, codingAgentCloseArgs, codingAgentStatusArgs } from '../../../forge/github/coding-agent.js';
import { acquireFileLockSync, lockPathFor, releaseFileLockSync } from '../../../lib/file-lock.js';
import { chooseCodingAgent, codingAgentFetchArgs, codingAgentLinkBody, codingAgentLinkCommentArgs, codingAgentMergeBaseArgs, CodingAgentMirrorUnreadableError, CodingAgentSessionsBusyError, codingAgentRecordProblem, isDefiniteAssignRefusal, releaseCodingAgentSession, reserveCodingAgentSession, codingAgentRefusal, codingAgentRepoOf, codingAgentSessionsOn, codingAgentTreeArgs, CODING_AGENT_FETCH_HEAD_ARGS, linkEntries, openAgentPrs, recordCodingAgentSession, resolveCodingAgentConfig, } from '../coding-agent-lane.js';
import { factoryGuardExec, FactorySafetyError } from '../exec.js';
import { createFactoryState, parseFactoryState } from '../state.js';
import { AGENT, FakeAgentGithub, HUMAN } from './fake-coding-agent.js';
import { gitIn } from './fake-lanes.js';
const REPO = { host: 'github.com', owner: 'o', name: 'r' };
const REPO_ARG = 'github.com/o/r';
const HEAD = 'c'.repeat(40);
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omg-coding-agent-lane-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
/** A guarded exec over a recorder; the agent provider returns `ctx()`. */
function guarded(ctx, read = () => ({ repo: REPO_ARG })) {
    const ran = [];
    const inner = (cmd, args) => {
        ran.push({ cmd, args: [...args], ...(args[5] === '--body-file' ? { body: readFileSync(args[6], 'utf8') } : {}) });
        return { status: 0, stdout: '', stderr: '' };
    };
    return { exec: factoryGuardExec(inner, () => ['dev'], undefined, undefined, undefined, read, ctx), ran };
}
describe('factory guard: coding agent writes need the step context', () => {
    const ctx = { repo: REPO_ARG, issue: 7, base: 'dev' };
    const assign = codingAgentAssignArgs(REPO, 7, 'dev');
    const close = codingAgentCloseArgs(REPO, 77);
    it('without the step context the assign, the close and the link comment are refused; the status read passes', () => {
        const body = join(dir, 'body.md');
        writeFileSync(body, 'link\n');
        const { exec, ran } = guarded(() => undefined);
        expect(() => exec('gh', assign)).toThrow(FactorySafetyError);
        expect(() => exec('gh', close)).toThrow(FactorySafetyError);
        expect(() => exec('gh', codingAgentLinkCommentArgs(REPO, 77, body))).toThrow(FactorySafetyError);
        exec('gh', codingAgentStatusArgs(REPO, 7, { at: '2026-11-09T10:00:00Z', source: 'github' }));
        expect(ran).toHaveLength(1);
    });
    it('the assign context admits the assign of its issue on its base only, never a close or a comment', () => {
        const { exec, ran } = guarded(() => ctx);
        exec('gh', assign);
        expect(() => exec('gh', codingAgentAssignArgs(REPO, 8, 'dev'))).toThrow(FactorySafetyError);
        expect(() => exec('gh', codingAgentAssignArgs(REPO, 7, 'main'))).toThrow(FactorySafetyError);
        expect(() => exec('gh', close)).toThrow(FactorySafetyError);
        expect(ran.map((r) => r.args)).toEqual([assign]);
    });
    it('the close context admits the close and the link comment of exactly its PR; the comment runs with the guard\'s copy of the body', () => {
        const body = join(dir, 'body.md');
        const link = { ownPr: 42, branch: 'factory/issue-7', head: HEAD };
        const text = codingAgentLinkBody({ issue: 7, ...link });
        writeFileSync(body, text);
        const { exec, ran } = guarded(() => ({ ...ctx, pr: 77, link }));
        exec('gh', close);
        exec('gh', codingAgentLinkCommentArgs(REPO, 77, body));
        // The close context without the link's numbers admits no comment.
        expect(() => guarded(() => ({ ...ctx, pr: 77 })).exec('gh', codingAgentLinkCommentArgs(REPO, 77, body))).toThrow(FactorySafetyError);
        expect(() => exec('gh', codingAgentCloseArgs(REPO, 78))).toThrow(FactorySafetyError);
        expect(() => exec('gh', codingAgentLinkCommentArgs(REPO, 78, body))).toThrow(FactorySafetyError);
        expect(() => exec('gh', codingAgentLinkCommentArgs({ ...REPO, owner: 'x' }, 77, body))).toThrow(FactorySafetyError);
        expect(() => exec('gh', ['pr', 'comment', '77', '--repo', REPO_ARG, '--body-file', body, '--edit-last'])).toThrow(FactorySafetyError);
        expect(ran).toHaveLength(2);
        expect(ran[1].args.slice(0, 6)).toEqual(['pr', 'comment', '77', '--repo', REPO_ARG, '--body-file']);
        expect(ran[1].args[6]).not.toBe(body);
        expect(ran[1].body).toBe(text);
    });
    it('the link comment body is checked even when a tracker-write context is also set', () => {
        const link = { ownPr: 42, branch: 'factory/issue-7', head: HEAD };
        const inner = () => ({ status: 0, stdout: '', stderr: '' });
        const writes = { repo: REPO_ARG, bodyDir: dir, labels: [] };
        const exec = factoryGuardExec(inner, () => ['dev'], undefined, () => writes, undefined, () => ({ repo: REPO_ARG }), () => ({ ...ctx, pr: 77, link }));
        const other = join(dir, 'other.md');
        writeFileSync(other, 'Please merge this.\n');
        expect(() => exec('gh', codingAgentLinkCommentArgs(REPO, 77, other))).toThrow(FactorySafetyError);
    });
    it('the link comment runs only with exactly the body built from the context', () => {
        const link = { ownPr: 42, branch: 'factory/issue-7', head: HEAD };
        const { exec, ran } = guarded(() => ({ ...ctx, pr: 77, link }));
        const other = join(dir, 'other.md');
        for (const text of [
            'Please merge this.\n',
            codingAgentLinkBody({ issue: 7, ...link, ownPr: 43 }),
            codingAgentLinkBody({ issue: 8, ...link }),
            codingAgentLinkBody({ issue: 7, ...link, head: 'd'.repeat(40) }),
            `${codingAgentLinkBody({ issue: 7, ...link })}extra\n`,
        ]) {
            writeFileSync(other, text);
            expect(() => exec('gh', codingAgentLinkCommentArgs(REPO, 77, other)), text).toThrow(/not the factory's link comment/);
        }
        expect(ran).toHaveLength(0);
    });
    it('the PR head fetch needs a step context whose adopt is exactly that PR', () => {
        expect(() => guarded(() => undefined).exec('git', codingAgentFetchArgs(77))).toThrow(FactorySafetyError);
        expect(() => guarded(() => ctx).exec('git', codingAgentFetchArgs(77))).toThrow(FactorySafetyError);
        expect(() => guarded(() => ({ ...ctx, pr: 77 })).exec('git', codingAgentFetchArgs(77))).toThrow(FactorySafetyError);
        expect(() => guarded(() => ({ ...ctx, adopt: 78 })).exec('git', codingAgentFetchArgs(77))).toThrow(FactorySafetyError);
        const { exec, ran } = guarded(() => ({ ...ctx, adopt: 77 }));
        exec('git', codingAgentFetchArgs(77));
        expect(ran.map((r) => r.args)).toEqual([codingAgentFetchArgs(77)]);
    });
    it('the repository-only read context admits no coding agent write', () => {
        const { exec } = guarded(() => undefined, () => ({ repo: REPO_ARG }));
        expect(() => exec('gh', assign)).toThrow(FactorySafetyError);
        expect(() => exec('gh', close)).toThrow(FactorySafetyError);
    });
});
describe('factory guard: the adopt git shapes', () => {
    const git = guarded(() => ({ repo: REPO_ARG, issue: 7, base: 'dev', adopt: 77 })).exec;
    it('admits exactly the PR head fetch, the FETCH_HEAD read and one commit\'s tree listing', () => {
        git('git', codingAgentFetchArgs(77));
        git('git', [...CODING_AGENT_FETCH_HEAD_ARGS]);
        git('git', codingAgentTreeArgs(HEAD));
        git('git', codingAgentMergeBaseArgs(HEAD, 'd'.repeat(40)));
    });
    it.each([
        [['fetch', '--no-tags', '--refmap=', 'origin', 'refs/pull/77/head:refs/heads/main']],
        [['fetch', '--no-tags', '--refmap=', 'origin', '+refs/pull/77/head:refs/heads/x']],
        [['fetch', '--no-tags', '--refmap=', 'omg-local', 'refs/pull/77/head']],
        [['fetch', '--refmap=', 'origin', 'refs/pull/77/head']],
        [['fetch', '--no-tags', 'origin', 'refs/pull/77/head']],
        [['fetch', '--no-tags', '--refmap=', 'origin', 'refs/pull/077/head']],
        [['fetch', '--no-tags', '--refmap=', 'origin', 'refs/pull/77/merge']],
        [['ls-tree', '-r', '-z', '--full-tree', 'HEAD']],
        [['rev-parse', '--verify', 'FETCH_HEAD']],
        [['merge-base', 'HEAD', 'c'.repeat(40)]],
        [['merge-base', '--all', 'c'.repeat(40), 'd'.repeat(40)]],
        [['merge-base', '--octopus', 'c'.repeat(40), 'd'.repeat(40)]],
    ])('refuses %j', (args) => {
        expect(() => git('git', args)).toThrow(FactorySafetyError);
    });
    it('the builders refuse what the guard would', () => {
        expect(() => codingAgentFetchArgs(0)).toThrow();
        expect(() => codingAgentTreeArgs('HEAD')).toThrow();
        expect(() => codingAgentLinkCommentArgs(REPO, -1, 'x')).toThrow();
    });
});
describe('coding agent config', () => {
    it('defaults: Copilot implements, 90 min wait, 5 sessions a day', () => {
        expect(resolveCodingAgentConfig(undefined, undefined)).toEqual({ config: { implementer: 'copilot', maxWaitMinutes: 90, maxSessionsPerDay: 5, repos: [] }, warnings: [] });
    });
    it('only the user config opts in; the project config may opt out and lower the numbers', () => {
        const user = { factory: { run: { implementer: 'coding-agent' }, codingAgent: { maxWaitMinutes: 60, maxSessionsPerDay: 3 } } };
        expect(resolveCodingAgentConfig(user, undefined).config).toEqual({ implementer: 'coding-agent', maxWaitMinutes: 60, maxSessionsPerDay: 3, repos: [] });
        const lower = resolveCodingAgentConfig(user, { factory: { run: { implementer: 'copilot' }, codingAgent: { maxWaitMinutes: 30, maxSessionsPerDay: 10 } } });
        expect(lower.config).toEqual({ implementer: 'copilot', maxWaitMinutes: 30, maxSessionsPerDay: 3, repos: [] });
        expect(lower.warnings).toEqual([expect.stringContaining('maxSessionsPerDay 10')]);
        const optIn = resolveCodingAgentConfig(undefined, { factory: { run: { implementer: 'coding-agent' } } });
        expect(optIn.config.implementer).toBe('copilot');
        expect(optIn.warnings).toEqual([expect.stringContaining('only the user config can opt in')]);
    });
    it('refuses ill-typed values', () => {
        expect(() => resolveCodingAgentConfig({ factory: { run: { implementer: 'agent' } } }, undefined)).toThrow(/implementer/);
        expect(() => resolveCodingAgentConfig({ factory: { codingAgent: { maxSessionsPerDay: 1.5 } } }, undefined)).toThrow(/maxSessionsPerDay/);
        expect(() => resolveCodingAgentConfig({ factory: { codingAgent: { maxWaitMinutes: 0 } } }, undefined)).toThrow(/maxWaitMinutes/);
        expect(() => resolveCodingAgentConfig({ factory: { codingAgent: [] } }, undefined)).toThrow(/factory.codingAgent/);
    });
    it('validates factory.codingAgent.repos and ignores a project-config list', () => {
        expect(resolveCodingAgentConfig({ factory: { codingAgent: { repos: ['O/R', 'a/b.c'] } } }, undefined).config.repos).toEqual(['O/R', 'a/b.c']);
        expect(() => resolveCodingAgentConfig({ factory: { codingAgent: { repos: 'o/r' } } }, undefined)).toThrow(/repos/);
        const bad = resolveCodingAgentConfig({ factory: { codingAgent: { repos: ['o/r', 'github.com/o/r', 'https://github.com/o/r', 'o/r.git', 'o/..', 7] } } }, undefined);
        expect(bad.config.repos).toEqual(['o/r']);
        expect(bad.warnings).toHaveLength(5);
        for (const entry of ['"github.com/o/r"', '"https://github.com/o/r"', '"o/r.git"', '"o/.."', '7'])
            expect(bad.warnings.join('\n')).toContain(entry);
        const proj = resolveCodingAgentConfig({ factory: { codingAgent: { repos: ['o/r'] } } }, { factory: { codingAgent: { repos: ['x/y'] } } });
        expect(proj.config.repos).toEqual(['o/r']);
        expect(proj.warnings).toEqual([expect.stringContaining('ignoring factory.codingAgent.repos from the working-tree project config')]);
    });
    describe('chooseCodingAgent: user opt-in AND listed repository AND GitHub', () => {
        const URL = 'https://github.com/o/r';
        const optIn = (repos = ['o/r']) => ({ factory: { run: { implementer: 'coding-agent' }, codingAgent: { repos } } });
        const never = () => { throw new Error('the project config must not be read'); };
        it('uses the agent only for a listed repository on GitHub, compared case-insensitively', () => {
            expect(chooseCodingAgent(optIn(['O/R']), () => undefined, { forgeKind: 'github', repoUrl: URL })).toMatchObject({ use: true, config: { implementer: 'coding-agent', repos: ['O/R'] } });
        });
        it('a GitHub Enterprise host with a listed owner/name is not enabled; the github.com aliases are', () => {
            expect(chooseCodingAgent(optIn(), never, { forgeKind: 'github', repoUrl: 'https://ghe.example.com/o/r' }))
                .toEqual({ use: false, warning: 'omg factory run: coding agent not enabled for o/r: add it to factory.codingAgent.repos; using a Copilot lane' });
            for (const host of ['github.com', 'www.github.com', 'ssh.github.com']) {
                expect(chooseCodingAgent(optIn(), () => undefined, { forgeKind: 'github', repoUrl: `https://${host}/o/r` }).use, host).toBe(true);
            }
        });
        it('a repository not listed: the Copilot lane with one warning, the project config unread', () => {
            expect(chooseCodingAgent(optIn(['o/other']), never, { forgeKind: 'github', repoUrl: URL }))
                .toEqual({ use: false, warning: 'omg factory run: coding agent not enabled for o/r: add it to factory.codingAgent.repos; using a Copilot lane' });
            expect(chooseCodingAgent({ factory: { run: { implementer: 'coding-agent' } } }, never, { forgeKind: 'github', repoUrl: URL }).use).toBe(false);
        });
        it.each(['local', 'azure-devops'])('the %s forge: the Copilot lane with one warning, no park', (forgeKind) => {
            const choice = chooseCodingAgent(optIn(), never, { forgeKind, repoUrl: URL });
            expect(choice).toEqual({ use: false, warning: `omg factory run: the coding agent is GitHub-only; using a Copilot lane (this run's forge is ${forgeKind})` });
        });
        it('no user opt-in: silent, and neither an ill-typed user key nor the project config is parsed', () => {
            for (const user of [undefined, null, {}, { factory: { run: { implementer: 'copilot' } } }, { factory: { run: { implementer: 5 }, codingAgent: { repos: 'x', maxWaitMinutes: -1 } } }, { factory: 'x' }]) {
                expect(chooseCodingAgent(user, never, { forgeKind: 'github', repoUrl: URL })).toEqual({ use: false });
            }
        });
        it('after the opt-in a config error throws (the engine parks); the project config may opt out', () => {
            expect(() => chooseCodingAgent(optIn(), () => ({ factory: { codingAgent: { maxWaitMinutes: 'x' } } }), { forgeKind: 'github', repoUrl: URL })).toThrow(/project config: factory.codingAgent.maxWaitMinutes/);
            expect(() => chooseCodingAgent(optIn('o/r'), never, { forgeKind: 'github', repoUrl: URL })).toThrow(/user config: factory.codingAgent.repos/);
            expect(chooseCodingAgent(optIn(), () => ({ factory: { run: { implementer: 'copilot' } } }), { forgeKind: 'github', repoUrl: URL })).toEqual({ use: false });
        });
    });
    it('GitHub issue runs only', () => {
        expect(codingAgentRefusal('github', 'issue')).toBeNull();
        expect(codingAgentRefusal('azure-devops', 'issue')).toContain('GitHub only');
        expect(codingAgentRefusal('local', 'issue')).toContain('GitHub only');
        expect(codingAgentRefusal('local', 'ci-heal')).toBeNull();
    });
    it('reads the run repository url', () => {
        expect(codingAgentRepoOf('https://github.com/o/r')).toEqual(REPO);
        expect(codingAgentRepoOf('https://github.com/o/r.git')).toEqual(REPO);
        expect(codingAgentRepoOf('git@github.com:o/r')).toBeUndefined();
    });
});
describe('the sealed coding agent record', () => {
    const ok = { laneId: 'issue-7-coding-agent-1', assignAt: '2026-11-09T10:00:00.123Z', assign: 'posted', since: { at: '2026-11-09T10:00:01Z', source: 'github' }, adopted: { pr: 77, head: HEAD }, linked: true, closed: false };
    it('accepts a well-formed record', () => {
        expect(codingAgentRecordProblem(ok)).toBeNull();
        expect(codingAgentRecordProblem({ laneId: ok.laneId, assignAt: ok.assignAt, assign: 'pending' })).toBeNull();
    });
    it.each([
        ['laneId', { ...ok, laneId: 'issue-7-implement-1' }],
        ['assign', { ...ok, assign: 'done' }],
        ['since', { ...ok, since: { at: '2026-11-09T10:00:01.500Z', source: 'github' } }],
        ['since', { ...ok, since: { at: '2026-11-09T10:00:01Z', source: 'local' } }],
        ['adopted', { ...ok, adopted: { pr: 77, head: 'HEAD' } }],
        ['adopted', { ...ok, adopted: { pr: 77, head: HEAD, extra: 1 } }],
        ['unknown field', { ...ok, trusted: true }],
    ])('refuses a bad %s', (_what, record) => {
        expect(codingAgentRecordProblem(record)).not.toBeNull();
    });
    it('the run state loader refuses a malformed record (the field is under the seal and shape-checked)', () => {
        const s = createFactoryState({ issue: 7, repoUrl: 'https://github.com/o/r', base: 'dev' }, '2026-11-09T10:00:00.000Z');
        expect(parseFactoryState('run-7.json', 7, JSON.stringify({ ...s, codingAgent: ok })).codingAgent).toEqual(ok);
        expect(() => parseFactoryState('run-7.json', 7, JSON.stringify({ ...s, codingAgent: { ...ok, assign: 'yes' } }))).toThrow(/field codingAgent/);
    });
});
describe('coding agent session reservation and the assign failure kinds', () => {
    const at = '2026-11-09T10:00:00.000Z';
    const session = (laneId, ledgerDir = join(dir, 'ledger')) => ({ root: join(dir, 'repo'), ledgerDir, laneId, run: laneId.replace(/-coding-agent-\d+$/, ''), repo: REPO_ARG, at, by: 'test' });
    it('two interleaved attempts at used = max - 1: exactly one proceeds; a definite refusal frees the slot', () => {
        mkdirSync(join(dir, 'repo'), { recursive: true });
        recordCodingAgentSession({ ...session('issue-1-coding-agent-1') });
        // Engine A reserves before its POST; engine B (another checkout, the same engine ledger) counts A's provisional entry.
        expect(reserveCodingAgentSession(session('issue-2-coding-agent-1'), 2)).toEqual({ ok: true, used: 1 });
        expect(reserveCodingAgentSession(session('issue-3-coding-agent-1'), 2)).toEqual({ ok: false, used: 2 });
        expect(codingAgentSessionsOn(join(dir, 'repo'), join(dir, 'ledger'), '2026-11-09')).toBe(2);
        // A's POST was refused for certain: its entry goes, and B may proceed.
        releaseCodingAgentSession(session('issue-2-coding-agent-1'));
        expect(reserveCodingAgentSession(session('issue-3-coding-agent-1'), 2)).toEqual({ ok: true, used: 1 });
        // B's POST returned: counting it keeps one entry (the provisional one).
        recordCodingAgentSession(session('issue-3-coding-agent-1'));
        expect(codingAgentSessionsOn(join(dir, 'repo'), join(dir, 'ledger'), '2026-11-09')).toBe(2);
    });
    it('a corrupt session record refuses the reserve and is never overwritten', () => {
        const ledgerDir = join(dir, 'ledger');
        mkdirSync(ledgerDir, { recursive: true });
        mkdirSync(join(dir, 'repo'), { recursive: true });
        const file = join(ledgerDir, 'coding-agent-sessions.json');
        for (const text of ['{ not json', '[]', 'null']) {
            writeFileSync(file, text);
            expect(() => reserveCodingAgentSession(session('issue-2-coding-agent-1', ledgerDir), 5)).toThrow(CodingAgentMirrorUnreadableError);
            expect(() => reserveCodingAgentSession(session('issue-2-coding-agent-1', ledgerDir), 5)).toThrow(/is unreadable; fix or remove it, then rerun/);
            expect(() => releaseCodingAgentSession(session('issue-2-coding-agent-1', ledgerDir))).toThrow(CodingAgentMirrorUnreadableError);
            expect(readFileSync(file, 'utf8')).toBe(text);
        }
        // The record call reports it as a failure and leaves the file alone.
        expect(recordCodingAgentSession(session('issue-2-coding-agent-1', ledgerDir)).join('\n')).toMatch(/engine ledger: .*unreadable/);
        expect(readFileSync(file, 'utf8')).toBe('null');
    });
    it('a held mirror lock is busy: nothing is reserved', () => {
        const ledgerDir = join(dir, 'ledger');
        mkdirSync(ledgerDir, { recursive: true });
        const handle = acquireFileLockSync(lockPathFor(join(ledgerDir, 'coding-agent-sessions.json')));
        expect(handle).not.toBeNull();
        try {
            expect(() => reserveCodingAgentSession(session('issue-2-coding-agent-1', ledgerDir), 5, 100)).toThrow(CodingAgentSessionsBusyError);
        }
        finally {
            releaseFileLockSync(handle);
        }
        expect(codingAgentSessionsOn(join(dir, 'repo'), ledgerDir, '2026-11-09')).toBe(0);
    });
    it.each([
        ['HTTP 422', 'gh api --method POST repos/o/r/issues/7/assignees failed (exit 1): gh: Validation Failed (HTTP 422)', true],
        ['HTTP 403', 'gh api --method POST repos/o/r/issues/7/assignees failed (exit 1): gh: Resource not accessible by integration (HTTP 403)', true],
        ['a timeout (no exit status)', 'gh api --method POST repos/o/r/issues/7/assignees failed (exit null): ', false],
        ['HTTP 502', 'gh api --method POST repos/o/r/issues/7/assignees failed (exit 1): gh: Bad Gateway (HTTP 502)', false],
        ['a network error', 'gh api --method POST repos/o/r/issues/7/assignees failed (exit 1): error connecting to api.github.com', false],
    ])('%s: definite refusal = %s', (_what, message, definite) => {
        expect(isDefiniteAssignRefusal(message)).toBe(definite);
    });
});
describe('coding agent sessions', () => {
    it('counts per UTC day, idempotently per lane, the larger of the budget ledger and the engine mirror', () => {
        const root = join(dir, 'repo');
        const ledgerDir = join(dir, 'ledger');
        mkdirSync(root);
        gitIn(root, 'init', '-q');
        const at = '2026-11-09T10:00:00.000Z';
        expect(codingAgentSessionsOn(root, ledgerDir, '2026-11-09')).toBe(0);
        expect(recordCodingAgentSession({ root, ledgerDir, laneId: 'issue-7-coding-agent-1', run: 'issue-7', repo: REPO_ARG, at })).toEqual([]);
        recordCodingAgentSession({ root, ledgerDir, laneId: 'issue-7-coding-agent-1', run: 'issue-7', repo: REPO_ARG, at });
        recordCodingAgentSession({ root, ledgerDir, laneId: 'issue-8-coding-agent-1', run: 'issue-8', repo: REPO_ARG, at: '2026-11-08T23:59:59.000Z' });
        expect(codingAgentSessionsOn(root, ledgerDir, '2026-11-09')).toBe(1);
        expect(codingAgentSessionsOn(root, ledgerDir, '2026-11-08')).toBe(1);
        // A lane that wipes the repository's state root does not reset the count.
        rmSync(join(root), { recursive: true, force: true });
        expect(codingAgentSessionsOn(root, ledgerDir, '2026-11-09')).toBe(1);
    });
});
describe('the pre-assign read and the tree check', () => {
    it('finds open agent PRs of any session in the repository; a human PR, a closed one or another repository does not count', () => {
        const fake = new FakeAgentGithub(() => '2026-11-09T10:00:00Z');
        fake.prs.push({ number: 5, state: 'OPEN', head: HEAD, linkedAt: '2026-01-01T00:00:00Z', commits: [], reviewRequests: [] }, { number: 6, state: 'CLOSED', head: HEAD, linkedAt: '2026-01-02T00:00:00Z', commits: [], reviewRequests: [] }, { number: 9, state: 'OPEN', head: HEAD, linkedAt: '2026-01-03T00:00:00Z', commits: [], reviewRequests: [], author: { ...HUMAN } });
        expect(openAgentPrs(fake.status(), 'o/r')).toEqual([5]);
        expect(openAgentPrs(fake.status(), 'x/r')).toEqual([]);
        expect(openAgentPrs('not json', 'o/r')).toEqual([]);
        expect(AGENT.login).toBe('copilot-swe-agent');
    });
    it('reports gitlinks and symlinks the head adds or changes', () => {
        const base = ['100644 blob 1111\tREADME.md', '160000 commit aaaa\tvendor/x'].join('\0');
        const head = ['100644 blob 2222\tREADME.md', '160000 commit bbbb\tvendor/x', '120000 blob cccc\tlink', '160000 commit dddd\tnew'].join('\0');
        expect(linkEntries(base, head)).toEqual({ gitlinks: ['vendor/x', 'new'], symlinks: ['link'] });
        expect(linkEntries(base, base)).toEqual({ gitlinks: [], symlinks: [] });
    });
});
//# sourceMappingURL=coding-agent-lane.test.js.map