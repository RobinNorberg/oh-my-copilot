#!/usr/bin/env node
/**
 * Plugin Post-Install Setup
 *
 * Configures HUD statusline when plugin is installed.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCopilotConfigDir } from './lib/config-dir.mjs';
import { buildHudWrapper } from './lib/hud-wrapper-template.mjs';
import { hookPrefixForPlatform, normalizeHooksDataForPlatform } from './lib/hook-command-normalizer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const CLAUDE_DIR = getCopilotConfigDir();
const HUD_DIR = join(CLAUDE_DIR, 'hud');
const HUD_LIB_DIR = join(HUD_DIR, 'lib');
const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');
// Store the absolute node binary path so find-node.sh can resolve Node for
// nvm/fnm users whose non-interactive hook shells do not include node on PATH
// (issue #892).
const nodeBin = process.execPath || 'node';
const isPublishedPluginCache = !existsSync(join(__dirname, '..', '.git'));


console.log('[OMC] Running post-install setup...');


// 1. Create HUD directory
if (!existsSync(HUD_DIR)) {
  mkdirSync(HUD_DIR, { recursive: true });
}

if (!existsSync(HUD_LIB_DIR)) {
  mkdirSync(HUD_LIB_DIR, { recursive: true });
}
copyFileSync(join(__dirname, 'lib', 'config-dir.mjs'), join(HUD_LIB_DIR, 'config-dir.mjs'));
copyFileSync(join(__dirname, 'lib', 'config-dir.sh'), join(HUD_LIB_DIR, 'config-dir.sh'));
copyFileSync(join(__dirname, 'find-node.sh'), join(HUD_DIR, 'find-node.sh'));
copyFileSync(join(__dirname, 'lib', 'hud-cache-wrapper.sh'), join(HUD_DIR, 'omg-hud-cache.sh'));
try { chmodSync(join(HUD_DIR, 'find-node.sh'), 0o755); } catch { /* Windows doesn't need this */ }
try { chmodSync(join(HUD_DIR, 'omg-hud-cache.sh'), 0o755); } catch { /* Windows doesn't need this */ }

// 2. Create HUD wrapper script
const hudScriptPath = join(HUD_DIR, 'omg-hud.mjs').replace(/\\/g, '/');
const hudScript = buildHudWrapper();

writeFileSync(hudScriptPath, hudScript);
try {
  chmodSync(hudScriptPath, 0o755);
} catch { /* Windows doesn't need this */ }
console.log('[OMC] Installed HUD wrapper script');

