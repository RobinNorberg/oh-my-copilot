/**
 * gh argv-parity baseline, chain side (factory forges design §A.6/§A.7, PR 2b):
 * the exact ordered gh sequence of `src/factory/map-ingest.ts` (through its
 * GhRunner/CommentRunner seams and, for the default runners, the spawnSync
 * they call), `src/factory/watchdog.ts` flagStall and
 * `src/hooks/session-end/spawn-next.ts` executeSpawnNext (the tracker
 * `issue edit` / `issue comment` writebacks and the spawn-failure alert).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const spawned = vi.hoisted(() => []);
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        spawnSync: vi.fn((cmd, args, opts) => {
            spawned.push({ cmd, args, opts });
            return { status: 0, stdout: '[]', stderr: '' };
        }),
    };
});
import { WAYFINDER_TASK_AFK_LABEL } from '../../factory/map-frontier.js';
import { defaultCommentRunner, defaultGhRunner, executePlanActions, loadMapRecords, planFromMap } from '../../factory/map-ingest.js';
import { flagStall } from '../../factory/watchdog.js';
import { AFK_INCLUDE_USER_SETTINGS_ENV, executeSpawnNext } from '../../hooks/session-end/spawn-next.js';
import { callLine } from './recording-exec.js';
beforeEach(() => {
    spawned.length = 0;
});
describe('gh argv baseline: src/factory/map-ingest.ts', () => {
    const MAP = { repo: 'o/r', number: 46 };
    const VIEW_FIELDS = 'number,state,labels,assignees,body,parent,blockedBy';
    const parentBody = '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)';
    const records = [
        { number: 46, state: 'OPEN', labels: ['wayfinder:map'], assignees: 0, body: '' },
        { number: 80, state: 'OPEN', labels: ['wayfinder:research'], assignees: 0, nativeParent: 46, body: `${parentBody}\n\n## Acceptance criteria\n\n- [ ] done` },
        { number: 81, state: 'OPEN', labels: ['wayfinder:task', WAYFINDER_TASK_AFK_LABEL], assignees: 0, nativeParent: 46, body: `${parentBody}\n\n## Question\n\nShould the widget invert itself?` },
        { number: 82, state: 'OPEN', labels: ['wayfinder:grilling'], assignees: 0, nativeParent: 46, body: `${parentBody}\n\n## Question\n\nWhich way?` },
    ];
    const provenance = { sessionId: 'sess-1', mode: 'afk', at: '2026-10-01T00:00:00.000Z' };
    /** A GhRunner answering from `records`; every call and comment recorded in one sequence. */
    function tracker() {
        const calls = [];
        const gh = (args) => {
            calls.push(callLine('gh', args, undefined));
            if (args[0] === 'issue' && args[1] === 'list')
                return { status: 0, stdout: JSON.stringify(records.map((r) => ({ number: r.number, state: r.state, labels: r.labels.map((name) => ({ name })), assignees: [], body: r.body }))), stderr: '' };
            if (args[0] === 'issue' && args[1] === 'view') {
                const rec = records.find((r) => r.number === Number(args[2]));
                return rec ? { status: 0, stdout: JSON.stringify({ ...rec, labels: rec.labels.map((name) => ({ name })), parent: null, blockedBy: { nodes: [] } }), stderr: '' } : { status: 1, stdout: '', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
        };
        const comment = (ref, ticket, body) => {
            calls.push(`comment ${ref.repo} #${ticket} ${JSON.stringify(body.split('\n')[0])}`);
            return 0;
        };
        return { calls, gh, comment };
    }
    const list = `gh ["issue","list","--repo","o/r","--state","all","--limit","200","--search","46 in:body","--json","number,state,labels,assignees,body"]`;
    const view = (n) => `gh ["issue","view","${n}","--repo","o/r","--json","${VIEW_FIELDS}"]`;
    /** loadMapRecords: the list, the map, then a view per listed issue and the map again. */
    const LOAD = [list, view(46), view(46), view(80), view(81), view(82), view(46)];
    it('loadMapRecords: one list, the map view, then one view per listed issue and the map', () => {
        const t = tracker();
        loadMapRecords(MAP, t.gh);
        expect(t.calls).toEqual(LOAD);
    });
    it('executePlanActions: claim + provenance, draft (reloads the map), route the human gate', () => {
        const t = tracker();
        executePlanActions(planFromMap(MAP, records), { provenance, gh: t.gh, comment: t.comment });
        const edit = (n, ...flag) => `gh ["issue","edit","${n}","--repo","o/r",${flag.map((f) => JSON.stringify(f)).join(',')}]`;
        expect(t.calls).toEqual([
            edit(80, '--add-assignee', '@me'),
            'comment o/r #80 "Claimed by an automated ralph planning run (mode: afk)."',
            edit(81, '--add-assignee', '@me'),
            'comment o/r #81 "Claimed by an automated ralph planning run (mode: afk)."',
            ...LOAD,
            edit(81, '--add-label', 'wayfinder:awaiting-human'),
            'comment o/r #81 "Drafted acceptance criteria (ralph planning run — EDIT AND ACCEPT before any execution):"',
            edit(82, '--add-label', 'wayfinder:awaiting-human'),
            'comment o/r #82 "Surfaced to a human by an automated ralph planning run: this ticket is a human gate (wayfinder:grilling / wayfinder:prototype / bare wayfinder:task). It was NOT claimed and will not be executed headlessly. Marked `wayfinder:awaiting-human`."',
        ]);
    });
    it('the default runners: gh argv through spawnSync, the comment body on stdin via --body-file -', () => {
        defaultGhRunner(['issue', 'edit', '80', '--repo', 'o/r', '--add-assignee', '@me']);
        defaultCommentRunner(MAP, 80, 'body ✓ 中文');
        expect(spawned.map((s) => ({ ...s, opts: Object.fromEntries(Object.entries(s.opts).sort()) }))).toEqual([
            { cmd: 'gh', args: ['issue', 'edit', '80', '--repo', 'o/r', '--add-assignee', '@me'], opts: { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000, windowsHide: true } },
            { cmd: 'gh', args: ['issue', 'comment', '80', '--repo', 'o/r', '--body-file', '-'], opts: { encoding: 'utf8', input: 'body ✓ 中文', timeout: 60_000, windowsHide: true } },
        ]);
    });
});
describe('gh argv baseline: src/factory/watchdog.ts flagStall', () => {
    it('labels then comments the tracker issue', () => {
        const stall = {
            intentId: 'acme/widget#12', session: 'sess-1', stage: 'intent', stalledForMs: 45 * 60_000,
            tracker: { repo: 'acme/widget', issue: 12, nextLabel: 'factory:plan', failedLabel: 'factory:failed' },
        };
        const calls = [];
        flagStall(stall, { cwd: os.tmpdir(), spawner: (cmd, args) => { calls.push(callLine(cmd, args, undefined)); } });
        expect(calls).toEqual([
            'gh ["issue","edit","12","--repo","acme/widget","--add-label","harbor:need-info"]',
            'gh ["issue","comment","12","--repo","acme/widget","--body","链已停住：intent 环会话 sess-1 已 45 分钟未推进（预写 ledger 未被接管），需人工检查。"]',
        ]);
    });
});
describe('gh argv baseline: src/hooks/session-end/spawn-next.ts executeSpawnNext', () => {
    const chain = {
        outcome: 'success',
        reason: 'clear',
        routeTable: { 'success:clear': { stage: 'launch', skill: 'execute' } },
        sessionId: 'sess-1',
        handoffContext: 'context body',
        tracker: { repo: 'owner/repo', issue: 42, nextLabel: 'in-launch', failedLabel: 'failed' },
    };
    let directory;
    beforeEach(() => {
        vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
        vi.stubEnv('COPILOT_CLI', '');
        vi.stubEnv('COPILOT_AGENT_SESSION_ID', '');
        vi.stubEnv(AFK_INCLUDE_USER_SETTINGS_ENV, '0');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omg-gh-baseline-spawn-'));
        execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    /** gh calls verbatim (with their spawn context); the host link spawn as one marker line. */
    function spawner(fail = false) {
        const calls = [];
        const spawnFn = (cmd, args, ctx) => {
            if (cmd !== 'gh') {
                calls.push('<host link spawn>');
                if (fail)
                    throw new Error('spawn-failure');
            }
            else {
                calls.push(callLine(cmd, args, ctx));
            }
            return { unref() { } };
        };
        return { calls, spawnFn };
    }
    it('after the next link spawns: label, then comment naming the handoff', () => {
        const s = spawner();
        executeSpawnNext(chain, directory, s.spawnFn);
        expect(s.calls).toEqual([
            '<host link spawn>',
            'gh ["issue","edit","42","--repo","owner/repo","--add-label","in-launch"]',
            'gh ["issue","comment","42","--repo","owner/repo","--body","链已推进到 launch，交接上下文：sess-1-launch.json"]',
        ]);
    });
    it('a failed spawn: alert comment, then the failed label, then the error', () => {
        const s = spawner(true);
        expect(() => executeSpawnNext(chain, directory, s.spawnFn)).toThrow('spawn-failure');
        expect(s.calls).toEqual([
            '<host link spawn>',
            'gh ["issue","comment","42","--repo","owner/repo","--body","链已停住：会话结束状态 success:clear 触发下一环启动失败，需人工修复（v1 无自动重试）。"]',
            'gh ["issue","edit","42","--repo","owner/repo","--add-label","failed"]',
        ]);
    });
});
//# sourceMappingURL=gh-argv-baseline.chain.test.js.map