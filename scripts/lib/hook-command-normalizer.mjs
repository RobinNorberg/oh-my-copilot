import { spawnSync } from 'node:child_process';

// The shipped manifest form. `node` is the only launcher that both cmd.exe and
// POSIX sh resolve the same way, so this command string is platform-neutral and
// survives marketplace updates and config directories shared across OSes.
export const PORTABLE_HOOK_PREFIX = 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ';
export const WINDOWS_HOOK_PREFIX = PORTABLE_HOOK_PREFIX;
// Bootstrap for the one case the portable form cannot cover: a POSIX host whose
// non-interactive hook environment has no `node` on PATH (nvm/fnm, issue #892).
export const UNIX_HOOK_PREFIX = 'sh "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ';

/**
 * True when a bare `node` resolves from the environment hooks will be spawned
 * with. Under an npm lifecycle script npm prepends its own Node directory to
 * PATH, so the probe cannot see the real hook PATH and reports false — keeping
 * the find-node bootstrap, which is correct either way.
 */
export function nodeResolvesOnHookPath(env = process.env) {
  if (env.npm_lifecycle_event || env.npm_execpath) return false;
  try {
    return spawnSync('node', ['-v'], { env, timeout: 5000, windowsHide: true, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export function hookPrefixForEnvironment({ platform = process.platform, nodeOnPath } = {}) {
  // Windows has no `sh`, so the bootstrap form is never an option there.
  if (platform === 'win32') return PORTABLE_HOOK_PREFIX;
  const resolvable = nodeOnPath ?? nodeResolvesOnHookPath();
  return resolvable ? PORTABLE_HOOK_PREFIX : UNIX_HOOK_PREFIX;
}

export function hookPrefixForPlatform(platform = process.platform) {
  return hookPrefixForEnvironment({ platform });
}

export function normalizeHookCommand(command, prefix = hookPrefixForPlatform()) {
  const legacyFindNodePattern =
    /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/find-node\.sh" "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([^"\s]+)"?(.*)$/;
  const currentFindNodePattern =
    /^(?:"\/bin\/sh"|sh) "\$CLAUDE_PLUGIN_ROOT"\/scripts\/find-node\.sh "\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs "\$CLAUDE_PLUGIN_ROOT"\/scripts\/([^"\s]+)"?(.*)$/;
  const directRunCjsPattern =
    /^node\s+"\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs\s+"\$CLAUDE_PLUGIN_ROOT"\/scripts\/([^"\s]+)"?(.*)$/;
  const absoluteNodeRunCjsPattern =
    /^"([^"]*\/node|[A-Za-z]:\\[^"]*\\node(?:\.exe)?)"\s+"\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs\s+"\$CLAUDE_PLUGIN_ROOT"\/scripts\/([^"\s]+)"?(.*)$/;

  const match = command.match(currentFindNodePattern)
    ?? command.match(legacyFindNodePattern)
    ?? command.match(directRunCjsPattern);
  if (match) return `${prefix}"$CLAUDE_PLUGIN_ROOT"/scripts/${match[1]}${match[2]}`;

  const absNodeMatch = command.match(absoluteNodeRunCjsPattern);
  if (absNodeMatch) return `${prefix}"$CLAUDE_PLUGIN_ROOT"/scripts/${absNodeMatch[2]}${absNodeMatch[3]}`;

  return command;
}

export function normalizeHooksDataForPlatform(data, platform = process.platform, prefix = hookPrefixForPlatform(platform)) {
  let patched = false;

  for (const groups of Object.values(data?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (!hook || typeof hook !== 'object' || typeof hook.command !== 'string') continue;
        const nextCommand = normalizeHookCommand(hook.command, prefix);
        if (hook.command !== nextCommand) {
          hook.command = nextCommand;
          patched = true;
        }
      }
    }
  }

  return patched;
}
