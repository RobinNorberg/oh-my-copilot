import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkThresholds, governTeamFanout, resolveBudgetSettings, runBudgetHook, } from '../governor.js';
import { emptyLedger, ledgerPath, ledgerTotals, MAX_SCAN_BYTES, mergeRecord, readCopilotSessionUsage, readLedger, readTailTotals, recordUsage, resetLedger, updateLedger, } from '../ledger.js';
import { acquireFileLockSync, lockPathFor, releaseFileLockSync } from '../../lib/file-lock.js';
import { budgetCommand } from '../../cli/commands/budget.js';
import { renderPremiumBudget } from '../../hud/elements/premium-budget.js';
import { applyBudgetGovernor, parseTeamArgs } from '../../cli/commands/team.js';
const SID = '1b4b720d-2e5c-4ba8-bd81-d42629574d3a';
const line = (type, data, extra = {}) => JSON.stringify({ type, data, ...extra });
// Shapes copied from a real Copilot CLI 1.0.91 events.jsonl (trimmed).
const PROMPT = line('user.message', { content: 'hi' });
const SUBAGENT_PROMPT = line('user.message', { content: 'sub', source: `agent-${SID}` });
const AUTO_MODEL = line('session.auto_mode_resolved', { chosenModel: 'mai-code-1.1-flash' });
const CHECKPOINT = line('session.usage_checkpoint', { totalNanoAiu: 268660000, totalPremiumRequests: 1 });
const SHUTDOWN = line('session.shutdown', { shutdownType: 'routine', totalPremiumRequests: 3, totalNanoAiu: 617430500, currentModel: 'mai-code-1.1-flash' });
let root;
let project;
let copilotHome;
function writeEvents(sessionId, lines) {
    const dir = join(copilotHome, 'session-state', sessionId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'events.jsonl');
    writeFileSync(path, `${lines.join('\n')}\n`);
    return path;
}
function writeBudget(budget) {
    mkdirSync(join(project, '.copilot'), { recursive: true });
    writeFileSync(join(project, '.copilot', 'omg.jsonc'), `// test\n${JSON.stringify({ budget })}\n`);
}
const record = (premiumRequests, source = 'measured', credits = 0) => ({ premiumRequests, credits, source, detail: 'test', updatedAt: '2026-10-11T00:00:00.000Z' });
const settings = (over = {}) => ({ enabled: true, mode: 'warn', unit: 'premiumRequests', ...over });
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-budget-'));
    project = join(root, 'project');
    copilotHome = join(root, 'copilot-home');
    mkdirSync(project, { recursive: true });
    vi.stubEnv('OMC_STATE_DIR', join(root, 'state'));
    vi.stubEnv('COPILOT_HOME', copilotHome);
    vi.stubEnv('APPDATA', join(root, 'appdata'));
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'appdata'));
    vi.stubEnv('OMC_BUDGET_GOVERNOR', '');
    vi.stubEnv('OMC_TEAM_WORKER', '');
    vi.stubEnv('OMC_BUDGET_HOST_LEDGER', '');
});
afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
});
describe('readCopilotSessionUsage', () => {
    it('prefers the last shutdown totals and labels them measured', () => {
        const usage = readCopilotSessionUsage(writeEvents(SID, [PROMPT, AUTO_MODEL, CHECKPOINT, SHUTDOWN]));
        expect(usage).toMatchObject({ premiumRequests: 3, credits: 0.6174305, source: 'measured', detail: 'session.shutdown', model: 'mai-code-1.1-flash' });
    });
    it('uses a usage checkpoint when the session has not shut down', () => {
        expect(readCopilotSessionUsage(writeEvents(SID, [PROMPT, CHECKPOINT]))).toMatchObject({ premiumRequests: 1, credits: 0.26866, source: 'measured', detail: 'session.usage_checkpoint' });
    });
    it('estimates one request per top-level prompt, ignoring subagent prompts', () => {
        const usage = readCopilotSessionUsage(writeEvents(SID, [PROMPT, SUBAGENT_PROMPT, PROMPT, 'not json']));
        expect(usage).toMatchObject({ premiumRequests: 2, credits: 0, source: 'estimated' });
        expect(usage?.detail).toMatch(/^estimate: 2 user prompt\(s\) x1/);
    });
    it('returns null for a missing file or a session without prompts', () => {
        expect(readCopilotSessionUsage(join(root, 'nope.jsonl'))).toBeNull();
        expect(readCopilotSessionUsage(writeEvents(SID, [AUTO_MODEL]))).toBeNull();
    });
});
describe('ledger', () => {
    it('never downgrades a measured record to an estimate', () => {
        expect(mergeRecord(record(4), record(9, 'estimated'))).toEqual(record(4));
        expect(mergeRecord(record(2, 'estimated'), record(5))).toEqual(record(5));
    });
    it('records sessions and teams under the lock and totals them', () => {
        const path = ledgerPath(project);
        recordUsage(path, 's1', record(2, 'measured', 0.5));
        recordUsage(path, 's2', record(1, 'estimated'));
        recordUsage(path, 'worker-1:a', record(3, 'measured', 1), 'alpha');
        recordUsage(path, '../escape', record(100));
        const totals = ledgerTotals(readLedger(path));
        expect(totals).toMatchObject({ premiumRequests: 6, credits: 1.5, sessions: 2, estimatedRecords: 1 });
        expect(totals.teams.alpha).toEqual({ premiumRequests: 3, credits: 1, records: 1 });
    });
    it('reads a corrupt or foreign-version ledger as empty and backs it up before overwriting', () => {
        const path = ledgerPath(project);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, '{broken');
        expect(readLedger(path).sessions).toEqual({});
        recordUsage(path, 's1', record(1));
        expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe('{broken');
        writeFileSync(path, JSON.stringify({ version: 2, since: 'x', sessions: { keep: record(9) } }));
        recordUsage(path, 's2', record(1));
        expect(JSON.parse(readFileSync(`${path}.corrupt`, 'utf8')).version).toBe(2);
        expect(Object.keys(readLedger(path).sessions)).toEqual(['s2']);
    });
    it('ignores null and non-object records instead of throwing', async () => {
        const path = ledgerPath(project);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, JSON.stringify({
            version: 1, since: '2026-10-01T00:00:00.000Z',
            sessions: { a: null, b: 3, c: record(2) }, teams: { x: null, y: { k: null, w: record(1) } }, notified: null,
        }));
        expect(ledgerTotals(readLedger(path))).toMatchObject({ premiumRequests: 3, sessions: 1, teams: { y: { records: 1 } } });
        // The raw shape too (a caller holding an unsanitized ledger).
        expect(ledgerTotals({ ...emptyLedger(), sessions: { a: null } }).sessions).toBe(0);
        recordUsage(path, 'c', record(5));
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            expect(await budgetCommand('reset', { json: true }, project)).toBe(0);
        }
        finally {
            log.mockRestore();
        }
    });
    it('never lowers an estimate, and keeps the larger measured total when one drops', () => {
        expect(mergeRecord(record(5, 'estimated'), record(3, 'estimated')).premiumRequests).toBe(5);
        const dropped = mergeRecord(record(7), record(2));
        expect(dropped.premiumRequests).toBe(7);
        expect(dropped.detail).toMatch(/total fell from 7 to 2 \(resumed session\?\), kept 7/);
    });
    it('refuses a ledger path in the real home directory under test', () => {
        vi.stubEnv('OMC_STATE_DIR', join(homedir(), '.omg-budget-test-guard'));
        expect(() => ledgerPath(project)).toThrow(/outside the temp dir under test/);
    });
});
describe('readCopilotSessionUsage incremental and tail mode', () => {
    const big = (prompts) => {
        // ~200 bytes a line, so 50k prompts are ~10 MB: past MAX_SCAN_BYTES (8 MB).
        const filler = 'x'.repeat(160);
        return Array.from({ length: prompts }, () => line('user.message', { content: filler }));
    };
    it('counts a file larger than the scan budget across calls; the estimate only grows', () => {
        const path = writeEvents(SID, big(50_000));
        expect(statSync(path).size).toBeGreaterThan(MAX_SCAN_BYTES);
        const first = readCopilotSessionUsage(path);
        expect(first.source).toBe('estimated');
        expect(first.premiumRequests).toBeGreaterThan(0);
        expect(first.premiumRequests).toBeLessThan(50_000);
        expect(first.detail).toMatch(/read \d+ bytes so far/);
        const second = readCopilotSessionUsage(path, new Date(), { prev: first.scan });
        expect(second.premiumRequests).toBe(50_000);
        expect(second.premiumRequests).toBeGreaterThan(first.premiumRequests);
        // Nothing appended: no re-read.
        expect(readCopilotSessionUsage(path, new Date(), { prev: second.scan })).toBeNull();
        appendFileSync(path, `${PROMPT}\n`);
        expect(readCopilotSessionUsage(path, new Date(), { prev: second.scan })?.premiumRequests).toBe(50_001);
    });
    it('reads the end-of-session totals from the tail when the scan is partial', () => {
        const path = writeEvents(SID, [...Array.from({ length: 200 }, () => PROMPT), SHUTDOWN]);
        const usage = readCopilotSessionUsage(path, new Date(), { maxScanBytes: 1024 });
        expect(usage).toMatchObject({ premiumRequests: 3, source: 'measured', detail: 'session.shutdown (events tail)' });
        expect(usage.scan.offset).toBeLessThanOrEqual(1024);
        expect(readTailTotals(path, statSync(path).size)).toMatchObject({ premium: 3, type: 'session.shutdown' });
    });
    it('counts only prompts from the period start', () => {
        const at = (iso) => line('user.message', { content: 'hi' }, { timestamp: iso });
        const path = writeEvents(SID, [at('2026-10-01T00:00:00.000Z'), at('2026-10-03T00:00:00.000Z')]);
        expect(readCopilotSessionUsage(path, new Date(), { since: '2026-10-02T00:00:00.000Z' })?.premiumRequests).toBe(1);
    });
});
describe('resolveBudgetSettings', () => {
    it('defaults to warn mode in premium requests with no limits', () => {
        expect(resolveBudgetSettings(undefined, {})).toEqual({ settings: settings(), issues: [] });
    });
    it('drops invalid values with an issue instead of throwing', () => {
        const { settings: s, issues } = resolveBudgetSettings({ mode: 'block', unit: 'usd', softLimit: -1, hardLimit: 10, perTeamLimit: '5', extra: 1 }, {});
        expect(s).toEqual(settings({ hardLimit: 10 }));
        expect(issues).toHaveLength(5);
    });
    it('flags a soft limit above the hard limit and honours the kill switch', () => {
        const { settings: s, issues } = resolveBudgetSettings({ softLimit: 20, hardLimit: 10, mode: 'enforce' }, { OMC_BUDGET_GOVERNOR: '0' });
        expect(s.enabled).toBe(false);
        expect(issues).toEqual(['budget.softLimit (20) is above budget.hardLimit (10)']);
    });
});
describe('checkThresholds', () => {
    it('notifies the soft and then the hard limit once each', () => {
        const ledger = emptyLedger();
        const s = settings({ softLimit: 2, hardLimit: 4 });
        ledger.sessions.a = record(1);
        expect(checkThresholds(ledger, s)).toBeNull();
        ledger.sessions.a = record(2);
        expect(checkThresholds(ledger, s)).toMatch(/^\[BUDGET\] Soft limit reached: 2 premium requests of 2/);
        expect(checkThresholds(ledger, s)).toBeNull();
        ledger.sessions.a = record(5);
        expect(checkThresholds(ledger, s)).toMatch(/^\[BUDGET\] Hard limit reached/);
        expect(checkThresholds(ledger, s)).toBeNull();
    });
    it('says how many records are estimated', () => {
        const ledger = emptyLedger();
        ledger.sessions.a = record(2, 'estimated');
        ledger.sessions.b = record(1);
        expect(checkThresholds(ledger, settings({ softLimit: 3 }))).toMatch(/3 premium requests of 3 used since .* \(1 record\(s\) estimated\)\. Mention/);
    });
    it('re-arms a notice when its limit is raised', () => {
        const ledger = emptyLedger();
        ledger.sessions.a = record(5);
        expect(checkThresholds(ledger, settings({ softLimit: 2, hardLimit: 4 }))).toMatch(/Hard limit reached: 5 premium requests of 4/);
        expect(checkThresholds(ledger, settings({ softLimit: 2, hardLimit: 4 }))).toBeNull();
        // Raised past the usage: nothing yet, but armed again.
        expect(checkThresholds(ledger, settings({ softLimit: 2, hardLimit: 10 }))).toBeNull();
        ledger.sessions.a = record(11);
        expect(checkThresholds(ledger, settings({ softLimit: 2, hardLimit: 10 }))).toMatch(/Hard limit reached: 11 premium requests of 10/);
        // Lowering never re-arms.
        expect(checkThresholds(ledger, settings({ softLimit: 2, hardLimit: 8 }))).toBeNull();
    });
});
describe('runBudgetHook', () => {
    const payload = (extra = {}) => ({ session_id: SID, cwd: project, ...extra });
    it('records usage silently when no limit is configured', () => {
        writeEvents(SID, [PROMPT]);
        expect(runBudgetHook({ phase: 'turn', payload: payload() })).toBeNull();
        expect(readLedger(ledgerPath(project)).sessions[SID]).toMatchObject({ premiumRequests: 1, source: 'estimated' });
    });
    it('marks a crossed limit at stop and delivers it once on the next prompt', () => {
        writeBudget({ softLimit: 1, hardLimit: 10 });
        writeEvents(SID, [PROMPT]);
        const stop = runBudgetHook({ phase: 'turn', payload: payload() });
        expect(stop?.systemMessage).toMatch(/Soft limit reached/);
        const prompt = runBudgetHook({ phase: 'submit', payload: payload() });
        expect(prompt.hookSpecificOutput.additionalContext).toMatch(/Soft limit reached/);
        expect(runBudgetHook({ phase: 'submit', payload: payload() })).toBeNull();
    });
    it('prints the summary at session start and upgrades ended estimates to measured', () => {
        writeBudget({ hardLimit: 50 });
        writeEvents(SID, [PROMPT]);
        runBudgetHook({ phase: 'turn', payload: payload() });
        writeEvents(SID, [PROMPT, SHUTDOWN]);
        const out = runBudgetHook({ phase: 'start', payload: payload({ session_id: 'new-session' }) });
        expect(out.hookSpecificOutput.additionalContext).toMatch(/^\[BUDGET\] Copilot usage since .*: 3 premium requests, 0\.617 AI credits \(1 session\(s\), 0 team\(s\)\)\. Limits in premiumRequests: hard 50 \(warn mode\)/);
        expect(readLedger(ledgerPath(project)).sessions[SID]?.source).toBe('measured');
    });
    it('records a pane team worker under its team without output, and skips host-recorded sdk workers', () => {
        writeBudget({ softLimit: 1 });
        writeEvents(SID, [PROMPT]);
        const env = { ...process.env, OMC_TEAM_WORKER: 'alpha/worker-1', OMC_TEAM_LEADER_CWD: project };
        expect(runBudgetHook({ phase: 'turn', payload: payload({ cwd: join(root, 'wt') }), env })).toBeNull();
        expect(readLedger(ledgerPath(project)).teams.alpha?.[SID]?.premiumRequests).toBe(1);
        expect(readLedger(ledgerPath(project)).sessions).toEqual({});
        writeEvents('other', [PROMPT]);
        runBudgetHook({ phase: 'turn', payload: payload({ session_id: 'other' }), env: { ...env, OMC_BUDGET_HOST_LEDGER: '1' } });
        expect(readLedger(ledgerPath(project)).teams.alpha?.other).toBeUndefined();
    });
    it('counts only usage after `omg budget reset` for a session running across it', async () => {
        const at = (ms) => line('user.message', { content: 'hi' }, { timestamp: new Date(ms).toISOString() });
        const t0 = Date.now() - 3_600_000;
        const forty = Array.from({ length: 40 }, (_, i) => at(t0 + i * 1000));
        writeEvents(SID, forty);
        runBudgetHook({ phase: 'turn', payload: payload() });
        expect(readLedger(ledgerPath(project)).sessions[SID]?.premiumRequests).toBe(40);
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            expect(await budgetCommand('reset', { json: true }, project)).toBe(0);
        }
        finally {
            log.mockRestore();
        }
        const since = Date.parse(readLedger(ledgerPath(project)).since);
        writeEvents(SID, [...forty, at(since + 1000)]);
        runBudgetHook({ phase: 'turn', payload: payload() });
        expect(readLedger(ledgerPath(project)).sessions[SID]).toMatchObject({ premiumRequests: 1, source: 'estimated' });
        // The session ends: its cumulative total (45) minus the pre-reset estimate (40); the split is estimated.
        writeEvents(SID, [...forty, at(since + 1000), line('session.shutdown', { totalPremiumRequests: 45, totalNanoAiu: 0 })]);
        runBudgetHook({ phase: 'turn', payload: payload() });
        expect(readLedger(ledgerPath(project)).sessions[SID]).toMatchObject({ premiumRequests: 5, source: 'estimated' });
    });
    it('subtracts a measured pre-reset total exactly', () => {
        const path = ledgerPath(project);
        recordUsage(path, 'w:1', record(4, 'measured', 2), 'alpha');
        updateLedger(path, (l) => { resetLedger(l); });
        recordUsage(path, 'w:1', record(6, 'measured', 2.5), 'alpha');
        expect(readLedger(path).teams.alpha?.['w:1']).toMatchObject({ premiumRequests: 2, credits: 0.5, source: 'measured' });
    });
    it('refreshes estimated pane team worker records at session start', () => {
        writeEvents(SID, [PROMPT]);
        const env = { ...process.env, OMC_TEAM_WORKER: 'alpha/worker-1', OMC_TEAM_LEADER_CWD: project };
        runBudgetHook({ phase: 'turn', payload: payload({ cwd: join(root, 'wt') }), env });
        expect(readLedger(ledgerPath(project)).teams.alpha?.[SID]?.source).toBe('estimated');
        writeEvents(SID, [PROMPT, SHUTDOWN]);
        runBudgetHook({ phase: 'start', payload: payload({ session_id: 'leader' }) });
        expect(readLedger(ledgerPath(project)).teams.alpha?.[SID]).toMatchObject({ premiumRequests: 3, source: 'measured' });
    });
    it('bounds the session-start refresh: rotates, skips unchanged files, marks gone ones final', () => {
        const ids = Array.from({ length: 25 }, (_, i) => `s-${String(i).padStart(2, '0')}`);
        const padding = ' '.repeat(200); // a line the scanner ignores, so the file can be rewritten at the same size
        for (const id of ids) {
            writeEvents(id, [PROMPT, padding]);
            runBudgetHook({ phase: 'turn', payload: payload({ session_id: id }) });
        }
        // Whole-second mtime: a sub-ms stamp does not survive utimesSync's float-seconds round trip exactly.
        const first = join(copilotHome, 'session-state', ids[0], 'events.jsonl');
        const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
        utimesSync(first, pinned, pinned);
        const sessions = () => readLedger(ledgerPath(project)).sessions;
        const checked = () => Object.entries(sessions()).filter(([, r]) => r.scan?.checkedSize !== undefined).map(([id]) => id);
        // A generous time budget: the count bound is under test here, not the clock (a loaded runner is slow).
        const start = (n) => runBudgetHook({ phase: 'start', payload: payload({ session_id: `leader-${n}` }), refreshDeadlineMs: 60_000 });
        start(1);
        expect(checked()).toEqual(ids.slice(0, 20));
        start(2);
        expect(checked()).toEqual(ids); // the rotation reached the last five
        // Same size and mtime as at the last check: not re-read, even though the content now holds totals.
        const { size } = statSync(first);
        const shutdown = line('session.shutdown', { totalPremiumRequests: 9, totalNanoAiu: 0 });
        writeFileSync(first, `${shutdown}\n`.padEnd(size - 1, ' ') + '\n');
        expect(statSync(first).size).toBe(size);
        utimesSync(first, pinned, pinned);
        start(3);
        expect(sessions()[ids[0]]?.source).toBe('estimated');
        // Changed mtime: re-read, upgraded to measured.
        utimesSync(first, new Date(), new Date(Date.now() + 5000));
        start(4);
        expect(sessions()[ids[0]]).toMatchObject({ premiumRequests: 9, source: 'measured' });
        // Gone: final, never re-read.
        rmSync(join(copilotHome, 'session-state', ids[1]), { recursive: true });
        for (let i = 5; i < 8; i++)
            start(i);
        expect(sessions()[ids[1]]).toMatchObject({ premiumRequests: 1, scan: { gone: true } });
        expect(sessions()[ids[1]]?.detail).toMatch(/events file gone, final/);
    });
    it('stops the refresh at its time budget but always moves the rotation on', () => {
        for (const id of ['a-1', 'a-2', 'a-3']) {
            writeEvents(id, [PROMPT]);
            runBudgetHook({ phase: 'turn', payload: payload({ session_id: id }) });
        }
        runBudgetHook({ phase: 'start', payload: payload({ session_id: 'leader' }), refreshDeadlineMs: -1 });
        const ledger = readLedger(ledgerPath(project));
        expect(Object.values(ledger.sessions).filter((r) => r.scan?.checkedSize !== undefined)).toHaveLength(1);
        expect(ledger.refreshCursor).toBe(1);
    });
    it('does nothing under the kill switch', () => {
        writeBudget({ softLimit: 1 });
        writeEvents(SID, [PROMPT]);
        expect(runBudgetHook({ phase: 'turn', payload: payload(), env: { ...process.env, OMC_BUDGET_GOVERNOR: '0' } })).toBeNull();
        expect(readLedger(ledgerPath(project)).sessions).toEqual({});
    });
});
describe('governTeamFanout', () => {
    const totals = (premiumRequests, credits = 0) => ({ ...ledgerTotals(emptyLedger()), premiumRequests, credits });
    const base = { maxCreditsPerWorker: 10, override: false, clampable: true };
    const four = ['copilot', 'copilot', 'copilot', 'copilot'];
    it('passes when within budget or when no copilot worker is billed', () => {
        expect(governTeamFanout({ ...base, settings: settings({ mode: 'enforce', hardLimit: 10 }), totals: totals(5), agentTypes: four })).toEqual({ workerCount: 4 });
        expect(governTeamFanout({ ...base, settings: settings({ mode: 'enforce', hardLimit: 1 }), totals: totals(5), agentTypes: ['claude', 'codex'] })).toEqual({ workerCount: 2 });
    });
    it('only warns in warn mode or with the override', () => {
        const warn = governTeamFanout({ ...base, settings: settings({ hardLimit: 6 }), totals: totals(4), agentTypes: four });
        expect(warn).toEqual({ workerCount: 4, notice: expect.stringMatching(/projected at least 4 premium requests .* exceeds the 2 premium requests left of budget.hardLimit 6; starting anyway \(warn mode\)/) });
        const override = governTeamFanout({ ...base, override: true, settings: settings({ mode: 'enforce', hardLimit: 6 }), totals: totals(4), agentTypes: four });
        expect(override.workerCount).toBe(4);
        expect(override.notice).toMatch(/--budget-override/);
    });
    it('clamps in enforce mode, and refuses when nothing fits or workers own subtasks', () => {
        const s = settings({ mode: 'enforce', hardLimit: 6, perTeamLimit: 3 });
        expect(governTeamFanout({ ...base, settings: s, totals: totals(0), agentTypes: four })).toMatchObject({ workerCount: 3, notice: expect.stringMatching(/exceeds budget.perTeamLimit 3; clamped to 3/) });
        expect(governTeamFanout({ ...base, settings: s, totals: totals(6), agentTypes: four }).refusal).toMatch(/team launch refused\. Pass --budget-override/);
        expect(governTeamFanout({ ...base, clampable: false, settings: s, totals: totals(0), agentTypes: four }).refusal).toMatch(/refused/);
    });
    it('projects the per-worker credit cap in credits', () => {
        const decision = governTeamFanout({ ...base, settings: settings({ mode: 'enforce', unit: 'credits', perTeamLimit: 25 }), totals: totals(0, 0), agentTypes: four });
        expect(decision).toMatchObject({ workerCount: 2, notice: expect.stringMatching(/projected 40 AI credits \(4 copilot worker\(s\) x 10 credit cap\)/) });
    });
});
describe('omg budget and the HUD element', () => {
    it('reports status as JSON, exits 1 at the hard limit, and resets', async () => {
        writeBudget({ hardLimit: 2 });
        recordUsage(ledgerPath(project), 's1', record(2));
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            expect(await budgetCommand('status', { json: true }, project)).toBe(1);
            expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ used: 2, settings: { hardLimit: 2 }, totals: { sessions: 1 } });
            expect(await budgetCommand('reset', { json: true }, project)).toBe(0);
            expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({ ok: true, previous: { premiumRequests: 2 } });
            expect(readLedger(ledgerPath(project)).sessions).toEqual({});
        }
        finally {
            log.mockRestore();
        }
    });
    it('fails a reset cleanly while another process holds the ledger lock', async () => {
        const path = ledgerPath(project);
        recordUsage(path, 's1', record(2));
        const handle = acquireFileLockSync(lockPathFor(path));
        expect(handle).not.toBeNull();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            expect(await budgetCommand('reset', {}, project)).toBe(1);
            expect(String(error.mock.calls[0]?.[0])).toMatch(/^omg budget reset: the ledger is locked by another process .*; try again in a moment\.$/);
            expect(readLedger(path).sessions.s1?.premiumRequests).toBe(2);
        }
        finally {
            error.mockRestore();
            releaseFileLockSync(handle);
        }
    });
    it('renders prq:used/limit, with ~ when part is estimated, only when limits exist', () => {
        expect(renderPremiumBudget(project)).toBeNull();
        writeBudget({ softLimit: 2, hardLimit: 5 });
        recordUsage(ledgerPath(project), 's1', record(3, 'estimated'));
        expect(renderPremiumBudget(project)?.replace(/\x1b\[[0-9;]*m/g, '')).toBe('prq:~3/5');
    });
});
describe('omg team --budget-override', () => {
    it('parses the flag only when given', () => {
        expect(parseTeamArgs(['2:copilot', '--budget-override', 'fix it']).budgetOverride).toBe(true);
        expect('budgetOverride' in parseTeamArgs(['2:copilot', 'fix it'])).toBe(false);
    });
});
describe('applyBudgetGovernor (omg team start)', () => {
    const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
    it('clamps an all-copilot team in enforce mode and prints why', async () => {
        writeBudget({ mode: 'enforce', perTeamLimit: 2 });
        const error = quiet();
        try {
            expect(await applyBudgetGovernor(parseTeamArgs(['4:copilot', 'fix it']), 4, true, project)).toBe(2);
            expect(String(error.mock.calls[0]?.[0])).toMatch(/projected at least 4 premium requests .* clamped to 2 worker\(s\)/);
        }
        finally {
            error.mockRestore();
        }
    });
    it('refuses a mixed-provider team instead of dropping workers, unless overridden', async () => {
        writeBudget({ mode: 'enforce', perTeamLimit: 1 });
        const error = quiet();
        try {
            await expect(applyBudgetGovernor(parseTeamArgs(['2:copilot,1:claude', 'fix it']), 3, true, project)).rejects.toThrow(/team launch refused/);
            expect(await applyBudgetGovernor(parseTeamArgs(['2:copilot,1:claude', '--budget-override', 'fix it']), 3, true, project)).toBe(3);
        }
        finally {
            error.mockRestore();
        }
    });
    it('starts unchanged when the governor itself fails (fail-open)', async () => {
        writeBudget({ mode: 'enforce', perTeamLimit: 1 });
        vi.stubEnv('OMC_STATE_DIR', join(homedir(), '.omg-budget-test-guard')); // ledgerPath throws under test
        expect(await applyBudgetGovernor(parseTeamArgs(['4:copilot', 'fix it']), 4, true, project)).toBe(4);
    });
});
describe('scripts/premium-budget.mjs', () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'premium-budget.mjs');
    const run = (scriptPath, phase, input) => spawnSync(process.execPath, [scriptPath, phase], {
        input, encoding: 'utf8', timeout: 20_000, env: { ...process.env, OMC_DEBUG_HOOKS: '' },
    });
    const noop = { continue: true, suppressOutput: true };
    it('prints the no-op for bad stdin and unknown phases', () => {
        for (const [phase, input] of [['turn', 'not json'], ['turn', ''], ['session-start', '{}']]) {
            const r = run(script, phase, input);
            expect(r.status, r.stderr).toBe(0);
            expect(JSON.parse(r.stdout)).toEqual(noop);
        }
    });
    it('prints the no-op when the dist build is missing', () => {
        const copy = join(root, 'plugin', 'scripts');
        mkdirSync(join(copy, 'lib'), { recursive: true });
        copyFileSync(script, join(copy, 'premium-budget.mjs'));
        copyFileSync(join(dirname(script), 'lib', 'stdin.mjs'), join(copy, 'lib', 'stdin.mjs'));
        expect(existsSync(join(root, 'plugin', 'dist'))).toBe(false);
        const r = run(join(copy, 'premium-budget.mjs'), 'turn', JSON.stringify({ session_id: SID, cwd: project }));
        expect(r.status, r.stderr).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual(noop);
    });
});
it('keeps the ledger as readable JSON', () => {
    recordUsage(ledgerPath(project), 's1', record(1));
    expect(JSON.parse(readFileSync(ledgerPath(project), 'utf8')).version).toBe(1);
});
//# sourceMappingURL=budget.test.js.map