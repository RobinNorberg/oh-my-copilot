import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The hook helper modules exist twice: `scripts/lib/` for the plugin hooks and
 * `templates/hooks/lib/` for standalone installs, which the installer copies
 * verbatim into `~/.claude/hooks/lib/`. Nothing enforced that the two copies
 * agreed, and a fix landed in one of them only: #765/#766 reduced readStdin's
 * default from 5s to 2s because 5s outlived the 3s external hook budget, but
 * `scripts/lib/stdin.mjs` kept the old default, so every plugin hook still
 * waited past the timeout that kills it.
 *
 * Byte equality is the contract, not a proxy for one: the installer ships the
 * template copy as-is, so anything that differs between the copies is a
 * difference between plugin installs and standalone installs.
 */
const root = process.cwd();
const pluginLib = join(root, 'scripts', 'lib');
const templateLib = join(root, 'templates', 'hooks', 'lib');

/**
 * `state-lock.mjs` is deliberately different: the template ships a fail-closed
 * stub and the installer provisions the real, package-root-pinned bridge
 * (provisionStandaloneStateLockBridge). Everything else must match.
 */
const DELIBERATELY_DIFFERENT = new Set(['state-lock.mjs', 'workflow-stage-prompts.mjs']);

// fork: scripts/build-workflow-stage-prompts.mjs writes the plugin copy with the
// host-aware skillSlash import (namespaced on Claude Code, bare on Copilot CLI)
// and the template copy with bare slashes, since standalone installs register
// skills by their bare name and ship no skill-slash.mjs/hook-host.mjs.
const SKILL_SLASH_IMPORT = "import { skillSlash } from './skill-slash.mjs';\n";
const BARE_SKILL_SLASH = 'const skillSlash = (name) => `/${name}`;\n';

function sharedHelperFiles(): string[] {
  return readdirSync(templateLib)
    .filter((name) => name.endsWith('.mjs') && !DELIBERATELY_DIFFERENT.has(name))
    .sort();
}

describe('hook helper copies stay in sync', () => {
  it('has a helper file in scripts/lib for every template helper', () => {
    expect(sharedHelperFiles().length).toBeGreaterThan(0);
    for (const name of sharedHelperFiles()) {
      expect(() => readFileSync(join(pluginLib, name), 'utf8'), `scripts/lib/${name}`).not.toThrow();
    }
  });

  it.each(sharedHelperFiles())('%s is byte-identical in both copies', (name) => {
    const plugin = readFileSync(join(pluginLib, name), 'utf8');
    const template = readFileSync(join(templateLib, name), 'utf8');
    expect(template, `${name} drifted; copy scripts/lib/${name} over templates/hooks/lib/${name}`).toBe(plugin);
  });

  it('differs from the plugin workflow-stage-prompts.mjs only in the skill slash binding', () => {
    const plugin = readFileSync(join(pluginLib, 'workflow-stage-prompts.mjs'), 'utf8');
    const template = readFileSync(join(templateLib, 'workflow-stage-prompts.mjs'), 'utf8');
    expect(plugin).toContain(SKILL_SLASH_IMPORT);
    expect(template).toBe(plugin.replace(SKILL_SLASH_IMPORT, BARE_SKILL_SLASH));
  });

  it('keeps the state-lock template fail-closed rather than syncing it', () => {
    const template = readFileSync(join(templateLib, 'state-lock.mjs'), 'utf8');
    expect(template).toContain('Unprovisioned standalone state-lock template');
    // The real implementation is ~950 lines of SQLite-backed locking; a template
    // that grew past the stub means someone copied it in and broke provisioning.
    expect(template.split('\n').length).toBeLessThan(20);
  });
});
