# oh-my-copilot v5.0.0: Upstream Rebase and Workflow Retirement

## Release Notes

The fork was at v4.13.102. It has now been rebased onto upstream
`yeachan-heo/oh-my-claudecode` v5.0.2 and is being released as the fork's own
**v5.0.0**, adopting upstream's canonical Tier-0 workflow surface
(`plan` → `execute` → `review` → `verify`) and retiring a set of legacy skill
and command names outright rather than aliasing them.

### Breaking Changes

- **Retired 11 skills, removed outright (not aliased):** `ultrawork`,
  `ultraqa`, `deep-dive`, `sciomc`, `cccg`, `omc-teams`, `setup`, `mcp-setup`,
  `omc-reference`, `learner`, `writer-memory`. Their behavior now lives in
  `execute`, `verify`, `review`, `research`, `omc-setup`, `wiki`, `remember`,
  and `team`.
- **Retired 7 commands:** `ccg.md`, `deep-dive.md`, `learner.md`,
  `mcp-setup.md`, `omc-teams.md`, `sciomc.md`, `writer-memory.md`.
- **Canonical Tier-0 workflows are now `plan → execute → review → verify`.**
  Three new skills are adopted from upstream: `execute`, `research`, and
  `review`. `review` installs as `omc-review` to avoid colliding with a native
  command. A new `compact` command is also added.
- **The `ultrawork` / `ultraqa` / `ultrapilot` hook subsystems are removed**,
  along with the `stagger-launch` hook. `stagger-launch`'s only trigger was
  `ultrawork` mode, and its thundering-herd protection for parallel agent
  launches is **not** carried over to the new workflow surface — this is a
  known regression, not an oversight.
- Post-retirement inventory: **46 skills, 20 agents, 21 commands**.
- **Host CLI surface moved `.claude/` → `.copilot/`.** oh-my-copilot is a
  GitHub Copilot CLI plugin, so it now reads the host's settings, hooks,
  commands, skills, plugins, rules, tasks, and worktrees from `.copilot/`
  instead of `.claude/`. Project config moved to `.copilot/omg.jsonc` (was
  `.claude/omc.jsonc`). Context-file discovery now prefers
  `copilot-instructions.md` and `.copilot/AGENTS.md`, while still falling
  back to `.claude/CLAUDE.md` and `.claude/AGENTS.md` so the plugin keeps
  working when run under Claude Code. A small number of genuine Claude Code
  interop paths still read `.claude/` on purpose (credentials, installer
  agent/command ownership, todo-continuation task files).
- **OMC runtime root moved `.omc/` → `.omg/`.** All oh-my-copilot runtime
  files now live under `.omg/`: state, sessions, logs, plans, research,
  notepad, project memory, drafts, autopilot, and team state. **This release
  does not auto-migrate existing `.omc/` content** — if you have runtime
  state under `.omc/`, moving it to `.omg/` is a manual step.
  `WORKSPACE_MARKER` is still `.omc-workspace` (unchanged in this release),
  so multi-repo workspace anchors keep working.

### Added

- **Microsoft Teams notifications**, sent as Adaptive Card payloads with
  `@mention` support via `tagList` entries in `"DisplayName:AAD-Object-ID"`
  format. Configure with `OMC_MICROSOFT_TEAMS_WEBHOOK_URL` or a `teams`
  config block. Supports both Power Automate Workflows and legacy O365
  Connector webhook URLs.
- **RecentTools HUD element**: a rolling list of recent tool calls with
  status icons and target summaries. Opt-in via `showRecentTools`; tunable
  with `recentToolsMax` (default 5) and `recentToolsShowTarget`.

### Fixed

- **Agent ownership inventory** (`src/installer/historical-agent-ownership.ts`)
  was regenerated from the fork's own 23 v4 release tags (57 records).
  Previously it held upstream's agent file hashes, so every fork-installed
  agent failed authentication and would never be reclaimed when upgrading
  4.13.102 → 5.0.0. A new generator script,
  `scripts/generate-historical-agent-ownership.mjs` (with `--verify`), plus
  npm scripts `generate:agent-ownership` / `verify:agent-ownership`, keep the
  inventory reproducible going forward.
- **Plugin manifest (`.claude-plugin/plugin.json`) previously listed only 32
  skills** — upstream's set — so all 14 fork-exclusive skills (five
  `omc-ado-*`, five `omc-gh-*`, plus `critique`, `deep-review`, `discover`,
  and `ralph-experiment`) were never registered with the plugin host. The
  manifest now lists all 46.

### Changed

- **Fork-exclusive skills preserved through the rebase (14):** the five
  `omc-ado-*` Azure DevOps skills, the five `omc-gh-*` GitHub skills, plus
  `critique`, `deep-review`, `discover`, and `ralph-experiment`.
- **Publishing is unchanged:** a `v*` tag still produces a GitHub Release and
  npm publish via `release.yml`. Upstream moved to OIDC Trusted Publishing;
  this fork deliberately did not adopt that change.

## oh-my-copilot v5.0.2

### Release Notes

v5.0.2 is the patch release from v5.0.1 through the final release candidate. It corrects Claude Code subagent nesting and concurrency guidance and hardens graph artifact containment, replay integrity, and path handling.

### Highlights

- Corrects Claude Code subagent nesting and concurrency workflow guidance for current Claude Code releases.
- Replaces opaque macOS `/dev/fd/N` graph failures with explicit fail-closed containment when a safe directory-descriptor primitive is unavailable.
- Closes graph artifact basename traversal, path-fallback time-of-check/time-of-use, malformed or unsafe epoch, symlink, and identity-validation gaps.
- Rejects missing journal history, descriptor/fingerprint metadata mismatches, special-file or hardlinked artifacts, and unsafe atomic-write temporary files before replay or publication.
- Keeps graph execution deterministic and safe on Linux while intentionally failing closed on macOS and Windows without a safe directory-descriptor primitive; macOS graph execution is not restored by this release.

### Validation

The release candidate was validated against the exact candidate head with version, projection, inventory, graph safe-fs/fence/CLI tests, build, typecheck, lint, package, and release-boundary checks. The release process must not treat any failing or unavailable validation as passing evidence.
