/**
 * OMC configuration directory resolution (CJS bridge runtime).
 *
 * Honours COPILOT_CONFIG_DIR (absolute, or ~-prefixed) and falls back to
 * ~/.copilot, the host CLI's config directory.
 *
 * Multi-surface mirrors (keep in sync):
 *   src/utils/config-dir.ts      — TypeScript runtime (source of truth)
 *   scripts/lib/config-dir.mjs   — ESM hook/HUD runtime
 *   scripts/lib/config-dir.sh    — POSIX shell runtime
 */

const { homedir } = require('node:os');
const { join, normalize, parse, sep } = require('node:path');

function stripTrailingSep(p) {
  if (!p.endsWith(sep)) {
    return p;
  }

  return p === parse(p).root ? p : p.slice(0, -1);
}

function getCopilotConfigDir() {
  const home = homedir();
  const configured = process.env.COPILOT_CONFIG_DIR?.trim();

  if (!configured) {
    return stripTrailingSep(normalize(join(home, '.copilot')));
  }

  if (configured === '~') {
    return stripTrailingSep(normalize(home));
  }

  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return stripTrailingSep(normalize(join(home, configured.slice(2))));
  }

  return stripTrailingSep(normalize(configured));
}

function getOmcConfigDir() {
  return join(getCopilotConfigDir(), '.omg');
}

function getUpdateCheckCachePath() {
  return join(getOmcConfigDir(), 'update-check.json');
}

module.exports = { getCopilotConfigDir, getOmcConfigDir, getUpdateCheckCachePath };
