# oh-my-copilot v5.19.6

An upstream port (oh-my-claudecode v5.7.18 to v5.7.30), a new haiku-tier
fallback, and a `ralph-experiment` fix for Copilot CLI. The MCP team bridge is
removed; `omg team` is unchanged.

Install with `npm install -g oh-my-copilot@5.19.6`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Added

- `omg quality-gates list --stage <deep-interview|ralplan|omc-review>` shows
  the configured custom quality gates for a stage, with model overrides and
  resolved skill paths. Configure them under `qualityGates` in
  `.copilot/omg.jsonc`.
- The mission board shows persisted missions across the newest sessions;
  `-s, --session <id>` restricts it to one session.

## Changed

- The haiku tier (explore, writer) falls back `claude-haiku-5.5`, `gpt-6-luna`,
  `claude-haiku-4.5`, `gemini-3.8-flash` (#420).
- `ralph-experiment` works on Copilot CLI (#408, fixes #407; thanks to the
  field agent). It uses the Copilot tool names and discards an experiment with
  `git revert` of its own commits by default. `git reset --hard` is used only
  when fail-closed checks pass. Files are staged by pathspec, the tree must be
  clean at the start, multi-repo runs record per-repo `{repo: hash}` values,
  and the measurement commands work in PowerShell 5.1.
- Auto-update reconciliation is faster (the plugin payload is synced once per
  target), and reinstalls recover from a dangling hook library symlink.

## Fixed (ported from upstream)

- Ralph pytest signature handling (#4800-#4802) and Jev context pruning
  (#4804, #4807).
- The keyword detector no longer routes the retired `ultraqa`, `omc-teams`
  and `ultrawork` names.
- Team worker launch on Windows (PATHEXT candidate, `where` no longer
  searches the current directory), SessionEnd manifest retries, and a single
  project-memory writer at session start.
- The mission board finds team missions without a session snapshot;
  `state_clear` output is bounded.

## Removed

- The MCP team bridge and 37 modules nothing reached. `oh-my-copilot/team` no
  longer exports their APIs (`getTeamStatus`, `readTask`,
  `readNewOutboxMessages` and others). See `docs/MIGRATION.md`.

## Caveats

- On Node 20, libuv ignores `NoDefaultCurrentDirectoryInExePath`, so full
  protection against a planted executable on Windows needs Node 22+. The Node
  22 minimum is planned for a later release.
- Upstream's Windows state-lock probe-budget test (#4727) is held out; a fork
  fix follows.
- This release was published without the live Copilot smoke.
