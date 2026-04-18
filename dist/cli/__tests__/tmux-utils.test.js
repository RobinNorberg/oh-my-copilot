/**
 * Tests for src/cli/tmux-utils.ts
 *
 * Covers:
 * - wrapWithLoginShell (issue #1153 — shell RC not loaded in tmux)
 * - quoteShellArg
 * - sanitizeTmuxToken
 * - createHudWatchPane login shell wrapping
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execFileSync: vi.fn(),
    };
});
import { buildTmuxShellCommand, buildTmuxShellCommandWithEnv, wrapWithLoginShell, quoteShellArg, sanitizeTmuxToken, } from '../tmux-utils.js';
const baselinePlatform = process.platform;
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: baselinePlatform, configurable: true });
});
// ---------------------------------------------------------------------------
// wrapWithLoginShell
// ---------------------------------------------------------------------------
describe('wrapWithLoginShell', () => {
    it('uses COMSPEC wrapping instead of Unix exec syntax on native Windows shells', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        vi.stubEnv('SHELL', '');
        vi.stubEnv('HOME', 'C:\\Users\\test');
        vi.stubEnv('MSYSTEM', '');
        vi.stubEnv('MINGW_PREFIX', '');
        const result = wrapWithLoginShell('copilot --print');
        expect(result).toBe('C:\\Windows\\System32\\cmd.exe /d /s /c "copilot --print"');
        expect(result).not.toContain('exec ');
        expect(result).not.toContain('-lc');
        expect(result).not.toContain('.bashrc');
        expect(result).not.toContain('.zshrc');
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('uses cmd-style argument quoting for Windows tmux shell commands', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('MSYSTEM', '');
        vi.stubEnv('MINGW_PREFIX', '');
        expect(buildTmuxShellCommand('copilot', ['--print', 'hello world'])).toBe('copilot --print "hello world"');
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('uses cmd-style env injection for Windows tmux shell commands', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('MSYSTEM', '');
        vi.stubEnv('MINGW_PREFIX', '');
        expect(buildTmuxShellCommandWithEnv('copilot', ['--print'], { CODEX_HOME: 'C:\\Users\\me\\codex home' }))
            .toBe('set "CODEX_HOME=C:\\Users\\me\\codex home" && copilot --print');
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('keeps Unix login-shell wrapping on MSYS2 Windows', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.stubEnv('MSYSTEM', 'MINGW64');
        vi.stubEnv('SHELL', '/usr/bin/bash');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('copilot');
        expect(result).toContain('exec ');
        expect(result).toContain('-lc');
        expect(result).toContain('/home/testuser/.bashrc');
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    it('wraps command with login shell using $SHELL', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        const result = wrapWithLoginShell('copilot --print');
        expect(result).toContain('/bin/zsh');
        expect(result).toContain('-lc');
        expect(result).toContain('copilot --print');
        expect(result).toMatch(/^exec /);
    });
    it('defaults to /bin/bash when $SHELL is not set', () => {
        vi.stubEnv('SHELL', '');
        const result = wrapWithLoginShell('codex');
        expect(result).toContain('/bin/bash');
        expect(result).toContain('-lc');
    });
    it('properly quotes the inner command containing single quotes', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        const result = wrapWithLoginShell("perl -e 'print 1'");
        expect(result).toContain('-lc');
        expect(result).toContain('perl');
        expect(result).toContain('print 1');
    });
    it('uses exec to replace the outer shell process', () => {
        vi.stubEnv('SHELL', '/bin/bash');
        const result = wrapWithLoginShell('my-command');
        expect(result).toMatch(/^exec /);
    });
    it('works with complex multi-statement commands', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        const cmd = 'sleep 0.3; echo hello; copilot --dangerously-skip-permissions';
        const result = wrapWithLoginShell(cmd);
        expect(result).toContain('/bin/zsh');
        expect(result).toContain('-lc');
        expect(result).toContain('sleep 0.3');
        expect(result).toContain('copilot');
    });
    it('handles shells with unusual paths', () => {
        vi.stubEnv('SHELL', '/usr/local/bin/fish');
        const result = wrapWithLoginShell('codex');
        expect(result).toContain('/usr/local/bin/fish');
        expect(result).toContain('-lc');
    });
    it('sources ~/.zshrc for zsh shells', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('copilot');
        expect(result).toContain('.zshrc');
        expect(result).toContain('/home/testuser/.zshrc');
    });
    it('sources ~/.bashrc for bash shells', () => {
        vi.stubEnv('SHELL', '/bin/bash');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('copilot');
        expect(result).toContain('.bashrc');
        expect(result).toContain('/home/testuser/.bashrc');
    });
    it('sources ~/.fishrc for fish shells', () => {
        vi.stubEnv('SHELL', '/usr/local/bin/fish');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('codex');
        expect(result).toContain('.fishrc');
        expect(result).toContain('/home/testuser/.fishrc');
    });
    it('skips rc sourcing when HOME is not set', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        vi.stubEnv('HOME', '');
        const result = wrapWithLoginShell('copilot');
        expect(result).not.toContain('.zshrc');
        expect(result).toContain('copilot');
    });
    it('uses conditional test before sourcing rc file', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        vi.stubEnv('HOME', '/home/testuser');
        const result = wrapWithLoginShell('copilot');
        expect(result).toContain('[ -f');
        expect(result).toContain('] && .');
    });
});
// ---------------------------------------------------------------------------
// quoteShellArg
// ---------------------------------------------------------------------------
describe('quoteShellArg', () => {
    it('wraps value in single quotes', () => {
        expect(quoteShellArg('hello')).toBe("'hello'");
    });
    it('escapes embedded single quotes', () => {
        const result = quoteShellArg("it's");
        expect(result).toContain("'\"'\"'");
    });
});
// ---------------------------------------------------------------------------
// sanitizeTmuxToken
// ---------------------------------------------------------------------------
describe('sanitizeTmuxToken', () => {
    it('lowercases and replaces non-alphanumeric with hyphens', () => {
        expect(sanitizeTmuxToken('My_Project.Name')).toBe('my-project-name');
        expect(sanitizeTmuxToken('MyProject')).toBe('myproject');
        expect(sanitizeTmuxToken('my project!')).toBe('my-project');
    });
    it('strips leading and trailing hyphens', () => {
        expect(sanitizeTmuxToken('--hello--')).toBe('hello');
    });
    it('returns "unknown" for empty result', () => {
        expect(sanitizeTmuxToken('...')).toBe('unknown');
        expect(sanitizeTmuxToken('!!!')).toBe('unknown');
    });
});
// ---------------------------------------------------------------------------
// createHudWatchPane — login shell wrapping
// ---------------------------------------------------------------------------
describe('createHudWatchPane login shell wrapping', () => {
    it('wraps hudCmd with wrapWithLoginShell in source code', () => {
        // Verify the source uses wrapWithLoginShell for the HUD command
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '..', 'tmux-utils.ts'), 'utf-8');
        expect(source).toContain('wrapWithLoginShell(hudCmd)');
    });
});
//# sourceMappingURL=tmux-utils.test.js.map