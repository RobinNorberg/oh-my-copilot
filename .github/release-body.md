# oh-my-copilot v5.13.0

A minor release from v5.12.2: OMC's keep-going modes now work on GitHub
Copilot CLI, with chained Stop continuations, a native ultragoal goal record,
per-agent models and a hook adapter brought up to Copilot CLI 1.0.103. No
breaking changes, but on Copilot a prompt can now cost up to 3 extra premium
requests from OMC continuations (`OMC_COPILOT_STOP_CHAIN_MAX=1` restores the
old behaviour).

Install with `npm install -g oh-my-copilot@5.13.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Added

- Chained Stop continuation on Copilot (#279): up to 3 OMC continuations per
  user prompt, each billed as one premium request; `OMC_COPILOT_STOP_CHAIN_MAX`
  (1 to 7) overrides the cap.
- OMG goal record for ultragoal on Copilot (#279): `omg ultragoal goal-start`
  and `goal-evidence` stand in for Claude Code's `/goal`.
- Per-agent models on Copilot (#281): `omg setup` syncs `agents.<name>.model`
  overrides into Copilot's `settings.json` using the Copilot 5.5 tier table
  (settings key not yet verified live; check with `/subagents`).
- `omg hooks doctor` (#280): checks the Copilot hook wiring and dry-runs every
  hook entry.
- Opt-in live smoke scenarios (#280): `omg smoke copilot --tier 2 --scenario
  continuation,prompt-context,events`.

## Changed

- `context-guard-stop` never blocks on Copilot; it advises once per session
  instead (#283).
- Copilot hook payloads gain Claude field names, `systemMessage` reaches the
  model, and PermissionRequest decisions use Copilot's shape with deny-wins
  merging (#283).
- On Copilot, SessionEnd cleanup and the factory-chain link wait for the real
  session end (#279).
- `omg release` runs the vitest suite in a new `suite` phase after `commit`,
  records the suite level and baseline, and refuses a skipped live smoke at
  `pr` unless `--allow-skipped-smoke` is given (#282).

## Fixed

- The lowercase `skill` tool on Copilot is recognized, so cancel, ultragoal
  bootstrap and skill-state hooks fire (#279).
- A repo nested under a git-less session root is no longer rejected, and
  state-root lookups are memoized, which removes minutes-long scans on
  Windows (#282).
- Copilot subagents: parent-session lookup for the ultragoal guard, oldest-first
  close of parallel same-type agents, and pruning of stale handoff files
  (#279, #283).

Upgrade notes are in `docs/MIGRATION.md`. Fork deviations (kept and dropped)
are listed in `CHANGELOG.md`.
