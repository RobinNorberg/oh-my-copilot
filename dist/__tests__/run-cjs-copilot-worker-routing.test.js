import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { basename, join, relative } from 'path';
/**
 * Fork (oh-my-copilot): under Copilot (OMC_HOOK_EVENT set) scripts/run.cjs runs
 * the audited generic hooks in an in-process Worker instead of the win32
 * `--generic-child-supervisor` child chain. Claude Code (no OMC_HOOK_EVENT)
 * and OMC_COPILOT_HOOK_WORKER=0 keep the generic child path.
 */
const REPO_ROOT = join(__dirname, '..', '..');
const RUN_CJS_PATH = join(REPO_ROOT, 'scripts', 'run.cjs');
const NODE = process.execPath;
const runCjs = createRequire(__filename)(RUN_CJS_PATH);
/**
 * A tiny --require preload that reports, via fd 3, whether it ever loaded
 * inside a Worker thread, without touching stdout/stderr. It is passed on
 * the *outer* `node` invocation, so it always loads once in the main thread
 * regardless of which path run.cjs takes; a Worker thread inherits execArgv
 * (and so --require) from its creator, so it loads a second time inside the
 * Worker only when run.cjs actually spawned one. Writing only on the
 * non-main-thread load keeps the signal unambiguous: a 'worker' write means
 * a Worker ran, and no write at all means the child path ran.
 */
