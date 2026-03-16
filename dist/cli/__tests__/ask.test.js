import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseAskArgs, resolveAskAdvisorScriptPath } from '../ask.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const TSX_LOADER_PATH = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
// On Windows, --import requires file:// URLs for absolute paths
const TSX_LOADER = pathToFileURL(TSX_LOADER_PATH).href;
const ADVISOR_SCRIPT = join(REPO_ROOT, 'scripts', 'run-provider-advisor.js');
const ASK_CODEX_WRAPPER = join(REPO_ROOT, 'scripts', 'ask-codex.sh');
const ASK_GEMINI_WRAPPER = join(REPO_ROOT, 'scripts', 'ask-gemini.sh');
function buildChildEnv(envOverrides = {}, options = {}) {
    if (options.preserveClaudeSessionEnv) {
        return { ...process.env, OMC_SKIP_WIN32_WARNING: '1', ...envOverrides };
    }
    const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
    return { ...cleanEnv, OMC_SKIP_WIN32_WARNING: '1', ...envOverrides };
}
function runCli(args, cwd, envOverrides = {}, options = {}) {
    const result = spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
        cwd,
        encoding: 'utf-8',
        env: buildChildEnv(envOverrides, options),
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error?.message,
    };
}
function runAdvisorScript(args, cwd, envOverrides = {}, options = {}) {
    const result = spawnSync(process.execPath, [ADVISOR_SCRIPT, ...args], {
        cwd,
        encoding: 'utf-8',
        env: buildChildEnv(envOverrides, options),
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error?.message,
    };
}
function runAdvisorScriptWithPrelude(preludePath, args, cwd, envOverrides = {}, options = {}) {
    // On Windows, --import requires file:// URLs for absolute paths
    const preludeUrl = pathToFileURL(preludePath).href;
    const result = spawnSync(process.execPath, ['--import', preludeUrl, ADVISOR_SCRIPT, ...args], {
        cwd,
        encoding: 'utf-8',
        env: buildChildEnv(envOverrides, options),
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error?.message,
    };
}
function runWrapperScript(wrapperPath, args, cwd, envOverrides = {}, options = {}) {
    const result = spawnSync(wrapperPath, args, {
        cwd,
        encoding: 'utf-8',
        env: buildChildEnv(envOverrides, options),
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error?.message,
    };
}
function writeAdvisorStub(dir) {
    const stubPath = join(dir, 'advisor-stub.js');
    writeFileSync(stubPath, [
        '#!/usr/bin/env node',
        'const payload = {',
        '  provider: process.argv[2],',
        '  prompt: process.argv[3],',
        '  originalTask: process.env.OMC_ASK_ORIGINAL_TASK ?? null,',
        '  passthrough: process.env.ASK_WRAPPER_TOKEN ?? null,',
        '};',
        'process.stdout.write(JSON.stringify(payload));',
        'if (process.env.ASK_STUB_STDERR) process.stderr.write(process.env.ASK_STUB_STDERR);',
        'process.exit(Number(process.env.ASK_STUB_EXIT_CODE || 0));',
        '',
    ].join('\n'), 'utf8');
    chmodSync(stubPath, 0o755);
    return stubPath;
}
function writeFakeProviderBinary(dir, provider) {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const isWin = process.platform === 'win32';
    // Cross-platform: write a Node.js script + .cmd shim on Windows, shell script on Unix
    const jsContent = [
        '#!/usr/bin/env node',
        "if (process.argv[2] === '--version') { console.log('fake'); process.exit(0); }",
        "if (process.argv[2] === '-p') { console.log('FAKE_PROVIDER_OK:' + process.argv[3]); process.exit(0); }",
        "process.stderr.write('unexpected\\n'); process.exit(9);",
    ].join('\n');
    if (isWin) {
        const jsPath = join(binDir, `${provider}.js`);
        writeFileSync(jsPath, jsContent, 'utf8');
        // .cmd shim so spawnSync can find it without .cmd extension on Windows
        writeFileSync(join(binDir, `${provider}.cmd`), `@node "%~dp0${provider}.js" %*\r\n`, 'utf8');
    }
    else {
        const binPath = join(binDir, provider);
        writeFileSync(binPath, jsContent, 'utf8');
        chmodSync(binPath, 0o755);
    }
    return binDir;
}
function writeSpawnSyncCapturePrelude(dir) {
    const preludePath = join(dir, 'spawn-sync-capture-prelude.mjs');
    writeFileSync(preludePath, [
        "import childProcess from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "import { syncBuiltinESMExports } from 'node:module';",
        '',
        "Object.defineProperty(process, 'platform', { value: 'win32' });",
        'const capturePath = process.env.SPAWN_CAPTURE_PATH;',
        "const mode = process.env.SPAWN_CAPTURE_MODE || 'success';",
        'const calls = [];',
        'childProcess.spawnSync = (command, args = [], options = {}) => {',
        '  calls.push({',
        '    command,',
        '    args,',
        '    options: {',
        "      shell: options.shell ?? false,",
        "      encoding: options.encoding ?? null,",
        "      stdio: options.stdio ?? null,",
        '    },',
        '  });',
        "  if (mode === 'missing' && command === 'where') {",
        "    return { status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null };",
        '  }',
        "  if (mode === 'missing' && (command === 'codex' || command === 'gemini') && Array.isArray(args) && args[0] === '--version') {",
        "    return { status: 1, stdout: '', stderr: \"'\" + command + \"' is not recognized\", pid: 0, output: [], signal: null };",
        '  }',
        "  const isVersionProbe = Array.isArray(args) && args[0] === '--version';",
        '  return {',
        '    status: 0,',
        "    stdout: isVersionProbe ? 'fake 1.0.0\\n' : 'FAKE_PROVIDER_OK',",
        "    stderr: '',",
        '    pid: 0,',
        '    output: [],',
        '    signal: null,',
        '  };',
        '};',
        'syncBuiltinESMExports();',
        'process.on(\'exit\', () => {',
        '  if (capturePath) {',
        "    writeFileSync(capturePath, JSON.stringify(calls), 'utf8');",
        '  }',
        '});',
        '',
    ].join('\n'), 'utf8');
    return preludePath;
}
function writeFakeCodexBinary(dir) {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const isWin = process.platform === 'win32';
    const jsContent = [
        '#!/usr/bin/env node',
        "if (process.argv[2] === '--version') { console.log('fake'); process.exit(0); }",
        "if (process.argv[2] === 'exec') {",
        "  console.log('CODEX_OK');",
        "  if (process.env.RUST_LOG || process.env.RUST_BACKTRACE) {",
        "    process.stderr.write('RUST_LEAK:' + (process.env.RUST_LOG || '') + ':' + (process.env.RUST_BACKTRACE || '') + '\\n');",
        "  }",
        "  process.exit(0);",
        "}",
        "process.stderr.write('unexpected\\n'); process.exit(9);",
    ].join('\n');
    if (isWin) {
        const jsPath = join(binDir, 'codex.js');
        writeFileSync(jsPath, jsContent, 'utf8');
        writeFileSync(join(binDir, 'codex.cmd'), `@node "%~dp0codex.js" %*\r\n`, 'utf8');
    }
    else {
        const binPath = join(binDir, 'codex');
        writeFileSync(binPath, jsContent, 'utf8');
        chmodSync(binPath, 0o755);
    }
    return binDir;
}
function writeFakeOmcBinary(dir) {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const isWin = process.platform === 'win32';
    const jsContent = [
        '#!/usr/bin/env node',
        'process.stderr.write("PATH_OMC_SHOULD_NOT_BE_CALLED\\n");',
        'process.exit(79);',
    ].join('\n');
    if (isWin) {
        const jsPath = join(binDir, 'omg.js');
        writeFileSync(jsPath, jsContent, 'utf8');
        writeFileSync(join(binDir, 'omg.cmd'), `@node "%~dp0omg.js" %*\r\n`, 'utf8');
    }
    else {
        const omcPath = join(binDir, 'omg');
        writeFileSync(omcPath, jsContent, 'utf8');
        chmodSync(omcPath, 0o755);
    }
    return binDir;
}
describe('parseAskArgs', () => {
    it('supports positional and print/prompt flag forms', () => {
        expect(parseAskArgs(['claude', 'review', 'this'])).toEqual({ provider: 'claude', prompt: 'review this' });
        expect(parseAskArgs(['gemini', '-p', 'brainstorm'])).toEqual({ provider: 'gemini', prompt: 'brainstorm' });
        expect(parseAskArgs(['claude', '--print', 'draft', 'summary'])).toEqual({ provider: 'claude', prompt: 'draft summary' });
        expect(parseAskArgs(['gemini', '--prompt=ship safely'])).toEqual({ provider: 'gemini', prompt: 'ship safely' });
        expect(parseAskArgs(['codex', 'review', 'this'])).toEqual({ provider: 'codex', prompt: 'review this' });
    });
    it('supports --agent-prompt flag and equals syntax', () => {
        expect(parseAskArgs(['claude', '--agent-prompt', 'executor', 'do', 'it'])).toEqual({
            provider: 'claude',
            prompt: 'do it',
            agentPromptRole: 'executor',
        });
        expect(parseAskArgs(['gemini', '--agent-prompt=planner', '--prompt', 'plan', 'it'])).toEqual({
            provider: 'gemini',
            prompt: 'plan it',
            agentPromptRole: 'planner',
        });
    });
    it('rejects unsupported provider matrix', () => {
        expect(() => parseAskArgs(['openai', 'hi'])).toThrow(/Invalid provider/i);
    });
});
describe('omc ask command', () => {
    it('accepts canonical advisor env and forwards prompt/task to advisor', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-canonical-'));
        try {
            const stubPath = writeAdvisorStub(wd);
            const result = runCli(['ask', 'claude', '--print', 'hello world'], wd, { OMC_ASK_ADVISOR_SCRIPT: stubPath });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stderr).toBe('');
            const payload = JSON.parse(result.stdout);
            expect(payload).toEqual({
                provider: 'claude',
                prompt: 'hello world',
                originalTask: 'hello world',
                passthrough: null,
            });
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
    it('accepts OMX advisor env alias in Phase-1 and emits deprecation warning', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-alias-'));
        try {
            const stubPath = writeAdvisorStub(wd);
            const result = runCli(['ask', 'gemini', 'legacy', 'path'], wd, { OMX_ASK_ADVISOR_SCRIPT: stubPath });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stderr).toContain('DEPRECATED');
            expect(result.stderr).toContain('OMX_ASK_ADVISOR_SCRIPT');
            const payload = JSON.parse(result.stdout);
            expect(payload.provider).toBe('gemini');
            expect(payload.prompt).toBe('legacy path');
            expect(payload.originalTask).toBe('legacy path');
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
    it('allows codex ask inside a Copilot CLI session', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-cli-codex-nested-'));
        try {
            const stubPath = writeAdvisorStub(wd);
            const result = runCli(['ask', 'codex', '--prompt', 'cli nested codex prompt'], wd, {
                OMC_ASK_ADVISOR_SCRIPT: stubPath,
                CLAUDECODE: '1',
            }, { preserveClaudeSessionEnv: true });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stderr).not.toContain('Nested launches are not supported');
            const payload = JSON.parse(result.stdout);
            expect(payload).toEqual({
                provider: 'codex',
                prompt: 'cli nested codex prompt',
                originalTask: 'cli nested codex prompt',
                passthrough: null,
            });
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
    it('allows gemini ask inside a Copilot CLI session', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-cli-gemini-nested-'));
        try {
            const stubPath = writeAdvisorStub(wd);
            const result = runCli(['ask', 'gemini', '--prompt', 'cli nested gemini prompt'], wd, {
                OMC_ASK_ADVISOR_SCRIPT: stubPath,
                CLAUDECODE: '1',
            }, { preserveClaudeSessionEnv: true });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stderr).not.toContain('Nested launches are not supported');
            const payload = JSON.parse(result.stdout);
            expect(payload.provider).toBe('gemini');
            expect(payload.prompt).toBe('cli nested gemini prompt');
            expect(payload.originalTask).toBe('cli nested gemini prompt');
            expect(payload.passthrough).toBeNull();
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
    it('loads --agent-prompt role from resolved prompts dir and prepends role content', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-agent-prompt-'));
        try {
            const stubPath = writeAdvisorStub(wd);
            mkdirSync(join(wd, '.omx'), { recursive: true });
            mkdirSync(join(wd, '.codex', 'prompts'), { recursive: true });
            writeFileSync(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }), 'utf8');
            writeFileSync(join(wd, '.codex', 'prompts', 'executor.md'), 'ROLE HEADER\nFollow checks.', 'utf8');
            const result = runCli(['ask', 'claude', '--agent-prompt=executor', '--prompt', 'ship feature'], wd, { OMC_ASK_ADVISOR_SCRIPT: stubPath });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            const payload = JSON.parse(result.stdout);
            expect(payload.originalTask).toBe('ship feature');
            expect(payload.prompt).toContain('ROLE HEADER');
            expect(payload.prompt).toContain('ship feature');
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
});
const PATH_SEP = process.platform === 'win32' ? ';' : ':';
describe('run-provider-advisor script contract', () => {
    it('writes artifact to .omg/artifacts/ask/{provider}-{slug}-{timestamp}.md', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-artifact-'));
        try {
            const binDir = writeFakeProviderBinary(wd, 'claude');
            // Use single-word prompt to avoid shell arg-splitting on Windows (shell:true + cmd.exe)
            const result = runAdvisorScript(['claude', '--print', 'artifact-contract'], wd, { PATH: `${binDir}${PATH_SEP}${process.env.PATH || ''}` });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            const artifactPath = result.stdout.trim();
            expect(artifactPath).toContain(join('.omg', 'artifacts', 'ask', 'claude-artifact-contract-'));
            expect(existsSync(artifactPath)).toBe(true);
            const artifact = readFileSync(artifactPath, 'utf8');
            expect(artifact).toContain('FAKE_PROVIDER_OK:artifact-contract');
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
    it('accepts OMX original-task alias in Phase-1 with deprecation warning', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-original-alias-'));
        try {
            const binDir = writeFakeProviderBinary(wd, 'gemini');
            const result = runAdvisorScript(['gemini', '--prompt', 'fallback task'], wd, {
                PATH: `${binDir}${PATH_SEP}${process.env.PATH || ''}`,
                OMX_ASK_ORIGINAL_TASK: 'legacy original task',
            });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stderr).toContain('DEPRECATED');
            expect(result.stderr).toContain('OMX_ASK_ORIGINAL_TASK');
            const artifactPath = result.stdout.trim();
            const artifact = readFileSync(artifactPath, 'utf8');
            expect(artifact).toContain('## Original task\n\nlegacy original task');
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
    it('sanitizes Rust env vars for codex so artifacts do not capture Rust stderr logs', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-codex-rust-env-'));
        try {
            const binDir = writeFakeCodexBinary(wd);
            // Use single-word prompt to avoid shell arg-splitting on Windows
            const result = runAdvisorScript(['codex', '--prompt', 'keep-artifact-small'], wd, {
                PATH: `${binDir}${PATH_SEP}${process.env.PATH || ''}`,
                RUST_LOG: 'trace',
                RUST_BACKTRACE: '1',
            });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            // Filter Node.js DEP0190 deprecation warning about shell:true with args (Windows)
            const stderrFiltered = result.stderr.replace(/\(node:\d+\) \[DEP0190\][\s\S]*?\n(\(Use .*?\n)?/g, '').trim();
            expect(stderrFiltered).toBe('');
            const artifactPath = result.stdout.trim();
            const artifact = readFileSync(artifactPath, 'utf8');
            expect(artifact).toContain('CODEX_OK');
            expect(artifact).not.toContain('RUST_LEAK');
            expect(artifact).not.toContain('trace');
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
    it('uses shell:true for Windows codex binary probe and execution', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-codex-win32-shell-'));
        try {
            const capturePath = join(wd, 'spawn-sync-calls.json');
            const preludePath = writeSpawnSyncCapturePrelude(wd);
            const result = runAdvisorScriptWithPrelude(preludePath, ['codex', '--prompt', 'windows cmd support'], wd, { SPAWN_CAPTURE_PATH: capturePath });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            const calls = JSON.parse(readFileSync(capturePath, 'utf8'));
            expect(calls).toHaveLength(2);
            expect(calls[0]).toMatchObject({
                command: 'codex',
                args: ['--version'],
                options: { shell: true, encoding: 'utf8', stdio: 'ignore' },
            });
            expect(calls[1]).toMatchObject({
                command: 'codex',
                args: ['exec', '--dangerously-bypass-approvals-and-sandbox', 'windows cmd support'],
                options: { shell: true, encoding: 'utf8', stdio: null },
            });
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
    it('shows install guidance when a Windows codex binary is missing under shell:true', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-codex-win32-missing-'));
        try {
            const capturePath = join(wd, 'spawn-sync-calls.json');
            const preludePath = writeSpawnSyncCapturePrelude(wd);
            const result = runAdvisorScriptWithPrelude(preludePath, ['codex', '--prompt', 'windows missing binary'], wd, {
                SPAWN_CAPTURE_PATH: capturePath,
                SPAWN_CAPTURE_MODE: 'missing',
            });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('Missing required local CLI binary: codex');
            expect(result.stderr).toContain('codex --version');
            const calls = JSON.parse(readFileSync(capturePath, 'utf8'));
            expect(calls).toHaveLength(2);
            expect(calls[0]).toMatchObject({
                command: 'codex',
                args: ['--version'],
                options: { shell: true, encoding: 'utf8', stdio: 'ignore' },
            });
            expect(calls[1]).toMatchObject({
                command: 'where',
                args: ['codex'],
            });
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
});
describe('resolveAskAdvisorScriptPath', () => {
    it('resolves canonical env and supports package-root relative paths', () => {
        // Use platform-native paths to avoid cross-platform path separator issues
        const packageRoot = join(tmpdir(), 'pkg-root');
        const optCustomJs = join(tmpdir(), 'opt', 'custom.js');
        expect(resolveAskAdvisorScriptPath(packageRoot, { OMC_ASK_ADVISOR_SCRIPT: 'scripts/custom.js' }))
            .toBe(join(packageRoot, 'scripts', 'custom.js'));
        expect(resolveAskAdvisorScriptPath(packageRoot, { OMC_ASK_ADVISOR_SCRIPT: optCustomJs }))
            .toBe(optCustomJs);
    });
});
describe.skipIf(process.platform === 'win32')('ask wrapper scripts contract', () => {
    it('ask-codex wrapper dispatches provider, forwards prompt, and ignores PATH omp shadow', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-wrapper-codex-'));
        try {
            const stubPath = writeAdvisorStub(wd);
            const fakePathBin = writeFakeOmcBinary(wd);
            const result = runWrapperScript(ASK_CODEX_WRAPPER, ['--print', 'wrapper prompt'], wd, {
                OMC_ASK_ADVISOR_SCRIPT: stubPath,
                ASK_WRAPPER_TOKEN: 'wrapper-token',
                PATH: `${fakePathBin}:${process.env.PATH || ''}`,
            });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stderr).not.toContain('PATH_OMC_SHOULD_NOT_BE_CALLED');
            const payload = JSON.parse(result.stdout);
            expect(payload).toEqual({
                provider: 'codex',
                prompt: 'wrapper prompt',
                originalTask: 'wrapper prompt',
                passthrough: 'wrapper-token',
            });
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
    it('ask-codex wrapper still works inside a Copilot CLI session', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-wrapper-codex-nested-'));
        try {
            const stubPath = writeAdvisorStub(wd);
            const result = runWrapperScript(ASK_CODEX_WRAPPER, ['--prompt', 'nested codex prompt'], wd, {
                OMC_ASK_ADVISOR_SCRIPT: stubPath,
                CLAUDECODE: '1',
            }, { preserveClaudeSessionEnv: true });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stderr).not.toContain('Nested launches are not supported');
            const payload = JSON.parse(result.stdout);
            expect(payload).toEqual({
                provider: 'codex',
                prompt: 'nested codex prompt',
                originalTask: 'nested codex prompt',
                passthrough: null,
            });
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
    it('ask-gemini wrapper still works inside a Copilot CLI session', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-wrapper-gemini-nested-'));
        try {
            const stubPath = writeAdvisorStub(wd);
            const result = runWrapperScript(ASK_GEMINI_WRAPPER, ['--prompt', 'nested gemini prompt'], wd, {
                OMC_ASK_ADVISOR_SCRIPT: stubPath,
                CLAUDECODE: '1',
            }, { preserveClaudeSessionEnv: true });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stderr).not.toContain('Nested launches are not supported');
            const payload = JSON.parse(result.stdout);
            expect(payload.provider).toBe('gemini');
            expect(payload.prompt).toBe('nested gemini prompt');
            expect(payload.originalTask).toBe('nested gemini prompt');
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
    it('ask-gemini wrapper dispatches provider and forwards positional prompt text', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-wrapper-gemini-'));
        try {
            const stubPath = writeAdvisorStub(wd);
            const result = runWrapperScript(ASK_GEMINI_WRAPPER, ['ship', 'this', 'feature'], wd, { OMC_ASK_ADVISOR_SCRIPT: stubPath });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            const payload = JSON.parse(result.stdout);
            expect(payload.provider).toBe('gemini');
            expect(payload.prompt).toBe('ship this feature');
            expect(payload.originalTask).toBe('ship this feature');
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
    it('wrapper propagates non-zero advisor exit code', () => {
        const wd = mkdtempSync(join(tmpdir(), 'omg-ask-wrapper-exit-'));
        try {
            const stubPath = writeAdvisorStub(wd);
            const result = runWrapperScript(ASK_CODEX_WRAPPER, ['--prompt', 'should fail'], wd, {
                OMC_ASK_ADVISOR_SCRIPT: stubPath,
                ASK_STUB_EXIT_CODE: '23',
            });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(23);
        }
        finally {
            rmSync(wd, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=ask.test.js.map