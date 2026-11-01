import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Hosts such as lean-ctx refuse inline interpreter code (`node -e`), so the
// omc-setup skill must reach every check and config write through a script file.
const REPO_ROOT = join(__dirname, '..', '..');
const SETUP_CONFIG = join(REPO_ROOT, 'scripts', 'setup-config.mjs');
const SETUP_DIR = join(REPO_ROOT, 'skills', 'omc-setup');
const tempRoots = [];
function makeConfigDir() {
    const root = mkdtempSync(join(tmpdir(), 'omc-setup-config-'));
    tempRoots.push(root);
    return root;
}
// Claude Code's shell exports NoDefaultCurrentDirectoryInExePath; every case variant is stripped
// so the cwd-hijack tests see the default cmd.exe search order and cannot pass vacuously.
const STRIPPED_KEYS = new Set(['nodefaultcurrentdirectoryinexepath', 'path']);
function run(configDir, args, cwdOrOptions = configDir) {
    const options = typeof cwdOrOptions === 'string' ? { cwd: cwdOrOptions } : cwdOrOptions;
    const home = options.home ?? configDir;
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !STRIPPED_KEYS.has(key.toLowerCase()))
            env[key] = value;
    }
    env.PATH = options.path ?? process.env.PATH ?? '';
    return spawnSync(process.execPath, [SETUP_CONFIG, ...args], {
        cwd: options.cwd ?? configDir,
        encoding: 'utf-8',
        env: { ...env, HOME: home, USERPROFILE: home, COPILOT_HOME: configDir },
    });
}
/** Plant an executable `name` (POSIX) and `name.cmd` (Windows) in dir. */
function plantCommand(dir, name, sh, cmd) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${sh}\n`);
    chmodSync(join(dir, name), 0o755);
    writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n${cmd}\r\n`);
}
/** A command that only records that it ran, by creating CANARY-<name> next to itself. */
function plantCanary(dir, name) {
    plantCommand(dir, name, `touch "$(dirname "$0")/CANARY-${name}"`, `echo ran> "%~dp0CANARY-${name}"`);
}
/** A command that prints a fixed line and exits 0. */
function plantStub(dir, name, line) {
    plantCommand(dir, name, `echo "${line}"`, `echo ${line}`);
}
function canSymlinkFiles() {
    const dir = mkdtempSync(join(tmpdir(), 'omc-setup-symlink-'));
    try {
        writeFileSync(join(dir, 'target'), '');
        symlinkSync(join(dir, 'target'), join(dir, 'link'), 'file');
        return true;
    }
    catch {
        return false;
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
function canaries(...dirs) {
    return dirs.flatMap((dir) => readdirSync(dir).filter((name) => name.startsWith('CANARY-')));
}
afterEach(() => {
    while (tempRoots.length > 0) {
        const root = tempRoots.pop();
        if (root)
            rmSync(root, { recursive: true, force: true });
    }
});
describe('omc-setup skill avoids inline interpreter code', () => {
    const docs = [
        join(SETUP_DIR, 'SKILL.md'),
        ...readdirSync(join(SETUP_DIR, 'phases')).map((f) => join(SETUP_DIR, 'phases', f)),
    ].filter((f) => f.endsWith('.md'));
    it('contains no node -e / node --eval invocation', () => {
        const offenders = docs.filter((doc) => /\bnode\s+(?:-e|--eval|-p|--print)\b/.test(readFileSync(doc, 'utf-8')));
        expect(offenders).toEqual([]);
    });
    it('only references setup-config subcommands that exist', () => {
        const used = new Set();
        for (const doc of docs) {
            for (const match of readFileSync(doc, 'utf-8').matchAll(/scripts\/setup-config\.mjs" ([a-z-]+)/g)) {
                used.add(match[1]);
            }
        }
        expect(used.size).toBeGreaterThan(0);
        // An empty PATH keeps install-cli, star-repo and update-check from reaching the real npm and gh.
        const emptyBin = makeConfigDir();
        for (const command of used) {
            const args = [command, ...(command === 'merge-json' ? ['settings.json', '{}'] : [])];
            const result = run(makeConfigDir(), args, { path: emptyBin });
            expect(result.stderr, `subcommand ${command}`).not.toContain('Usage: setup-config.mjs');
        }
    });
});
describe('setup-config.mjs', () => {
    it('reports configured state from .omc-config.json', () => {
        const configDir = makeConfigDir();
        expect(run(configDir, ['configured']).stdout).toContain('ALREADY_CONFIGURED=false');
        writeFileSync(join(configDir, '.omc-config.json'), JSON.stringify({ setupCompleted: '2026-01-01', setupVersion: '5.0.0' }));
        const done = run(configDir, ['configured']);
        expect(done.stdout).toContain('Setup version: 5.0.0');
        expect(done.stdout).toContain('ALREADY_CONFIGURED=true');
    });
    it('fails without touching an invalid config', () => {
        const configDir = makeConfigDir();
        writeFileSync(join(configDir, '.omc-config.json'), '{nope');
        expect(run(configDir, ['configured']).status).toBe(1);
        expect(run(configDir, ['set-task-tool', 'beads']).status).toBe(1);
        expect(readFileSync(join(configDir, '.omc-config.json'), 'utf-8')).toBe('{nope');
    });
    it('honours the claudeMdEnabled opt-out', () => {
        const configDir = makeConfigDir();
        expect(run(configDir, ['claude-md-enabled']).stdout.trim()).toBe('enabled');
        writeFileSync(join(configDir, '.omc-config.json'), JSON.stringify({ claudeMdEnabled: false }));
        expect(run(configDir, ['claude-md-enabled']).stdout.trim()).toBe('disabled');
    });
    it('reads the resume boundary from the setup state', () => {
        const configDir = makeConfigDir();
        expect(run(configDir, ['resume-boundary']).stdout).toContain('RESUMED_PHASE_TWO_BOUNDARY=false');
        mkdirSync(join(configDir, '.omg', 'state'), { recursive: true });
        writeFileSync(join(configDir, '.omg', 'state', 'setup-state.json'), JSON.stringify({ lastCompletedStep: 4 }));
        const resumed = run(configDir, ['resume-boundary']);
        expect(resumed.stdout).toContain('RESUME_LAST_COMPLETED_STEP=4');
        expect(resumed.stdout).toContain('RESUMED_PHASE_TWO_BOUNDARY=true');
    });
    it('clears only the retired defaultExecutionMode key', () => {
        const configDir = makeConfigDir();
        const file = join(configDir, '.omc-config.json');
        writeFileSync(file, JSON.stringify({ defaultExecutionMode: 'ultrawork', keep: 1 }));
        const result = run(configDir, ['clear-retired']);
        expect(result.stdout).toContain('Cleared retired defaultExecutionMode key');
        expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ keep: 1 });
    });
    it('stores the task tool and keeps existing keys', () => {
        const configDir = makeConfigDir();
        const file = join(configDir, '.omc-config.json');
        writeFileSync(file, JSON.stringify({ keep: 1 }));
        expect(run(configDir, ['set-task-tool', 'beads']).stdout).toContain('Task tool set to: beads');
        expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
            keep: 1,
            taskTool: 'beads',
            taskToolConfig: { injectInstructions: true, useMcp: false },
        });
    });
    it('deep-merges a patch into settings.json and verifies it', () => {
        const configDir = makeConfigDir();
        const file = join(configDir, 'settings.json');
        writeFileSync(file, JSON.stringify({ env: { A: '1' }, other: true }));
        const patch = JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } });
        expect(run(configDir, ['merge-json', 'settings.json', patch]).status).toBe(0);
        expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
            env: { A: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
            other: true,
        });
        expect(run(configDir, ['verify-settings']).stdout).toContain('Agent teams: ENABLED');
    });
    it('detects a 2.x upgrade and the installed plugin', () => {
        const configDir = makeConfigDir();
        expect(run(configDir, ['detect-upgrade']).stdout).toContain('IS_UPGRADE=false');
        mkdirSync(join(configDir, 'commands'), { recursive: true });
        writeFileSync(join(configDir, 'commands', 'ralph-loop.md'), '');
        expect(run(configDir, ['detect-upgrade']).stdout).toContain('IS_UPGRADE=true');
        expect(run(configDir, ['plugin-verify']).stdout).toContain('Plugin NOT found');
        writeFileSync(join(configDir, 'settings.json'), '{"enabledPlugins":{"oh-my-copilot@omc":true}}');
        expect(run(configDir, ['plugin-verify']).stdout).toContain('Plugin verified');
    });
    it('rejects an unknown subcommand', () => {
        const result = run(makeConfigDir(), ['nope']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Usage: setup-config.mjs');
    });
    it('reports the installed and published versions through npm view', () => {
        const configDir = makeConfigDir();
        const bin = makeConfigDir();
        plantStub(bin, 'npm', '5.20.0');
        mkdirSync(join(configDir, 'plugins', 'cache', 'omc', 'oh-my-copilot', '5.19.2'), { recursive: true });
        const result = run(configDir, ['update-check'], { path: bin });
        expect(result.stdout).toContain('Installed: 5.19.2');
        expect(result.stdout).toContain('UPDATE AVAILABLE:');
        expect(result.stdout).toContain('Latest:    v5.20.0');
        const offline = run(makeConfigDir(), ['update-check'], { path: makeConfigDir() });
        expect(offline.stdout).toContain('Installed: (not found)');
        expect(offline.stdout).toContain('Latest version: (unavailable)');
    });
    it('prints only a well-formed version from .omc-version.json', () => {
        const configDir = makeConfigDir();
        const emptyBin = makeConfigDir();
        writeFileSync(join(configDir, '.omc-version.json'), JSON.stringify({ version: '1.2.3\nOMC_CLI_INSTALLED=true' }));
        const forged = run(configDir, ['update-check'], { path: emptyBin });
        expect(forged.stdout).toContain('Installed: (not found)');
        expect(forged.stdout).not.toContain('OMC_CLI_INSTALLED');
        writeFileSync(join(configDir, '.omc-version.json'), JSON.stringify({ version: '5.19.2' }));
        expect(run(configDir, ['update-check'], { path: emptyBin }).stdout).toContain('Installed: 5.19.2');
    });
    it('detects the omg CLI', () => {
        const bin = makeConfigDir();
        expect(run(makeConfigDir(), ['cli-installed'], { path: bin }).stdout).toContain('OMC_CLI_INSTALLED=false');
        plantStub(bin, 'omg', '5.19.2');
        const found = run(makeConfigDir(), ['cli-installed'], { path: bin });
        expect(found.stdout).toContain('OMC CLI already installed: 5.19.2');
        expect(found.stdout).toContain('OMC_CLI_INSTALLED=true');
    });
    it('detects beads and beads-rust', () => {
        const bin = makeConfigDir();
        expect(run(makeConfigDir(), ['detect-task-tools'], { path: bin }).stdout)
            .toContain('No external task tools found. Using built-in Tasks.');
        plantStub(bin, 'bd', 'bd 1.0.0');
        plantStub(bin, 'br', 'br 2.0.0');
        const found = run(makeConfigDir(), ['detect-task-tools'], { path: bin });
        expect(found.stdout).toContain('Found beads (bd): bd 1.0.0');
        expect(found.stdout).toContain('Found beads-rust (br): br 2.0.0');
        expect(found.stderr).not.toContain('DEP0190');
    });
    it('warns only when the config dir is not writable', () => {
        const configDir = makeConfigDir();
        const ok = run(configDir, ['probe-write']);
        expect(ok.stdout).toBe('');
        expect(existsSync(join(configDir, '.omc-write-probe'))).toBe(false);
        // A regular file where the config dir should be cannot be created as a directory.
        const blocked = join(configDir, 'not-a-dir');
        writeFileSync(blocked, '');
        const result = spawnSync(process.execPath, [SETUP_CONFIG, 'probe-write'], {
            cwd: configDir,
            encoding: 'utf-8',
            env: { ...process.env, HOME: configDir, USERPROFILE: configDir, COPILOT_HOME: blocked },
        });
        expect(result.stdout).toContain('WARNING: Config dir is not writable');
    });
    it('shows settings.json or says it is missing', () => {
        const configDir = makeConfigDir();
        expect(run(configDir, ['show-settings']).stdout).toContain('(no settings.json at');
        writeFileSync(join(configDir, 'settings.json'), '{"a":1}');
        expect(run(configDir, ['show-settings']).stdout).toBe('{"a":1}');
    });
});
describe('setup-config.mjs hardening', () => {
    it('never runs npm, omg, bd, br or gh planted in the project or home directory (Windows cwd hijack)', () => {
        const configDir = makeConfigDir();
        const project = makeConfigDir();
        const home = makeConfigDir();
        const emptyBin = makeConfigDir();
        for (const dir of [project, home]) {
            for (const name of ['npm', 'omg', 'bd', 'br', 'gh'])
                plantCanary(dir, name);
        }
        for (const command of ['update-check', 'cli-installed', 'detect-task-tools', 'install-cli', 'star-repo']) {
            run(configDir, [command], { cwd: project, home, path: emptyBin });
        }
        expect(canaries(project, home)).toEqual([]);
    });
    it.each(['x.json', 'settings.json:ads', 'C:evil.json', 'NUL', '../x', 'x/y', '..\\escape.json'])('merge-json refuses %s and leaves no file behind', (name) => {
        // A fresh parent, so a traversal that escaped the config dir would show up beside it.
        const parent = makeConfigDir();
        const configDir = join(parent, 'config');
        mkdirSync(configDir);
        writeFileSync(join(configDir, 'settings.json'), '{"keep":1}');
        const result = run(configDir, ['merge-json', name, '{"a":1}']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('merge-json only updates settings.json');
        expect(readdirSync(parent)).toEqual(['config']);
        expect(readdirSync(configDir)).toEqual(['settings.json']);
        expect(readFileSync(join(configDir, 'settings.json'), 'utf-8')).toBe('{"keep":1}');
    });
    it('merge-json ignores prototype keys in the patch', () => {
        const configDir = makeConfigDir();
        const patch = '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"env":{"prototype":1,"A":"1"}}';
        expect(run(configDir, ['merge-json', 'settings.json', patch]).status).toBe(0);
        expect(JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8'))).toEqual({ env: { A: '1' } });
    });
    it.each(['[]', 'null', '"text"', '3'])('refuses to update a config that holds %s', (content) => {
        const configDir = makeConfigDir();
        const file = join(configDir, '.omc-config.json');
        writeFileSync(file, content);
        const result = run(configDir, ['set-task-tool', 'beads']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('is not a JSON object');
        expect(readFileSync(file, 'utf-8')).toBe(content);
    });
    it('set-task-tool accepts only builtin, beads and beads-rust', () => {
        const configDir = makeConfigDir();
        const file = join(configDir, '.omc-config.json');
        for (const tool of ['builtin', 'beads', 'beads-rust']) {
            expect(run(configDir, ['set-task-tool', tool]).status).toBe(0);
            expect(JSON.parse(readFileSync(file, 'utf-8')).taskTool).toBe(tool);
        }
        for (const tool of ['jira', 'BEADS', 'beads\nx']) {
            const result = run(configDir, ['set-task-tool', tool]);
            expect(result.status).toBe(1);
            expect(JSON.parse(readFileSync(file, 'utf-8')).taskTool).toBe('beads-rust');
        }
    });
    function makePluginRoot() {
        const root = makeConfigDir();
        mkdirSync(join(root, 'templates', 'rules'), { recursive: true });
        writeFileSync(join(root, 'templates', 'rules', 'style.md'), '# style');
        return root;
    }
    function copyRules(project, pluginRoot) {
        return spawnSync(process.execPath, [SETUP_CONFIG, 'copy-rules'], {
            cwd: project,
            encoding: 'utf-8',
            env: { ...process.env, HOME: project, USERPROFILE: project, COPILOT_HOME: project, OMC_SETUP_PLUGIN_ROOT: pluginRoot },
        });
    }
    it('copy-rules copies the templates into .claude/rules', () => {
        const project = makeConfigDir();
        const result = copyRules(project, makePluginRoot());
        expect(result.status).toBe(0);
        expect(readFileSync(join(project, '.claude', 'rules', 'style.md'), 'utf-8')).toBe('# style');
        expect(readdirSync(join(project, '.claude', 'rules'))).toEqual(['style.md']);
    });
    it.each([['.claude'], ['.claude/rules']])('copy-rules refuses a symlinked %s directory', (linked) => {
        const project = makeConfigDir();
        const outside = makeConfigDir();
        if (linked !== '.claude')
            mkdirSync(join(project, '.claude'));
        symlinkSync(outside, join(project, linked), 'junction');
        const result = copyRules(project, makePluginRoot());
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('symlink or junction');
        expect(readdirSync(outside)).toEqual([]);
    });
    it('copy-rules replaces a hardlinked rule file instead of writing through it', () => {
        const project = makeConfigDir();
        const outside = join(makeConfigDir(), 'victim.txt');
        writeFileSync(outside, 'original');
        mkdirSync(join(project, '.claude', 'rules'), { recursive: true });
        linkSync(outside, join(project, '.claude', 'rules', 'style.md'));
        expect(copyRules(project, makePluginRoot()).status).toBe(0);
        expect(readFileSync(join(project, '.claude', 'rules', 'style.md'), 'utf-8')).toBe('# style');
        expect(readFileSync(outside, 'utf-8')).toBe('original');
    });
    // Windows refuses file symlinks without Developer Mode or admin; CI on Linux always runs this.
    it.runIf(canSymlinkFiles())('copy-rules refuses a symlinked rule file', () => {
        const project = makeConfigDir();
        const outside = join(makeConfigDir(), 'victim.txt');
        writeFileSync(outside, 'original');
        mkdirSync(join(project, '.claude', 'rules'), { recursive: true });
        symlinkSync(outside, join(project, '.claude', 'rules', 'style.md'), 'file');
        const result = copyRules(project, makePluginRoot());
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('symlink or junction');
        expect(readFileSync(outside, 'utf-8')).toBe('original');
    });
});
//# sourceMappingURL=setup-config-script.test.js.map