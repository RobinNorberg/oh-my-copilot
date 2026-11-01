#!/usr/bin/env node
// setup-config.mjs - config and environment helpers for the omc-setup skill
// Usage: node setup-config.mjs <command> [args]
//
// The setup skill used to carry these as inline `node -e "..."` one-liners. Hosts that
// refuse inline interpreter code (lean-ctx blocks `node -e` by default) then could not
// run setup at all, so every one-liner lives here as a plain script file instead.
//
// Commands:
//   configured                 Was setup already completed? (ALREADY_CONFIGURED=true|false)
//   claude-md-enabled          Print enabled|disabled for the global CLAUDE.md opt-out
//   resume-boundary            Print RESUME_LAST_COMPLETED_STEP and RESUMED_PHASE_TWO_BOUNDARY
//   probe-write                Warn when the config dir is not writable
//   update-check               Print the installed version and whether a newer one is published
//   clear-retired              Remove the retired defaultExecutionMode key
//   cli-installed              Print OMC_CLI_INSTALLED=true|false
//   install-cli                npm install -g oh-my-copilot
//   detect-task-tools          Look for beads (bd) and beads-rust (br)
//   set-task-tool <tool>       Store taskTool in .omc-config.json
//   plugin-verify              Check that settings.json mentions the plugin
//   show-settings              Print settings.json
//   merge-json settings.json <json>  Deep-merge a JSON patch into settings.json in the config dir
//   verify-settings            Check settings.json parses and agent teams are enabled
//   detect-upgrade             Print IS_UPGRADE=true|false (2.x command files present)
//   copy-rules                 Copy templates/rules/*.md into ./.claude/rules
//   star-repo                  Star the repository through gh (silent on failure)

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { getCopilotConfigDir } from './lib/config-dir.mjs';

const CONFIG_DIR = getCopilotConfigDir();
const CONFIG_FILE = join(CONFIG_DIR, '.omc-config.json');
const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');
const WINDOWS = process.platform === 'win32';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const TASK_TOOLS = ['builtin', 'beads', 'beads-rust'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** The child env with every case variant of NoDefaultCurrentDirectoryInExePath replaced by =1. */
function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() !== 'nodefaultcurrentdirectoryinexepath') env[key] = value;
  }
  env.NoDefaultCurrentDirectoryInExePath = '1';
  return env;
}

/**
 * Run a PATH command (npm, omg, bd, br, gh) outside the project. cmd.exe searches the cwd
 * before PATH, so with the project as cwd a planted npm.cmd or gh.cmd there would run instead;
 * the home directory as cwd plus NoDefaultCurrentDirectoryInExePath=1 rules that out. Windows
 * needs cmd.exe for .cmd shims, so it gets one command line (every argument here is a fixed
 * literal) rather than shell:true with an args array (DEP0190).
 */
function run(command, args, options = {}) {
  const base = { encoding: 'utf8', cwd: homedir(), env: childEnv(), ...options };
  return WINDOWS
    ? spawnSync([command, ...args].join(' '), { ...base, shell: true })
    : spawnSync(command, args, base);
}

function firstLine(result) {
  return (result.stdout || '').split(/\r?\n/)[0];
}

/** Parse a JSON file; undefined when it does not exist, throws when it is invalid. */
function readJson(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Write through a fresh temp file and rename it over path, so a failure cannot truncate the
 * original and a symlink or hardlink at path is replaced rather than written through.
 */
function writeAtomic(path, data) {
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, data, { flag: 'wx' });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, JSON.stringify(value, null, 2));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readConfigOrFail(path, label) {
  let value;
  try {
    value = readJson(path);
  } catch {
    return fail(`ERROR: ${label} is not valid JSON. Existing file was not modified.`);
  }
  if (value === undefined) return {};
  if (!isPlainObject(value)) fail(`ERROR: ${label} is not a JSON object. Existing file was not modified.`);
  return value;
}

function cmdConfigured() {
  let config;
  try {
    config = readJson(CONFIG_FILE);
  } catch {
    fail('ERROR: Existing OMC config is invalid JSON. Existing config was not modified.');
  }
  if (config?.setupCompleted) {
    console.log(`OMC setup was already completed on: ${config.setupCompleted}`);
    if (config.setupVersion) console.log(`Setup version: ${config.setupVersion}`);
    console.log('ALREADY_CONFIGURED=true');
  } else {
    console.log('ALREADY_CONFIGURED=false');
  }
}

function cmdClaudeMdEnabled() {
  try {
    console.log(readJson(CONFIG_FILE)?.claudeMdEnabled === false ? 'disabled' : 'enabled');
  } catch {
    console.log('enabled');
  }
}

