import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADAPTER = join(root, 'scripts', 'lib', 'copilot-hook-adapter.cjs');
const RUN_CJS = join(root, 'scripts', 'run.cjs');
const FIXTURES = join(root, 'src', '__tests__', 'fixtures', 'copilot-hook-adapter');
const HOOK_FIXTURE = join(FIXTURES, 'hook.mjs');
const WORKER_FIXTURE = join(FIXTURES, 'worker.mjs');
const nodeRequire = createRequire(import.meta.url);
const { transform, parseHookOutput, writeAllSync, EAGAIN_MAX_RETRIES } = nodeRequire(ADAPTER);
const cjsFs = nodeRequire('fs');
describe('copilot-hook-adapter parseHookOutput()', () => {
    it('parses a pretty-printed object preceded by a log line', () => {
        const pretty = JSON.stringify({ decision: 'block', nested: { a: [{ b: 1 }] } }, null, 2);
        expect(parseHookOutput(`some log line\n${pretty}\n`)).toEqual({
            kind: 'object',
            value: { decision: 'block', nested: { a: [{ b: 1 }] } },
        });
    });
    it('still prefers a single-line trailing object and falls back to raw', () => {
        expect(parseHookOutput('log\n{"a":1}\n')).toEqual({ kind: 'object', value: { a: 1 } });
        expect(parseHookOutput('log\n{ not json\n')).toEqual({ kind: 'raw' });
    });
});
describe('copilot-hook-adapter writeAllSync()', () => {
    const eagain = () => Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
    it('sleeps between EAGAIN retries instead of spinning and finishes the write', () => {
        const original = cjsFs.writeSync;
        const originalWait = Atomics.wait;
        const written = [];
        let calls = 0;
        let waits = 0;
        Atomics.wait = ((...args) => {
            waits++;
            return originalWait(...args);
        });
        cjsFs.writeSync = (_fd, buffer, offset, length) => {
            calls++;
            if (calls <= 3)
                throw eagain();
            const chunk = Math.min(2, length);
            written.push(buffer.subarray(offset, offset + chunk).toString('utf8'));
            return chunk;
        };
        try {
            writeAllSync(1, 'hello');
        }
        finally {
            cjsFs.writeSync = original;
            Atomics.wait = originalWait;
        }
        expect(written.join('')).toBe('hello');
        expect(waits).toBe(3);
    });
    it('gives up after the retry cap', () => {
        const original = cjsFs.writeSync;
        const originalWait = Atomics.wait;
        let calls = 0;
        Atomics.wait = (() => 'timed-out');
        cjsFs.writeSync = () => {
            calls++;
            throw eagain();
        };
        try {
            expect(() => writeAllSync(1, 'x')).not.toThrow();
        }
        finally {
            cjsFs.writeSync = original;
            Atomics.wait = originalWait;
        }
        expect(calls).toBe(EAGAIN_MAX_RETRIES + 1);
    });
});
const json = (value) => `${JSON.stringify(value)}\n`;
const parsed = (result) => JSON.parse(result.stdout);
describe('copilot-hook-adapter transform()', () => {
    const deny = (reason) => ({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
    });
    const cases = [
        {
            name: 'hoists hookSpecificOutput.additionalContext to the top level',
            event: 'UserPromptSubmit',
            run: { stdout: json({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'ctx' } }) },
            stdout: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'ctx' }, additionalContext: 'ctx' },
            exitCode: 0,
        },
        {
            name: 'keeps an existing top-level additionalContext (top level wins)',
            event: 'PostToolUse',
            run: { stdout: json({ additionalContext: 'top', hookSpecificOutput: { additionalContext: 'nested' } }) },
            stdout: { additionalContext: 'top', hookSpecificOutput: { additionalContext: 'nested' } },
            exitCode: 0,
        },
        {
            name: 'tolerates pretty-printed JSON',
            event: 'SessionStart',
            run: { stdout: `${JSON.stringify({ hookSpecificOutput: { additionalContext: 'p' } }, null, 2)}\n` },
            stdout: { hookSpecificOutput: { additionalContext: 'p' }, additionalContext: 'p' },
            exitCode: 0,
        },
        {
            name: 'takes the last JSON object line after log noise',
            event: 'PostToolUse',
            run: { stdout: 'log line\n{"continue":true}\n' },
            stdout: { continue: true },
            exitCode: 0,
        },
        {
            name: 'PreToolUse decision:block becomes a deny',
            event: 'PreToolUse',
            run: { stdout: json({ decision: 'block', reason: 'no' }) },
            stdout: { decision: 'block', reason: 'no', ...deny('no') },
            exitCode: 0,
        },
        {
            name: 'PreToolUse continue:false becomes a deny using stopReason',
            event: 'PreToolUse',
            run: { stdout: json({ continue: false, stopReason: 'halt' }) },
            stdout: { continue: false, stopReason: 'halt', ...deny('halt') },
            exitCode: 0,
        },
        {
            name: 'PreToolUse hookSpecificOutput.permissionDecision is hoisted',
            event: 'PreToolUse',
            run: { stdout: json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' } }) },
            stdout: deny('r'),
            exitCode: 0,
        },
        {
            name: 'PreToolUse updatedInput is dropped',
            event: 'PreToolUse',
            run: { stdout: json({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { model: 'opus' }, additionalContext: 'a' } }) },
            stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'a' }, additionalContext: 'a' },
            exitCode: 0,
        },
        {
            name: 'PreToolUse exit 2 becomes deny JSON with the stderr tail as reason',
            event: 'PreToolUse',
            run: { stdout: 'ignored', exitCode: 2, stderrTail: 'policy says no\n' },
            stdout: deny('policy says no'),
            exitCode: 0,
        },
        {
            name: 'PreToolUse other non-zero exit fails open with an [omg-hook] line',
            event: 'PreToolUse',
            run: { stdout: '', exitCode: 1, script: '/x/pre-tool-enforcer.mjs' },
            stdout: '',
            exitCode: 0,
            stderr: /^\[omg-hook\] PreToolUse internal error: pre-tool-enforcer\.mjs exited 1; failing open\n$/,
        },
        {
            name: 'OMC_HOOK_FAIL_CLOSED preserves the original exit code',
            event: 'PreToolUse',
            run: { stdout: '', exitCode: 1, failClosed: true },
            stdout: '',
            exitCode: 1,
        },
        {
            name: 'Stop continue:false + decision:block emits {} (Claude precedence)',
            event: 'Stop',
            run: { stdout: json({ continue: false, decision: 'block', reason: 'done' }) },
            stdout: {},
            exitCode: 0,
            stderr: /continue:false overrides decision:block; allowing stop: done/,
        },
        {
            name: 'SubagentStop continue:false + decision:block emits {}',
            event: 'SubagentStop',
            run: { stdout: json({ continue: false, decision: 'block', reason: 'done' }) },
            stdout: {},
            exitCode: 0,
            stderr: /^\[omg-hook\] SubagentStop: continue:false overrides decision:block/,
        },
        {
            name: 'Stop plain decision:block passes through',
            event: 'Stop',
            run: { stdout: json({ decision: 'block', reason: 'keep going' }) },
            stdout: { decision: 'block', reason: 'keep going' },
            exitCode: 0,
        },
        {
            name: 'Stop exit 2 becomes decision:block with the stderr tail',
            event: 'Stop',
            run: { stdout: '', exitCode: 2, stderrTail: 'budget exceeded\n' },
            stdout: { decision: 'block', reason: 'budget exceeded' },
            exitCode: 0,
        },
        {
            name: 'PostToolUseFailure exit 2 becomes additionalContext',
            event: 'PostToolUseFailure',
            run: { stdout: '', exitCode: 2, stderrTail: 'try again\n' },
            stdout: { additionalContext: 'try again' },
            exitCode: 0,
        },
        {
            name: 'PermissionRequest keeps exit 2 (deny on both hosts)',
            event: 'PermissionRequest',
            run: { stdout: '', exitCode: 2, stderrTail: 'nope' },
            stdout: '',
            exitCode: 2,
        },
        {
            name: 'other events: non-zero exit becomes 0, output otherwise unchanged',
            event: 'UserPromptSubmit',
            run: { stdout: json({ continue: true }), exitCode: 3 },
            stdout: { continue: true },
            exitCode: 0,
            stderr: /UserPromptSubmit internal error: hook exited 3/,
        },
        {
            name: 'non-JSON output passes through unchanged',
            event: 'PostToolUse',
            run: { stdout: 'plain text\n' },
            stdout: 'plain text\n',
            exitCode: 0,
        },
        {
            name: 'empty output stays empty',
            event: 'Stop',
            run: { stdout: '  \n' },
            stdout: '',
            exitCode: 0,
        },
    ];
    it.each(cases)('$name', ({ event, run, stdout, exitCode, stderr }) => {
        const result = transform(event, run);
        if (typeof stdout === 'string')
            expect(result.stdout).toBe(stdout);
        else
            expect(parsed(result)).toEqual(stdout);
        expect(result.exitCode).toBe(exitCode);
        if (stderr)
            expect(result.stderr).toMatch(stderr);
        else if (exitCode === run.exitCode || !run.exitCode)
            expect(result.stderr).toBe('');
    });
    it('emits exactly one compact JSON document', () => {
        const result = transform('SessionStart', { stdout: `${JSON.stringify({ a: 1 }, null, 2)}\n` });
        expect(result.stdout).toBe('{"a":1}\n');
    });
});
function runNode(args, env = {}, input = '', cwd) {
    const childEnv = { ...process.env };
    for (const key of ['OMC_HOOK_EVENT', 'OMC_HOOK_FAIL_CLOSED', 'OMC_HOOK_STRICT', 'OMC_DEBUG_HOOKS', 'FIXTURE_MODE']) {
        delete childEnv[key];
    }
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined)
            delete childEnv[key];
        else
            childEnv[key] = value;
    }
    const result = spawnSync(process.execPath, args, { cwd, env: childEnv, input, encoding: 'utf8', timeout: 30000 });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}
