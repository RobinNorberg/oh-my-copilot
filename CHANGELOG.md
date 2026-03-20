# Changelog

All notable changes to oh-my-copilot will be documented in this file.

## [4.9.0-preview.1] - 2026-03-20

### Added
- **Autoresearch module** (`src/autoresearch/`): Thin-supervisor autoresearch with keep/discard/reset parity, guided interview flow, and Claude session setup
- **Ralphthon module** (`src/ralphthon/`): Autonomous hackathon lifecycle mode with PRD-driven phases, tmux interaction, and idle detection
- **Deep-dive skill**: 2-stage pipeline combining trace (causal investigation) with deep-interview (requirements crystallization) and 3-point injection
- **Deepinit manifest tool** (`src/tools/deepinit-manifest.ts`): Manifest-based incremental deepinit for hierarchical AGENTS.md documentation
- **HUD session summary element**: AI-generated session summary (<20 chars) displayed in HUD, opt-in via `sessionSummary: true`
- **Skill resources guidance**: Bundled skill resources discovery and rendering for better skill context
- **MCP standalone shutdown handler**: Parent-PID polling and signal-based shutdown for orphaned MCP servers
- **CLI commands**: `omc autoresearch`, `omc ralphthon`, HUD watch loop extraction
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
- **Circular fix detection**: Error hash tracking (`src/hooks/circular-fix-detector/`) detects when the same error recurs 3+ times in ultraqa/ralph QA loops. Generates structured escalation report at `.omc/escalation-report.md` instead of retrying endlessly.
- **Stagger delay for parallel launches**: Advisory stagger hook (`src/hooks/stagger-launch/`) injects 1-second delay guidance between rapid-fire agent launches in ultrawork to prevent thundering herd rate limits. Configurable via `stagger_delay_ms` on UltraworkState.
- **Structured recovery manager**: Orchestration-level failure classification (`src/hooks/recovery/orchestration-recovery.ts`) with mapped recovery actions (retry, retry with backoff, skip, escalate). Per-task attempt tracking with 2-hour rolling window. Integrates with circular fix detector for escalation path.
- **Multi-pass deep review** (`/deep-review`): New skill that runs 3 parallel review passes (Security, Quality, Structural) followed by a validation pass that confirms/dismisses findings. Also accessible via `--deep` flag on code-reviewer agent.
- **Context accumulation between phases**: Hook (`src/hooks/context-accumulator/`) captures key outputs after each autopilot phase or ralph story and injects them into the next phase's agent prompt as `<prior-phase-context>`. Truncated to 12KB per phase, session-scoped.
- **Ideation/discovery skill** (`/discover`): Spawns 6 parallel specialist agents (Security, Quality, Tests, Performance, Documentation, Architecture) to scan a codebase and produce a prioritized improvement backlog at `.omc/discover/backlog.md`. Supports scoping to subdirectories.
- **Semantic merge resolution**: Extended git-master agent with `<Merge_Conflict_Resolution>` protocol for AI-assisted merge conflict resolution — reads full file context, resolves semantically, verifies with build/tests.

## [4.8.2-preview.3] - 2026-03-18

### Added
- Claude Code CLI as a supported team worker provider (`omc team N:claude "..."`)
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
