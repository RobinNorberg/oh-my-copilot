#!/usr/bin/env node
// setup-claude-md.mjs - install CLAUDE.md through the plugin-local coordinator
// Usage: node setup-claude-md.mjs <local|global> [overwrite|preserve]
//
// Node port of scripts/setup-claude-md.sh. The shell version needs bash, jq and a
// POSIX toolchain; this one needs only the Node that already runs the coordinator,
// so setup works identically on Windows without Git Bash.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { getCopilotConfigDir } from './lib/config-dir.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PLUGIN_ROOT = resolve(SCRIPT_DIR, '..');
const MAX_REEXEC_DEPTH = 2;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]+)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]+))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const GIT_EXCLUDE_BLOCK = [
  '# BEGIN OMC local artifacts',
  '!.omg/',
  '.omg/*',
  '!.omg/skills/',
  '!.omg/skills/**',
  '.omx/',
  '# END OMC local artifacts',
  '',
].join('\n');

const LEGACY_HOOK_FILES = [
  'keyword-detector.sh',
  'stop-continuation.sh',
  'persistent-mode.sh',
  'session-start.sh',
];

const LEGACY_HOOK_COMMAND = /(^|[^a-zA-Z0-9_-])(keyword-detector|stop-continuation|persistent-mode|session-start)(\.(sh|mjs|cjs|js))?([^a-zA-Z0-9_-]|$)/;

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function isNonEmptyFile(path) {
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// A candidate root is usable only when it carries the complete coordinator
// handshake surface plus real skill content; setup must never fall back to
// hand-merging a partial checkout.
function isValidPluginRoot(candidate) {
  return (
    isDirectory(candidate)
    && existsSync(join(candidate, 'scripts', 'setup-claude-md.mjs'))
    && existsSync(join(candidate, 'scripts', 'lib', 'config-dir.mjs'))
    && existsSync(join(candidate, 'docs', 'CLAUDE.md'))
    && existsSync(join(candidate, 'bridge', 'claude-md-coordinator.cjs'))
    && isNonEmptyFile(join(candidate, 'skills', 'wiki', 'SKILL.md'))
  );
}

function parseSemver(value) {
  const match = value.match(SEMVER);
  if (!match) return null;
  const pre = match[4]?.split('.') ?? [];
  // Reject numeric prerelease identifiers with leading zeros.
  if (pre.some(id => /^\d+$/.test(id) && !/^(0|[1-9]\d*)$/.test(id))) return null;
  return { value, core: match.slice(1, 4).map(Number), pre };
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (!left.pre.length || !right.pre.length) {
    return left.pre.length ? -1 : right.pre.length ? 1 : 0;
  }
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    if (left.pre[index] === undefined) return -1;
    if (right.pre[index] === undefined) return 1;
    if (left.pre[index] === right.pre[index]) continue;
    const numericLeft = /^\d+$/.test(left.pre[index]);
    const numericRight = /^\d+$/.test(right.pre[index]);
    if (numericLeft && numericRight) return Number(left.pre[index]) - Number(right.pre[index]);
    if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
    return left.pre[index] < right.pre[index] ? -1 : 1;
  }
  return 0;
}

