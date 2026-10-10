# oh-my-copilot v5.9.0

A minor release. Under the Copilot CLI host, `omg team` now starts headless
SDK workers by default; Copilot hooks run through a per-event dispatcher; the
project config is `.copilot/omg.jsonc` everywhere; a daily upstream drift bot
proposes ports; and upstream oh-my-claudecode `dev` is ported through
a720eabd0 (ef9a44f0e..a720eabd0, 6 commits). Under Claude Code nothing about
the team transport changes.

Install with `npm install -g oh-my-copilot@5.9.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

To keep tmux/psmux panes under Copilot CLI, pass `--transport pane` or set
`{ "team": { "transport": "pane" } }` in `.copilot/omg.jsonc`. See the
[migration note](https://github.com/RobinNorberg/oh-my-copilot/blob/main/docs/MIGRATION.md#v581--v590-sdk-team-transport-by-default).

## SDK team transport by default under Copilot CLI

- **`omg team` defaults to `--transport auto`.** That means `sdk` under the
  Copilot CLI host and `pane` under Claude Code or a plain terminal. `auto`
  falls back to panes, with a note on stderr, for `--auto-merge`, non-copilot
  workers, an explicitly assigned reviewer-contract role, or a missing
  `@github/copilot-sdk`. `team.transport` in the project config overrides it.
- **Parallel worker launch.** SDK hosts start 4 at a time by default
  (`team.sdk.launchConcurrency`, env `OMC_TEAM_SDK_LAUNCH_CONCURRENCY`). A live
  2-worker launch went from 75.3 s serial to 24.0 to 51.8 s parallel.
- **`omg team status --json`** adds `transport` and, per SDK worker,
  `host_pid`, `runtime_pid`, `session_id`, `attempt_id`, `updated_at`,
  `task_state`, `current_task_id` and `premium_requests_final`.
- **Shutdown no longer loses work.** A worker worktree with commits the leader
  HEAD does not contain is kept, with its branch, and named on stderr. Worker
  branches the commit check did not cover are kept, and a merged worker branch
  the leader has checked out no longer fails teardown.
- **Shutdown no longer keeps every worktree.** A copilot worker's own `.omg/`
  runtime state (SessionEnd job records) no longer counts as dirty, so
  `omg team shutdown` cleans up instead of exiting 1 and keeping the
  reservation.
- **`one_team_per_leader_session` sees SDK teams**, and
  `omg smoke copilot --tier 2 --scenario team` (opt-in, about 2 premium
  requests) runs a real 2-worker team from start to clean shutdown.

## Per-event Copilot hook dispatcher

`copilot/hooks.json` now has 12 entries, one per `(event, matcher)` group,
instead of one per hook. Each runs `scripts/copilot/dispatch.cjs`, which reads
stdin once, runs the group's hooks in order with the same routing and per-hook
timeouts, and merges their outputs (a PreToolUse deny wins, a Stop block
survives, a throwing hook fails alone). On Windows, Stop drops from 1358 to
1011 ms and SessionStart from 2403 to 2036 ms. Set
`OMC_COPILOT_HOOK_DISPATCH=0` to run one process per hook again without
regenerating. Claude Code and `hooks/hooks.json` are unchanged.

## Canonical `.copilot/omg.jsonc` config

The security config reader, the Stop hook, the keyword detector opt-out,
per-agent model overrides and `autopilot --workflow` profiles all read
`.copilot/omg.jsonc` first, with `.copilot/omc.jsonc` (and, where it applied
before, `.claude/omc.jsonc`) as a fallback. `omg doctor conflicts` prints the
rename command for a legacy-named file and never renames it itself.

## Upstream drift bot

A daily workflow, `.github/workflows/upstream-drift.yml`, compares upstream
`dev` with the last ported sha in `.github/upstream-port.json`, applies the
range with the runbook's exclusions and rename map, and opens a draft port PR
(clean apply) or an issue listing the conflicts. Scheduled workflows run only
from the default branch. The optional `UPSTREAM_DRIFT_TOKEN` secret lets CI
run on the bot's PRs.

## Upstream port (ef9a44f0e..a720eabd0, 6 commits)

- Plugin cache cleanup keeps symlinked versions and ignores orphaned
  `*.tmp~*` directories (#4263).
- cmux teams verify pane ownership through the tmux-compat layer, and
  `--force` shutdown no longer stalls on workers without a verifiable pane
  (#4261).
- Session cwds in a repo subdirectory on Windows resolve to the right worktree
  (#4254).
- `omg ask antigravity` runs on Windows, and antigravity team workers are no
  longer refused there (#4258).

## Documentation

`docs/DEVELOPERS.md` audits every hook event Copilot CLI 1.0.91 supports
against the generated `copilot/hooks.json`.

## Upstream credits

Ported work originates from
[Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
`dev` ef9a44f0e..a720eabd0 (#4254, #4258, #4261, #4263); see `CHANGELOG.md`
for the breakdown.