function cmdResumeBoundary() {
  const stateFile = join('.omg', 'state', 'setup-state.json');
  let state = {};
  try {
    state = readJson(stateFile) ?? {};
  } catch {
    fail('ERROR: Setup state is invalid JSON. Existing setup state was not modified.');
  }
  const step = Number.isFinite(state.lastCompletedStep) ? state.lastCompletedStep : 0;
  console.log(`RESUME_LAST_COMPLETED_STEP=${step}`);
  console.log(`RESUMED_PHASE_TWO_BOUNDARY=${step >= 4}`);
}

function cmdProbeWrite() {
  const probe = join(CONFIG_DIR, '.omc-write-probe');
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
  } catch {
    console.log('WARNING: Config dir is not writable; Ralph state persistence will fail until it is.');
  }
}

function detectInstalledVersion() {
  const cache = join(CONFIG_DIR, 'plugins', 'cache', 'omc', 'oh-my-copilot');
  try {
    const versions = readdirSync(cache)
      .filter((name) => VERSION_PATTERN.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (versions.length > 0) return versions[versions.length - 1];
  } catch {
    // No plugin cache: fall through to the next source.
  }

  try {
    const version = JSON.parse(readFileSync('.omc-version.json', 'utf8')).version;
    if (typeof version === 'string' && VERSION_PATTERN.test(version)) return version;
  } catch {
    // No project version file.
  }

  for (const candidate of [join('.claude', 'CLAUDE.md'), join(CONFIG_DIR, 'CLAUDE.md')]) {
    try {
      const match = readFileSync(candidate, 'utf8').match(/^# oh-my-copilot.*?(v?\d+\.\d+\.\d+)/m);
      if (match) return match[1].replace(/^v/, '');
    } catch {
      // Try the next CLAUDE.md.
    }
  }
  return '';
}

function cmdUpdateCheck() {
  const installed = detectInstalledVersion();
  console.log(`Installed: ${installed || '(not found)'}`);

  const result = run('npm', ['view', 'oh-my-copilot', 'version']);
  const latest = result.status === 0 ? (result.stdout || '').trim() : '';
  if (installed && latest) {
    if (installed === latest) {
      console.log(`You are on the latest version: v${installed}`);
    } else {
      console.log('UPDATE AVAILABLE:');
      console.log(`  Installed: v${installed}`);
      console.log(`  Latest:    v${latest}`);
      console.log('To update, run: claude /install-plugin oh-my-copilot');
    }
  } else if (latest) {
    console.log(`Latest version available: v${latest}`);
  } else {
    console.log('Latest version: (unavailable)');
  }
}

function cmdClearRetired() {
  let config;
  try {
    config = readJson(CONFIG_FILE);
  } catch {
    console.log(`WARNING: ${CONFIG_FILE} is not valid JSON. Existing config was not modified.`);
    return;
  }
  if (!isPlainObject(config) || !('defaultExecutionMode' in config)) return;

  delete config.defaultExecutionMode;
  try {
    writeJsonAtomic(CONFIG_FILE, config);
    console.log('Cleared retired defaultExecutionMode key (ultrawork was removed in 5.0.0)');
  } catch {
    console.log('WARNING: Failed to clear retired defaultExecutionMode. Existing config was not modified.');
  }
}

function cmdCliInstalled() {
  const result = run('omg', ['--version']);
  if (result.status === 0) {
    console.log(`OMC CLI already installed: ${firstLine(result) || 'installed'}`);
    console.log('OMC_CLI_INSTALLED=true');
  } else {
    console.log('OMC_CLI_INSTALLED=false');
  }
}

function cmdInstallCli() {
  if (run('npm', ['--version']).status !== 0) {
    console.log('WARNING: npm not found. Cannot install OMC CLI automatically.');
    console.log('Install Node.js/npm first, then run: npm install -g oh-my-copilot');
    return;
  }
  const install = run('npm', ['install', '-g', 'oh-my-copilot'], { stdio: 'inherit' });
  if (install.status === 0) {
    console.log('OMC CLI installed successfully.');
    const verify = run('omg', ['--version']);
    console.log(verify.status === 0
      ? `Verified: omg ${firstLine(verify) || 'installed'}`
      : "Installed but 'omg' not on PATH. You may need to restart your shell.");
  } else {
    console.log('WARNING: Failed to install OMC CLI (permission issue or network error).');
    console.log('You can install manually later: npm install -g oh-my-copilot');
    console.log('On Linux/macOS you may need: sudo npm install -g oh-my-copilot');
  }
}

function cmdDetectTaskTools() {
  let found = false;
  for (const [command, label] of [['bd', 'beads (bd)'], ['br', 'beads-rust (br)']]) {
    const result = run(command, ['--version']);
    if (result.status === 0) {
      found = true;
      console.log(`Found ${label}: ${firstLine(result) || 'installed'}`);
    }
  }
  if (!found) console.log('No external task tools found. Using built-in Tasks.');
}

function cmdSetTaskTool(tool) {
  if (!TASK_TOOLS.includes(tool)) fail('ERROR: task tool must be builtin, beads, or beads-rust.');
  const config = readConfigOrFail(CONFIG_FILE, CONFIG_FILE);
  config.taskTool = tool;
  config.taskToolConfig = { injectInstructions: true, useMcp: false };
  try {
    writeJsonAtomic(CONFIG_FILE, config);
  } catch {
    fail(`ERROR: Failed to update ${CONFIG_FILE}. Existing config was not modified.`);
  }
  console.log(`Task tool set to: ${tool}`);
}

function readSettingsText() {
  try {
    return readFileSync(SETTINGS_FILE, 'utf8');
  } catch {
    return '';
  }
}

function cmdPluginVerify() {
  console.log(readSettingsText().includes('oh-my-copilot')
    ? 'Plugin verified'
    : 'Plugin NOT found - run: claude /install-plugin oh-my-copilot');
}

function cmdShowSettings() {
  const text = readSettingsText();
  if (text) process.stdout.write(text);
  else console.log(`(no settings.json at ${SETTINGS_FILE})`);
}

function mergeInto(target, patch) {
  for (const key of Object.keys(patch)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const value = patch[key];
    target[key] = isPlainObject(value) ? mergeInto(isPlainObject(target[key]) ? target[key] : {}, value) : value;
  }
  return target;
}

function cmdMergeJson(name, raw) {
  if (!name || raw === undefined) fail('Usage: setup-config.mjs merge-json <file-name> <json-patch>');
  // The skill only ever merges into settings.json; any other name (an ADS suffix, a drive-relative
  // path, a device name, a traversal) is refused before anything is opened.
  if (name !== 'settings.json') fail('ERROR: merge-json only updates settings.json in the config directory.');
  let patch;
  try {
    patch = JSON.parse(raw);
  } catch {
    fail('ERROR: the JSON patch is not valid JSON.');
  }
  if (!isPlainObject(patch)) fail('ERROR: the JSON patch must be an object.');

  const target = join(CONFIG_DIR, name);
  const current = readConfigOrFail(target, target);
  try {
    writeJsonAtomic(target, mergeInto(current, patch));
  } catch {
    fail(`ERROR: Failed to update ${target}. Existing file was not modified.`);
  }
  console.log(`Updated ${target}`);
}

function cmdVerifySettings() {
  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    fail('ERROR: settings.json is invalid JSON or missing. Restore it from the backup before continuing.');
  }
  console.log('settings.json: valid JSON');
  console.log(settings.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    ? 'Agent teams: ENABLED'
    : 'WARNING: Agent teams env var not found in settings.json');
  console.log('');
  console.log('Final settings.json:');
  console.log(JSON.stringify(settings, null, 2));
}

function cmdDetectUpgrade() {
  console.log(`IS_UPGRADE=${existsSync(join(CONFIG_DIR, 'commands', 'ralph-loop.md'))}`);
}

/** Refuse to write through a symlink or junction (lstat reports both as links). */
function refuseLink(path) {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    fail(`ERROR: ${path} is a symlink or junction; refusing to write through it.`);
  }
}