function selectLatestSemver(values) {
  const parsed = values.map(parseSemver).filter(Boolean);
  parsed.sort(compareSemver);
  return parsed.at(-1)?.value ?? '';
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

function activeInstallPath(installedPluginsPath) {
  const json = readJson(installedPluginsPath);
  if (!json || typeof json !== 'object') return '';
  const plugins = json.plugins && typeof json.plugins === 'object' ? json.plugins : json;
  for (const [key, value] of Object.entries(plugins)) {
    if (!key.startsWith('oh-my-copilot')) continue;
    const installPath = Array.isArray(value) ? value[0]?.installPath : undefined;
    if (typeof installPath === 'string' && installPath) return installPath;
  }
  return '';
}

// Resolve the current cached plugin rather than trusting a root captured when
// the host CLI started.
function resolveActivePluginRoot() {
  const cacheBase = dirname(SCRIPT_PLUGIN_ROOT);
  let entries = [];
  try {
    entries = readdirSync(cacheBase);
  } catch {
    entries = [];
  }
  const latest = selectLatestSemver(entries.filter(entry => isValidPluginRoot(join(cacheBase, entry))));

  const installPath = activeInstallPath(join(getCopilotConfigDir(), 'plugins', 'installed_plugins.json'));
  if (installPath && isValidPluginRoot(installPath)) {
    const newest = selectLatestSemver([basename(installPath), latest].filter(Boolean));
    return latest && newest === latest ? join(cacheBase, latest) : installPath;
  }

  if (latest) return join(cacheBase, latest);
  if (isValidPluginRoot(SCRIPT_PLUGIN_ROOT)) return SCRIPT_PLUGIN_ROOT;
  return '';
}

function normalizePluginRoot(root) {
  try {
    return realpathSync.native(root);
  } catch {
    return resolve(root);
  }
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf-8', ...options });
}

function requestHandshake(coordinator, canonicalClaudeMd) {
  const handshakeRun = runNode([coordinator, '--handshake']);
  if (handshakeRun.status !== 0) {
    fail('ERROR: Coordinator handshake is unavailable; refusing setup.', handshakeRun.status ?? 1);
  }

  // Independently hashing the canonical source binds the coordinator's authority
  // to the exact bytes this invocation will request.
  let handshake;
  try {
    handshake = JSON.parse(handshakeRun.stdout);
  } catch {
    fail('ERROR: Coordinator handshake validation failed; refusing setup.');
  }
  const valid = handshake
    && typeof handshake === 'object'
    && handshake.schemaVersion === 1
    && typeof handshake.engineVersion === 'string'
    && handshake.engineVersion
    && typeof handshake.sourceSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(handshake.sourceSha256);
  if (!valid) {
    fail('ERROR: Coordinator handshake validation failed; refusing setup.');
  }

  const sourceSha256 = createHash('sha256').update(readFileSync(canonicalClaudeMd)).digest('hex');
  if (sourceSha256 !== handshake.sourceSha256) {
    fail('ERROR: Coordinator handshake validation failed; refusing setup.');
  }
  return { engineVersion: handshake.engineVersion, sourceSha256 };
}

function runCoordinator(coordinator, request) {
  const run = runNode([coordinator], { input: JSON.stringify(request) });
  const exitCode = run.status ?? 1;

  let response;
  try {
    response = JSON.parse(run.stdout);
  } catch {
    fail('ERROR: malformed coordinator response, ok/exit disagreement, or exit-code mismatch');
  }
  if (
    !response
    || typeof response !== 'object'
    || typeof response.ok !== 'boolean'
    || response.exitCode !== exitCode
    || response.ok !== (exitCode === 0)
  ) {
    fail('ERROR: malformed coordinator response, ok/exit disagreement, or exit-code mismatch');
  }

  const print = (label, values) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      console.log(`${label}: ${typeof value === 'string' ? value : value.path}`);
    }
  };
  print('Coordinator backup', response.backups);
  print('Coordinator mutated path', response.mutatedPaths);

  if (!response.ok) {
    process.stderr.write(`Coordinator failure: ${response.error || 'unspecified failure'}\n`);
    if (response.failedPath) process.stderr.write(`Coordinator failure path: ${response.failedPath}\n`);
    if (Array.isArray(response.rollback)) {
      for (const item of response.rollback) {
        const state = item.ok ? 'restored' : `failed: ${item.error || 'unspecified failure'}`;
        process.stderr.write(`Coordinator rollback path: ${item.path} (${state})\n`);
      }
    }
    process.exit(1);
  }
}

function installReferenceSkill(source, target) {
  if (!isNonEmptyFile(source)) {
    console.log('Skipped wiki skill install (canonical skill source unavailable)');
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`Installed wiki skill to ${target}`);
}

function ensureLocalOmcGitExclude() {
  const gitPath = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf-8' });
  if (gitPath.status !== 0 || !gitPath.stdout?.trim()) {
    console.log('Skipped OMC git exclude setup (not a git repository)');
    return;
  }
  const excludePath = resolve(process.cwd(), gitPath.stdout.trim());
  mkdirSync(dirname(excludePath), { recursive: true });

  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
  if (existing.includes('# BEGIN OMC local artifacts')) {
    if (existing.split(/\r?\n/).includes('.omx/')) {
      console.log('OMC git exclude already configured');
      return;
    }
    appendFileSync(excludePath, `${existing.length > 0 ? '\n' : ''}.omx/\n`);
    console.log('Updated OMC git exclude for local OMX artifacts');
    return;
  }

  appendFileSync(excludePath, `${existing.length > 0 ? '\n' : ''}${GIT_EXCLUDE_BLOCK}`);
  console.log('Configured git exclude for local OMC/OMX artifacts (preserving .omg/skills/)');
}

