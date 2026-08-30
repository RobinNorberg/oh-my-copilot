import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The shipped hooks manifest uses the one launcher both cmd.exe and POSIX sh
 * resolve identically (`node`). Rewriting it to the sh/find-node bootstrap locks
 * the install to the OS that ran setup, which is what kills every hook when a
 * config directory is shared across OSes or a marketplace update lands. These
 * tests pin the rule that the rewrite happens only when this host genuinely
 * cannot run the portable form.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const MODULE_PATH = join(REPO_ROOT, 'scripts', 'lib', 'hook-command-normalizer.mjs');

type Normalizer = {
  PORTABLE_HOOK_PREFIX: string;
  UNIX_HOOK_PREFIX: string;
  WINDOWS_HOOK_PREFIX: string;
  nodeResolvesOnHookPath: (env?: NodeJS.ProcessEnv) => boolean;
  hookPrefixForEnvironment: (options?: { platform?: string; nodeOnPath?: boolean }) => string;
  normalizeHookCommand: (command: string, prefix?: string) => string;
  normalizeHooksDataForPlatform: (data: unknown, platform?: string, prefix?: string) => boolean;
};

const normalizer = (await import(pathToFileURL(MODULE_PATH).href)) as Normalizer;

const SESSION_END = '"$CLAUDE_PLUGIN_ROOT"/scripts/session-end.mjs';

describe('hook prefix selection', () => {
  it('always uses the portable form on Windows, which has no sh', () => {
    expect(normalizer.hookPrefixForEnvironment({ platform: 'win32', nodeOnPath: true }))
      .toBe(normalizer.PORTABLE_HOOK_PREFIX);
    expect(normalizer.hookPrefixForEnvironment({ platform: 'win32', nodeOnPath: false }))
      .toBe(normalizer.PORTABLE_HOOK_PREFIX);
  });

  it('keeps the portable form on POSIX hosts that resolve node on PATH', () => {
    for (const platform of ['linux', 'darwin']) {
      expect(normalizer.hookPrefixForEnvironment({ platform, nodeOnPath: true }))
        .toBe(normalizer.PORTABLE_HOOK_PREFIX);
    }
  });

  it('falls back to the find-node bootstrap only when POSIX node is off PATH', () => {
    expect(normalizer.hookPrefixForEnvironment({ platform: 'linux', nodeOnPath: false }))
      .toBe(normalizer.UNIX_HOOK_PREFIX);
    expect(normalizer.UNIX_HOOK_PREFIX).toContain('find-node.sh');
  });

  it('exposes the legacy Windows prefix name as the portable form', () => {
    expect(normalizer.WINDOWS_HOOK_PREFIX).toBe(normalizer.PORTABLE_HOOK_PREFIX);
    expect(normalizer.PORTABLE_HOOK_PREFIX).toBe('node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ');
  });
});

describe('node PATH probe', () => {
  it('reports false under an npm lifecycle, whose PATH is not the hook PATH', () => {
    expect(normalizer.nodeResolvesOnHookPath({ ...process.env, npm_lifecycle_event: 'postinstall' })).toBe(false);
    expect(normalizer.nodeResolvesOnHookPath({ ...process.env, npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' })).toBe(false);
  });

  it('reports false when PATH cannot resolve node', () => {
    const env = { ...process.env };
    delete env.npm_lifecycle_event;
    delete env.npm_execpath;
    env.PATH = join(REPO_ROOT, 'does-not-exist-bin');
    env.Path = env.PATH;
    expect(normalizer.nodeResolvesOnHookPath(env)).toBe(false);
  });
});

describe('command rewriting', () => {
  it('rewrites every historical form to the requested prefix', () => {
    const portable = `${normalizer.PORTABLE_HOOK_PREFIX}${SESSION_END}`;
    const bootstrap = `${normalizer.UNIX_HOOK_PREFIX}${SESSION_END}`;

    expect(normalizer.normalizeHookCommand(bootstrap, normalizer.PORTABLE_HOOK_PREFIX)).toBe(portable);
    expect(normalizer.normalizeHookCommand(portable, normalizer.UNIX_HOOK_PREFIX)).toBe(bootstrap);
    expect(normalizer.normalizeHookCommand(
      '"/opt/node/bin/node" "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/session-end.mjs',
      normalizer.PORTABLE_HOOK_PREFIX,
    )).toBe(portable);
  });

  it('reports no change when the manifest already matches the prefix', () => {
    const data = {
      hooks: {
        SessionEnd: [{
          matcher: '*',
          hooks: [{ type: 'command', command: `${normalizer.PORTABLE_HOOK_PREFIX}${SESSION_END}` }],
        }],
      },
    };
    expect(normalizer.normalizeHooksDataForPlatform(data, 'linux', normalizer.PORTABLE_HOOK_PREFIX)).toBe(false);
  });
});

describe('shipped hooks manifest', () => {
  const hooksJson = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf-8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>>;
  };
  const commands = Object.entries(hooksJson.hooks).flatMap(([event, groups]) =>
    groups.flatMap(group =>
      group.hooks
        .map(hook => hook.command)
        .filter((command): command is string => typeof command === 'string')
        .map(command => ({ event, command })),
    ),
  );

  it('ships only portable commands, so a fresh cache needs no rewrite', () => {
    expect(commands.length).toBeGreaterThan(0);
    for (const { event, command } of commands) {
      expect(command, event).toMatch(/^node "\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs /);
      expect(command, event).not.toContain('find-node.sh');
      expect(command, event).not.toContain('/bin/sh');
    }
  });

  it('needs no patch on a host that can run the portable form', () => {
    const data = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
    for (const platform of ['win32', 'linux', 'darwin']) {
      expect(
        normalizer.normalizeHooksDataForPlatform(data, platform, normalizer.PORTABLE_HOOK_PREFIX),
        platform,
      ).toBe(false);
    }
  });
});
