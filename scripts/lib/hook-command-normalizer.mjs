// Hook commands use the braced `${CLAUDE_PLUGIN_ROOT}` form.
//
// Claude Code and Grok substitute the braced placeholder themselves. When
// `args` is present they spawn `command` with no shell, so each path is one
// argument and a plugin root that contains spaces cannot be split. The old
// shell spelling
//   node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs ...
// is one string. PowerShell on Windows splits it after the closing quote, Node
// receives the plugin directory as its script, and the hook exits at
// package_json_reader. That spelling is accepted on input and repaired.
//
// The shipped exec form is platform-neutral: Windows and POSIX hosts both
// spawn `node` with no shell. A Unix published cache is rewritten to the
// find-node.sh bootstrap unless `node` resolves from the standard system dirs
// alone (nvm/fnm/volta installs are not there, and a host launched from a GUI or
// non-login shell may not put them on the hook PATH). Keeping the exec form
// everywhere else means a config directory shared between WSL/macOS and native
// Windows keeps working without a Windows-side repair. A git checkout does not
// rewrite the manifest (plugin-setup.mjs).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';

export const UNIX_HOOK_PREFIX = 'sh "${CLAUDE_PLUGIN_ROOT}"/scripts/find-node.sh "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs ';

const ROOT = String.raw`(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT)`;
const SCRIPT_NAME = /^[A-Za-z0-9._-]+\.mjs$/;

const legacyFindNodePattern = new RegExp(
  String.raw`^sh "${ROOT}\/scripts\/find-node\.sh" "${ROOT}\/scripts\/([^"\s]+)"?(.*)$`,
);
const currentFindNodePattern = new RegExp(
  String.raw`^(?:"\/bin\/sh"|sh) "${ROOT}"\/scripts\/find-node\.sh "${ROOT}"\/scripts\/run\.cjs "${ROOT}"\/scripts\/([^"\s]+)"?(.*)$`,
);
const directRunCjsPattern = new RegExp(
  String.raw`^node\s+"${ROOT}"\/scripts\/run\.cjs\s+"${ROOT}"\/scripts\/([^"\s]+)"?(.*)$`,
);
const absoluteNodeRunCjsPattern = new RegExp(
  String.raw`^"([^"]*\/node|[A-Za-z]:\\[^"]*\\node(?:\.exe)?)"\s+"${ROOT}"\/scripts\/run\.cjs\s+"${ROOT}"\/scripts\/([^"\s]+)"?(.*)$`,
);

function tailTokens(tail) {
  return String(tail ?? '').trim().split(/\s+/).filter(Boolean);
}

