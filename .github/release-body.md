# oh-my-copilot v5.16.0

A minor release from v5.15.0: a HUD overhaul for Copilot CLI. The HUD detects
its host from the statusline payload, shows real Copilot data, hides what
Copilot's own footer already shows, and prints the right update command for
your install channel. Claude Code output is unchanged apart from the label.

Install with `npm install -g oh-my-copilot@5.16.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Added

- New elements: `copilotMode` (`mode:plan`, `mode:autopilot`, `mode:yolo`),
  `team` (live `omg team` run) and `ultragoal` (open plan progress). On under
  Copilot, off under Claude Code unless set to `true`.
- Real Copilot data: session duration, context %, `cr:` session AI credits,
  and agent, skill and tool-call counts from the session's `events.jsonl`.

## Changed

- The label reads `[oh-my-copilot#version]` on both hosts.
- Under Copilot, `model`, `effort`, `cwd` and `gitBranch` default to off
  because Copilot's footer shows them; set one to `true` to keep it.
  Claude-only elements (`rateLimits`, `enterpriseMode`, `showEnterpriseCost`,
  `apiKeySource`, `thinking`, `todos`, `sessionSummary`) are off, and the
  Claude Code update hint is gone.
- Update hints match your channel. Plugin installs get
  `copilot plugin marketplace update omc && copilot plugin update oh-my-copilot@omc`;
  npm installs get `npm i -g oh-my-copilot@latest`. The check is cached for
  6 hours.
- Each element renders in its own guard, so a failing element no longer blanks
  the HUD.

## Fixed

- `omg update --check` queried the wrong GitHub owner and now uses the fork's.
- Copilot sessions no longer show a bogus Claude Code update hint.

Upgrade notes are in `docs/MIGRATION.md`. Fork deviations (kept and dropped)
are listed in `CHANGELOG.md`.
