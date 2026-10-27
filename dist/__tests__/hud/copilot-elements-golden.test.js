/**
 * End-to-end HUD renderings for the OMC-state elements (copilotMode, team,
 * ultragoal) through the real index.ts main(), with the same harness as
 * copilot-render-golden.test.ts: stdin and the Anthropic usage API mocked,
 * everything else read from a throwaway COPILOT_HOME, state dir and project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getOmcRoot } from '../../lib/worktree-paths.js';
const EVENTS_FIXTURE = fileURLToPath(new URL('./fixtures/copilot-events-synth.jsonl', import.meta.url));
const ENV_KEYS = ['COPILOT_HOME', 'APPDATA', 'XDG_CONFIG_HOME', 'OMC_STATE_DIR', 'COLUMNS', 'CLAUDE_SESSION_ID', 'CLAUDECODE_SESSION_ID'];
function fixture(name) {
    return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}
function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
}
describe('HUD OMC-state elements by host (golden)', () => {
    let root;
    let project;
    let copilotHome;
    const savedEnv = {};
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'hud-elements-golden-'));
        project = join(root, 'project');
        copilotHome = join(root, '.copilot');
        mkdirSync(project, { recursive: true });
        mkdirSync(copilotHome, { recursive: true });
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        process.env.COPILOT_HOME = copilotHome;
        process.env.APPDATA = join(root, 'appdata');
        process.env.XDG_CONFIG_HOME = join(root, 'xdg');
        process.env.OMC_STATE_DIR = join(root, 'state');
        writeFileSync(join(copilotHome, 'settings.json'), JSON.stringify({ omcHud: { elements: { callCountsFormat: 'ascii', safeMode: true, profile: false }, maxWidth: 400 } }));
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-27T10:05:00.000Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.doUnmock('../../hud/stdin.js');
        vi.doUnmock('../../hud/usage-api.js');
        vi.restoreAllMocks();
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = savedEnv[key];
        }
        rmSync(root, { recursive: true, force: true });
    });
    async function runHud(payload) {
        vi.resetModules();
        vi.doMock('../../hud/stdin.js', async (importOriginal) => ({
            ...(await importOriginal()),
            readStdin: vi.fn(async () => payload),
            readStdinCache: vi.fn(() => null),
            writeStdinCache: vi.fn(),
        }));
        vi.doMock('../../hud/usage-api.js', () => ({
            getUsage: vi.fn(async () => null),
            getSubscriptionInfo: vi.fn(() => null),
        }));
        const log = vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
        await import('../../hud/index.js');
        await vi.waitFor(() => expect(log).toHaveBeenCalled(), { timeout: 5000 });
        return String(log.mock.calls[0][0])
            .replace(/\x1b\[[0-9;]*m/g, '')
            .replace(/\[oh-my-copilot#[^\]]*\]/g, '[oh-my-copilot#V]');
    }
    function copilotPayload(name, withEvents) {
        const payload = fixture(name);
        const sessionDir = join(copilotHome, 'session-state', String(payload.session_id));
        mkdirSync(sessionDir, { recursive: true });
        if (withEvents)
            copyFileSync(EVENTS_FIXTURE, join(sessionDir, 'events.jsonl'));
        return { ...payload, cwd: project, transcript_path: sessionDir };
    }
    /** The project's state root as the HUD resolves it (OMC_STATE_DIR/<project-id>). */
    const omgRoot = () => getOmcRoot(project);
    function writeRalph(sessionId) {
        writeJson(join(omgRoot(), 'state', 'sessions', sessionId, 'ralph-state.json'), {
            active: true,
            iteration: 4,
            max_iterations: 10,
        });
    }
    function writeTeamAndGoals() {
        const team = join(omgRoot(), 'state', 'team', 'hud-fix');
        writeJson(join(team, 'config.json'), {
            name: 'hud-fix',
            task: 'HUD overhaul',
            created_at: '2026-10-27T09:47:00.000Z',
            workers: ['worker-1', 'worker-2', 'worker-3', 'worker-4'].map((name) => ({ name, role: 'executor' })),
        });
        for (const [name, state] of [['worker-1', 'working'], ['worker-2', 'working'], ['worker-3', 'working'], ['worker-4', 'idle']]) {
            writeJson(join(team, 'workers', name, 'status.json'), { state, updated_at: '2026-10-27T10:04:00.000Z' });
        }
        const statuses = ['completed', 'completed', 'completed', 'completed', 'completed', 'in_progress', 'in_progress', 'in_progress', 'pending'];
        statuses.forEach((status, index) => writeJson(join(team, 'tasks', `${index + 1}.json`), { id: String(index + 1), status }));
        const goals = ['complete', 'complete', 'in_progress', 'pending', 'pending'].map((status, index) => ({
            id: `G${index + 1}`, title: `goal ${index + 1}`, objective: 'o', status, attempt: 1, createdAt: 'x', updatedAt: 'x',
        }));
        writeJson(join(omgRoot(), 'ultragoal', 'goals.json'), {
            version: 1, createdAt: 'x', updatedAt: 'x', briefPath: 'b', goalsPath: 'g', ledgerPath: 'l', goals,
        });
    }
    it('Copilot, idle: the new elements render nothing without state', async () => {
        const out = await runHud(copilotPayload('copilot-1.0.103-synth-idle.json', false));
        expect(out).toBe('[oh-my-copilot#V] | session:0m | ctx:[----------]0%');
    });
    it('Copilot, ralph active in native autopilot mode', async () => {
        const payload = copilotPayload('copilot-1.0.103-synth-after-prompt.json', true);
        writeRalph(String(payload.session_id));
        const out = await runHud(payload);
        // `ralph skill:ralph` is the existing skills element (active ralph plus the last skill).
        expect(out).toBe([
            '[oh-my-copilot#V] | cr:0.4 | mode:autopilot | session:25m | ralph:4/10 | ralph skill:ralph | ctx:[###-------]31% | agents:1 | T:5 A:2 S:1',
            '└─ x exec          4m  lane-b: events reader (call_ta)',
        ].join('\n'));
    });
    it('Copilot, team running with an ultragoal plan and allow-all on', async () => {
        writeTeamAndGoals();
        const out = await runHud({ ...copilotPayload('copilot-1.0.103-synth-near-limit.json', false), allow_all_enabled: true });
        expect(out).toBe([
            '[oh-my-copilot#V] | cr:9.1 | mode:yolo | session:125m | team:hud-fix 3/4w 5/9t | goal:2/5 | ctx:[#########-]86% CRITICAL',
            '[!] ctx 86% >= 80% threshold - run /compact',
        ].join('\n'));
    });
    it('Copilot: a user false turns an element off', async () => {
        writeTeamAndGoals();
        writeFileSync(join(copilotHome, 'settings.json'), JSON.stringify({ omcHud: { elements: { callCountsFormat: 'ascii', safeMode: true, profile: false, team: false }, maxWidth: 400 } }));
        const out = await runHud(copilotPayload('copilot-1.0.103-synth-idle.json', false));
        expect(out).toBe('[oh-my-copilot#V] | session:0m | goal:2/5 | ctx:[----------]0%');
    });
    it('Claude Code: output is unchanged with team and ultragoal state present', async () => {
        writeTeamAndGoals();
        const transcript = join(root, '.claude', 'projects', 'p', 'a1d28173-0000-4000-8000-000000000000.jsonl');
        const out = await runHud({
            cwd: project,
            session_id: 'a1d28173-0000-4000-8000-000000000000',
            transcript_path: transcript,
            model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
            effort: { level: 'high' },
            version: '2.1.309',
            output_style: { name: 'default' },
            exceeds_200k_tokens: false,
            cost: { total_duration_ms: 1_500_000 },
            context_window: { context_window_size: 200000, used_percentage: 12 },
        });
        // Identical to the Claude golden in copilot-render-golden.test.ts.
        expect(out).toBe([
            'branch:main',
            '[oh-my-copilot#V] | Model: Opus 4.7 | effort:high | session:0m | ctx:[#---------]12%',
        ].join('\n'));
    });
});
//# sourceMappingURL=copilot-elements-golden.test.js.map