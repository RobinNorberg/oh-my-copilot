#!/usr/bin/env node
// Oh-My-Copilot Uninstaller (Node port of scripts/uninstall.sh)
// Removes OMC-installed files and hook configuration from the host CLI config dir.
//
// Usage:
//   node scripts/uninstall.mjs            interactive confirmation on a TTY
//   node scripts/uninstall.mjs --yes      no prompt
//   node scripts/uninstall.mjs --dry-run  report every action, change nothing

import { createInterface } from 'node:readline/promises';
import { constants as fsConstants, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { atomicWriteFileSync } from './lib/atomic-write.mjs';
import { getCopilotConfigDir } from './lib/config-dir.mjs';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || args.includes('-n');
const ASSUME_YES = args.includes('--yes') || args.includes('-y');

const unknown = args.filter(arg => !['--dry-run', '-n', '--yes', '-y'].includes(arg));
if (unknown.length > 0) {
  process.stderr.write(`Unknown argument(s): ${unknown.join(' ')}\n`);
  process.stderr.write('Usage: node scripts/uninstall.mjs [--dry-run] [--yes]\n');
  process.exit(1);
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const blue = text => paint('0;34', text);
const green = text => paint('0;32', text);
const yellow = text => paint('1;33', text);

const CONFIG_DIR = getCopilotConfigDir();

const AGENTS = [
  'architect.md',
  'document-specialist.md',
  'explore.md',
  'designer.md',
  'writer.md',
  'vision.md',
  'critic.md',
  'analyst.md',
  'executor.md',
  'planner.md',
];

const COMMANDS = [
  'coordinator.md',
  'omc.md',
  'ultrawork.md',
  'deepsearch.md',
  'analyze.md',
  'plan.md',
  'review.md',
  'planner.md',
  'orchestrator.md',
  'update.md',
];

const SKILL_DIRS = ['ultrawork', 'git-master', 'frontend-ui-ux'];

const HOOKS = ['keyword-detector.sh', 'stop-continuation.sh', 'silent-auto-update.sh'];

const STATE_FILES = [
  '.omc-version.json',
  '.omc-silent-update.json',
  '.omc-update.log',
  '.omc-config.json',
];

const LEGACY_HOOK_COMMANDS = ['keyword-detector.sh', 'silent-auto-update.sh', 'stop-continuation.sh'];

function remove(path, { recursive = false } = {}) {
  if (!existsSync(path)) return;
  if (DRY_RUN) {
    console.log(`  would remove ${path}`);
    return;
  }
  rmSync(path, { force: true, recursive });
}

/**
 * Backup path that does not collide with an existing one. `.bak` is used when
 * free; otherwise the run stamps its own copy so a previous uninstall's backup
 * survives.
 */
function backupPathFor(settingsFile) {
  const plain = `${settingsFile}.bak`;
  if (!existsSync(plain)) return plain;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = `${settingsFile}.${stamp}.bak`;
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = `${settingsFile}.${stamp}-${counter}.bak`;
    counter += 1;
  }
  return candidate;
}

/** Strip OMC hook entries from one settings.json hook event array. */
function stripEventHooks(groups) {
  if (!Array.isArray(groups)) return { groups, changed: false };
  let changed = false;
  const kept = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const hooks = group.hooks.filter(hook => {
      const command = typeof hook?.command === 'string' ? hook.command : '';
      const isOmc = LEGACY_HOOK_COMMANDS.some(name => command.includes(name));
      if (isOmc) changed = true;
      return !isOmc;
    });
    if (hooks.length === 0) {
      changed = true;
      continue;
    }
    kept.push({ ...group, hooks });
  }
  return { groups: kept, changed };
}