function cmdCopyRules() {
  const root = process.env.OMC_SETUP_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) fail('ERROR: plugin root is not set');
  const source = join(root, 'templates', 'rules');
  const destination = join('.claude', 'rules');
  refuseLink('.claude');
  refuseLink(destination);
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source).filter((file) => file.endsWith('.md'))) {
    const target = join(destination, name);
    refuseLink(target);
    writeAtomic(target, readFileSync(join(source, name)));
    console.log(`Copied ${name}`);
  }
}

function cmdStarRepo() {
  const result = run('gh', ['api', '-X', 'PUT', 'user/starred/RobinNorberg/oh-my-copilot']);
  if (result.status === 0) console.log('Thanks for starring');
}

const [command, ...rest] = process.argv.slice(2);

const commands = {
  configured: cmdConfigured,
  'claude-md-enabled': cmdClaudeMdEnabled,
  'resume-boundary': cmdResumeBoundary,
  'probe-write': cmdProbeWrite,
  'update-check': cmdUpdateCheck,
  'clear-retired': cmdClearRetired,
  'cli-installed': cmdCliInstalled,
  'install-cli': cmdInstallCli,
  'detect-task-tools': cmdDetectTaskTools,
  'set-task-tool': () => cmdSetTaskTool(rest[0]),
  'plugin-verify': cmdPluginVerify,
  'show-settings': cmdShowSettings,
  'merge-json': () => cmdMergeJson(rest[0], rest[1]),
  'verify-settings': cmdVerifySettings,
  'detect-upgrade': cmdDetectUpgrade,
  'copy-rules': cmdCopyRules,
  'star-repo': cmdStarRepo,
};

if (!Object.hasOwn(commands, command ?? '')) {
  fail(`Usage: setup-config.mjs {${Object.keys(commands).join('|')}}`);
}
commands[command]();
