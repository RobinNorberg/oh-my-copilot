# oh-my-copilot v5.19.7

A fix release for Copilot CLI users: `/omc-setup` and `/team` no longer give
Claude Code instructions on Copilot CLI, setup works in PowerShell, and on
Windows hooks no longer overrun their time budget on a busy machine.

Install with `npm install -g oh-my-copilot@5.19.7`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Fixed

- `/omc-setup` no longer asks Claude Code questions on Copilot CLI
  (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `teammateMode`, a teammate provider
  list without Copilot). It explains the `omg team` defaults and the
  `team.transport` and `team.ops.defaultAgentType` keys in
  `.copilot/omg.jsonc`, and points MCP setup at `copilot mcp add` (#425).
- `/omc-setup` finds its own scripts. It takes the plugin root from the
  skill's base directory and writes it literally into each command, so the
  commands run in PowerShell, bash and zsh. If the scripts are missing, it
  stops with install instructions. Expect one permission prompt to run
  scripts from the plugin folder (#426, #427).
- `/team` on Copilot CLI drives `omg team` (start, `status`, `shutdown`,
  the `sdk`/`pane` transport, `--transport sdk` in Warp). The Claude Code
  steps are marked as Claude Code only (#429).
- Skills no longer show the bash-only `${COPILOT_HOME:-~/.copilot}` form that
  PowerShell cannot parse (#428, #431).
- On Windows, the hook state lock no longer spawns PowerShell to learn its own
  start time. That probe took 0.4-3 s per hook and, on a busy machine, made
  the lock fail closed, so state writes were skipped. A lock acquire now takes
  about 20 ms (#434).
- The hook state lock handles slow owner probes: it retries an inconclusive
  probe within its budget and never acquires after its deadline (upstream
  #4727 tests, #424, #430).
- Hook stdin waits now fit inside the time `run.cjs` gives each hook, so on a
  loaded Windows machine hooks fail open on their own instead of being killed
  past the host's budget. With `OMC_HOOK_FAIL_CLOSED=1`, `git-guardrails`
  exits 124 when its input never arrived complete (#433).
- Timing tests measure the runner's own lifetime and wait on readiness
  signals, so they no longer fail on a busy Windows machine (#435, #436).

## Known issue: mixed plugin versions

Lock records written by 5.19.7 on Windows are version 2. An older plugin
version reads them as malformed and gives up on that lock instead of waiting.
After a downgrade below 5.19.7, a lock left by a crashed 5.19.7 hook stays
held until it is cleaned up by hand. See the CHANGELOG entry for the cleanup
steps.

## Caveats

- On Node 20, libuv ignores `NoDefaultCurrentDirectoryInExePath`, so full
  protection against a planted executable on Windows needs Node 22+. The Node
  22 minimum is planned for a later release.
- This release was published without the live Copilot smoke.
