# Changelog

All notable changes to oh-my-copilot will be documented in this file.

## [5.0.0] - 2026-08-31

The fork was at v4.13.102. It has now been rebased onto upstream
`yeachan-heo/oh-my-claudecode` v5.0.2 and is being released as the fork's own
**v5.0.0**, adopting upstream's canonical Tier-0 workflow surface
(`plan` → `execute` → `review` → `verify`) and retiring a set of legacy skill
and command names outright rather than aliasing them.

### Breaking Changes

- **Retired 11 skills, removed outright (not aliased):** `ultrawork`,
  `ultraqa`, `deep-dive`, `sciomc`, the `cccg` skill (invoked as `/ccg`),
  `omc-teams`, `setup`, `mcp-setup`, `omc-reference`, `learner`,
  `writer-memory`. Their behavior now lives in `execute`, `verify`, `review`,
  `research`, `omc-setup`, `wiki`, `remember`, and `team`.
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
- **Team: per-role provider and model routing** via `.copilot/omg.jsonc`,
  with a resolved-routing snapshot. Declare which provider (`claude`,
  `codex`, `gemini`, `grok`, `cursor`, `antigravity`) and model tier backs
  each canonical role (critic, code-reviewer, executor, planner, etc.) in
  `team.roleRouting`. Routing resolves once at team creation, persists in
  `TeamConfig.resolved_routing`, and is reused across spawn/scale-up/restart.
  Env override via `OMCP_TEAM_ROLE_OVERRIDES`. New `omc doctor team-routing`
  command probes CLI presence for every provider referenced by
  `team.roleRouting`. See `skills/team/SKILL.md` § Per-Role Provider & Model
  Routing.

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
- **Team: alias-keyed role routing is honored, and `team.ops.defaultAgentType`
  is restricted to runtime-supported CLI providers.** Role keys accepted as
  aliases (e.g. `reviewer`) now resolve correctly against `team.roleRouting`
  during validation and stage routing, instead of being silently rejected or
  ignored.
- **State-file locking works on Windows and macOS.** `flockPath()` probed only
  `/usr/bin/flock` and `/bin/flock`, so off Linux `acquireLockAt()` returned
  `unlocked: true` while the caller was still told the lock was acquired —
  there was no inter-process exclusion at all. A portable lockfile fallback
  now runs wherever `flock` is absent: `O_EXCL` temp plus `linkSync`
  publication, an `O_EXCL` guard marker serializing reclaim and release, and
  stale owners cleared by a PID liveness probe with a 60s age ceiling. The
  result reports `acquired: false` rather than claiming exclusivity it does
  not have, and `flock` stays the fast path where it exists. Applied
  identically to `scripts/lib/atomic-write.mjs`,
  `templates/hooks/lib/atomic-write.mjs`, and `src/lib/mode-state-io.ts`.
  `OMC_TEST_STATE_LOCK_MODE` selects `none` or `portable` for tests.
- **Named autopilot workflows are no longer refused off Linux.**
  `isWorkflowRuntimeSupported()` required `process.platform === 'linux'` plus
  an `flock` binary, and `namedWorkflowRuntimeSupported()` additionally
  required `/proc/self/fd`, so named workflow profiles were rejected outright
  on Windows and macOS while state writes skipped integrity validation. Both
  gates now ask whether a working state-file lock exists rather than which
  platform is running. The `/proc/self/fd` transcript walk is kept verbatim on
  Linux; elsewhere each path component is rejected up front if it is a symlink
  and the opened file is confirmed by device and inode, preserving the
  no-follow contract.
- **Setup and uninstall no longer require bash or jq.** `/omc-setup` drove
  `scripts/setup-claude-md.sh` and `scripts/setup-progress.sh`, the latter
  exiting when `jq` was missing, and `scripts/uninstall.sh` had no non-bash
  equivalent — so a Windows user without Git Bash could never complete setup
  and had no supported uninstall, and resume broke on a stock macOS install.
  `scripts/setup-claude-md.mjs`, `scripts/setup-progress.mjs`, and
  `scripts/uninstall.mjs` are the documented entry points; `uninstall.mjs`
  takes `--dry-run` and `--yes`. The shell scripts remain for back-compat.
