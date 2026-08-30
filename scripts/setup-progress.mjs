#!/usr/bin/env node
// setup-progress.mjs - Save/clear/resume setup progress helpers (no bash, no jq)
// Usage:
//   node setup-progress.mjs save <step_number> [config_type]
//   node setup-progress.mjs clear
//   node setup-progress.mjs resume
//   node setup-progress.mjs complete [version]
//
// Node port of scripts/setup-progress.sh. The shell version hard-required jq and
// GNU/BSD `date`, which no Windows install and no stock macOS install can satisfy.
// `save` and `complete` also resolve their optional argument themselves, so the
// setup skill no longer needs a jq/grep/sed preamble to compute it.

import { spawnSync } from 'node:child_process';
import { constants as fsConstants, copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';

import { atomicWriteFileSync, ensureDirSync } from './lib/atomic-write.mjs';
import { getCopilotConfigDir } from './lib/config-dir.mjs';
import { resolveOmcStateRoot } from './lib/state-root.mjs';

const CONFIG_DIR = getCopilotConfigDir();
const STATE_DIR = join(await resolveOmcStateRoot(process.cwd()), 'state');
const STATE_FILE = join(STATE_DIR, 'setup-state.json');
const CONFIG_FILE = join(CONFIG_DIR, '.omc-config.json');

const STALE_STATE_MS = 24 * 60 * 60 * 1000;
const STALE_SKILL_STATE_MS = 30 * 60 * 1000;
const VERSION_PROBE_TIMEOUT_MS = 3000;
// cmd.exe re-parses the command line, so only a path of this shape is handed to
// it. Mirrors SAFE_BATCH_PATH in src/platform/executable-resolution.ts.
const SAFE_BATCH_PATH = /^[A-Za-z]:\\(?:[A-Za-z0-9 ._-]+\\)*[A-Za-z0-9 ._-]+\.(?:cmd|bat)$/i;
const DEFAULT_COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
// Mirrors SESSION_ID_REGEX in the TypeScript runtime.
const SESSION_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * Carry a pre-unification config into the resolved config directory.
 *
 * The Node surfaces used to resolve ~/.claude while the shell surfaces used
 * ~/.copilot, so an upgraded install can still hold its only .omc-config.json
 * in the old location. Setup is the upgrade path, so recover it here rather
 * than probing two directories on every read. The legacy file is copied, never
 * moved, and only when the current location has nothing to lose.
 */
function adoptLegacyConfigFile() {
  if (process.env.COPILOT_CONFIG_DIR?.trim()) return;
  if (existsSync(CONFIG_FILE)) return;

  const legacy = join(homedir(), '.claude', '.omc-config.json');
  if (legacy === CONFIG_FILE || !existsSync(legacy)) return;

  try {
    ensureDirSync(dirname(CONFIG_FILE));
    // COPYFILE_EXCL makes "never overwrite" the filesystem's guarantee rather
    // than a check that another process can win the race against.
    copyFileSync(legacy, CONFIG_FILE, fsConstants.COPYFILE_EXCL);
    console.log(`Adopted settings from ${legacy}`);
    console.log(`The active config is now ${CONFIG_FILE}; the old file is no longer read.`);
  } catch (error) {
    if (error?.code === 'EEXIST') return;
    console.log(`Note: could not copy ${legacy} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function readJsonFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
  return JSON.parse(raw);
}

/**
 * Replace `path` with `content` without ever truncating the destination first.
 * Delegates to the shared primitive, which creates its temp file with O_EXCL
 * under a random name and fsyncs both the file and its directory — a
 * hand-rolled `path.tmp.<pid>` is both guessable and plantable as a symlink.
 */
function writeJsonAtomic(path, value) {
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Config type recorded by an earlier `save`, so later phases need not recompute it. */
function savedConfigType() {
  try {
    const state = readJsonFile(STATE_FILE);
    if (state && typeof state === 'object' && typeof state.configType === 'string' && state.configType) {
      return state.configType;
    }
  } catch {
    // A corrupt state file simply carries no usable config type.
  }
  return 'unknown';
}

function cmdSave(step, configType) {
  const parsed = Number(step);
  if (!Number.isInteger(parsed)) {
    fail(`ERROR: step number must be an integer, got '${step}'.`);
  }
  const resolved = configType ?? savedConfigType();
  writeJsonAtomic(STATE_FILE, {
    lastCompletedStep: parsed,
    timestamp: new Date().toISOString(),
    configType: resolved,
  });
  console.log(`Progress saved: step ${parsed} (${resolved})`);
}

function cmdClear() {
  rmSync(STATE_FILE, { force: true });
  console.log('Setup state cleared.');
}

function cmdResume() {
  let state;
  try {
    state = readJsonFile(STATE_FILE);
  } catch {
    fail('ERROR: Setup state is invalid JSON. Existing setup state was not modified.');
  }
  if (state === undefined) {
    console.log('fresh');
    return;
  }
  if (state === null || typeof state !== 'object') {
    fail('ERROR: Setup state is invalid JSON. Existing setup state was not modified.');
  }

  const timestamp = typeof state.timestamp === 'string' ? state.timestamp : '';
  const parsedAt = timestamp ? Date.parse(timestamp) : Number.NaN;
  // An absent or unparseable timestamp forces a fresh start, matching the shell.
  const age = Number.isNaN(parsedAt) ? Number.POSITIVE_INFINITY : Date.now() - parsedAt;

  if (age > STALE_STATE_MS) {
    console.log('Previous setup state is more than 24 hours old. Starting fresh.');
    rmSync(STATE_FILE, { force: true });
    console.log('fresh');
    return;
  }

  const lastStep = Number.isFinite(state.lastCompletedStep) ? state.lastCompletedStep : 0;
  const configType = typeof state.configType === 'string' ? state.configType : 'unknown';
  console.log(
    `Found previous setup session (Step ${lastStep} completed at ${timestamp}, configType=${configType})`,
  );
  console.log(String(lastStep));
}

function pruneStaleSkillState(dir, cutoff) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      pruneStaleSkillState(path, cutoff);
      continue;
    }
    if (entry.name !== 'skill-active-state.json') continue;
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // A file that vanished under us needs no pruning.
    }
  }
}

function clearSkillActiveState() {
  // Nested skill invocations (e.g. mcp-setup inside omc-setup) leave a
  // skill-active-state file behind; the stop hook then blocks with "skill still
  // executing" even though setup has finished.
  const sessionId = process.env.CLAUDE_SESSION_ID || process.env.CLAUDECODE_SESSION_ID || '';
  if (sessionId) {
    if (SESSION_ID_REGEX.test(sessionId)) {
      rmSync(join(STATE_DIR, 'sessions', sessionId, 'skill-active-state.json'), { force: true });
    }
    return;
  }
  pruneStaleSkillState(STATE_DIR, Date.now() - STALE_SKILL_STATE_MS);
}

function versionFromClaudeMd(path) {
  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
  return content.match(/OMC:VERSION:(\S+)/)?.[1] ?? '';
}

/**
 * Absolute path of `omc` on PATH, or '' when it is not installed.
 *
 * Resolved by walking PATH rather than by asking a shell or `where.exe`: both
 * of those search the current directory first, so running setup inside a cloned
 * repository that happens to contain an `omc.cmd` would execute it. Relative
 * PATH entries are skipped for the same reason.
 */
function resolveOmcBinary() {
  const isWindows = process.platform === 'win32';
  const entries = (process.env.PATH ?? '').split(isWindows ? ';' : ':');
  const extensions = isWindows
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const entry of entries) {
    const dir = entry.trim().replace(/^"|"$/g, '');
    if (!dir || !isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `omc${extension}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not present in this directory; keep looking.
      }
    }
  }
  return '';
}