function sameArgs(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

/** Script basename plus tokens that follow it (`start` / `stop`). */
export function parseHookInvocation(hook) {
  if (!hook || typeof hook !== 'object') return null;
  const command = typeof hook.command === 'string' ? hook.command : '';
  const args = Array.isArray(hook.args) ? hook.args.filter((item) => typeof item === 'string') : [];

  if (command === 'node' && args.length >= 2) {
    const runner = args[0].replace(/\\/g, '/');
    const script = args[1].replace(/\\/g, '/').split('/').pop();
    if (runner.endsWith('/scripts/run.cjs') && SCRIPT_NAME.test(script)) {
      return { script, extra: args.slice(2) };
    }
  }

  const match = command.match(currentFindNodePattern)
    ?? command.match(legacyFindNodePattern)
    ?? command.match(directRunCjsPattern);
  if (match) return { script: match[1], extra: tailTokens(match[2]) };

  const absolute = command.match(absoluteNodeRunCjsPattern);
  if (absolute) return { script: absolute[2], extra: tailTokens(absolute[3]) };
  return null;
}

export function windowsExecArgs(script, extra = []) {
  return [
    '${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs',
    `\${CLAUDE_PLUGIN_ROOT}/scripts/${script}`,
    ...extra,
  ];
}

export function unixShellCommand(script, extra = []) {
  const tail = extra.length > 0 ? ` ${extra.join(' ')}` : '';
  return `${UNIX_HOOK_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/${script}${tail}`;
}

/** Always on the minimal hook PATH; the Homebrew and MacPorts dirs join when they exist. */
export const SYSTEM_PATH_DIRS = ['/usr/local/bin', '/usr/bin', '/bin'];
const OPTIONAL_SYSTEM_PATH_DIRS = ['/opt/homebrew/bin', '/opt/local/bin'];

export function systemPathDirs(exists = existsSync) {
  return [...SYSTEM_PATH_DIRS, ...OPTIONAL_SYSTEM_PATH_DIRS.filter((dir) => exists(dir))];
}

/**
 * The environment a host launched from a GUI or non-login shell may give its
 * hooks: PATH holds only `pathDirs`, HOME stays, every other variable is dropped.
 */
export function minimalHookEnv(env = process.env, pathDirs = systemPathDirs()) {
  return { PATH: pathDirs.join(delimiter), ...(env.HOME ? { HOME: env.HOME } : {}) };
}

/**
 * True when a bare `node` resolves from `pathDirs` (the standard system dirs)
 * alone, never from this process's PATH: a node that only nvm/fnm/volta or a
 * login shell puts on PATH reports false, so the cache keeps the find-node
 * bootstrap, which also finds those installs. Under an npm lifecycle script the
 * probe reports false too.
 */
export function nodeResolvesOnHookPath(env = process.env, pathDirs = systemPathDirs()) {
  if (env.npm_lifecycle_event || env.npm_execpath) return false;
  try {
    return spawnSync('node', ['-v'], { env: minimalHookEnv(env, pathDirs), timeout: 5000, windowsHide: true, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * `nodeOnPath` defaults to false, so a caller that does not probe keeps the
 * conservative find-node rewrite on POSIX.
 */
export function hookPrefixForPlatform(platform = process.platform, { nodeOnPath = false } = {}) {
  return platform === 'win32' || nodeOnPath ? 'node' : UNIX_HOOK_PREFIX;
}

/**
 * Rewrite one shell command to the Unix find-node form.
 * Windows output is not a string: `normalizeHooksDataForPlatform` writes
 * `command` plus `args` so no shell can split the plugin root.
 */
export function normalizeHookCommand(command, prefix = UNIX_HOOK_PREFIX) {
  if (prefix !== UNIX_HOOK_PREFIX) return command;
  const parsed = parseHookInvocation({ command });
  if (!parsed) return command;
  return unixShellCommand(parsed.script, parsed.extra);
}

export function normalizeHooksDataForPlatform(data, platform = process.platform, { nodeOnPath = false } = {}) {
  const execForm = hookPrefixForPlatform(platform, { nodeOnPath }) === 'node';
  let patched = false;

  for (const groups of Object.values(data?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        const parsed = parseHookInvocation(hook);
        if (!parsed) continue;

        if (execForm) {
          const nextArgs = windowsExecArgs(parsed.script, parsed.extra);
          if (hook.command === 'node' && sameArgs(hook.args, nextArgs)) continue;
          hook.command = 'node';
          hook.args = nextArgs;
          patched = true;
          continue;
        }

        const nextCommand = unixShellCommand(parsed.script, parsed.extra);
        const hadArgs = Array.isArray(hook.args);
        if (hook.command === nextCommand && !hadArgs) continue;
        hook.command = nextCommand;
        if (hadArgs) delete hook.args;
        patched = true;
      }
    }
  }

  return patched;
}

/**
 * Plugin setup's manifest step: normalize the hooks.json at `path` for
 * `platform`, running `probe` on POSIX only. Returns the form label when the
 * file was rewritten, otherwise null.
 */
export function patchHooksManifestFile(path, platform = process.platform, probe = nodeResolvesOnHookPath) {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  const nodeOnPath = platform !== 'win32' && probe();
  if (!normalizeHooksDataForPlatform(data, platform, { nodeOnPath })) return null;
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  return platform === 'win32' || nodeOnPath ? 'direct node exec' : 'find-node.sh run.cjs';
}