- **A fresh plugin cache is runnable on Windows without a rewrite.** The shipped
  `hooks/hooks.json` uses `node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs`, the one
  launcher cmd.exe and POSIX sh resolve the same way, and the install-time
  rewrite now self-heals a manifest left in the `sh`/`find-node.sh` form by an
  install on another OS — which previously failed every hook on Windows with
  `'sh' is not recognized`. POSIX installs still take the `find-node.sh`
  bootstrap unconditionally: it resolves `node` from `PATH` when it is there
  and from the nvm/fnm/volta locations when it is not, so it is correct in both
  cases (issue #892).
- **Skill instructions run on Windows.** Eighteen skills, across 21 markdown
  files, embedded POSIX-only command blocks with no Windows variant — including
  the cancel skill's emergency stop-hook escape (a sha256 shell function, GNU
  `date -u -d`, and a python3 heredoc) and the hud install step, whose
  `mkdir -p` and `cp` meant `omcp-hud.mjs` was never installed while
  `statusLine` pointed at it. Those blocks are now `node -e` one-liners. The
  cancel escape reuses `scripts/lib/state-root.mjs`, so it honours
  `OMC_STATE_DIR` and workspace markers exactly as the state tools do.
- **Autoresearch evaluator commands run on Windows.** Evaluator commands are
  user-authored POSIX `sh`; running them through `spawnSync` with `shell:true`
  handed them to `cmd.exe`, so every iteration recorded `error` and no mission
  could pass. `src/platform/posix-shell.ts` discovers a real POSIX shell and
  routes the command through `bash -lc`; when none exists the record carries
  an actionable message instead of an inscrutable `cmd.exe` failure.
- **Workflow integrity checks accept NTFS file ids.** Windows file ids
  routinely exceed `Number.MAX_SAFE_INTEGER`, but the transcript identity was
  built with `Number(stat.ino)` and then validated with
  `Number.isSafeInteger`, so the producer emitted values its own validator
  rejected and named workflow Stop handling answered
  `workflow_descriptor_integrity_failed`. Rounding also let two distinct files
  compare equal. Device and inode now travel as decimal strings, matching what
  `mtimeNs` and `ctimeNs` already did; validation still accepts a legacy safe
  integer, so existing state keeps validating.
- **Windows path matching in team permissions, the bridge daemon, and worktree
  cleanup.** Three defects of the same shape: `isPathAllowed` compared a
  `relative()` result carrying backslashes against `/`-written globs, so
  `allowedPaths` denied everything and — more seriously — `deniedPaths` stopped
  denying anything; `validateConfigPath` built containment by concatenating
  `homeDir + '/'`, which no resolved Windows path matches, so the bridge daemon
  could not start at all; and `assertCleanLeaderWorktree` still filtered
  untracked `.omc` after the runtime root was renamed, so OMC's own metadata
  made the leader look dirty and blocked a second worker. All three now go
  through `path.relative` with segment boundaries preserved.
- **The OMC config directory is unified on `${COPILOT_CONFIG_DIR:-~/.copilot}`.**
  `scripts/lib/config-dir.mjs` and `.cjs` defaulted to `~/.claude` while
  `src/utils/config-dir.ts` and `scripts/lib/config-dir.sh` — which their own
  header names as mirrors — defaulted to `~/.copilot`. The bash lifecycle
  therefore wrote `.omc-config.json` where the Node hooks never looked, so
  settings written by one half of the install were invisible to the other.
  Setup now also adopts a stranded pre-unification `~/.claude/.omc-config.json`
  when the resolved location has none, copying rather than moving; the
  `omc-doctor` skill reports one it finds.
- **Background daemons start under Volta and nvm-windows.** The rate-limit-wait
  daemon and the notification reply-listener spawned themselves as
  `spawn('node', ...)` with a stripped env, so where the `node` on the
  forwarded `PATH` did not exist the spawn failed and the daemon silently never
  started. Both now use `process.execPath`, which needs nothing from `PATH`.
  `resolveDaemonModulePath` also follows the shape of the path it is given
  rather than the host platform.
- **The CLI trust check understands Windows.** Trusted prefixes were POSIX-only
  paths joined onto `$HOME`, `OMC_TRUSTED_CLI_DIRS` was split on `:` (shredding
  `C:\Tools\bin`), and matching was a case-sensitive `startsWith`, so every CLI
  resolution on Windows warned about a non-standard path with no way to silence
  it. Home now comes from `USERPROFILE` on Windows, Windows contributes its own
  trusted roots, the override splits on the platform delimiter, and boundary
  matching uses `path.relative`.