/** `omc --version`, run from an absolute path and never through a shell. */
function probeOmcVersion(binary) {
  const isBatch = /\.(cmd|bat)$/i.test(binary);
  // A .cmd shim cannot be started directly, so it goes through cmd.exe — but
  // only when the path fits a closed grammar, since cmd.exe re-parses it.
  if (isBatch && !SAFE_BATCH_PATH.test(binary)) return '';

  const run = isBatch
    ? spawnSync(process.env.ComSpec || DEFAULT_COMSPEC, ['/d', '/s', '/c', `"${binary}" --version`], {
      encoding: 'utf-8',
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
    : spawnSync(binary, ['--version'], {
      encoding: 'utf-8',
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });

  return run.status === 0 ? (run.stdout ?? '').split(/\r?\n/)[0].trim() : '';
}

/** Installed OMC version: the CLAUDE.md marker first, then the `omc` CLI. */
function resolveOmcVersion() {
  const localMarker = versionFromClaudeMd(join(process.cwd(), '.claude', 'CLAUDE.md'));
  if (localMarker) return localMarker;
  const globalMarker = versionFromClaudeMd(join(CONFIG_DIR, 'CLAUDE.md'));
  if (globalMarker) return globalMarker;

  const binary = resolveOmcBinary();
  return (binary && probeOmcVersion(binary)) || 'unknown';
}

function cmdComplete(version) {
  rmSync(STATE_FILE, { force: true });
  clearSkillActiveState();
  adoptLegacyConfigFile();

  let existing = {};
  try {
    const parsed = readJsonFile(CONFIG_FILE);
    if (parsed !== undefined) {
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(`ERROR: ${CONFIG_FILE} is not a JSON object. Existing config was not modified.`);
      }
      existing = parsed;
    }
  } catch {
    fail(`ERROR: ${CONFIG_FILE} is invalid JSON. Existing config was not modified.`);
  }

  writeJsonAtomic(CONFIG_FILE, {
    ...existing,
    setupCompleted: new Date().toISOString(),
    setupVersion: version,
  });

  console.log('Setup completed successfully!');
  console.log('Note: Future updates will only refresh CLAUDE.md, not the full setup wizard.');
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'save': {
    if (rest[0] === undefined) fail('ERROR: step number required.');
    cmdSave(rest[0], rest[1]);
    break;
  }
  case 'clear':
    cmdClear();
    break;
  case 'resume':
    cmdResume();
    break;
  case 'complete':
    cmdComplete(rest[0] ?? resolveOmcVersion());
    break;
  default:
    fail('Usage: setup-progress.mjs {save <step> [config_type]|clear|resume|complete [version]}');
}
