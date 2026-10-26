# oh-my-copilot v5.13.1

A patch release from v5.13.0 that ports upstream oh-my-claudecode `dev`
faedfd200..ed9eb4fa8 (upstream v5.7.7 to v5.7.17). The fork is now at upstream
dev ed9eb4fa8. Bug fixes only: no new features and no breaking changes.

Install with `npm install -g oh-my-copilot@5.13.1`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Fixed

- Environment timeouts are read as whole numbers instead of being truncated
  (`1e3` used to become 1): host-load gate thresholds, LSP, team
  shell-ready, worker-ready, launch-ack and start-submit timeouts, team-dispatch
  cooldown, notify tmux tail lines, persistent-mode and pre-tool advisory
  timeouts (upstream #4510, #4543, #4545 to #4547, #4556 to #4558, #4600).
- Zero or negative `OMC_REPLY_RATE_LIMIT` and `OMC_REPLY_POLL_INTERVAL_MS` are
  rejected, so replies are no longer dropped or polled in a tight loop
  (upstream #4497).
- `OMC_DEBUG` accepts `1` or `true`, or a comma-separated scope list, the same
  way everywhere (upstream #4508).
- A leading UTF-8 BOM is accepted in JSONC config, `prd.json` and the OpenClaw
  config (upstream #4494, #4499).
- `omg team` on Windows: repaired worker supervisor and guarded startup trust
  prompts, including wrapped Claude trust dialogs (upstream #4479, #4502,
  #4528, #4611).
- Team recovery: exited providers inside live panes count as dead, and
  rebase-conflict messages list modify/delete and add conflicts (upstream
  #4618, #4608).
- Keyword detector keeps explicit leading modes and treats multilingual help
  requests as informational; think mode matches whole words (upstream #4551,
  #4553, #4564, #4493).
- Stop hook Jev resolver is detached and its timeout aligned (upstream #4575,
  #4515).
- Ralph fails closed on an invalid PRD (upstream #4526).
- Teleport and provider URL parsing accept trailing slashes, sub-pages and
  patch/diff URLs (upstream #4542, #4549, #4604).
- Smaller fixes: prerelease versions rank below their release (#4511), HUD
  token display near 1000k (#4601), tmux session names with spaces in
  rate-limit-wait (#4544), first `git status` path in the subagent summary
  (#4607), and unpaired surrogates in MCP registry TOML output (#4512).

## Removed

- The unwired team dispatch hook, which had no caller or registration
  (upstream #4581).

Upgrade notes are in `docs/MIGRATION.md`. Fork deviations (kept and dropped)
are listed in `CHANGELOG.md`.
