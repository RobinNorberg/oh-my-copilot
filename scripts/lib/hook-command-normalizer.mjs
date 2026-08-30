// The shipped manifest form, and the only one Windows can run: `node` is the
// one launcher cmd.exe and POSIX sh resolve the same way, and Windows has no
// `sh` to bootstrap with. Shipping this form keeps a fresh plugin cache usable
// on Windows without any rewrite.
export const PORTABLE_HOOK_PREFIX = 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ';
export const WINDOWS_HOOK_PREFIX = PORTABLE_HOOK_PREFIX;
// The POSIX form. find-node.sh resolves `node` from PATH when it is there and
// from the nvm/fnm/volta locations when it is not, so this works in both cases
// while the bare-node form works only in the first (issue #892).
export const UNIX_HOOK_PREFIX = 'sh "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ';

/**
 * The hook prefix a platform can execute.
 *
 * POSIX always gets the find-node bootstrap. An earlier version probed whether
 * a bare `node` resolved and skipped the bootstrap when it did, but the probe
 * ran in the setup process, not in the environment the host CLI later spawns
 * hooks in. An nvm/fnm user who runs setup from an interactive shell and then
 * launches the CLI from a desktop launcher or launchd has node on PATH for the
 * probe and not for the hooks, so every hook dies — the exact shape of #892.
 * The bootstrap is correct whether or not node is on PATH, so there is nothing
 * to gain by guessing.
 */
export function hookPrefixForPlatform(platform = process.platform) {
  return platform === 'win32' ? PORTABLE_HOOK_PREFIX : UNIX_HOOK_PREFIX;
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
