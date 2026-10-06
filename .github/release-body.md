# oh-my-copilot v5.8.1

A patch release that ports upstream oh-my-claudecode `dev` through ef9a44f0e
(bcaceb136..ef9a44f0e), moving parity to upstream v5.6.2 and the dev commits
after it. There are **no breaking changes** and nothing to migrate.

Install with `npm install -g oh-my-copilot@5.8.1`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## What's in

- **HUD cache wrapper is cheaper (#4237).** A minimum refresh age
  (`OMC_HUD_MIN_REFRESH_SECONDS`, default 15) and a POSIX-sh fast path let a
  fresh statusline render skip the lock/refresh step and the usual
  mkdir/sweep/stdin-save work entirely.
- **HUD tracks `TaskCreate`/`TaskUpdate` todos by task id (#4242/#4243).** The
  HUD now renders todos created and updated through the `Task*` tools, not
  only `TodoWrite`, addressed correctly by task id.
- **HUD shows the Claude Code effort level (#4249).** A new `effort` element
  renders `effort:<level>`, colored cool to warm by intensity and never red.
- **Autopilot no longer arms from a pasted echo (#4250/#4251).** A mode
  keyword appearing only inside pasted system-echo content that sanitizes to
  the pasted-echo sentinel no longer arms that mode's state.
- **Detached `new-session -F` format fix (#4252/#4253).** A stale allowlist
  entry was escaping the detached tmux format string, which broke every
  `omc team` start outside tmux; the format is now defined once and reused.
- **Ralph's `hardMaxIterations` is enforced in the Stop hook scripts
  (#4256/#4257).** The cap was previously hardened only in TypeScript; the
  Stop hook scripts that actually run ralph now mirror the same enforcement,
  including `templates/hooks/persistent-mode.mjs`, which had none before.

## Upstream credits

Ported work originates from
[Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
v5.6.2 and `dev` bcaceb136..ef9a44f0e (#4237, #4242, #4243, #4249, #4250,
#4251, #4252, #4253, #4256, #4257); see `CHANGELOG.md` for the breakdown.
Thanks also for merging this fork's own #4246 (wiki-session-end SessionEnd
budget) and #4247 (team-shutdown reservation) upstream, both now returning
to the fork in their canonical upstream form.