function cleanSettings(settingsFile) {
  if (!existsSync(settingsFile)) return;

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
  } catch {
    console.log(yellow('⚠ Could not modify settings.json automatically (invalid JSON)'));
    console.log("  Please manually remove OMC hooks from the 'hooks' section");
    return;
  }
  if (!settings || typeof settings !== 'object' || !settings.hooks || typeof settings.hooks !== 'object') {
    return;
  }

  console.log(blue('Removing hook configurations from settings.json...'));

  let changed = false;
  const hooks = { ...settings.hooks };
  for (const event of ['UserPromptSubmit', 'Stop']) {
    if (!(event in hooks)) continue;
    const result = stripEventHooks(hooks[event]);
    if (!result.changed) continue;
    changed = true;
    if (Array.isArray(result.groups) && result.groups.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = result.groups;
    }
  }

  if (!changed) {
    console.log('  No OMC hook entries found in settings.json');
    return;
  }

  const next = { ...settings };
  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = hooks;
  }

  const backup = backupPathFor(settingsFile);
  if (DRY_RUN) {
    console.log(`  would back up ${settingsFile} to ${backup}`);
    console.log(`  would remove OMC hook entries from ${settingsFile}`);
    return;
  }

  try {
    // COPYFILE_EXCL: an earlier uninstall's backup is the only copy of settings
    // from before that run, so it must never be overwritten by this one.
    copyFileSync(settingsFile, backup, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    console.log(yellow('⚠ Could not write a backup; settings.json was left unchanged'));
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    // The shared primitive creates its temp file with O_EXCL under a random
    // name and fsyncs it, so neither a planted symlink nor a crash mid-write
    // can damage the user's settings.
    atomicWriteFileSync(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    console.log(yellow('⚠ Could not modify settings.json automatically'));
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    console.log("  Please manually remove OMC hooks from the 'hooks' section");
    return;
  }
  console.log(green('✓ Removed OMC hooks from settings.json'));
  console.log(yellow(`  Backup saved to: ${backup}`));
}

async function confirm() {
  if (ASSUME_YES || DRY_RUN) return true;
  if (!process.stdin.isTTY) {
    console.log('Non-interactive mode detected or terminal not available. Uninstallation cancelled.');
    console.log('Re-run with --yes to confirm, or --dry-run to preview.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const reply = await rl.question('Continue? (y/N) ');
    return /^y/i.test(reply.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  console.log(blue('Oh-My-Copilot Uninstaller'));
  console.log('');
  if (DRY_RUN) {
    console.log(yellow('DRY RUN - no files will be changed.'));
    console.log('');
  }

  console.log('This will remove ALL OMC components from:');
  console.log(`  ${CONFIG_DIR}`);
  console.log('');
  console.log('Components to be removed:');
  console.log('  - Agents (architect, document-specialist, explore, etc. + legacy aliases)');
  console.log('  - Commands (omc, plan, etc. + retired legacy commands)');
  console.log('  - Skills (git-master, frontend-ui-ux, etc. + retired legacy skills)');
  console.log('  - Hooks (keyword-detector, silent-auto-update, stop-continuation)');
  console.log('  - Version and state files');
  console.log('  - Hook configurations from settings.json');
  console.log('');

  if (!(await confirm())) {
    console.log('Cancelled.');
    process.exit(0);
  }

  console.log(blue('Removing agents...'));
  for (const agent of AGENTS) remove(join(CONFIG_DIR, 'agents', agent));

  console.log(blue('Removing commands...'));
  for (const command of COMMANDS) remove(join(CONFIG_DIR, 'commands', command));

  console.log(blue('Removing skills...'));
  for (const skill of SKILL_DIRS) remove(join(CONFIG_DIR, 'skills', skill), { recursive: true });

  console.log(blue('Removing hooks...'));
  for (const hook of HOOKS) remove(join(CONFIG_DIR, 'hooks', hook));

  console.log(blue('Removing state and config files...'));
  for (const file of STATE_FILES) remove(join(CONFIG_DIR, file));

  cleanSettings(join(CONFIG_DIR, 'settings.json'));

  if (existsSync(join(process.cwd(), '.omg'))) {
    console.log(yellow('Note: .omg directory (plans/notepads) was not removed.'));
    console.log('  To remove project plans and notepads, delete the .omg directory in your project.');
  }

  console.log('');
  console.log(green(DRY_RUN ? 'Dry run complete - nothing was changed.' : 'Uninstallation complete!'));
  console.log('');
  console.log(yellow('Items NOT removed (manual cleanup if desired):'));
  console.log(`  - CLAUDE.md: ${join(CONFIG_DIR, 'CLAUDE.md')}`);
  console.log(`  - settings.json backups: ${join(CONFIG_DIR, 'settings.json*.bak')}`);
  console.log('');
  console.log('To verify complete removal, inspect:');
  console.log(`  ${CONFIG_DIR}`);
}

main().catch(error => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