function hasLegacyHookCommand(value) {
  if (Array.isArray(value)) return value.some(hasLegacyHookCommand);
  if (!value || typeof value !== 'object') return false;
  if (typeof value.command === 'string' && LEGACY_HOOK_COMMAND.test(value.command)) return true;
  return Object.values(value).some(hasLegacyHookCommand);
}

function reportLegacyGlobalHooks(configDir) {
  for (const hook of LEGACY_HOOK_FILES) {
    const hookPath = join(configDir, 'hooks', hook);
    if (existsSync(hookPath)) {
      console.log(
        `NOTE: Preserved unverified legacy hook at ${hookPath}; only coordinator-verified configuration is mutated.`,
      );
    }
  }
  const settingsFile = join(configDir, 'settings.json');
  const settings = readJson(settingsFile);
  if (settings && hasLegacyHookCommand(settings)) {
    console.log(
      `NOTE: Found legacy OMC hook entries in settings.json. Remove only the legacy OMC hook entries from ${settingsFile}; third-party hook entries can remain.`,
    );
  }
}

const [mode, installStyleArg] = process.argv.slice(2);
const installStyle = installStyleArg ?? 'overwrite';

if (mode !== 'local' && mode !== 'global') {
  fail(`ERROR: Invalid mode '${mode ?? ''}'. Use 'local' or 'global'.`);
}
if (installStyle !== 'overwrite' && installStyle !== 'preserve') {
  fail(`ERROR: Invalid install style '${installStyle}'. Use 'overwrite' or 'preserve'.`);
}

let activePluginRoot = resolveActivePluginRoot();
if (!activePluginRoot) {
  fail('ERROR: Active plugin root lacks the required coordinator artifact and canonical source; refusing setup.');
}

if (normalizePluginRoot(activePluginRoot) === normalizePluginRoot(SCRIPT_PLUGIN_ROOT)) {
  // Same physical plugin root: keep executing here. Re-exec'ing on a path-shape
  // mismatch is what turned a Windows-style installPath into a process chain.
  activePluginRoot = SCRIPT_PLUGIN_ROOT;
} else {
  const depth = Number(process.env.OMC_SETUP_REEXEC_DEPTH ?? 0) + 1;
  if (!Number.isFinite(depth) || depth > MAX_REEXEC_DEPTH) {
    fail(`ERROR: setup re-exec loop detected (depth ${depth}); refusing to continue.`);
  }
  const reexec = runNode(
    [join(activePluginRoot, 'scripts', 'setup-claude-md.mjs'), mode, installStyle],
    { stdio: 'inherit', env: { ...process.env, OMC_SETUP_REEXEC_DEPTH: String(depth) } },
  );
  process.exit(reexec.status ?? 1);
}

const coordinator = join(activePluginRoot, 'bridge', 'claude-md-coordinator.cjs');
const canonicalClaudeMd = join(activePluginRoot, 'docs', 'CLAUDE.md');
const canonicalReferenceSkill = join(activePluginRoot, 'skills', 'wiki', 'SKILL.md');
if (!existsSync(coordinator) || !existsSync(canonicalClaudeMd) || !isNonEmptyFile(canonicalReferenceSkill)) {
  fail('ERROR: Coordinator artifact or canonical source is unavailable; refusing setup.');
}

const configDir = getCopilotConfigDir();
const configRoot = mode === 'local' ? join(process.cwd(), '.claude') : configDir;
const skillTargetPath = join(configRoot, 'skills', 'wiki', 'SKILL.md');
const coordinatorMode = mode === 'local'
  ? 'local'
  : installStyle === 'preserve'
    ? 'global-preserve'
    : 'global-overwrite';

const handshake = requestHandshake(coordinator, canonicalClaudeMd);
mkdirSync(configRoot, { recursive: true });

runCoordinator(coordinator, {
  schemaVersion: 1,
  engineVersion: handshake.engineVersion,
  mode: coordinatorMode,
  configRoot,
  pluginRoot: activePluginRoot,
  sourcePath: canonicalClaudeMd,
  sourceSha256: handshake.sourceSha256,
  sourceVersion: handshake.engineVersion,
});

installReferenceSkill(canonicalReferenceSkill, skillTargetPath);
if (mode === 'local') ensureLocalOmcGitExclude();
if (mode === 'global') reportLegacyGlobalHooks(configDir);

const settingsFile = join(configDir, 'settings.json');
if (existsSync(settingsFile) && readFileSync(settingsFile, 'utf-8').includes('oh-my-copilot')) {
  console.log('Plugin verified');
} else {
  console.log('Plugin NOT found - run: claude /install-plugin oh-my-copilot');
}