function writeRuntimeMarker(dir) {
    const markerPath = join(dir, 'runtime-marker.cjs');
    writeFileSync(markerPath, `
const { isMainThread } = require('node:worker_threads');
if (!isMainThread) { try { require('fs').writeSync(3, 'worker'); } catch {} }
`);
    return markerPath;
}
const PROBE = `
import { isMainThread } from 'node:worker_threads';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input || '{}');
  console.log(JSON.stringify({ isMainThread, argv: process.argv.slice(2), owner: process.env.OMC_SESSION_OWNER_PID ?? null, payload }));
  process.stderr.write('probe-stderr\\n');
  if (payload.hang) setTimeout(() => {}, 60_000);
  else process.exitCode = payload.exitCode ?? 0;
});
`;
function hostEnv(extra) {
    const env = { ...process.env, ...extra };
    for (const key of ['OMC_HOOK_EVENT', 'OMC_HOOK_FAIL_CLOSED', 'OMC_COPILOT_HOOK_WORKER', 'OMC_SESSION_OWNER_PID', 'NODE_ENV']) {
        if (!(key in extra))
            delete env[key];
    }
    return env;
}
describe('run.cjs Copilot generic-hook Worker routing (fork)', () => {
    const tempDirs = [];
    afterEach(() => {
        for (const dir of tempDirs.splice(0))
            rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 25 });
    });
    function tempDir(prefix) {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        tempDirs.push(dir);
        return dir;
    }
    /** A plugin whose audited generic script names (budget-guard, subagent-tracker) run the probe. */
    function probePlugin() {
        const root = tempDir('omc-run-cjs-copilot-worker-');
        mkdirSync(join(root, 'scripts'), { recursive: true });
        mkdirSync(join(root, 'hooks'), { recursive: true });
        writeFileSync(join(root, 'scripts', 'run.cjs'), '// plugin-root marker');
        writeFileSync(join(root, 'scripts', 'budget-guard.mjs'), PROBE);
        writeFileSync(join(root, 'scripts', 'subagent-tracker.mjs'), PROBE);
        writeFileSync(join(root, 'scripts', 'not-audited.mjs'), PROBE);
        const command = (script) => `node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/${script}`;
        writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({
            hooks: {
                Stop: [{ hooks: [
                            // Above COPILOT_WORKER_MIN_TIMEOUT_MS: these fixtures exercise the
                            // Worker path itself, not the <=3s child-path carve-out (covered
                            // against the real manifest below).
                            { type: 'command', command: command('budget-guard.mjs'), timeout: 5 },
                            { type: 'command', command: command('not-audited.mjs'), timeout: 5 },
                        ] }],
                SubagentStart: [{ hooks: [{ type: 'command', command: `${command('subagent-tracker.mjs')} start`, timeout: 5 }] }],
            },
        }));
        return root;
    }
    function run(root, script, args, extra, payload = {}) {
        const result = spawnSync(NODE, [RUN_CJS_PATH, join(root, 'scripts', script), ...args], {
            encoding: 'utf-8',
            env: hostEnv({ CLAUDE_PLUGIN_ROOT: root, ...extra }),
            input: JSON.stringify(payload),
            timeout: 30_000,
            windowsHide: true,
        });
        const line = (result.stdout || '').trim().split('\n').find((candidate) => candidate.startsWith('{'));
        return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', probe: line ? JSON.parse(line) : null };
    }
    it('runs an audited generic hook in a Worker under Copilot, with stdin, owner pid and exit code', () => {
        const root = probePlugin();
        const result = run(root, 'budget-guard.mjs', [], { OMC_HOOK_EVENT: 'Stop' }, { exitCode: 3, marker: 'stdin-ok' });
        expect(result.status, result.stderr).toBe(3);
        expect(result.probe).toMatchObject({ isMainThread: false, argv: [], payload: { marker: 'stdin-ok' } });
        expect(result.probe.owner).toMatch(/^\d+$/);
        expect(result.stderr).toContain('probe-stderr');
    });
    it('passes extra script arguments (subagent-tracker start) into the Worker argv', () => {
        const root = probePlugin();
        const result = run(root, 'subagent-tracker.mjs', ['start'], { OMC_HOOK_EVENT: 'SubagentStart' });
        expect(result.status, result.stderr).toBe(0);
        expect(result.probe).toMatchObject({ isMainThread: false, argv: ['start'] });
    });
    it('keeps an explicit OMC_SESSION_OWNER_PID', () => {
        const root = probePlugin();
        const result = run(root, 'budget-guard.mjs', [], { OMC_HOOK_EVENT: 'Stop', OMC_SESSION_OWNER_PID: '4242' });
        expect(result.probe).toMatchObject({ isMainThread: false, owner: '4242' });
    });
    it('times out fail-closed (124) in the Worker path, fail-open (0) otherwise', () => {
        const root = probePlugin();
        const closed = run(root, 'budget-guard.mjs', [], { OMC_HOOK_EVENT: 'Stop', OMC_HOOK_FAIL_CLOSED: '1' }, { hang: true });
        expect(closed.status, closed.stderr).toBe(124);
        expect(closed.stderr).toContain('exiting fail-closed (124).');
        const open = run(root, 'budget-guard.mjs', [], { OMC_HOOK_EVENT: 'Stop' }, { hang: true });
        expect(open.status, open.stderr).toBe(0);
        expect(open.stderr).toContain('exiting fail-open.');
    }, 30_000);
    it.each([
        ['Claude Code (no OMC_HOOK_EVENT)', 'budget-guard.mjs', [], {}],
        ['the OMC_COPILOT_HOOK_WORKER=0 kill switch', 'budget-guard.mjs', [], { OMC_HOOK_EVENT: 'Stop', OMC_COPILOT_HOOK_WORKER: '0' }],
        ['an event that does not match the manifest', 'budget-guard.mjs', [], { OMC_HOOK_EVENT: 'PreToolUse' }],
        ['a script outside the audited set', 'not-audited.mjs', [], { OMC_HOOK_EVENT: 'Stop' }],
        ['extra args that do not match the manifest', 'subagent-tracker.mjs', ['stop'], { OMC_HOOK_EVENT: 'SubagentStart' }],
    ])('keeps the generic child path for %s', (_label, script, args, extra) => {
        const root = probePlugin();
        const result = run(root, script, [...args], extra, { exitCode: 0 });
        expect(result.status, result.stderr).toBe(0);
        expect(result.probe).toMatchObject({ isMainThread: true });
    });
    it('keeps the generic child path for a target outside the trusted plugin root', () => {
        const root = probePlugin();
        const other = probePlugin();
        const result = spawnSync(NODE, [RUN_CJS_PATH, join(other, 'scripts', 'budget-guard.mjs')], {
            encoding: 'utf-8', env: hostEnv({ CLAUDE_PLUGIN_ROOT: root, OMC_HOOK_EVENT: 'Stop' }), input: '{}', timeout: 30_000, windowsHide: true,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout.trim()).isMainThread).toBe(true);
    });
    it('the audited set covers exactly the generic entries of copilot/hooks.json', () => {
        const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'copilot', 'hooks.json'), 'utf8'));
        const generic = new Set();
        for (const entries of Object.values(manifest.hooks)) {
            for (const entry of entries) {
                const script = basename(entry.args[3]);
                if (!runCjs.TRUSTED_WORKER_HOOKS.has(script) && !/^(wiki-)?session-end\.mjs$/.test(script))
                    generic.add(script);
            }
        }
        // A new upstream hook must be audited (no process.chdir, signal handlers,
        // isMainThread gating, or stdio-inheriting children) before it joins the set.
        expect([...runCjs.COPILOT_WORKER_HOOKS].sort()).toEqual([...generic].sort());
    });
    it('every shipped generic entry resolves to the Worker path under its own event, except the <=3s-budget ones that stay on the child path', () => {
        const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'copilot', 'hooks.json'), 'utf8'));
        const root = realpathSync(REPO_ROOT);
        let checked = 0;
        for (const entries of Object.values(manifest.hooks)) {
            for (const entry of entries) {
                const script = basename(entry.args[3]);
                if (!runCjs.COPILOT_WORKER_HOOKS.has(script))
                    continue;
                const resolution = { targetPath: realpathSync(join(root, 'scripts', script)), trustedPluginRoot: root };
                const hook = runCjs.resolveCopilotWorkerTarget(resolution, entry.args.slice(4), entry.env);
                const label = `${script} ${entry.env.OMC_HOOK_EVENT} (timeoutSec=${entry.timeoutSec})`;
                if (entry.timeoutSec * 1000 <= runCjs.COPILOT_WORKER_MIN_TIMEOUT_MS) {
                    // A Worker cannot preempt a blocked sync call; a tight manifest
                    // budget stays on the supervised child path instead.
                    expect(hook, label).toBeNull();
                }
                else {
                    expect(hook, label).toMatchObject({ event: entry.env.OMC_HOOK_EVENT });
                }
                expect(runCjs.resolveCopilotWorkerTarget(resolution, entry.args.slice(4), {})).toBeNull();
                checked++;
            }
        }
        expect(checked).toBe(runCjs.COPILOT_WORKER_HOOKS.size + 1); // subagent-tracker start + stop
    });
    // Every generic shipped hook, once through each path with the same fixture
    // payload in fresh identical projects: exit code, normalised stdout, and the
    // set of files written must match.
    it('on an idle project, every hook\'s stdout/stderr and written files match the child path, and the worker run actually used the Worker path where expected', () => {
        const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'copilot', 'hooks.json'), 'utf8'));
        const sessionId = '11111111-2222-4333-8444-555555555555';
        const runAll = (tag, extra, markerPath) => {
            const base = tempDir(`omc-copilot-worker-equiv-${tag}-`);
            const project = join(base, 'p');
            const home = join(base, 'h');
            mkdirSync(project);
            mkdirSync(home);
            execFileSync('git', ['init', '-q'], { cwd: project, windowsHide: true });
            writeFileSync(join(project, 'README.md'), 'x\n');
            const normalise = (text) => text
                .split(project).join('<P>').split(project.replace(/\\/g, '\\\\')).join('<P>')
                .split(home).join('<H>').split(home.replace(/\\/g, '\\\\')).join('<H>')
                .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<TS>');
            const results = [];
            const runtimeByName = {};
            for (const [event, entries] of Object.entries(manifest.hooks)) {
                for (const entry of entries) {
                    const args = entry.args.map((arg) => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', REPO_ROOT)).slice(2);
                    if (!runCjs.COPILOT_WORKER_HOOKS.has(basename(args[1])))
                        continue;
                    const payload = {
                        session_id: sessionId, cwd: project, hook_event_name: event, transcript_path: join(home, 'events.jsonl'),
                    };
                    if (/ToolUse|Permission/.test(event))
                        Object.assign(payload, { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { output: 'README.md' }, error: 'boom' });
                    if (event === 'SessionStart')
                        payload.source = 'startup';
                    if (/Subagent/.test(event))
                        Object.assign(payload, { agent_id: 'a1', agent_type: 'executor' });
                    if (/Stop/.test(event))
                        payload.stop_hook_active = false;
                    if (event === 'PreCompact')
                        payload.trigger = 'auto';
                    // fd 3 carries the --require marker's worker/child report so it
                    // never touches the stdout/stderr the hook itself produces.
                    const result = spawnSync(NODE, ['--require', markerPath, ...args], {
                        cwd: project,
                        env: hostEnv({
                            HOME: home, USERPROFILE: home, COPILOT_HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT,
                            OMC_STATE_DIR: '', ...entry.env, ...extra,
                        }),
                        input: JSON.stringify(payload),
                        encoding: 'utf8',
                        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
                        timeout: 30_000,
                        windowsHide: true,
                    });
                    const name = `${event} ${args.slice(1).map((arg) => basename(arg)).join(' ')}`;
                    results.push({
                        name,
                        status: result.status,
                        stdout: normalise(result.stdout || ''),
                        stderr: normalise(result.stderr || ''),
                    });
                    const stayedOnChildPath = entry.timeoutSec * 1000 <= runCjs.COPILOT_WORKER_MIN_TIMEOUT_MS;
                    const expectedWorker = extra.OMC_COPILOT_HOOK_WORKER !== '0' && !stayedOnChildPath;
                    // `encoding: 'utf8'` above decodes every stdio slot in `output`,
                    // including fd 3, to a string rather than a Buffer.
                    const marker = result.output?.[3];
                    const actualWorker = typeof marker === 'string' && marker.trim() === 'worker';
                    runtimeByName[name] = { actualWorker, expectedWorker };
                }
            }
            const files = [];
            const walk = (dir) => {
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                    const path = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (entry.name !== '.git')
                            walk(path);
                    }
                    else {
                        // pre-compact names checkpoints by time: checkpoint-2026-10-06T04-05-11-863Z.json
                        files.push(relative(base, path).replace(/\\/g, '/').replace(/\d{4}-\d\d-\d\dT[\d-]+Z/g, '<TS>'));
                    }
                }
            };
            walk(base);
            return { results, files: files.sort(), runtimeByName };
        };
        const markerPath = writeRuntimeMarker(tempDir('omc-copilot-worker-marker-'));
        const child = runAll('child', { OMC_COPILOT_HOOK_WORKER: '0' }, markerPath);
        const worker = runAll('worker', {}, markerPath);
        expect(worker.results.length).toBe(runCjs.COPILOT_WORKER_HOOKS.size + 1); // subagent-tracker start + stop
        expect(worker.results).toEqual(child.results);
        expect(worker.files).toEqual(child.files);
        // Every child-path run actually ran in a plain child process (no Worker
        // spawned at all), and every worker-path run actually used a Worker
        // thread exactly where resolveCopilotWorkerTarget says it should (and
        // correctly fell through to the child path for the <=3s budgets).
        for (const [name, { actualWorker }] of Object.entries(child.runtimeByName)) {
            expect(actualWorker, `child path, ${name}`).toBe(false);
        }
        for (const [name, { actualWorker, expectedWorker }] of Object.entries(worker.runtimeByName)) {
            expect(actualWorker, `worker run, ${name}`).toBe(expectedWorker);
        }
    }, 120_000);
});
//# sourceMappingURL=run-cjs-copilot-worker-routing.test.js.map