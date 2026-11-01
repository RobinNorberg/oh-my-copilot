'use strict';
/**
 * Windows executable search hardening (CJS hook/script runtime).
 *
 * Without NoDefaultCurrentDirectoryInExePath, Windows looks up a bare command
 * name (`git`, `npm`) in the current directory before PATH, so an executable
 * planted in the project folder runs. Entry points call
 * hardenWindowsExeSearch() first; explicit child envs go through childEnv().
 *
 * Multi-surface mirrors (keep in sync):
 *   src/utils/windows-search.ts      — TypeScript runtime (source of truth)
 *   scripts/lib/windows-search.mjs   — ESM re-export of this file
 */

const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';

function isVariable(key) {
  return key.toUpperCase() === VARIABLE.toUpperCase();
}

function hardenWindowsExeSearch() {
  if (process.platform !== 'win32') return;
  for (const key of Object.keys(process.env)) {
    if (isVariable(key)) delete process.env[key];
  }
  process.env[VARIABLE] = '1';
}

function childEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (process.platform !== 'win32' || !isVariable(key)) out[key] = value;
  }
  if (process.platform === 'win32') out[VARIABLE] = '1';
  return out;
}

module.exports = { hardenWindowsExeSearch, childEnv };
