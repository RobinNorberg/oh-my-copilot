import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The Node setup lifecycle must run everywhere Node runs: no bash, no jq, no
// POSIX date. These tests exercise the scripts through the real Node binary on
// whatever platform the suite is running on.
const REPO_ROOT = join(__dirname, '..', '..');
const SETUP_PROGRESS = join(REPO_ROOT, 'scripts', 'setup-progress.mjs');
const UNINSTALL = join(REPO_ROOT, 'scripts', 'uninstall.mjs');
const tempRoots = [];
function makeWorkspace(prefix) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    tempRoots.push(root);
    const project = join(root, 'project');
    const configDir = join(root, 'config');
    mkdirSync(project, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    // The state root resolver anchors workspace state at the git root, so the
    // fixture must be a repository for setup state to stay inside the temp dir.
    spawnSync('git', ['init', '--quiet'], { cwd: project, encoding: 'utf-8' });
    return { root, project, configDir };
}
function runScript(script, args, cwd, configDir) {
    return spawnSync(process.execPath, [script, ...args], {
        cwd,
        encoding: 'utf-8',
        env: { ...process.env, COPILOT_CONFIG_DIR: configDir },
    });
}
afterEach(() => {
    while (tempRoots.length > 0) {
        const root = tempRoots.pop();
        if (root)
            rmSync(root, { recursive: true, force: true });
    }
});
describe('setup-progress.mjs', () => {
    it('reports a fresh tree, then saves and resumes progress', () => {
        const { project, configDir } = makeWorkspace('omc-progress-node-');
        const fresh = runScript(SETUP_PROGRESS, ['resume'], project, configDir);
        expect(fresh.status).toBe(0);
        expect(fresh.stdout.trim()).toBe('fresh');
        const saved = runScript(SETUP_PROGRESS, ['save', '2', 'local'], project, configDir);
        expect(saved.status).toBe(0);
        const state = JSON.parse(readFileSync(join(project, '.omg', 'state', 'setup-state.json'), 'utf-8'));
        expect(state.lastCompletedStep).toBe(2);
        expect(state.configType).toBe('local');
        expect(Number.isNaN(Date.parse(state.timestamp))).toBe(false);
        const resumed = runScript(SETUP_PROGRESS, ['resume'], project, configDir);
        expect(resumed.status).toBe(0);
        expect(resumed.stdout).toContain('Found previous setup session (Step 2');
        expect(resumed.stdout.trim().split(/\r?\n/).at(-1)).toBe('2');
    });
    it('carries the recorded config type forward when save omits it', () => {
        const { project, configDir } = makeWorkspace('omc-progress-carry-');
        runScript(SETUP_PROGRESS, ['save', '2', 'global'], project, configDir);
        const saved = runScript(SETUP_PROGRESS, ['save', '3'], project, configDir);
        expect(saved.status).toBe(0);
        expect(saved.stdout).toContain('Progress saved: step 3 (global)');
    });
    it('discards state older than 24 hours', () => {
        const { project, configDir } = makeWorkspace('omc-progress-stale-');
        const statePath = join(project, '.omg', 'state', 'setup-state.json');
        mkdirSync(join(project, '.omg', 'state'), { recursive: true });
        writeFileSync(statePath, JSON.stringify({ lastCompletedStep: 3, timestamp: '2001-01-01T00:00:00.000Z', configType: 'local' }));
        const result = runScript(SETUP_PROGRESS, ['resume'], project, configDir);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('more than 24 hours old');
        expect(result.stdout.trim().split(/\r?\n/).at(-1)).toBe('fresh');
        expect(existsSync(statePath)).toBe(false);
    });
    it('fails closed on invalid state instead of rewriting it', () => {
        const { project, configDir } = makeWorkspace('omc-progress-invalid-');
        const statePath = join(project, '.omg', 'state', 'setup-state.json');
        mkdirSync(join(project, '.omg', 'state'), { recursive: true });
        writeFileSync(statePath, '{not json');
        const result = runScript(SETUP_PROGRESS, ['resume'], project, configDir);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('invalid JSON');
        expect(readFileSync(statePath, 'utf-8')).toBe('{not json');
    });
    it('merges completion metadata into an existing config without jq', () => {
        const { project, configDir } = makeWorkspace('omc-progress-complete-');
        const configPath = join(configDir, '.omc-config.json');
        writeFileSync(configPath, JSON.stringify({ existing: true }, null, 2));
        const result = runScript(SETUP_PROGRESS, ['complete', 'v9.9.9'], project, configDir);
        expect(result.status).toBe(0);
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        expect(config.existing).toBe(true);
        expect(config.setupVersion).toBe('v9.9.9');
        expect(config.setupCompleted).toBeTruthy();
    });
    it('preserves an unparseable config rather than truncating it', () => {
        const { project, configDir } = makeWorkspace('omc-progress-badconfig-');
        const configPath = join(configDir, '.omc-config.json');
        writeFileSync(configPath, 'garbage');
        const result = runScript(SETUP_PROGRESS, ['complete', 'v1.0.0'], project, configDir);
        expect(result.status).not.toBe(0);
        expect(readFileSync(configPath, 'utf-8')).toBe('garbage');
    });
    it('adopts a pre-unification config left in the old directory', () => {
        // Node surfaces used to resolve ~/.claude while the shell surfaces used
        // ~/.copilot, so an upgraded install can hold its only .omc-config.json in
        // the old place. Setup is the upgrade path, so `complete` recovers it.
        const { root, project } = makeWorkspace('omc-progress-adopt-');
        const home = join(root, 'home');
        const legacyDir = join(home, '.claude');
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(join(legacyDir, '.omc-config.json'), JSON.stringify({ taskTool: 'beads', notifications: { enabled: true } }, null, 2));
        const env = { ...process.env, HOME: home, USERPROFILE: home };
        delete env.COPILOT_CONFIG_DIR;
        const result = spawnSync(process.execPath, [SETUP_PROGRESS, 'complete', 'v1.2.3'], {
            cwd: project,
            encoding: 'utf-8',
            env,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Adopted settings from');
        const adopted = JSON.parse(readFileSync(join(home, '.copilot', '.omc-config.json'), 'utf-8'));
        expect(adopted.taskTool).toBe('beads');
        expect(adopted.setupVersion).toBe('v1.2.3');
        // The legacy file is copied, never moved, so nothing is destroyed.
        expect(existsSync(join(legacyDir, '.omc-config.json'))).toBe(true);
    });
    it('resolves the omg version binary from PATH, never from the working directory', () => {
        // cmd.exe and where.exe both search the current directory first, so a
        // cloned repository carrying an omg.cmd would otherwise run during setup.
        const { root, project, configDir } = makeWorkspace('omc-progress-cwd-omc-');
        const marker = join(root, 'planted-omc-ran.txt');
        const planted = process.platform === 'win32' ? 'omg.cmd' : 'omg';
        writeFileSync(join(project, planted), process.platform === 'win32'
            ? `@echo off\r\n> "${marker}" echo ran\r\necho 9.9.9-planted\r\n`
            : `#!/bin/sh\necho ran > "${marker}"\necho 9.9.9-planted\n`, process.platform === 'win32' ? undefined : { mode: 0o755 });
        const result = spawnSync(process.execPath, [SETUP_PROGRESS, 'complete'], {
            cwd: project,
            encoding: 'utf-8',
            env: { ...process.env, COPILOT_CONFIG_DIR: configDir },
        });
        expect(result.status).toBe(0);
        expect(existsSync(marker)).toBe(false);
        const config = JSON.parse(readFileSync(join(configDir, '.omc-config.json'), 'utf-8'));
        expect(config.setupVersion).not.toContain('planted');
    });
    it.runIf(process.platform === 'win32')('never spawns a COMSPEC that is not a validated cmd.exe', () => {
        // The batch fallback spawns with windowsVerbatimArguments, which leaves
        // argv[0] unquoted, so the launcher is validated before use: absolute,
        // whitespace-free, and named cmd.exe. This impostor is runnable and writes
        // a marker, so if it were ever spawned the marker would exist.
        const { root, project, configDir } = makeWorkspace('omc-progress-comspec-');
        const marker = join(root, 'impostor-ran.txt');
        const impostor = join(root, 'notcmd.exe.cmd');
        writeFileSync(impostor, `@echo off\r\n> "${marker}" echo ran\r\necho 0.0.0-impostor\r\n`);
        const result = spawnSync(process.execPath, [SETUP_PROGRESS, 'complete'], {
            cwd: project,
            encoding: 'utf-8',
            env: { ...process.env, COPILOT_CONFIG_DIR: configDir, ComSpec: impostor },
        });
        expect(result.status).toBe(0);
        expect(existsSync(marker)).toBe(false);
        const config = JSON.parse(readFileSync(join(configDir, '.omc-config.json'), 'utf-8'));
        expect(config.setupVersion).not.toContain('impostor');
    });
    it('leaves an existing config alone rather than adopting the legacy one', () => {
        const { root, project } = makeWorkspace('omc-progress-no-adopt-');
        const home = join(root, 'home');
        mkdirSync(join(home, '.claude'), { recursive: true });
        mkdirSync(join(home, '.copilot'), { recursive: true });
        writeFileSync(join(home, '.claude', '.omc-config.json'), JSON.stringify({ taskTool: 'beads' }));
        writeFileSync(join(home, '.copilot', '.omc-config.json'), JSON.stringify({ taskTool: 'builtin' }));
        const env = { ...process.env, HOME: home, USERPROFILE: home };
        delete env.COPILOT_CONFIG_DIR;
        const result = spawnSync(process.execPath, [SETUP_PROGRESS, 'complete', 'v1.2.3'], {
            cwd: project,
            encoding: 'utf-8',
            env,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain('Adopted settings from');
        const active = JSON.parse(readFileSync(join(home, '.copilot', '.omc-config.json'), 'utf-8'));
        expect(active.taskTool).toBe('builtin');
    });
    it('reads the version from the CLAUDE.md marker when complete gets no argument', () => {
        const { project, configDir } = makeWorkspace('omc-progress-version-');
        mkdirSync(join(project, '.claude'), { recursive: true });
        writeFileSync(join(project, '.claude', 'CLAUDE.md'), '<!-- OMC:VERSION:5.1.2 -->\n');
        const result = runScript(SETUP_PROGRESS, ['complete'], project, configDir);
        expect(result.status).toBe(0);
        const config = JSON.parse(readFileSync(join(configDir, '.omc-config.json'), 'utf-8'));
        expect(config.setupVersion).toBe('5.1.2');
    });
});
describe('uninstall.mjs', () => {
    function seedInstall(configDir) {
        mkdirSync(join(configDir, 'agents'), { recursive: true });
        mkdirSync(join(configDir, 'skills', 'git-master'), { recursive: true });
        writeFileSync(join(configDir, 'agents', 'architect.md'), 'agent');
        writeFileSync(join(configDir, 'skills', 'git-master', 'SKILL.md'), 'skill');
        const settingsPath = join(configDir, 'settings.json');
        writeFileSync(settingsPath, JSON.stringify({
            model: 'opus',
            hooks: {
                UserPromptSubmit: [
                    { matcher: '*', hooks: [{ type: 'command', command: 'hooks/keyword-detector.sh' }] },
                    { matcher: '*', hooks: [{ type: 'command', command: 'vendor/third-party.sh' }] },
                ],
                Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'hooks/stop-continuation.sh' }] }],
            },
        }, null, 2));
        return settingsPath;
    }
    it('changes nothing in dry-run mode', () => {
        const { project, configDir } = makeWorkspace('omc-uninstall-dry-');
        const settingsPath = seedInstall(configDir);
        const before = readFileSync(settingsPath, 'utf-8');
        const result = runScript(UNINSTALL, ['--dry-run'], project, configDir);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('DRY RUN');
        expect(result.stdout).toContain('would remove');
        expect(existsSync(join(configDir, 'agents', 'architect.md'))).toBe(true);
        expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
    });
    it('removes OMC entries but leaves third-party hooks and settings intact', () => {
        const { project, configDir } = makeWorkspace('omc-uninstall-run-');
        const settingsPath = seedInstall(configDir);
        const result = runScript(UNINSTALL, ['--yes'], project, configDir);
        expect(result.status).toBe(0);
        expect(existsSync(join(configDir, 'agents', 'architect.md'))).toBe(false);
        expect(existsSync(join(configDir, 'skills', 'git-master'))).toBe(false);
        expect(existsSync(`${settingsPath}.bak`)).toBe(true);
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(settings.model).toBe('opus');
        expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
        expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe('vendor/third-party.sh');
        expect(settings.hooks.Stop).toBeUndefined();
    });
    it('keeps an earlier backup instead of overwriting it', () => {
        const { project, configDir } = makeWorkspace('omc-uninstall-backup-');
        const settingsPath = seedInstall(configDir);
        const existingBackup = `${settingsPath}.bak`;
        writeFileSync(existingBackup, '{"from":"an earlier uninstall"}');
        const result = runScript(UNINSTALL, ['--yes'], project, configDir);
        expect(result.status).toBe(0);
        // The pre-existing backup is the only copy of what settings looked like
        // before that run, so this run must not clobber it.
        expect(readFileSync(existingBackup, 'utf-8')).toBe('{"from":"an earlier uninstall"}');
        const stamped = readdirSync(configDir).filter(name => name.startsWith('settings.json.') && name.endsWith('.bak') && name !== 'settings.json.bak');
        expect(stamped).toHaveLength(1);
        expect(JSON.parse(readFileSync(join(configDir, stamped[0]), 'utf-8')).model).toBe('opus');
    });
    it('refuses to run unattended without --yes', () => {
        const { project, configDir } = makeWorkspace('omc-uninstall-noninteractive-');
        seedInstall(configDir);
        const result = runScript(UNINSTALL, [], project, configDir);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Uninstallation cancelled');
        expect(existsSync(join(configDir, 'agents', 'architect.md'))).toBe(true);
    });
});
describe('omc-setup skill documents the Node entry points', () => {
    const SETUP_DOCS = [
        join(REPO_ROOT, 'skills', 'omc-setup', 'SKILL.md'),
        join(REPO_ROOT, 'skills', 'omc-setup', 'phases', '01-install-claude-md.md'),
        join(REPO_ROOT, 'skills', 'omc-setup', 'phases', '02-configure.md'),
        join(REPO_ROOT, 'skills', 'omc-setup', 'phases', '03-integrations.md'),
        join(REPO_ROOT, 'skills', 'omc-setup', 'phases', '04-welcome.md'),
    ];
    it('never instructs the agent to shell into the bash setup scripts', () => {
        const offenders = SETUP_DOCS.filter(doc => /\bbash\s+"?\$\{?OMC_SETUP_PLUGIN_ROOT/.test(readFileSync(doc, 'utf-8')));
        expect(offenders).toEqual([]);
    });
    it('invokes setup-progress and setup-claude-md through node', () => {
        const skill = readFileSync(SETUP_DOCS[0], 'utf-8');
        expect(skill).toContain('node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-claude-md.mjs"');
        expect(skill).toContain('node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-progress.mjs"');
    });
});
//# sourceMappingURL=setup-lifecycle-node.test.js.map