const preload = (target, env, extra = []) => runNode(['--require', ADAPTER, target, ...extra], env);
describe('copilot-hook-adapter preload (spawned)', () => {
    it('crash (throw): PreToolUse fails open with exit 0', () => {
        const result = preload(HOOK_FIXTURE, { OMC_HOOK_EVENT: 'PreToolUse', FIXTURE_MODE: 'crash' });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('[omg-hook] PreToolUse internal error: hook.mjs exited 1; failing open');
    });
    it('process.exit(1): exit code is re-read after the exit event, buffered output is transformed', () => {
        const result = preload(HOOK_FIXTURE, { OMC_HOOK_EVENT: 'PreToolUse', FIXTURE_MODE: 'exit1' });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            hookSpecificOutput: { additionalContext: 'before exit' },
            additionalContext: 'before exit',
        });
    });
    it('fd 1 stays writable at exit after process.stdout.destroy()', () => {
        const result = preload(HOOK_FIXTURE, { OMC_HOOK_EVENT: 'PostToolUse', FIXTURE_MODE: 'destroyed-stdout' });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ additionalContext: 'survives destroy' });
    });
    it('exit 2 + stderr on PreToolUse becomes deny JSON with exit 0', () => {
        const result = preload(HOOK_FIXTURE, { OMC_HOOK_EVENT: 'PreToolUse', FIXTURE_MODE: 'exit2' });
        expect(result.status).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.permissionDecision).toBe('deny');
        expect(output.hookSpecificOutput).toEqual({
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'policy says no',
        });
    });
    it('exit 2 + stderr on Stop becomes decision:block, through run.cjs', () => {
        const result = runNode(['--require', ADAPTER, RUN_CJS, HOOK_FIXTURE], { OMC_HOOK_EVENT: 'Stop', FIXTURE_MODE: 'exit2' }, '{}');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ decision: 'block', reason: 'policy says no' });
    });
    it('PreToolUse decision:block through run.cjs becomes a deny', () => {
        const result = runNode(['--require', ADAPTER, RUN_CJS, HOOK_FIXTURE], { OMC_HOOK_EVENT: 'PreToolUse', FIXTURE_MODE: 'block' }, '{}');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).permissionDecision).toBe('deny');
    });
    it('pretty JSON is compacted to one document with hoisted additionalContext', () => {
        const result = preload(HOOK_FIXTURE, { OMC_HOOK_EVENT: 'UserPromptSubmit', FIXTURE_MODE: 'pretty' });
        expect(result.status).toBe(0);
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
        expect(JSON.parse(result.stdout).additionalContext).toBe('pretty context');
    });
    it('empty output stays empty', () => {
        const result = preload(HOOK_FIXTURE, { OMC_HOOK_EVENT: 'Stop', FIXTURE_MODE: 'empty' });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
    });
    it('non-JSON output passes through unchanged', () => {
        const result = preload(HOOK_FIXTURE, { OMC_HOOK_EVENT: 'PostToolUse', FIXTURE_MODE: 'nonjson' });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('plain text output\n');
    });
    it('directory target: loud stderr, exit 0 (1 with OMC_HOOK_STRICT=1)', () => {
        const scriptsDir = join(root, 'scripts');
        const lenient = runNode(['--require', ADAPTER, RUN_CJS, scriptsDir], { OMC_HOOK_EVENT: 'Stop' });
        expect(lenient.status).toBe(0);
        expect(lenient.stdout).toBe('');
        expect(lenient.stderr).toContain(`[omg-hook] Stop: hook target is not a file: ${scriptsDir}`);
        const strict = runNode(['--require', ADAPTER, RUN_CJS, scriptsDir], { OMC_HOOK_EVENT: 'Stop', OMC_HOOK_STRICT: '1' });
        expect(strict.status).toBe(1);
        expect(strict.stderr).toContain('hook target is not a file');
    });
    it('missing target: loud stderr, run.cjs still exits 0', () => {
        const missing = join(root, 'scripts', 'does-not-exist.mjs');
        const result = runNode(['--require', ADAPTER, RUN_CJS, missing], { OMC_HOOK_EVENT: 'PreToolUse' });
        expect(result.status).toBe(0);
        expect(result.stderr).toContain(`hook target is not a file: ${missing}`);
    });
    it('OMC_HOOK_FAIL_CLOSED=1 preserves the original exit code', () => {
        const result = preload(HOOK_FIXTURE, { OMC_HOOK_EVENT: 'PreToolUse', FIXTURE_MODE: 'exit1', OMC_HOOK_FAIL_CLOSED: '1' });
        expect(result.status).toBe(1);
        expect(result.stderr).not.toContain('[omg-hook]');
    });
    it('is a byte-identical no-op when OMC_HOOK_EVENT is unset', () => {
        for (const mode of ['pretty', 'exit1', 'exit2', 'nonjson']) {
            const bare = runNode([HOOK_FIXTURE], { FIXTURE_MODE: mode });
            const preloaded = runNode(['--require', ADAPTER, HOOK_FIXTURE], { FIXTURE_MODE: mode });
            expect(preloaded.stdout).toBe(bare.stdout);
            expect(preloaded.status).toBe(bare.status);
        }
    });
    it('does not act inside worker threads (only the main thread emits, once)', () => {
        const result = preload(WORKER_FIXTURE, { OMC_HOOK_EVENT: 'PostToolUse' });
        expect(result.status).toBe(0);
        expect(result.stderr).toContain('worker exit 3');
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
        expect(JSON.parse(result.stdout)).toEqual({
            hookSpecificOutput: { additionalContext: 'from worker' },
            additionalContext: 'from worker',
        });
    });
    it('run.cjs trusted worker path emits a single JSON document', () => {
        const workDir = mkdtempSync(join(tmpdir(), 'copilot-hook-adapter-'));
        try {
            const payload = JSON.stringify({
                hook_event_name: 'PostToolUse',
                session_id: 'copilot-hook-adapter-test',
                tool_name: 'Read',
                tool_input: { file_path: join(workDir, 'README.md') },
                tool_response: {},
                cwd: workDir,
            });
            const result = runNode(['--require', ADAPTER, RUN_CJS, join(root, 'scripts', 'post-tool-rules-injector.mjs')], { OMC_HOOK_EVENT: 'PostToolUse', CLAUDE_PLUGIN_ROOT: root }, payload, workDir);
            expect(result.status).toBe(0);
            const text = result.stdout.trim();
            if (text) {
                expect(text.split('\n')).toHaveLength(1);
                expect(typeof JSON.parse(text)).toBe('object');
            }
        }
        finally {
            rmSync(workDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=copilot-hook-adapter.test.js.map