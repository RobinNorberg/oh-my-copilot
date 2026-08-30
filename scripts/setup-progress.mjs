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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { getCopilotConfigDir } from './lib/config-dir.mjs';
import { resolveOmcStateRoot } from './lib/state-root.mjs';

const CONFIG_DIR = getCopilotConfigDir();
const STATE_DIR = join(await resolveOmcStateRoot(process.cwd()), 'state');
const STATE_FILE = join(STATE_DIR, 'setup-state.json');
const CONFIG_FILE = join(CONFIG_DIR, '.omc-config.json');

const STALE_STATE_MS = 24 * 60 * 60 * 1000;
const STALE_SKILL_STATE_MS = 30 * 60 * 1000;
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
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    copyFileSync(legacy, CONFIG_FILE);
    console.log(`Adopted settings from ${legacy}`);
    console.log(`The active config is now ${CONFIG_FILE}; the old file is no longer read.`);
  } catch (error) {
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

/** Replace `path` with `content` without ever truncating the destination first. */
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
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

/** Installed OMC version: the CLAUDE.md marker first, then the `omc` CLI. */
function resolveOmcVersion() {
  const localMarker = versionFromClaudeMd(join(process.cwd(), '.claude', 'CLAUDE.md'));
  if (localMarker) return localMarker;
  const globalMarker = versionFromClaudeMd(join(CONFIG_DIR, 'CLAUDE.md'));
  if (globalMarker) return globalMarker;

  // Windows installs `omc` as a .cmd shim, which only a shell lookup resolves.
  const run = spawnSync('omc', ['--version'], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  const reported = run.status === 0 ? (run.stdout ?? '').split(/\r?\n/)[0].trim() : '';
  return reported || 'unknown';
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
