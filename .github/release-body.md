# oh-my-copilot v5.19.7

A fix release for Copilot CLI users: `/omc-setup` and `/team` no longer give
Claude Code instructions on Copilot CLI, setup works in PowerShell, and the
hook state lock copes with slow Windows owner probes.

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
- The hook state lock no longer fails on one slow Windows owner probe, stays
  within its time budget, and never acquires after its deadline (upstream
  #4727 tests). Inconclusive probes are retried at most twice, a single
  attempt can take over a dead owner, and the TypeScript mode-state lock
  retries an inconclusive probe instead of failing on the first one
  (#424, #430).

## Caveats

- On Node 20, libuv ignores `NoDefaultCurrentDirectoryInExePath`, so full
  protection against a planted executable on Windows needs Node 22+. The Node
  22 minimum is planned for a later release.
- This release was published without the live Copilot smoke.
