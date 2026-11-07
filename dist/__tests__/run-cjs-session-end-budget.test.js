import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from 'path';
/**
 * Fork (oh-my-copilot) SessionEnd foreground budget in scripts/run.cjs:
 * half the manifest timeout, at least 1000ms on Claude Code (upstream #4845),
 * and a flat 1500ms when the Copilot projection sets OMC_HOOK_EVENT=SessionEnd
 * (Copilot waits for SessionEnd on every turn). OMC_SESSION_END_BUDGET_MS
 * overrides both; the manifest-derived inner timeout caps the result. The 124
 * fail-closed timeout contract is unchanged.
 */
const REPO_ROOT = join(__dirname, '..', '..');
const RUN_CJS_PATH = join(REPO_ROOT, 'scripts', 'run.cjs');
const NODE = process.execPath;
const HAS_GENERATED_DIST = existsSync(join(REPO_ROOT, 'dist', 'hooks', 'session-end', 'foreground-bootstrap.js'));
const { resolveSessionEndBudgetMs } = createRequire(__filename)(RUN_CJS_PATH);
/** A clean host env: no inherited budget knobs, no vitest NODE_ENV=test widening. */
function hostEnv(extra = {}) {
    const env = { ...process.env, ...extra };
    for (const key of ['NODE_ENV', 'OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS', 'OMC_SESSION_END_BUDGET_MS', 'OMC_HOOK_EVENT', 'OMC_HOOK_FAIL_CLOSED']) {
        if (!(key in extra))
            delete env[key];
    }
    return env;
}
describe('run.cjs SessionEnd foreground budget (fork)', () => {
    const tempDirs = [];
    afterEach(() => {
        for (const dir of tempDirs.splice(0))
            rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 25 });
    });
    describe('resolveSessionEndBudgetMs', () => {
        it('floors at 1000ms without OMC_HOOK_EVENT (Claude Code) and 1500ms under Copilot SessionEnd', () => {
            expect(resolveSessionEndBudgetMs({})).toBe(1000);
            expect(resolveSessionEndBudgetMs({ OMC_HOOK_EVENT: 'Stop' })).toBe(1000);
            expect(resolveSessionEndBudgetMs({ OMC_HOOK_EVENT: 'SessionEnd' })).toBe(1500);
        });
        it('uses half the manifest timeout on Claude Code when that is above the floor', () => {
            expect(resolveSessionEndBudgetMs({}, 30_000)).toBe(15_000);
            expect(resolveSessionEndBudgetMs({}, 28_500)).toBe(14_250);
            expect(resolveSessionEndBudgetMs({}, 1_500)).toBe(1000);
            expect(resolveSessionEndBudgetMs({ OMC_SESSION_END_BUDGET_MS: '800' }, 30_000)).toBe(800);
        });
        it('keeps Copilot SessionEnd at a flat 1500ms whatever the manifest timeout', () => {
            expect(resolveSessionEndBudgetMs({ OMC_HOOK_EVENT: 'SessionEnd' }, 30_000)).toBe(1500);
            expect(resolveSessionEndBudgetMs({ OMC_HOOK_EVENT: 'SessionEnd' }, 28_500)).toBe(1500);
            expect(resolveSessionEndBudgetMs({ OMC_HOOK_EVENT: 'SessionEnd' }, 2_000)).toBe(1500);
            expect(resolveSessionEndBudgetMs({ OMC_HOOK_EVENT: 'SessionEnd', OMC_SESSION_END_BUDGET_MS: '5000' }, 30_000)).toBe(5000);
        });
        it('honours a valid OMC_SESSION_END_BUDGET_MS on both hosts', () => {
            expect(resolveSessionEndBudgetMs({ OMC_SESSION_END_BUDGET_MS: '800' })).toBe(800);
            expect(resolveSessionEndBudgetMs({ OMC_SESSION_END_BUDGET_MS: ' 2500 ', OMC_HOOK_EVENT: 'SessionEnd' })).toBe(2500);
            expect(resolveSessionEndBudgetMs({ OMC_SESSION_END_BUDGET_MS: '100', OMC_HOOK_EVENT: 'SessionEnd' })).toBe(100);
        });
        it.each(['', 'abc', '0', '-5', '1.5', '1e3', '60001'])('ignores invalid override %j', (value) => {
            expect(resolveSessionEndBudgetMs({ OMC_SESSION_END_BUDGET_MS: value })).toBe(1000);
            expect(resolveSessionEndBudgetMs({ OMC_SESSION_END_BUDGET_MS: value, OMC_HOOK_EVENT: 'SessionEnd' })).toBe(1500);
        });
        it('keeps the test-only widening first and only under NODE_ENV=test', () => {
            const widen = { OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: '4000', OMC_SESSION_END_BUDGET_MS: '800', OMC_HOOK_EVENT: 'SessionEnd' };
            expect(resolveSessionEndBudgetMs({ ...widen, NODE_ENV: 'test' })).toBe(4000);
            expect(resolveSessionEndBudgetMs(widen)).toBe(800);
        });
    });
    describe('runner exit behaviour', () => {
        // A SessionEnd hook whose foreground takes ~700ms: over a 300ms budget,
        // inside the 1500ms Copilot floor.
        function slowSessionEndPlugin(manifestTimeoutSec = 30, hookDelayMs = 700) {
            const root = mkdtempSync(join(tmpdir(), 'omc-run-cjs-se-budget-'));
            tempDirs.push(root);
            mkdirSync(join(root, 'scripts'), { recursive: true });
            mkdirSync(join(root, 'hooks'), { recursive: true });
            writeFileSync(join(root, 'scripts', 'run.cjs'), '// plugin-root marker');
            writeFileSync(join(root, 'scripts', 'session-end.mjs'), `await new Promise((r) => setTimeout(r, ${hookDelayMs}));\nconsole.log(JSON.stringify({ continue: true }));\n`);
            // resolveTrustedSessionEndTarget realpaths both canonical scripts; without
            // this file the runner silently takes the generic child path instead.
            writeFileSync(join(root, 'scripts', 'wiki-session-end.mjs'), '');
            writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({
                hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/session-end.mjs', timeout: manifestTimeoutSec }] }] },
            }));
            return root;
        }
        function run(root, extra) {
            const result = spawnSync(NODE, [RUN_CJS_PATH, join(root, 'scripts', 'session-end.mjs')], {
                encoding: 'utf-8',
                env: hostEnv({ CLAUDE_PLUGIN_ROOT: root, OMC_HOOK_FAIL_CLOSED: '1', ...extra }),
                input: '{}',
                timeout: 20_000,
                windowsHide: true,
            });
            return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
        }
        it('Claude Code (no OMC_HOOK_EVENT): a 300ms budget times out fail-closed (124)', () => {
            const result = run(slowSessionEndPlugin(), { OMC_SESSION_END_BUDGET_MS: '300' });
            expect(result.status, result.stderr).toBe(124);
            expect(result.stderr).toContain('timed out after 300ms; exiting fail-closed (124).');
        });
        it('Copilot (OMC_HOOK_EVENT=SessionEnd): the 1500ms budget lets the hook finish', () => {
            const result = run(slowSessionEndPlugin(), { OMC_HOOK_EVENT: 'SessionEnd' });
            expect(result.status, result.stderr).toBe(0);
            expect(result.stderr).not.toContain('timed out');
            expect(JSON.parse(result.stdout.trim())).toEqual({ continue: true });
        });
        it('OMC_SESSION_END_BUDGET_MS overrides the budget on both hosts', () => {
            const root = slowSessionEndPlugin();
            const widened = run(root, { OMC_SESSION_END_BUDGET_MS: '2000' });
            expect(widened.status, widened.stderr).toBe(0);
            const narrowed = run(root, { OMC_HOOK_EVENT: 'SessionEnd', OMC_SESSION_END_BUDGET_MS: '100' });
            expect(narrowed.status, narrowed.stderr).toBe(124);
            expect(narrowed.stderr).toContain('timed out after 100ms');
        });
        it('caps an override above the manifest timeout at the manifest-derived inner timeout', () => {
            // A 2s manifest and a 4s hook; the override asks for 5s. The runner takes
            // min(inner manifest timeout, budget), so the hook is cut off inside the
            // manifest timeout, never at the 5s override.
            const result = run(slowSessionEndPlugin(2, 4000), { OMC_HOOK_EVENT: 'SessionEnd', OMC_SESSION_END_BUDGET_MS: '5000' });
            expect(result.status, result.stderr).toBe(124);
            const match = /timed out after ([0-9]+)ms/.exec(result.stderr);
            expect(match, result.stderr).not.toBeNull();
            expect(Number(match[1])).toBeLessThan(2000);
        });
    });
    // Regression for the red Tier 2 gate: under 4 parallel SessionEnd loads the
    // 300ms budget failed 39/64 runs (exit 124). With the Copilot budget the real
    // shipped hooks must pass every run fail-closed.
    //
    // Each run.cjs/session-end.mjs foreground process hands off cleanup to a
    // detached background worker (src/hooks/session-end/worker.ts,
    // spawnSessionEndWorker). This test only awaits the foreground process, not
    // that worker, by design: awaiting it would defeat the fast-foreground
    // point of the budget this test is regression-testing. The worker is
    // bounded by its own MAX_WORKER_MS (10s) deadline and self-terminates, so
    // nothing it leaves running is unbounded; the directory removal below is
    // best-effort only because Windows can hold a handle open for that window,
    // not because a worker could run forever.
    async function runSessionEndLoadTest(lanes, rounds) {
        const project = mkdtempSync(join(tmpdir(), 'omc-run-cjs-se-load-'));
        onTestFinished(() => {
            try {
                rmSync(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
            }
            catch { /* workers still running, bounded by MAX_WORKER_MS */ }
        });
        const home = join(project, 'home');
        mkdirSync(home);
        expect(spawnSync('git', ['init', '-q'], { cwd: project, windowsHide: true }).status).toBe(0);
        const env = hostEnv({
            HOME: home,
            USERPROFILE: home,
            COPILOT_HOME: home,
            CLAUDE_CONFIG_DIR: home,
            CLAUDE_PLUGIN_ROOT: REPO_ROOT,
            OMC_STATE_DIR: '',
            OMC_HOOK_EVENT: 'SessionEnd',
            OMC_HOOK_FAIL_CLOSED: '1',
        });
        const runHook = (script, sessionId) => new Promise((resolve) => {
            const child = spawn(NODE, [RUN_CJS_PATH, join(REPO_ROOT, 'scripts', script)], { cwd: project, env, windowsHide: true });
            let stderr = '';
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.stdout.resume();
            child.once('close', (code) => resolve({ code, stderr }));
            child.stdin.end(JSON.stringify({
                session_id: sessionId, transcript_path: join(project, 'transcript.jsonl'), cwd: project,
                permission_mode: 'default', hook_event_name: 'SessionEnd', reason: 'other',
            }));
        });
        const failures = [];
        await Promise.all(Array.from({ length: lanes }, async (_unused, lane) => {
            for (let round = 0; round < rounds; round++) {
                for (const script of ['session-end.mjs', 'wiki-session-end.mjs']) {
                    const result = await runHook(script, `se-load-${lane}-${round}`);
                    if (result.code !== 0)
                        failures.push(`${script} lane ${lane} round ${round}: exit ${result.code} ${result.stderr.trim()}`);
                }
            }
        }));
        return failures;
    }
    // Always-on, light: catches a gross regression on every run without the
    // full 40-call cost below.
    it.skipIf(!HAS_GENERATED_DIST)('real session-end + wiki-session-end pass fail-closed under 2 parallel lanes x 2 rounds', async () => {
        expect(await runSessionEndLoadTest(2, 2)).toEqual([]);
    }, 60_000);
    // The full regression load (4 lanes x 5 rounds = 40 hook calls): opt-in via
    // OMC_LOAD_TESTS=1, since it is slow and its 40 detached background workers
    // are unnecessary load on every CI run once the light case above passes.
    it.skipIf(!HAS_GENERATED_DIST || !process.env.OMC_LOAD_TESTS)('real session-end + wiki-session-end pass 5/5 rounds fail-closed under 4 parallel lanes (OMC_LOAD_TESTS=1)', async () => {
        expect(await runSessionEndLoadTest(4, 5)).toEqual([]);
    }, 120_000);
});
//# sourceMappingURL=run-cjs-session-end-budget.test.js.map