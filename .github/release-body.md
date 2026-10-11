# oh-my-copilot v5.10.0

A minor release. It adds a premium-request budget governor (`omg budget`,
warn-only by default), the `omg ship` merge-gate engine and `ship` skill, a
Copilot `notification` hook for permission prompts and `ask_user`, opt-in
in-process SDK tools for sdk team workers, and the `session-flow` skill (63
skills). Upstream oh-my-claudecode `dev` is ported through 7cb577e94
(a720eabd0..7cb577e94, 224 commits).

Install with `npm install -g oh-my-copilot@5.10.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

**Behavior change:** permission auto-approval is narrower. On Copilot,
`npm run build`, test commands, git read commands (`git diff`, `git log`,
`git branch`, `git show`, `git fetch`) and heredoc `git commit`/`git tag`
are no longer auto-approved; they go through the normal permission flow.

## Added

### Premium-request budget governor

- A ledger at `.omg/state/budget-ledger.json` records Copilot usage per
  session and per team, each record labelled measured (from the session's
  `events.jsonl` totals) or estimated (one premium request per prompt).
- `budget` keys in `.copilot/omg.jsonc`: `mode` (`warn` default, `enforce`
  opt-in), `unit`, `softLimit`, `hardLimit`, `perTeamLimit`. A fail-open hook
  prints a SessionStart summary and a one-time notice when a limit is crossed;
  the HUD gains a `premiumBudget` element.
- In enforce mode `omg team` clamps or refuses a fan-out whose projected cost
  exceeds the limits (`--budget-override` starts it anyway).
- `omg budget` (`status`, `reset`, `--json`) shows and resets the ledger.
  `OMC_BUDGET_GOVERNOR=0` turns it all off.

### `omg ship` and the `ship` skill

- `/oh-my-copilot:ship` takes a task or an open PR to merge-ready: executor
  lane, independent verifier lane, bounded fix rounds by fresh agents.
- `omg ship gates <pr> [--watch]` is green only when every non-advisory check
  is SUCCESS or SKIPPED and every workflow run for the head is complete; known
  flaky tests (`.github/known-flaky-tests.json`) are rerun once.
- `omg ship prepare` merges GitHub's base sha (never rebases), runs the local
  gates and regenerates the inventory last. `omg ship merge` prints the
  `gh pr merge --admin` command; it runs the admin merge itself only when the
  owner sets `ship.allowAdminMerge` in the user config. There is no CLI flag.
- Safety keys come from the user config and the base branch's committed
  `.copilot/omg.jsonc` only. `ship.trustedBases` (default `dev`, `main`,
  `master`) limits which bases are read and admin-merged.
- Known limits: the state file's integrity hash is not a signature; a lane
  with write access to `.git/objects` can forge objects; environment and
  `PATH` overrides are advisory.

### Copilot `notification` hook

- Permission prompts and `ask_user` questions are sent to the configured
  Discord, Telegram or Slack targets. On Copilot the upstream
  `AskUserQuestion` path never fired.
- A permission prompt is sent as its title, tool category and command binary
  only (`Permission needed: Run command: curl`), never the arguments, and it
  is never replyable: remote replies cannot answer a permission prompt.
- `ask_user` text is redacted and capped at 200 characters.
- Fail-closed: on a stale `dist/` without these guarantees the hook sends no
  permission prompt until `dist/` is rebuilt.

### In-process SDK tools for sdk team workers (opt-in)

- `team.sdk.inProcessTools` (default `false`; env
  `OMC_TEAM_SDK_INPROCESS_TOOLS=1`) registers the plugin tools in the sdk host
  instead of a stdio MCP server per worker. There is no latency gain (session
  start 2843 ms vs 2872 ms); each worker saves one node process (about 85 MB).

### `session-flow` skill

- An evidence-backed map of the current session (upstream #4319). The plugin
  ships 63 skills.

## Changed: upstream port (a720eabd0..7cb577e94, 224 commits)

- Shipyard is lean: drydock seeds `CLAUDE.md` + `GLOSSARY.md`; other surfaces
  appear on first use; the audit (contract v2) checks only adopted surfaces.
- Permission auto-approval is narrower (#4283, #4280); see the behavior change
  above.
- AFK user settings are opt-in (`OMC_AFK_INCLUDE_USER_SETTINGS=1`, #4282).
- Fixes: MCP registry TOML parsing (multiline and literal strings, quoted
  keys), a native Windows tmux identity guard, Cursor team worker lifecycle,
  plugin-cache purge validation, notification template escaping and reply
  registry hardening, HUD fixes, and SSRF guard IPv6 ranges. See
  [MIGRATION.md](https://github.com/RobinNorberg/oh-my-copilot/blob/main/docs/MIGRATION.md)
  for the three upstream migration notes.

## Fork deviations

- Split panes remove the private pane env file again when a split fails.
- MSYS2/Cygwin tmux keeps the POSIX identity guard (the PowerShell guard is
  chosen only for psmux).
- `lsp_diagnostics_directory` resolves tsc on Windows (project TypeScript or
  the `tsc.cmd` shim) and reports a missing compiler as a failure.

## Upstream credits

Ported work originates from
[Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
`dev` a720eabd0..7cb577e94; see `CHANGELOG.md` for the breakdown.