// 3. Configure settings.json
try {
  let settings = {};
  if (existsSync(SETTINGS_FILE)) {
    settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
  }

  const statusLineCommand = process.platform === 'win32'
    ? `"${nodeBin}" "${hudScriptPath.replace(/\\/g, "/")}"`
    : `sh "${join(HUD_DIR, 'omg-hud-cache.sh').replace(/\\/g, "/")}" "${hudScriptPath.replace(/\\/g, "/")}"`;

  settings.statusLine = {
    type: 'command',
    command: statusLineCommand
  };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  console.log('[OMC] Configured HUD statusLine in settings.json');

  // Persist the node binary path to .omc-config.json for use by find-node.sh
  try {
    const configPath = join(CLAUDE_DIR, '.omc-config.json');
    let omcConfig = {};
    if (existsSync(configPath)) {
      omcConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
    if (nodeBin !== 'node') {
      omcConfig.nodeBinary = nodeBin;
      writeFileSync(configPath, JSON.stringify(omcConfig, null, 2));
      console.log(`[OMC] Saved node binary path: ${nodeBin}`);
    }
  } catch (e) {
    console.log('[OMC] Warning: Could not save node binary path (non-fatal):', e.message);
  }
} catch (e) {
  console.log('[OMC] Warning: Could not configure settings.json:', e.message);
}

// Keep the cached plugin manifest executable by the host that will actually run
// the hooks. Claude Code's plugin loader reads hooks/hooks.json directly, and
// the shipped manifest is the platform-neutral `node -> run.cjs` form, which
// both cmd.exe and POSIX sh resolve identically. The manifest is rewritten only
// when this host genuinely cannot use it: a POSIX box whose non-interactive hook
// PATH has no node (nvm/fnm) gets the find-node.sh bootstrap instead. Leaving
// the neutral form in place everywhere else is what keeps a marketplace update
// — or a config directory shared between WSL/macOS and native Windows — from
// silently killing the whole hook pipeline.
//
// Commands are emitted with the braced "${CLAUDE_PLUGIN_ROOT}" placeholder,
// which the host CLI substitutes itself. The bare "$CLAUDE_PLUGIN_ROOT" spelling
// only expands where a POSIX shell runs the command, so it cannot work behind
// the direct-node Windows prefix (#4042).
//
// Stale manifests still self-heal, whichever form they are in (both the bare
// and braced spellings are accepted on input):
//  1. find-node.sh format – sh "${CLAUDE_PLUGIN_ROOT}"/scripts/find-node.sh ...
//  2. Legacy find-node.sh format – sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" ...
//  3. Direct run.cjs format from the neutral shipped manifest
//  4. Absolute run.cjs format from older setup patches/publish mistakes
//
// Fixes issues #909, #899, #892, #869, #3121, #4042.
try {
  const hooksJsonPath = isPublishedPluginCache ? join(__dirname, '..', 'hooks', 'hooks.json') : null;
  if (hooksJsonPath && existsSync(hooksJsonPath)) {
    const data = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    const prefix = hookPrefixForPlatform();
    const patched = normalizeHooksDataForPlatform(data, process.platform, prefix);

    if (patched) {
      writeFileSync(hooksJsonPath, JSON.stringify(data, null, 2) + '\n');
      const platformLabel = prefix.startsWith('node ') ? 'portable node run.cjs' : 'find-node.sh run.cjs';
      console.log(`[OMC] Patched hooks.json to use ${platformLabel} hook commands`);
    } else {
      console.log('[OMC] hooks.json already uses hook commands this host can run');
    }
  }
} catch (e) {
  console.log('[OMC] Warning: Could not patch hooks.json:', e.message);
}

// 5. Ensure runtime dependencies are installed in the plugin cache directory.
//    The npm-published tarball includes only the files listed in "files" (package.json),
//    which does NOT include node_modules.  When Claude Code extracts the plugin into its
//    cache the dependencies are therefore missing, causing ERR_MODULE_NOT_FOUND at runtime.
//    We detect this by probing for a known production dependency (commander) and running a
//    production-only install when it is absent.  --ignore-scripts avoids re-triggering this
//    very setup script (and any other lifecycle hooks).  Fixes #1113.
const packageDir = join(__dirname, '..');
const commanderCheck = join(packageDir, 'node_modules', 'commander');
const betterSqliteBindingCheck = join(
  packageDir,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);

function probeBetterSqliteBinding() {
  try {
    const loaded = require('better-sqlite3');
    const Database = typeof loaded === 'function' ? loaded : loaded?.default;
    if (typeof Database !== 'function') return false;
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}
if (!existsSync(commanderCheck)) {
  console.log('[OMC] Installing runtime dependencies...');
  try {
    execSync('npm install --omit=dev --ignore-scripts', {
      cwd: packageDir,
      stdio: 'pipe',
      timeout: 60000,
    });
    console.log('[OMC] Runtime dependencies installed successfully');
  } catch (e) {
    console.log('[OMC] Warning: Could not install dependencies:', e.message);
  }
} else {
  console.log('[OMC] Runtime dependencies already present');
}

// better-sqlite3 has a native install script.  The dependency bootstrap above
// intentionally ignores package lifecycle scripts so it cannot recurse into
// this setup entry point; rebuild this one native package explicitly instead.
if (!existsSync(betterSqliteBindingCheck) && isPublishedPluginCache) {
  console.log('[OMC] Building better-sqlite3 native binding...');
  try {
    execSync('npm rebuild better-sqlite3', {
      cwd: packageDir,
      stdio: 'pipe',
      timeout: 60000,
    });
    if (existsSync(betterSqliteBindingCheck)) {
      console.log('[OMC] better-sqlite3 native binding built successfully');
    } else {
      console.log('[OMC] Warning: npm rebuild completed without producing better_sqlite3.node; state mutation will use the file-lock fallback.');
    }
  } catch (e) {
    console.log('[OMC] Warning: Could not build better-sqlite3 native binding:', e.message);
    console.log('[OMC] State mutation will use the file-lock fallback until better-sqlite3 is rebuilt successfully.');
  }
} else if (!existsSync(betterSqliteBindingCheck)) {
  console.log('[OMC] better-sqlite3 native binding is absent in the repository checkout; runtime state mutation will use the file-lock fallback.');
}

const betterSqliteBindingHealthy = probeBetterSqliteBinding();
if (existsSync(betterSqliteBindingCheck) && !betterSqliteBindingHealthy) {
  console.log('[OMC] Warning: better_sqlite3.node exists but could not be loaded; runtime state mutation will use the file-lock fallback until the native binding is rebuilt for this Node runtime.');
}

if (betterSqliteBindingHealthy) {
  console.log('[OMC] Setup complete! Restart Claude Code to activate HUD.');
} else {
  console.log('[OMC] Setup complete with file-lock fallback (better-sqlite3 native binding unavailable). Restart Claude Code to activate HUD.');
}
