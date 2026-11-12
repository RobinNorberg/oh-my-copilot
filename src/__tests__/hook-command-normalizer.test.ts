import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The shipped hooks manifest uses the exec form (`command: "node"` plus
 * `args`): the host spawns node with no shell, so a plugin root that contains
 * spaces stays one argument on Windows. POSIX installs are rewritten to the
 * find-node bootstrap unconditionally: find-node.sh resolves `node` from PATH
 * when it is there and from the nvm/fnm/volta locations when it is not. These
 * tests pin that the choice is made from the platform alone — an earlier
 * version probed the setup process's PATH, which is not the PATH hooks are
 * later spawned with.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const MODULE_PATH = join(REPO_ROOT, 'scripts', 'lib', 'hook-command-normalizer.mjs');

type Hook = { type?: string; command?: string; args?: string[] };
type Manifest = { hooks: Record<string, Array<{ hooks: Hook[] }>> };
type Normalizer = {
  UNIX_HOOK_PREFIX: string;
  hookPrefixForPlatform: (platform?: string) => string;
  normalizeHookCommand: (command: string, prefix?: string) => string;
  normalizeHooksDataForPlatform: (data: unknown, platform?: string) => boolean;
};

const normalizer = (await import(pathToFileURL(MODULE_PATH).href)) as Normalizer;

const RUN_CJS = '${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs';
const SESSION_END = '${CLAUDE_PLUGIN_ROOT}/scripts/session-end.mjs';
const freshManifest = (): Manifest => JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
const allHooks = (data: Manifest): Hook[] => Object.values(data.hooks).flatMap(groups => groups.flatMap(group => group.hooks));

describe('hook prefix selection', () => {
  it('uses direct node exec on Windows, which has no sh', () => {
    expect(normalizer.hookPrefixForPlatform('win32')).toBe('node');
  });

  it('uses the find-node bootstrap on every POSIX platform', () => {
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      expect(normalizer.hookPrefixForPlatform(platform), platform).toBe(normalizer.UNIX_HOOK_PREFIX);
    }
    expect(normalizer.UNIX_HOOK_PREFIX).toContain('find-node.sh');
  });

  it('does not consult PATH when choosing the POSIX prefix', () => {
    // The regression this guards: probing whether `node` resolves samples the
    // setup process's environment, not the one the host CLI spawns hooks with.
    const source = readFileSync(MODULE_PATH, 'utf-8');
    expect(source).not.toContain('spawnSync');
    expect(source).not.toContain('nodeResolvesOnHookPath');
    expect(source).not.toMatch(/\benv\.PATH\b/);
  });
});

describe('command rewriting', () => {
  it('rewrites the legacy shell forms to the bootstrap', () => {
    const bootstrap = `${normalizer.UNIX_HOOK_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/session-end.mjs`;
    expect(normalizer.normalizeHookCommand(
      'node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs "${CLAUDE_PLUGIN_ROOT}"/scripts/session-end.mjs',
    )).toBe(bootstrap);
    expect(normalizer.normalizeHookCommand(
      '"/opt/node/bin/node" "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/session-end.mjs',
    )).toBe(bootstrap);
  });

  it('reports no change when the manifest already uses the exec form on Windows', () => {
    const data = {
      hooks: { SessionEnd: [{ matcher: '*', hooks: [{ type: 'command', command: 'node', args: [RUN_CJS, SESSION_END] }] }] },
    };
    expect(normalizer.normalizeHooksDataForPlatform(data, 'win32')).toBe(false);
  });
});

describe('shipped hooks manifest', () => {
  it('ships the exec form, with no sh anywhere', () => {
    const hooks = allHooks(freshManifest());
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) {
      expect(hook.command).toBe('node');
      expect(hook.args?.[0]).toBe(RUN_CJS);
      expect(JSON.stringify(hook)).not.toContain('find-node.sh');
    }
  });

  it('needs no patch on Windows and is rewritten to the bootstrap on POSIX', () => {
    expect(normalizer.normalizeHooksDataForPlatform(freshManifest(), 'win32')).toBe(false);

    for (const platform of ['linux', 'darwin']) {
      const data = freshManifest();
      expect(normalizer.normalizeHooksDataForPlatform(data, platform), platform).toBe(true);
      for (const hook of allHooks(data)) {
        expect(hook.args, platform).toBeUndefined();
        expect(hook.command, platform).toMatch(
          /^sh "\$\{CLAUDE_PLUGIN_ROOT\}"\/scripts\/find-node\.sh "\$\{CLAUDE_PLUGIN_ROOT\}"\/scripts\/run\.cjs /,
        );
      }
    }
  });
});