- **Every tmux call goes through argv.** `tmuxShell` built a bare
  `tmux <command>` string, skipping the win32 `.cmd`/`COMSPEC` wrapping
  `resolveTmuxInvocation` exists to apply and forcing callers to POSIX-quote
  format arguments — `cmd.exe` passes single quotes through literally, so
  `-F '#{pane_id}'` came back quote-wrapped and pane matching never fired.
  `isTmuxAvailable` also probes with `shell:false`, so an install path
  containing a space no longer reports tmux as missing. This removes the last
  shell-string assumptions from the tmux surface, which is what a Windows
  tmux-compatible binary such as psmux needs; it was verified with unit tests
  against mocked spawns rather than a live tmux session.

### Changed

- **Fork-exclusive skills preserved through the rebase (14):** the five
  `omc-ado-*` Azure DevOps skills, the five `omc-gh-*` GitHub skills, plus
  `critique`, `deep-review`, `discover`, and `ralph-experiment`.
- **Publishing is unchanged:** a `v*` tag still produces a GitHub Release and
  npm publish via `release.yml`. Upstream moved to OIDC Trusted Publishing;
  this fork deliberately did not adopt that change.
- **Executable resolution is consolidated into `src/platform`.** The Windows
  resolution ritual (`where`/`which`, `.cmd` shim handling, `COMSPEC`
  fallback) had been reimplemented independently in six places, most without a
  timeout — a hook checking for a formatter could hang on an unreachable
  network-drive `PATH` entry. `src/platform/executable-resolution.ts` now
  exposes `resolveExecutable`, `isExecutableAvailable`, and `probeExecutable`,
  and the copies in `src/team/cli-detection.ts`, `src/team/model-contract.ts`,
  `src/mcp/cli-detection.ts`, `src/hooks/plugin-patterns/index.ts`,
  `src/tools/lsp/servers.ts`, and `src/cli/tmux-utils.ts` all delegate to it.
  Importers are unchanged. The `COMSPEC` retry validates its arguments against
  a closed grammar before they reach `cmd.exe`.

### Install

```bash
npm install -g oh-my-copilot@5.0.0
```

## Unreleased

### New Features

