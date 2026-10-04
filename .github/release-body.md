# oh-my-copilot v5.6.1

This release brings the unattended-run / software-factory surface of upstream
oh-my-claudecode v5.6.0 and v5.6.1 to GitHub Copilot CLI, hardens how host
binaries are launched on Windows, and brings the fork to parity with upstream
`dev` through 4280efb1f. Unattended Copilot sessions run under a scoped AFK
permission profile instead of blanket allow flags.

Install with `npm install -g oh-my-copilot@5.6.1`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`. Upgrading from 5.5.0?
Read the [v5.5.0 → v5.6.1 guide](docs/MIGRATION.md#v550--v561-fork-upgrade-guide).
There are **no breaking changes**: nothing is renamed or removed.

## Highlights

- **Software factory.** A SessionEnd chain enqueuer routes finished sessions
  through `.omg/factory-routes.json`, with gate grading, a serial
  single-session lock, a daily cap of 10 links, a diff-first review gate and a
  stalled-chain watchdog. `omg factory init` seeds the route table,
  `omg factory listen` accepts HMAC-signed tracker events on 127.0.0.1, and
  `omg factory status` audits chains read-only.
- **Headless intake.** `omg intake run` runs one harbor sweep without a
  human; `omg intake schedule --cron <expr>` registers it with cron, or with
  Task Scheduler on Windows. A run ledger records every unattended run.
- **Ralph AFK.** `omg ralph afk "<task>"` launches an isolated headless ralph
  run, `omg ralph verify` judges it against the recorded feedback baseline,
  and `omg ralph from-map` plans, claims and launches a run from a wayfinder
  map.
- **Copilot AFK permission profile.** Factory links and ralph AFK runs launch
  `copilot` with `--no-ask-user`, an allowlist (`gh issue view|comment|edit`,
  `gh pr view|list`, `gh label list`, file writes, `github.com`) and deny rules
  for `write(.git)`, `write(package.json)` and `shell(git push)`. Deny beats
  allow. Declared `--verify` commands are added one `--allow-tool` rule each;
  a bare program or interpreter flag is refused.
- **Unattended-run guardrails.** A destructive-git PreToolUse hook
  (`OMC_GIT_GUARDRAILS`), a stale-run watchdog (`OMC_STALE_RUN_HOURS`) and a
  host-load gate (`OMC_HOST_LOAD_THRESHOLD`, `OMC_FREE_MEMORY_THRESHOLD`,
  `OMC_MAX_SIBLING_SESSIONS`) keep dark runs from damaging the repo or the
  machine.
- **Team.** `OMC_TEAM_WORKER_ENV_PASSTHROUGH` forwards custom provider
  credentials to workers, `team.roleRouting.<role>.reasoningEffort` sets
  effort per role, and the supervised start command stays under 1024 bytes.

## Security fixes

- **The prompt never reaches a `cmd.exe` command line.** On Windows, factory
  links and ralph AFK runs hand the host binary its prompt (and `gh` its
  `--body`) on stdin, native `.exe` binaries are spawned
  directly with an argument array, and only `.cmd`/`.bat` shims go through
  `COMSPEC` with stricter quoting that refuses `%`. Before, a prompt
  containing `\" --allow-all-tools \"` could add flags and `%GH_TOKEN%`
  expanded inside quotes; both were reachable from `package.json` scripts and
  from `check_suite.head_branch` in the factory listener.
- **`COPILOT_ALLOW_ALL` is excluded.** It is no longer passed through to
  session-end children, and every AFK child gets `COPILOT_ALLOW_ALL=false`, so
  an exported value cannot widen the AFK profile to unrestricted shell.

## Behaviour changes

- An exported `COPILOT_ALLOW_ALL` no longer applies to factory links,
  `omg ralph afk|from-map` or `omg intake run`. Interactive sessions and
  `omg team` workers are unaffected.
- On Windows, factory links and ralph AFK runs pipe the prompt to `copilot`
  on stdin instead of passing `-p <prompt>` (verified against Copilot CLI
  1.0.91); `claude` keeps `-p` and reads the prompt from stdin.

## Known limitations

- **Copilot factory chains stop after one link.** Copilot CLI has no
  `--session-id`, so the next link cannot be pinned; the watchdog reports the
  stalled chain.
- **`reasoningEffort` is ignored for Copilot workers.** Copilot CLI has no
  verified reasoning-effort flag; claude and codex workers honour it.
- **git-guardrails under Copilot on Windows is not live-verified.** The hook
  is projected and unit-tested, but its PreToolUse payload has not been
  exercised against a live Copilot session on Windows.

## Requirements

- GitHub Copilot CLI 1.0.88 or later (1.0.91 verified for stdin prompts);
  Claude Code remains supported.
- `node` on PATH, as in v5.5.0.
- Factory and intake: the host binary on PATH and `gh` authenticated for the
  repository.

## Upstream credits

Ported work originates from
[Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
v5.6.0, v5.6.1 and `dev` through 4280efb1f (862c69273..4280efb1f); see
`CHANGELOG.md` for the per-release breakdown and the fork-specific
adaptations.
