# Reference Documentation

Complete reference for oh-my-copilot. For quick start, see the main [README.md](../README.md).

---

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [CLI Commands: ask/team](#cli-commands-askteam)
- [Agents (18 Total)](#agents-18-total)
- [Skills (37 Total)](#skills-37-total)
- [Slash Commands](#slash-commands)
- [Hooks System](#hooks-system)
- [Magic Keywords](#magic-keywords)
- [Platform Support](#platform-support)
- [Performance Monitoring](#performance-monitoring)
- [Troubleshooting](#troubleshooting)
- [Changelog](#changelog)

---

## Installation

**Only the Copilot CLI Plugin method is supported.** Other installation methods (npm, bun, curl) are deprecated and may not work correctly.

### Copilot CLI Plugin (Required)

```bash
# Step 1: Add the marketplace
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot

# Step 2: Install the plugin
/plugin install oh-my-copilot
```

This integrates directly with Copilot CLI's plugin system and uses Node.js hooks.

> **Note**: Direct npm/bun global installs are **not supported**. The plugin system handles all installation and hook setup automatically.

### Requirements

- [Copilot CLI](https://docs.github.com/copilot-cli) installed
- One of:
  - **Copilot Max/Pro subscription** (recommended for individuals)
  - **Anthropic API key** (`ANTHROPIC_API_KEY` environment variable)

---

## Configuration

### Project-Scoped Configuration (Recommended)

Configure omc for the current project only:

```
/oh-my-copilot:omc-setup --local
```

- Creates `./.copilot/copilot-instructions.md` in your current project
- Configuration applies only to this project
- Won't affect other projects or global settings
- **Safe**: Preserves your global copilot-instructions.md

### Global Configuration

Configure omc for all Copilot CLI sessions:

```
/oh-my-copilot:omc-setup
```

- Creates `~/.copilot/copilot-instructions.md` globally
- Configuration applies to all projects
- **Warning**: Completely overwrites existing `~/.copilot/copilot-instructions.md`

### What Configuration Enables

| Feature           | Without     | With omc Config            |
| ----------------- | ----------- | -------------------------- |
| Agent delegation  | Manual only | Automatic based on task    |
| Keyword detection | Disabled    | ultrawork, search, with informational-query filtering |
| Todo continuation | Basic       | Enforced completion        |
| Model routing     | Default     | Smart tier selection       |
| Skill composition | None        | Auto-combines skills       |

### Configuration Precedence

If both configurations exist, **project-scoped takes precedence** over global:

```
./.copilot/copilot-instructions.md  (project)   →  Overrides  →  ~/.copilot/copilot-instructions.md  (global)
```

### Environment Variables

| Variable                   | Default              | Description                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OMC_STATE_DIR`            | _(unset)_            | Centralized state directory. When set, OMC stores state at `$OMC_STATE_DIR/{project-id}/` instead of `{worktree}/.omg/`. This preserves state across worktree deletions. The project identifier is derived from the git remote URL (or worktree path for local-only repos). |
| `OMC_BRIDGE_SCRIPT`        | _(auto-detected)_    | Path to the Python bridge script                                                                                                                                                                                                                                            |
| `OMC_PARALLEL_EXECUTION`   | `true`               | Enable/disable parallel agent execution                                                                                                                                                                                                                                     |
| `OMC_CODEX_DEFAULT_MODEL`  | _(provider default)_ | Default model for Codex CLI workers                                                                                                                                                                                                                                         |
| `OMC_GEMINI_DEFAULT_MODEL` | _(provider default)_ | Default model for Gemini CLI workers                                                                                                                                                                                                                                        |
| `OMC_LSP_TIMEOUT_MS`                | `15000`              | Timeout (ms) for LSP requests. Increase for large repos or slow language servers                                                                                                                                                                                            |
| `OMC_LSP_IDLE_TIMEOUT_MS`           | `300000` (5 min)     | Idle timeout before evicting unused LSP clients                                                                                                                                                                                                                             |
| `OMC_LSP_IDLE_CHECK_INTERVAL_MS`    | `60000` (1 min)      | Interval for checking idle LSP clients                                                                                                                                                                                                                                      |
| `DISABLE_OMC`                       | _(unset)_            | Set to any value to disable all OMC hooks                                                                                                                                                                                                                                   |
| `OMC_SKIP_HOOKS`                    | _(unset)_            | Comma-separated list of hook names to skip                                                                                                                                                                                                                                  |

#### Centralized State with `OMC_STATE_DIR`

By default, OMC stores state in `{worktree}/.omg/`. This is lost when worktrees are deleted. To preserve state across worktree lifecycles, set `OMC_STATE_DIR`:

```bash
# In your shell profile (~/.bashrc, ~/.zshrc, etc.)
export OMC_STATE_DIR="$HOME/.copilot/omc"
```

This resolves to `~/.copilot/omc/{project-identifier}/` where the project identifier uses a hash of the git remote URL (stable across worktrees/clones) with a fallback to the directory path hash for local-only repos.

If both a legacy `{worktree}/.omg/` directory and a centralized directory exist, OMC logs a notice and uses the centralized directory. You can then migrate data from the legacy directory and remove it.

### When to Re-run Setup

- **First time**: Run after installation (choose project or global)
- **After updates**: Re-run to get the latest configuration
- **Different machines**: Run on each machine where you use Copilot CLI
- **New projects**: Run `/oh-my-copilot:omc-setup --local` in each project that needs omc

> **NOTE**: After updating the plugin (via `npm update`, `git pull`, or Copilot CLI's plugin update), you MUST re-run `/oh-my-copilot:omc-setup` to apply the latest copilot-instructions.md changes.

### Agent Customization

Edit agent files in `~/.copilot/agents/` to customize behavior:

```yaml
---
name: architect
description: Your custom description
tools: Read, Grep, Glob, Bash, Edit
model: opus # or sonnet, haiku
---
Your custom system prompt here...
```

### Project-Level Config

Create `.copilot/copilot-instructions.md` in your project for project-specific instructions:

```markdown
# Project Context

This is a TypeScript monorepo using:

- Bun runtime
- React for frontend
- PostgreSQL database

## Conventions

- Use functional components
- All API routes in /src/api
- Tests alongside source files
```

### Stop Callback Notification Tags

Configure tags for Telegram/Discord stop callbacks with `omc config-stop-callback`.

```bash
# Set/replace tags
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"

# Incremental updates
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags

# Inspect current callback config
omc config-stop-callback telegram --show
omc config-stop-callback discord --show
```

Tag behavior:

- Telegram: `alice` is normalized to `@alice`
- Discord: supports `@here`, `@everyone`, numeric user IDs (`<@id>`), and role tags (`role:<id>` -> `<@&id>`)
- `file` callbacks ignore tag options

---

## CLI Commands: ask/team

### `omc ask`

```bash
omc ask copilot "review this patch"
omc ask codex "review this patch from a security perspective"
omc ask gemini --prompt "suggest UX improvements"
omc ask copilot --agent-prompt executor --prompt "create an implementation plan"
```

- Provider matrix: `copilot | codex | gemini`
- Artifacts: `.omg/artifacts/ask/{provider}-{slug}-{timestamp}.md`
- Canonical env vars: `OMC_ASK_ADVISOR_SCRIPT`, `OMC_ASK_ORIGINAL_TASK`
- Skill shortcuts: `/oh-my-copilot:ask-codex` and `/oh-my-copilot:ask-gemini` route to this command

### `omc team` (CLI runtime surface)

```bash
omc team 2:codex "review auth flow"
omc team status review-auth-flow
omc team shutdown review-auth-flow --force
omc team api claim-task --input '{"team_name":"auth-review","task_id":"1","worker":"worker-1"}' --json
```

Supported entrypoints: direct start (`omc team [N:agent] "<task>"`), `status`, `shutdown`, and `api`.

### `omc autoresearch`

```bash
omc autoresearch <topic>
omc autoresearch guided <topic>
omc autoresearch intake <topic>
```

Thin-supervisor autoresearch with keep/discard/reset parity. Supports guided and intake flows.

### `omc ralphthon`

```bash
omc ralphthon <task>
```

Autonomous hackathon lifecycle mode with PRD-driven phases and idle detection.

---

## Agents (18 Total)

Always use `oh-my-copilot:` prefix when calling via Task tool.

### By Domain and Tier

| Domain           | LOW (Haiku)             | MEDIUM (Sonnet)       | HIGH (Opus)         |
| ---------------- | ----------------------- | --------------------- | ------------------- |
| **Analysis**     | `architect-low`         | `architect-medium`    | `architect`         |
| **Execution**    | `executor-low`          | `executor`            | `executor-high`     |
| **Search**       | `explore`               | -                     | `explore-high`      |
| **Research**     | -                       | `document-specialist` | -                   |
| **Frontend**     | `designer-low`          | `designer`            | `designer-high`     |
| **Docs**         | `writer`                | -                     | -                   |
| **Visual**       | -                       | `vision`              | -                   |
| **Planning**     | -                       | -                     | `planner`           |
| **Critique**     | -                       | -                     | `critic`            |
| **Pre-Planning** | -                       | -                     | `analyst`           |
| **Testing**      | -                       | `qa-tester`           | -                   |
| **Security**     | `security-reviewer-low` | -                     | `security-reviewer` |
| **Build**        | -                       | `debugger`            | -                   |
| **TDD**          | -                       | `test-engineer`       | -                   |
| **Code Review**  | -                       | -                     | `code-reviewer`     |
| **Data Science** | -                       | `scientist`           | `scientist-high`    |

### Agent Selection Guide

| Task Type                    | Best Agent                    | Model  |
| ---------------------------- | ----------------------------- | ------ |
| Quick code lookup            | `explore`                     | haiku  |
| Find files/patterns          | `explore`                     | haiku  |
| Complex architectural search | `explore-high`                | opus   |
| Simple code change           | `executor-low`                | haiku  |
| Feature implementation       | `executor`                    | sonnet |
| Complex refactoring          | `executor-high`               | opus   |
| Debug simple issue           | `architect-low`               | haiku  |
| Debug complex issue          | `architect`                   | opus   |
| UI component                 | `designer`                    | sonnet |
| Complex UI system            | `designer-high`               | opus   |
| Write docs/comments          | `writer`                      | haiku  |
| Research docs/APIs           | `document-specialist`         | sonnet |
| Analyze images/diagrams      | `vision`                      | sonnet |
| Strategic planning           | `planner`                     | opus   |
| Review/critique plan         | `critic`                      | opus   |
| Pre-planning analysis        | `analyst`                     | opus   |
| Test CLI interactively       | `qa-tester`                   | sonnet |
| Security review              | `security-reviewer`           | opus   |
| Quick security scan          | `security-reviewer-low`       | haiku  |
| Fix build errors             | `debugger`                    | sonnet |
| Simple build fix             | `debugger` (model=haiku)      | haiku  |
| TDD workflow                 | `test-engineer`               | sonnet |
| Quick test suggestions       | `test-engineer` (model=haiku) | haiku  |
| Code review                  | `code-reviewer`               | opus   |
| Quick code check             | `code-reviewer` (model=haiku) | haiku  |
| Data analysis/stats          | `scientist`                   | sonnet |
| Quick data inspection        | `scientist` (model=haiku)     | haiku  |
| Complex ML/hypothesis        | `scientist-high`              | opus   |

---

## Skills (37 Total)

Includes **37 canonical skills**.

| Skill                     | Description                                                      | Manual Command                              |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `ask-codex`               | Ask Codex via `omc ask codex` and store an ask artifact          | `/oh-my-copilot:ask-codex`               |
| `ask-gemini`              | Ask Gemini via `omc ask gemini` and store an ask artifact        | `/oh-my-copilot:ask-gemini`              |
| `autoresearch`            | Thin-supervisor autoresearch with keep/discard/reset             | `/oh-my-copilot:autoresearch`            |
| `autopilot`               | Full autonomous execution from idea to working code              | `/oh-my-copilot:autopilot`               |
| `cancel`                  | Unified cancellation for active modes                            | `/oh-my-copilot:cancel`                  |
| `ccg`                     | Tri-model workflow via `ask-codex` + `ask-gemini`, then Copilot synthesis | `/oh-my-copilot:ccg`                     |
| `configure-notifications` | Configure notifications (Teams/Discord/Telegram/Slack)           | `/oh-my-copilot:configure-notifications` |
| `deep-interview`          | Socratic deep interview with ambiguity gating                    | `/oh-my-copilot:deep-interview`          |
| `deep-dive`               | 2-stage pipeline: trace → deep-interview with 3-point injection  | `/oh-my-copilot:deep-dive`               |
| `deep-review`             | Multi-pass code review (security, quality, structural + validation)  | `/oh-my-copilot:deep-review`             |
| `discover`                | Parallel codebase quality scan with prioritized backlog              | `/oh-my-copilot:discover`                |
| `deepinit`                | Generate hierarchical AGENTS.md docs                             | `/oh-my-copilot:deepinit`                |
| `external-context`        | Parallel document-specialist research                            | `/oh-my-copilot:external-context`        |
| `learn-about-omc`         | Analyze OMC usage patterns                                       | `/oh-my-copilot:learn-about-omc`         |
| `learner`                 | Extract reusable skill from session                              | `/oh-my-copilot:learner`                 |
| `mcp-setup`               | Configure MCP servers                                            | `/oh-my-copilot:mcp-setup`               |
| `note`                    | Save notes to notepad                                            | `/oh-my-copilot:note`                    |
| `omc-doctor`              | Diagnose and fix installation issues                             | `/oh-my-copilot:omc-doctor`              |
| `omc-help`                | Show OMC usage guide                                             | `/oh-my-copilot:omc-help`                |
| `omc-plan`                | Planning workflow (`/plan` safe alias)                           | `/oh-my-copilot:omc-plan`                |
| `omc-setup`               | One-time setup wizard                                            | `/oh-my-copilot:omc-setup`               |
| `omc-teams`               | Legacy compatibility wrapper for `omc team` CLI                  | `/oh-my-copilot:omc-teams`               |
| `project-session-manager` | Manage isolated dev environments (git worktrees + tmux)          | `/oh-my-copilot:project-session-manager` |
| `ralph`                   | Persistence loop until verified completion                       | `/oh-my-copilot:ralph`                   |
| `ralph-init`              | Initialize PRD for structured ralph execution                    | `/oh-my-copilot:ralph-init`              |
| `ralplan`                 | Consensus planning alias for `/omc-plan --consensus`             | `/oh-my-copilot:ralplan`                 |
| `ralphthon`               | Autonomous hackathon lifecycle mode                              | `/oh-my-copilot:ralphthon`               |
| `release`                 | Automated release workflow                                       | `/oh-my-copilot:release`                 |
| `sciomc`                  | Parallel scientist orchestration                                 | `/oh-my-copilot:sciomc`                  |
| `skill`                   | Manage local skills (list/add/remove/search/edit)                | `/oh-my-copilot:skill`                   |
| `team`                    | Coordinated multi-agent workflow                                 | `/oh-my-copilot:team`                    |
| `trace`                   | Show orchestration trace timeline                                | `/oh-my-copilot:trace`                   |
| `ultraqa`                 | QA cycle until goal is met                                       | `/oh-my-copilot:ultraqa`                 |
| `ultrawork`               | Maximum parallel throughput mode                                 | `/oh-my-copilot:ultrawork`               |
| `writer-memory`           | Agentic memory system for writing projects                       | `/oh-my-copilot:writer-memory`           |

---

## Slash Commands

All installed skills are available as slash commands with the prefix `/oh-my-copilot:`. Compatibility keyword modes like `deep-analyze` and `tdd` are prompt-triggered behaviors, not standalone slash commands.

| Command                                     | Description                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/oh-my-copilot:autoresearch <topic>`    | Launch thin-supervisor autoresearch                                                           |
| `/oh-my-copilot:autopilot <task>`        | Full autonomous execution                                                                     |
| `/oh-my-copilot:ultrawork <task>`        | Maximum performance mode with parallel agents                                                 |
| `/oh-my-copilot:team <N>:<agent> <task>` | Coordinated native team workflow                                                              |
| `/oh-my-copilot:ralph-init <task>`       | Initialize PRD for structured task tracking                                                   |
| `/oh-my-copilot:ralph <task>`            | Self-referential loop until task completion                                                   |
| `/oh-my-copilot:ultraqa <goal>`          | Autonomous QA cycling workflow                                                                |
| `/oh-my-copilot:omc-plan <description>`  | Start planning session (supports consensus structured deliberation)                           |
| `/oh-my-copilot:ralplan <description>`   | Iterative planning with consensus structured deliberation (`--deliberate` for high-risk mode) |
| `/oh-my-copilot:ralphthon <task>`        | Autonomous hackathon lifecycle                                                                |
| `/oh-my-copilot:deep-dive <issue>`       | Trace → deep-interview pipeline                                                               |
| `/oh-my-copilot:deep-interview <idea>`   | Socratic interview with ambiguity scoring before execution                                    |
| `/oh-my-copilot:deep-review`           | Multi-pass code review with validation                                            |
| `/oh-my-copilot:discover [scope]`      | Parallel specialist scan with prioritized backlog                                 |
| `/oh-my-copilot:deepinit [path]`         | Index codebase with hierarchical AGENTS.md files                                              |
| `/oh-my-copilot:sciomc <topic>`          | Parallel research orchestration                                                               |
| `/oh-my-copilot:learner`                 | Extract reusable skill from session                                                           |
| `/oh-my-copilot:note <content>`          | Save notes to notepad.md                                                                      |
| `/oh-my-copilot:cancel`                  | Unified cancellation                                                                          |
| `/oh-my-copilot:omc-setup`               | One-time setup wizard                                                                         |
| `/oh-my-copilot:omc-doctor`              | Diagnose and fix installation issues                                                          |
| `/oh-my-copilot:omc-help`                | Show OMC usage guide                                                                          |
| `/oh-my-copilot:release`                 | Automated release workflow                                                                    |
| `/oh-my-copilot:mcp-setup`               | Configure MCP servers                                                                         |
| `/oh-my-copilot:trace`                   | Show orchestration trace timeline                                                             |

---

## Hooks System

Oh-my-copilot-cli includes 31 lifecycle hooks that enhance Copilot CLI's behavior.

### Execution Mode Hooks

| Hook              | Description                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `autopilot`       | Full autonomous execution from idea to working code                         |
| `ultrawork`       | Maximum parallel agent execution                                            |
| `ralph`           | Persistence until verified complete                                         |
| `team-pipeline`   | Native team staged pipeline orchestration                                   |
| `ultraqa`         | QA cycling until goal met                                                   |
| `mode-registry`   | Tracks active execution mode state (including team/ralph/ultrawork/ralplan) |
| `persistent-mode` | Maintains mode state across sessions                                        |

### Core Hooks

| Hook                 | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `rules-injector`     | Dynamic rules injection with YAML frontmatter parsing |
| `omc-orchestrator`   | Enforces orchestrator behavior and delegation         |
| `auto-slash-command` | Automatic slash command detection and execution       |
| `keyword-detector`   | Magic keyword detection (ultrawork, ralph, etc.) (with informational intent filtering — questions like "what is ralph?" won't trigger modes) |
| `skill-state`        | Skill active-state management with collision prevention |
| `todo-continuation`  | Ensures todo list completion                          |
| `notepad`            | Compaction-resilient memory system                    |
| `learner`            | Skill extraction from conversations                   |

### Context & Recovery

| Hook                        | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `recovery`                  | Edit error, session, and context window recovery |
| `preemptive-compaction`     | Context usage monitoring to prevent limits       |
| `pre-compact`               | Pre-compaction processing                        |
| `directory-readme-injector` | README context injection                         |

### Quality & Validation

| Hook                       | Description                                            |
| -------------------------- | ------------------------------------------------------ |
| `comment-checker`          | BDD detection and directive filtering                  |
| `thinking-block-validator` | Extended thinking validation                           |
| `empty-message-sanitizer`  | Empty message handling                                 |
| `permission-handler`       | Permission requests and validation                     |
| `think-mode`               | Extended thinking detection                            |
| `code-simplifier`          | Auto-simplify recently modified files on Stop (opt-in) |

### Code Simplifier Hook

The `code-simplifier` Stop hook automatically delegates recently modified source files to the
`code-simplifier` agent after each Copilot turn. It is **disabled by default** and must be
explicitly enabled via `~/.omg/config.json`.

**Enable:**

```json
{
  "codeSimplifier": {
    "enabled": true
  }
}
```

**Full config options:**

```json
{
  "codeSimplifier": {
    "enabled": true,
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"],
    "maxFiles": 10
  }
}
```

| Option       | Type       | Default                                         | Description                        |
| ------------ | ---------- | ----------------------------------------------- | ---------------------------------- |
| `enabled`    | `boolean`  | `false`                                         | Opt-in to automatic simplification |
| `extensions` | `string[]` | `[".ts",".tsx",".js",".jsx",".py",".go",".rs"]` | File extensions to consider        |
| `maxFiles`   | `number`   | `10`                                            | Maximum files simplified per turn  |

**How it works:**

1. When Copilot stops, the hook runs `git diff HEAD --name-only` to find modified files
2. If modified source files are found, the hook injects a message asking Copilot to delegate to the `code-simplifier` agent
3. The agent simplifies the files for clarity and consistency without changing behavior
4. A turn-scoped marker prevents the hook from triggering more than once per turn cycle

### Coordination & Environment

| Hook                      | Description                              |
| ------------------------- | ---------------------------------------- |
| `subagent-tracker`        | Tracks spawned sub-agents                |
| `session-end`             | Session termination handling             |
| `non-interactive-env`     | CI/non-interactive environment handling  |
| `agent-usage-reminder`    | Reminder to use specialized agents       |
| `background-notification` | Background task completion notifications |
| `plugin-patterns`         | Plugin pattern detection                 |
| `setup`                   | Initial setup and configuration          |

---

## Magic Keywords

Use these trigger phrases in natural language prompts to activate enhanced modes:

| Keyword                                                 | Effect                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ultrawork`, `ulw`                                      | Activates parallel agent orchestration                                                        |
| `autopilot`, `build me`, `I want a`                     | Full autonomous execution                                                                     |
| `ralph`, `don't stop`, `must complete`                  | Persistence until verified complete                                                           |
| `ccg`, `copilot-clix-gemini`                            | Copilot-Codex-Gemini orchestration                                                             |
| `ralplan`                                               | Iterative planning consensus with structured deliberation (`--deliberate` for high-risk mode) |
| `deep interview`, `ouroboros`                           | Deep Socratic interview with mathematical clarity gating                                      |
| `deepsearch`, `search the codebase`, `find in codebase` | Codebase-focused search mode (with informational intent filtering — questions like "what is ralph?" won't trigger the keyword) |
| `deepanalyze`, `deep-analyze`                           | Deep analysis mode                                                                            |
| `ultrathink`                                            | Deep reasoning mode                                                                           |
| `tdd`, `test first`, `red green`                        | TDD workflow enforcement                                                                      |
| `ralphthon`                                             | Autonomous hackathon lifecycle mode                                                           |
| `cancelomc`, `stopomc`                                  | Unified cancellation                                                                          |

### Examples

```bash
# In Copilot CLI:

# Maximum parallelism
ultrawork implement user authentication with OAuth

# Enhanced search
deepsearch for files that import the utils module

# Deep analysis
deep-analyze why the tests are failing

# Autonomous execution
autopilot: build a todo app with React

# Parallel autonomous execution
team 3:executor "build a fullstack todo app"

# Persistence mode
ralph: refactor the authentication module

# Planning session
ralplan this feature

# TDD workflow
tdd: implement password validation

# Stop active orchestration
stopomc
```

---

## Platform Support

### Operating Systems

| Platform    | Install Method              | Hook Type      |
| ----------- | --------------------------- | -------------- |
| **Windows** | WSL2 recommended (see note) | Node.js (.mjs) |
| **macOS**   | curl or npm                 | Bash (.sh)     |
| **Linux**   | curl or npm                 | Bash (.sh)     |

> **Note**: Bash hooks are fully portable across macOS and Linux (no GNU-specific dependencies).

> **Windows**: Native Windows (win32) support is experimental. OMC requires tmux, which is not available on native Windows. **WSL2 is strongly recommended** for Windows users. See the [WSL2 installation guide](https://learn.microsoft.com/en-us/windows/wsl/install). Native Windows issues may have limited support.

> **Advanced**: Set `OMC_USE_NODE_HOOKS=1` to use Node.js hooks on macOS/Linux.

### Available Tools

| Tool          | Status       | Description           |
| ------------- | ------------ | --------------------- |
| **Read**      | ✅ Available | Read files            |
| **Write**     | ✅ Available | Create files          |
| **Edit**      | ✅ Available | Modify files          |
| **Bash**      | ✅ Available | Run shell commands    |
| **Glob**      | ✅ Available | Find files by pattern |
| **Grep**      | ✅ Available | Search file contents  |
| **WebSearch** | ✅ Available | Search the web        |
| **WebFetch**  | ✅ Available | Fetch web pages       |
| **Task**      | ✅ Available | Spawn subagents       |
| **TodoWrite** | ✅ Available | Track tasks           |

### LSP Tools (Real Implementation)

| Tool                        | Status         | Description                                 |
| --------------------------- | -------------- | ------------------------------------------- |
| `lsp_hover`                 | ✅ Implemented | Get type info and documentation at position |
| `lsp_goto_definition`       | ✅ Implemented | Jump to symbol definition                   |
| `lsp_find_references`       | ✅ Implemented | Find all usages of a symbol                 |
| `lsp_document_symbols`      | ✅ Implemented | Get file outline (functions, classes, etc.) |
| `lsp_workspace_symbols`     | ✅ Implemented | Search symbols across workspace             |
| `lsp_diagnostics`           | ✅ Implemented | Get errors, warnings, hints                 |
| `lsp_prepare_rename`        | ✅ Implemented | Check if rename is valid                    |
| `lsp_rename`                | ✅ Implemented | Rename symbol across project                |
| `lsp_code_actions`          | ✅ Implemented | Get available refactorings                  |
| `lsp_code_action_resolve`   | ✅ Implemented | Get details of a code action                |
| `lsp_servers`               | ✅ Implemented | List available language servers             |
| `lsp_diagnostics_directory` | ✅ Implemented | Project-level type checking                 |

> **Note**: LSP tools require language servers to be installed (typescript-language-server, pylsp, rust-analyzer, gopls, etc.). Use `lsp_servers` to check installation status.

### AST Tools (ast-grep Integration)

| Tool               | Status         | Description                                  |
| ------------------ | -------------- | -------------------------------------------- |
| `ast_grep_search`  | ✅ Implemented | Pattern-based code search using AST matching |
| `ast_grep_replace` | ✅ Implemented | Pattern-based code transformation            |

> **Note**: AST tools use [@ast-grep/napi](https://ast-grep.github.io/) for structural code matching. Supports meta-variables like `$VAR` (single node) and `$$$` (multiple nodes).

---

## Performance Monitoring

oh-my-copilot includes comprehensive monitoring for agent performance, token usage, and debugging parallel workflows.

For complete documentation, see **[Performance Monitoring Guide](./PERFORMANCE-MONITORING.md)**.

### Quick Overview

| Feature                 | Description                                     | Access                               |
| ----------------------- | ----------------------------------------------- | ------------------------------------ |
| **Agent Observatory**   | Real-time agent status, efficiency, bottlenecks | HUD / API                            |
| **Token Analytics**     | Cost tracking, usage reports, budget warnings   | HUD (`analytics` preset), `omc cost` |
| **Session Replay**      | Event timeline for post-session analysis        | `.omg/state/agent-replay-*.jsonl`    |
| **Intervention System** | Auto-detection of stale agents, cost overruns   | Automatic                            |

### CLI Commands

```bash
omc                # Default analytics dashboard
omc cost daily     # Daily cost report
omc cost weekly    # Weekly cost report
omc backfill       # Import historical transcript data
# Agent breakdown: use HUD observatory / replay logs
```

### HUD Analytics Preset

Enable detailed cost tracking in your status line:

```json
{
  "omcHud": {
    "preset": "analytics"
  }
}
```

### External Resources

- **[MarginLab.ai](https://marginlab.ai)** - SWE-Bench-Pro performance tracking with statistical significance testing for detecting Copilot model degradation

---

## Troubleshooting

### Diagnose Installation Issues

```bash
/oh-my-copilot:omc-doctor
```

Checks for:

- Missing dependencies
- Configuration errors
- Hook installation status
- Agent availability
- Skill registration

### Configure HUD Statusline

```bash
/oh-my-copilot:hud setup
```

Installs or repairs the HUD statusline for real-time status updates.

### HUD Configuration (settings.json)

Configure HUD elements in `~/.copilot/settings.json`:

```json
{
  "omcHud": {
    "preset": "focused",
    "elements": {
      "cwd": true,
      "gitRepo": true,
      "gitBranch": true
    }
  }
}
```

| Element      | Description                    | Default |
| ------------ | ------------------------------ | ------- |
| `cwd`        | Show current working directory | `false` |
| `gitRepo`    | Show git repository name       | `false` |
| `gitBranch`  | Show current git branch        | `false` |
| `omcLabel`   | Show [OMC] label               | `true`  |
| `contextBar` | Show context window usage      | `true`  |
| `agents`     | Show active agents count       | `true`  |
| `todos`      | Show todo progress             | `true`  |
| `ralph`      | Show ralph loop status         | `true`  |
| `autopilot`      | Show autopilot status              | `true`  |
| `sessionSummary` | Show AI-generated session summary  | `false` |

Additional `omcHud` layout options (top-level):

| Option     | Description                                                                       | Default    |
| ---------- | --------------------------------------------------------------------------------- | ---------- |
| `maxWidth` | Maximum HUD line width (terminal columns)                                         | unset      |
| `wrapMode` | `truncate` (ellipsis) or `wrap` (break at `\|` boundaries) when `maxWidth` is set | `truncate` |

Available presets: `minimal`, `focused`, `full`, `dense`, `analytics`, `opencode`

### Common Issues

| Issue                 | Solution                                                                         |
| --------------------- | -------------------------------------------------------------------------------- |
| Commands not found    | Re-run `/oh-my-copilot:omc-setup`                                             |
| Hooks not executing   | Check hook permissions: `chmod +x ~/.copilot/hooks/**/*.sh`                       |
| Agents not delegating | Verify copilot-instructions.md is loaded: check `./.copilot/copilot-instructions.md` or `~/.copilot/copilot-instructions.md` |
| LSP tools not working | Install language servers: `npm install -g typescript-language-server`            |
| Token limit errors    | Use `/oh-my-copilot:` for token-efficient execution                           |

### Auto-Update

Oh-my-copilot-cli includes a silent auto-update system that checks for updates in the background.

Features:

- **Rate-limited**: Checks at most once every 24 hours
- **Concurrent-safe**: Lock file prevents simultaneous update attempts
- **Cross-platform**: Works on both macOS and Linux

To manually update, re-run the plugin install command or use Copilot CLI's built-in update mechanism.

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/RobinNorberg/oh-my-copilot/main/scripts/uninstall.sh | bash
```

Or manually:

```bash
rm ~/.copilot/agents/{architect,document-specialist,explore,designer,writer,vision,critic,analyst,executor,qa-tester}.md
rm ~/.copilot/commands/{analyze,autopilot,deepsearch,plan,review,ultrawork}.md
```

---

## Changelog

See [CHANGELOG.md](../CHANGELOG.md) for version history and release notes.

---

## License

MIT - see [LICENSE](../LICENSE)

## Credits

Inspired by [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) by code-yeongyu.
