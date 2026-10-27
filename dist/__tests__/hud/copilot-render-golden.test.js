/**
 * End-to-end HUD renderings per host: the real index.ts pipeline with only
 * stdin and the Anthropic usage API mocked, under a throwaway COPILOT_HOME,
 * APPDATA and project directory. The Copilot payloads are the synthetic
 * fixtures in ./fixtures; the Claude case guards byte-identical output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
const EVENTS_FIXTURE = fileURLToPath(new URL('./fixtures/copilot-events-synth.jsonl', import.meta.url));
const ENV_KEYS = ['COPILOT_HOME', 'APPDATA', 'XDG_CONFIG_HOME', 'OMC_STATE_DIR', 'COLUMNS', 'CLAUDE_SESSION_ID', 'CLAUDECODE_SESSION_ID'];
function fixture(name) {
    return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));
}
describe('HUD renderings by host (golden)', () => {
    let root;
    let project;
    let copilotHome;
    const savedEnv = {};
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'hud-golden-'));
        project = join(root, 'project');
        copilotHome = join(root, '.copilot');
        mkdirSync(project, { recursive: true });
        mkdirSync(copilotHome, { recursive: true });
        // A non-git cwd makes the HUD fall back to the process's repo; keep it here.
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        process.env.COPILOT_HOME = copilotHome;
        process.env.APPDATA = join(root, 'appdata');
        process.env.XDG_CONFIG_HOME = join(root, 'xdg');
        process.env.OMC_STATE_DIR = join(root, 'state');
        // Pin what varies by platform or terminal (call-count icons, width), and
        // the profile chip, which only shows because this test sets COPILOT_HOME.
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
    /** Run the HUD once on `payload` and return stdout with the version tag normalised. */
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
        await import('../../hud/index.js'); // index.ts runs main() on import
        await vi.waitFor(() => expect(log).toHaveBeenCalled(), { timeout: 5000 });
        return String(log.mock.calls[0][0])
            .replace(/\x1b\[[0-9;]*m/g, '')
            .replace(/\[oh-my-copilot#[^\]]*\]/g, '[oh-my-copilot#V]');
    }
    /** A Copilot fixture pointed at this test's project dir and session-state dir. */
    function copilotPayload(name, withEvents) {
        const payload = fixture(name);
        const sessionDir = join(copilotHome, 'session-state', String(payload.session_id));
        mkdirSync(sessionDir, { recursive: true });
        if (withEvents)
            copyFileSync(EVENTS_FIXTURE, join(sessionDir, 'events.jsonl'));
        return { ...payload, cwd: project, transcript_path: sessionDir };
    }
    it('Copilot, idle: no model, no credits at zero, session from cost.total_duration_ms', async () => {
        const out = await runHud(copilotPayload('copilot-1.0.103-synth-idle.json', false));
        // Before this lane: branch:main / Model: Sonnet 5.5 | session:0m | ctx 0%.
        expect(out).toBe('[oh-my-copilot#V] | session:0m | ctx:[----------]0%');
    });
    it('Copilot, after a prompt: credits, context from current_context, events data', async () => {
        const out = await runHud(copilotPayload('copilot-1.0.103-synth-after-prompt.json', true));
        // Before: session:0m and ctx 18% (used_percentage), no events data at all.
        expect(out).toBe([
            '[oh-my-copilot#V] | cr:0.4 | mode:autopilot | session:25m | skill:ralph | ctx:[###-------]31% | agents:1 | T:5 A:2 S:1',
            '└─ x exec          4m  lane-b: events reader (call_ta)',
        ].join('\n'));
    });
    it('Copilot, near the context limit: converted credits and the warning line', async () => {
        const out = await runHud(copilotPayload('copilot-1.0.103-synth-near-limit.json', false));
        expect(out).toBe([
            '[oh-my-copilot#V] | cr:9.1 | session:125m | ctx:[#########-]86% CRITICAL',
            '[!] ctx 86% >= 80% threshold - run /compact',
        ].join('\n'));
    });
    it('Copilot: a user true re-enables the model, while dropped elements stay off', async () => {
        writeFileSync(join(copilotHome, 'settings.json'), JSON.stringify({
            omcHud: {
                elements: { callCountsFormat: 'ascii', safeMode: true, profile: false, model: true, rateLimits: true, todos: true, thinking: true },
                maxWidth: 400,
            },
        }));
        const out = await runHud(copilotPayload('copilot-1.0.103-synth-ai-used.json', false));
        expect(out).toBe('[oh-my-copilot#V] | Model: Auto>balanced | cr:11.8 | mode:yolo | session:43m | ctx:[#####-----]48%');
    });
    it('Claude Code: output is unchanged by the Copilot data lane', async () => {
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
        // Captured from the pre-lane sources: the Claude path must not move.
        expect(out).toBe([
            'branch:main',
            '[oh-my-copilot#V] | Model: Opus 4.7 | effort:high | session:0m | ctx:[#---------]12%',
        ].join('\n'));
    });
});
//# sourceMappingURL=copilot-render-golden.test.js.map