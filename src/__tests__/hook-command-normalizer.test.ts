import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The shipped hooks manifest uses the exec form (`command: "node"` plus
 * `args`): the host spawns node with no shell, so a plugin root that contains
 * spaces stays one argument on Windows. POSIX keeps that exec form when the
 * caller reports that `node` resolves on the hook PATH, so a config dir shared
 * with native Windows keeps working; otherwise it is rewritten to the
 * find-node bootstrap, which also resolves nvm/fnm/volta installs. The probe
 * refuses to trust an npm lifecycle PATH and the default is the bootstrap.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const MODULE_PATH = join(REPO_ROOT, 'scripts', 'lib', 'hook-command-normalizer.mjs');

type Hook = { type?: string; command?: string; args?: string[] };
type Manifest = { hooks: Record<string, Array<{ hooks: Hook[] }>> };
type Normalizer = {
  UNIX_HOOK_PREFIX: string;
  hookPrefixForPlatform: (platform?: string, options?: { nodeOnPath?: boolean }) => string;
  nodeResolvesOnHookPath: (env?: NodeJS.ProcessEnv) => boolean;
  normalizeHookCommand: (command: string, prefix?: string) => string;
  normalizeHooksDataForPlatform: (data: unknown, platform?: string, options?: { nodeOnPath?: boolean }) => boolean;
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

  it('keeps the exec form on POSIX only when the caller says node resolves', () => {
    for (const platform of ['linux', 'darwin']) {
      expect(normalizer.hookPrefixForPlatform(platform, { nodeOnPath: true }), platform).toBe('node');
      expect(normalizer.hookPrefixForPlatform(platform, { nodeOnPath: false }), platform).toBe(normalizer.UNIX_HOOK_PREFIX);
    }
    expect(normalizer.hookPrefixForPlatform('win32', { nodeOnPath: false })).toBe('node');
  });
});

describe('nodeResolvesOnHookPath', () => {
  it('reports false under an npm lifecycle script, whose PATH is not the hook PATH', () => {
    expect(normalizer.nodeResolvesOnHookPath({ ...process.env, npm_lifecycle_event: 'postinstall' })).toBe(false);
    expect(normalizer.nodeResolvesOnHookPath({ ...process.env, npm_execpath: '/usr/lib/npm-cli.js' })).toBe(false);
  });

  it('reports false when PATH has no node', () => {
    const env: NodeJS.ProcessEnv = { PATH: join(REPO_ROOT, 'no-such-dir') };
    if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
    expect(normalizer.nodeResolvesOnHookPath(env)).toBe(false);
  });

  it('reports true when PATH holds the running node', () => {
    const env = { ...process.env, PATH: dirname(process.execPath) };
    delete env.npm_lifecycle_event;
    delete env.npm_execpath;
    expect(normalizer.nodeResolvesOnHookPath(env)).toBe(true);
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

  it('on Windows only restores the shipped form, e.g. after a WSL setup rewrote a shared cache', () => {
    // A config dir shared between WSL and native Windows: the POSIX rewrite left
    // `sh find-node.sh`, which Windows cannot run. win32 never invents a
    // host-specific form; it puts back exactly the shipped manifest.
    const shared = freshManifest();
    expect(normalizer.normalizeHooksDataForPlatform(shared, 'linux')).toBe(true);
    expect(normalizer.normalizeHooksDataForPlatform(shared, 'win32')).toBe(true);
    expect(shared).toEqual(freshManifest());
    expect(normalizer.normalizeHooksDataForPlatform(shared, 'win32')).toBe(false);
  });

  it('stays unchanged on POSIX when node resolves, so a shared config dir keeps working on Windows', () => {
    for (const platform of ['linux', 'darwin']) {
      const data = freshManifest();
      expect(normalizer.normalizeHooksDataForPlatform(data, platform, { nodeOnPath: true }), platform).toBe(false);
      expect(data, platform).toEqual(freshManifest());
      // And Windows has nothing to repair afterwards.
      expect(normalizer.normalizeHooksDataForPlatform(data, 'win32'), platform).toBe(false);
    }
  });

  it('restores the exec form on POSIX with node on PATH after an earlier find-node rewrite', () => {
    const data = freshManifest();
    expect(normalizer.normalizeHooksDataForPlatform(data, 'linux')).toBe(true);
    expect(normalizer.normalizeHooksDataForPlatform(data, 'linux', { nodeOnPath: true })).toBe(true);
    expect(data).toEqual(freshManifest());
  });

  it('needs no patch on Windows and is rewritten to the bootstrap on POSIX without node', () => {
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