- **Deep Interview: Round 0 topology enumeration** (#2919) — confirms and locks top-level components before ambiguity scoring, rotates multi-component targeting, and includes confirmed components plus deferrals in generated specs.

### Migration Notes

- Existing `deep-interview` state files without `state.topology` are treated as legacy state. On resume, unfinished interviews run the new Round 0 topology gate before the next scoring pass; already-finalized specs are left unchanged and should be treated as topology-not-captured legacy artifacts.

---

## [4.11.5] - 2026-04-09

### Fixed (ported from upstream oh-my-claudecode v4.11.4)
- **Keyword detector: narrow false-positive suppression** — Added activation and diagnostic intent detection near keywords. Prompts like "ralph keeps looping" or "what is autopilot mode now?" no longer trigger skill invocations, while explicit requests like "use autopilot to fix bug" still activate correctly (#2411)
- **Installer: portable hook command paths on Windows** — Windows hook commands now use bash-portable `${COPILOT_CONFIG_DIR:-$HOME/.copilot}` expansion instead of CMD-only `%USERPROFILE%` syntax (#2415)
- **HUD: fallback to older built cache versions** — When the latest cached plugin version fails to import, the HUD wrapper now tries progressively older built versions before giving up (#2416)
- **Team: preserve forceInherit by skipping worker model resolution** — When `OMC_ROUTING_FORCE_INHERIT=true`, worker model resolution is skipped to preserve parent model inheritance (#2418)
- **Preemptive compaction: fallback to hook context window usage** — When transcript lacks context_window fields, the hook now falls back to `context_window.used_percentage` or token-based calculation from hook input (#2412)

## [4.11.4] - 2026-04-09

### Fixed (ported from upstream oh-my-claudecode v4.11.3)
- **Node resolution: prefer PATH over ephemeral execPath** — PATH-resolved node is now preferred over `process.execPath` which may point at CI toolcache or Homebrew Cellar version-specific paths that disappear after upgrades (#2396)
- **Hooks: avoid .json false positives in source extension check** — `.json` and `.jsonl` files no longer trigger false "Bash command may modify source files" warnings (#2395)
- **Autoresearch: strip TMUX env for nested session compatibility** — Autoresearch launched from inside a nested tmux session no longer silently creates sessions on the nested server (#2385)
- **Symlink path resolution fixes** — Fixed asymmetric symlink resolution in worktree-paths, autoresearch contracts, learner finder, and team fs-utils (#2372)
- **Installer: detect enabledPlugins field** — `hasEnabledOmcPlugin()` now checks both `enabledPlugins` (modern) and `plugins` (legacy) settings fields (#2371)
- **Ralplan: deactivate stale state after completion** — Prevents ralplan state from rearming after consensus completion or circuit breaker exhaustion (#2370)
- **HUD: version fallback from path** — When package.json is missing, version is extracted from the plugin cache directory path (#2362)

### Changed
- **Build scripts: --watch mode** — All esbuild scripts now support `--watch` flag for development hot-reload
- **Plugin-dir helper** — New shared `resolvePluginDirArg()` utility for CLI plugin directory resolution

## [4.9.0-preview.1] - 2026-03-20

### Added
- **Autoresearch module** (`src/autoresearch/`): Thin-supervisor autoresearch with keep/discard/reset parity, guided interview flow, and Claude session setup
- **Ralphthon module** (`src/ralphthon/`): Autonomous hackathon lifecycle mode with PRD-driven phases, tmux interaction, and idle detection
- **Deep-dive skill**: 2-stage pipeline combining trace (causal investigation) with deep-interview (requirements crystallization) and 3-point injection
- **Deepinit manifest tool** (`src/tools/deepinit-manifest.ts`): Manifest-based incremental deepinit for hierarchical AGENTS.md documentation
- **HUD session summary element**: AI-generated session summary (<20 chars) displayed in HUD, opt-in via `sessionSummary: true`
- **Skill resources guidance**: Bundled skill resources discovery and rendering for better skill context
- **MCP standalone shutdown handler**: Parent-PID polling and signal-based shutdown for orphaned MCP servers
- **CLI commands**: `omcp autoresearch`, `omcp ralphthon`, HUD watch loop extraction
- **Deepsearch magic keyword**: Enhanced codebase search mode with parallel agent orchestration
- **cmux multiplexer support**: Team sessions can now launch from cmux surfaces alongside tmux

### Fixed
- **Security: ReDoS guards** — `safe-regex` validation on user-supplied regex patterns in live-data deny/allow lists
- **Informational keyword filtering** — Questions like "what is ralph?" no longer trigger execution modes (supports EN, KO, JA, ZH)
- **Skill-state collision prevention** — OMC built-in skills no longer collide with project custom skills of the same name (#1581)
- **Session-end fire-and-forget** — Notification and cleanup promises no longer block the SessionEnd hook timeout (#1700)
- **Orchestrator idle allowance** — Orchestrators can go idle while delegated subagents are still running (#1721)
- **Bridge/MCP child process cleanup** — Orphaned bridge and MCP child processes are cleaned up on shutdown (#1724)
- **Bedrock/Vertex model passthrough** — Provider-specific model IDs passed as-is to team workers instead of normalizing to invalid aliases (#1695, #1415)
- **Team split-pane cleanup** — Shutdown now discovers and removes split-pane workers after metadata drift (#1751)
- **LSP singleton protection** — Process-global singleton prevents duplicate LSP client managers across module reloads
- **LSP idle deadline management** — Per-client idle deadlines with configurable timeout via `OMC_LSP_IDLE_TIMEOUT_MS`
- **Kotlin LSP update** — Updated to official JetBrains kotlin-lsp implementation (#1710)
- **Task router fix** — `build-fix` intent now maps to `code-edit` capability instead of `testing`
- **Marketplace clone protection** — Auto-update no longer runs destructive resets on marketplace clones (#1755)
- **Legacy state cleanup consolidation** — Unified ghost-legacy cleanup across multiple candidate paths
- **Project memory preservation** — customNotes and userDirectives preserved when re-detecting project environment (#1689)
- **Print mode tmux bypass** — `--print`/`-p` flag bypasses tmux wrapping so stdout flows to parent process (#1666, #1685)
- **Orphaned tmux session cleanup** — Failed tmux attach now kills the orphaned detached session
- **Keychain credential freshness** — HUD prefers the freshest non-expired Keychain entry when multiple exist (#1684)

### Changed
- Agent tool model parameter denial extended to cover both Task and Agent tools on Bedrock/Vertex (#1415)
- Learner now scans `.agents/skills/` directory alongside `.claude/skills/` for skill discovery
- Bridge manager tracks owned sessions and passes `OMC_PARENT_PID` env var for orphan detection

## [4.8.2-preview.4] - 2026-03-18

### Added
- **Complexity-first phase selection**: Heuristic classifier (`src/hooks/complexity-classifier/`) classifies tasks as SIMPLE/STANDARD/COMPLEX before autopilot/ralplan runs planning. SIMPLE skips planning phases, COMPLEX adds Critic review. AI fallback model configurable via `/omc-setup` (defaults to haiku).
- **Circular fix detection**: Error hash tracking (`src/hooks/circular-fix-detector/`) detects when the same error recurs 3+ times in ultraqa/ralph QA loops. Generates structured escalation report at `.omcp/escalation-report.md` instead of retrying endlessly.
- **Stagger delay for parallel launches**: Advisory stagger hook (`src/hooks/stagger-launch/`) injects 1-second delay guidance between rapid-fire agent launches in ultrawork to prevent thundering herd rate limits. Configurable via `stagger_delay_ms` on UltraworkState.
- **Structured recovery manager**: Orchestration-level failure classification (`src/hooks/recovery/orchestration-recovery.ts`) with mapped recovery actions (retry, retry with backoff, skip, escalate). Per-task attempt tracking with 2-hour rolling window. Integrates with circular fix detector for escalation path.
- **Multi-pass deep review** (`/deep-review`): New skill that runs 3 parallel review passes (Security, Quality, Structural) followed by a validation pass that confirms/dismisses findings. Also accessible via `--deep` flag on code-reviewer agent.
- **Context accumulation between phases**: Hook (`src/hooks/context-accumulator/`) captures key outputs after each autopilot phase or ralph story and injects them into the next phase's agent prompt as `<prior-phase-context>`. Truncated to 12KB per phase, session-scoped.
- **Ideation/discovery skill** (`/discover`): Spawns 6 parallel specialist agents (Security, Quality, Tests, Performance, Documentation, Architecture) to scan a codebase and produce a prioritized improvement backlog at `.omcp/discover/backlog.md`. Supports scoping to subdirectories.
- **Semantic merge resolution**: Extended git-master agent with `<Merge_Conflict_Resolution>` protocol for AI-assisted merge conflict resolution — reads full file context, resolves semantically, verifies with build/tests.

## [4.8.2-preview.3] - 2026-03-18

### Added
- Claude Code CLI as a supported team worker provider (`omcp team N:claude "..."`)
- `ralph-experiment` skill documented in README and copilot-instructions
- Hierarchical docs/ structure (get-started, guides, reference, architecture, migration)
- `docs/index.md` as documentation table of contents

### Changed
- README trimmed to gateway document (~180 lines), detailed content moved to docs/guides/
- All `omg-*` commands renamed to `omc-*` (omc-setup, omc-doctor, omc-plan, etc.)
- All `OMP`/`OMG` abbreviations standardized to `OMC`
- Agent tiers reference updated to reflect actual 18 agents (from 32 pre-consolidation)
- Multi-AI Orchestration section lists all 4 providers (Copilot, Claude, Gemini, Codex)

### Fixed
- `claude` agent type: binary corrected from `copilot` to `claude`
- Broken `https://docs/REFERENCE.md` URLs in README
- Phantom agent entries removed from AGENTS.md (11 non-existent roles)
- Agent counts updated from 28/32 to actual 18 across all docs
- `OMP:VERSION` markers renamed to `OMC:VERSION` in installer

### Removed
- 11 translated README files (English-only going forward)
- 7 stale root markdown files (ANALYSIS.md, IMPLEMENTATION_SUMMARY.md, etc.)
- `docs/partials/` (duplicate of docs/shared/)
- `docs/ko/` Korean translations
- `seminar/` presentation materials
- `benchmark/` SWE-bench (empty results)
- `skills/hud/` (Copilot doesn't support custom HUDs)
- `.github/SPONSOR_TIERS.md` and sponsor badges
- Star history charts

## [4.8.2-preview.1] - 2026-03-17

### Changed
- Initial release as oh-my-copilot
- All URLs updated to `RobinNorberg/oh-my-copilot`
- Preview versions publish to npm under `preview` tag
- `.copilot-plugin/` references corrected to `.claude-plugin/` in CI
