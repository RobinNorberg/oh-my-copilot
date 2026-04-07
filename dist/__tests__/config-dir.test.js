import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, join, normalize } from 'path';
import { getCopilotConfigDir } from '../utils/config-dir.js';
import { isValidTranscriptPath } from '../lib/worktree-paths.js';
import { findRuleFiles } from '../hooks/rules-injector/finder.js';
const originalConfigDir = process.env.COPILOT_CONFIG_DIR;
describe('getCopilotConfigDir', () => {
    afterEach(() => {
        if (originalConfigDir === undefined) {
            delete process.env.COPILOT_CONFIG_DIR;
        }
        else {
            process.env.COPILOT_CONFIG_DIR = originalConfigDir;
        }
    });
    it('falls back to ~/.copilot when COPILOT_CONFIG_DIR is unset', () => {
        delete process.env.COPILOT_CONFIG_DIR;
        expect(getCopilotConfigDir()).toBe(normalize(join(homedir(), '.copilot')));
    });
    it('falls back to ~/.copilot when COPILOT_CONFIG_DIR is empty', () => {
        process.env.COPILOT_CONFIG_DIR = '   ';
        expect(getCopilotConfigDir()).toBe(normalize(join(homedir(), '.copilot')));
    });
    it('returns an absolute custom path unchanged aside from normalization', () => {
        process.env.COPILOT_CONFIG_DIR = join(tmpdir(), 'custom-copilot-config', '..', 'custom-copilot-config');
        expect(getCopilotConfigDir()).toBe(normalize(join(tmpdir(), 'custom-copilot-config', '..', 'custom-copilot-config')));
    });
    it('expands a bare tilde to the home directory', () => {
        process.env.COPILOT_CONFIG_DIR = '~';
        expect(getCopilotConfigDir()).toBe(normalize(homedir()));
    });
    it('expands a ~-prefixed config path', () => {
        process.env.COPILOT_CONFIG_DIR = '~/.copilot-alt';
        expect(getCopilotConfigDir()).toBe(normalize(join(homedir(), '.copilot-alt')));
    });
    it('strips a trailing separator from custom paths', () => {
        process.env.COPILOT_CONFIG_DIR = join(tmpdir(), 'custom-copilot-config') + '/';
        expect(getCopilotConfigDir()).toBe(normalize(join(tmpdir(), 'custom-copilot-config')));
        expect(getCopilotConfigDir().endsWith('/')).toBe(false);
    });
    it('preserves a Windows drive root when trimming separators', async () => {
        process.env.COPILOT_CONFIG_DIR = 'C:\\';
        vi.resetModules();
        vi.doMock('node:os', () => ({
            homedir: () => 'C:\\Users\\tester',
        }));
        vi.doMock('node:path', async () => import('node:path/win32'));
        try {
            const { getCopilotConfigDir: getWindowsConfigDir } = await import('../utils/config-dir.js');
            expect(getWindowsConfigDir()).toBe('C:\\');
        }
        finally {
            vi.doUnmock('node:os');
            vi.doUnmock('node:path');
            vi.resetModules();
        }
    });
    it('keeps the script helper aligned with the TypeScript helper', async () => {
        process.env.COPILOT_CONFIG_DIR = '~/.copilot-alt';
        const output = execFileSync(process.execPath, [
            '--input-type=module',
            '-e',
            "import { getClaudeConfigDir } from './scripts/lib/config-dir.mjs'; process.stdout.write(getClaudeConfigDir());",
        ], {
            cwd: process.cwd(),
            env: { ...process.env, CLAUDE_CONFIG_DIR: process.env.COPILOT_CONFIG_DIR },
            encoding: 'utf-8',
        });
        expect(output).toBe(normalize(join(homedir(), '.copilot-alt')));
    });
    it.skipIf(process.platform === 'win32')('find-node.sh resolves a ~-prefixed COPILOT_CONFIG_DIR before reading .omc-config.json', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'omc-find-node-home-'));
        const configDir = join(homeDir, '.copilot-alt');
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, '.omc-config.json'), JSON.stringify({ nodeBinary: process.execPath }));
        const output = execFileSync('/bin/sh', [join(process.cwd(), 'scripts', 'find-node.sh'), '-e', "process.stdout.write('ok')"], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                HOME: homeDir,
                PATH: '/bin:/usr/bin',
                CLAUDE_CONFIG_DIR: '~/.copilot-alt',
            },
            encoding: 'utf-8',
        });
        expect(output).toBe('ok');
    });
    it.skipIf(process.platform === 'win32')('shared shell helper expands a ~-prefixed COPILOT_CONFIG_DIR', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'omc-uninstall-home-'));
        const output = execFileSync('bash', ['-lc', `. "${join(process.cwd(), 'scripts', 'lib', 'config-dir.sh')}"; resolve_claude_config_dir`], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                HOME: homeDir,
                CLAUDE_CONFIG_DIR: '~/.copilot-alt',
            },
            encoding: 'utf-8',
        });
        expect(output.trim()).toBe(join(homeDir, '.copilot-alt'));
    });
    it('keeps the CJS helper aligned with the TypeScript helper', () => {
        process.env.COPILOT_CONFIG_DIR = '~/.copilot-alt';
        const cjsPath = join(process.cwd(), 'scripts', 'lib', 'config-dir.cjs');
        const output = execFileSync(process.execPath, ['-e', `const { getClaudeConfigDir } = require(${JSON.stringify(cjsPath)}); process.stdout.write(getClaudeConfigDir());`], {
            cwd: process.cwd(),
            env: { ...process.env, CLAUDE_CONFIG_DIR: process.env.COPILOT_CONFIG_DIR },
            encoding: 'utf-8',
        });
        expect(output).toBe(normalize(join(homedir(), '.copilot-alt')));
    });
});
describe('COPILOT_CONFIG_DIR downstream integration', () => {
    let origConfigDir;
    let tempDir;
    let tildeConfigDir;
    beforeEach(() => {
        origConfigDir = process.env.COPILOT_CONFIG_DIR;
        tempDir = join(tmpdir(), `omc-test-configdir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        tildeConfigDir = join(homedir(), `.omc-test-configdir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tempDir, { recursive: true });
    });
    afterEach(() => {
        if (origConfigDir === undefined) {
            delete process.env.COPILOT_CONFIG_DIR;
        }
        else {
            process.env.COPILOT_CONFIG_DIR = origConfigDir;
        }
        try {
            rmSync(tempDir, { recursive: true, force: true });
        }
        catch {
            // ignore cleanup errors
        }
        try {
            rmSync(tildeConfigDir, { recursive: true, force: true });
        }
        catch {
            // ignore cleanup errors
        }
    });
    it('accepts transcript paths under custom COPILOT_CONFIG_DIR', () => {
        process.env.COPILOT_CONFIG_DIR = '/opt/custom-copilot-config';
        const transcriptPath = '/opt/custom-copilot-config/projects/-foo/bar/session.jsonl';
        expect(isValidTranscriptPath(transcriptPath)).toBe(true);
    });
    it('accepts transcript paths when COPILOT_CONFIG_DIR uses a ~-prefixed path', () => {
        process.env.COPILOT_CONFIG_DIR = `~/${basename(tildeConfigDir)}`;
        const transcriptPath = join(tildeConfigDir, 'projects', '-foo', 'bar', 'session.jsonl');
        expect(isValidTranscriptPath(transcriptPath)).toBe(true);
    });
    it('discovers user rules from custom COPILOT_CONFIG_DIR/rules', () => {
        const customRulesDir = join(tempDir, 'rules');
        mkdirSync(customRulesDir, { recursive: true });
        writeFileSync(join(customRulesDir, 'my-rule.md'), '# My Rule\nRule content');
        process.env.COPILOT_CONFIG_DIR = tempDir;
        const candidates = findRuleFiles(null, '/some/file.ts');
        const globalRules = candidates.filter(c => c.isGlobal);
        expect(globalRules.length).toBeGreaterThanOrEqual(1);
        expect(globalRules.some(c => c.path.includes('my-rule.md'))).toBe(true);
    });
    it('uses the active config dir rather than default ~/.copilot/rules for user rules', () => {
        const customRulesDir = join(tempDir, 'rules');
        mkdirSync(customRulesDir, { recursive: true });
        writeFileSync(join(customRulesDir, 'custom-rule.md'), '# Custom Rule');
        process.env.COPILOT_CONFIG_DIR = tempDir;
        const candidates = findRuleFiles(null, '/some/file.ts');
        const globalRules = candidates.filter(c => c.isGlobal);
        expect(globalRules.some(c => c.path.includes('custom-rule.md'))).toBe(true);
    });
    it('discovers user rules when COPILOT_CONFIG_DIR uses a ~-prefixed path', () => {
        const customRulesDir = join(tildeConfigDir, 'rules');
        mkdirSync(customRulesDir, { recursive: true });
        writeFileSync(join(customRulesDir, 'tilde-rule.md'), '# Tilde Rule');
        process.env.COPILOT_CONFIG_DIR = `~/${basename(tildeConfigDir)}`;
        const candidates = findRuleFiles(null, '/some/file.ts');
        const globalRules = candidates.filter(c => c.isGlobal);
        expect(globalRules.some(c => c.path.includes('tilde-rule.md'))).toBe(true);
    });
});
//# sourceMappingURL=config-dir.test.js.map