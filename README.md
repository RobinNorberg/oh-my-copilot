English | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md)

# oh-my-copilot

[![npm version](https://img.shields.io/npm/v/oh-my-copilot?color=cb3837)](https://www.npmjs.com/package/oh-my-copilot)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-copilot?color=blue)](https://www.npmjs.com/package/oh-my-copilot)
[![GitHub stars](https://img.shields.io/github/stars/RobinNorberg/oh-my-copilot?style=flat&color=yellow)](https://github.com/RobinNorberg/oh-my-copilot/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

> oh-my-copilot is a fork of [oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode) by Yeachan Heo, adapted for GitHub Copilot CLI.

> **For Codex users:** Check out [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) — the same orchestration experience for OpenAI Codex CLI.

**Multi-agent orchestration for Copilot CLI. Zero learning curve.**

_Don't learn Copilot CLI. Just use OMP._

[Get Started](#quick-start) • [Documentation](https://docs/REFERENCE.md) • [CLI Reference](https://docs/REFERENCE.md/docs.html#cli-reference) • [Workflows](https://docs/REFERENCE.md/docs.html#workflows) • [Migration Guide](docs/MIGRATION.md)

---

## Quick Start

**Step 1: Install**

```bash
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot
/plugin install oh-my-copilot
```

**Step 2: Setup**

```bash
/omg-setup
```

**Step 3: Build something**

```
autopilot: build a REST API for managing tasks
```

That's it. Everything else is automatic.

### Not Sure Where to Start?

If you're uncertain about requirements, have a vague idea, or want to micromanage the design:

```
/deep-interview "I want to build a task management app"
```

The deep interview uses Socratic questioning to clarify your thinking before any code is written. It exposes hidden assumptions and measures clarity across weighted dimensions, ensuring you know exactly what to build before execution begins.

## Team Mode (Recommended)

Starting in **v4.1.7**, **Team** is the canonical orchestration surface in OMP. The legacy `swarm` keyword/skill has been removed; use `team` directly.

```bash
/team 3:executor "fix all TypeScript errors"
```

Team runs as a staged pipeline:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Enable Copilot CLI native teams in `~/.copilot/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> If teams are disabled, OMP will warn you and fall back to non-team execution where possible.

### tmux CLI Workers — Codex & Gemini (v4.4.0+)

**v4.4.0 removes the Codex/Gemini MCP servers** (`x`, `g` providers). Use the CLI-first Team runtime (`omp team ...`) to spawn real tmux worker panes:

```bash
omp team 2:codex "review auth module for security issues"
omp team 2:gemini "redesign UI components for accessibility"
omp team 1:copilot "implement the payment flow"
omp team status auth-review
omp team shutdown auth-review
```

`/omg-teams` remains as a legacy compatibility skill and now routes to `omp team ...`.

For mixed Codex + Gemini work in one command, use the **`/ccg`** skill (routes via `ask-codex` + `ask-gemini`, then Copilot synthesizes):

```bash
/ccg Review this PR — architecture (Codex) and UI components (Gemini)
```

| Surface                   | Workers            | Best For                                     |
| ------------------------- | ------------------ | -------------------------------------------- |
| `omp team N:codex "..."`  | N Codex CLI panes  | Code review, security analysis, architecture |
| `omp team N:gemini "..."` | N Gemini CLI panes | UI/UX design, docs, large-context tasks      |
| `omp team N:copilot "..."` | N Copilot CLI panes | General tasks via Copilot CLI in tmux         |
| `/ccg`                    | ask-codex + ask-gemini | Tri-model advisor synthesis             |

Workers spawn on-demand and die when their task completes — no idle resource usage. Requires `codex` / `gemini` CLIs installed and an active tmux session.

> **Note: Package naming** — The project is branded as **oh-my-copilot** (repo, plugin, commands), but the npm package is published as [`oh-my-copilot`](https://www.npmjs.com/package/oh-my-copilot). If you install the CLI tools via npm/bun, use `npm install -g oh-my-copilot`.

### Updating

```bash
# 1. Update the marketplace clone
/plugin marketplace update omp

# 2. Re-run setup to refresh configuration
/omg-setup
```

> **Note:** If marketplace auto-update is not enabled, you must manually run `/plugin marketplace update omp` to sync the latest version before running setup.

If you experience issues after updating, clear the old plugin cache:

```bash
/omg-doctor
```

<h1 align="center">Your Copilot In Overdrive.</h1>

<p align="center">
  <img src="assets/omg-character.png" alt="oh-my-copilot" width="400" />
</p>

---

## Why oh-my-copilot?

- **Zero configuration required** - Works out of the box with intelligent defaults
- **Team-first orchestration** - Team is the canonical multi-agent surface
- **Natural language interface** - No commands to memorize, just describe what you want
- **Automatic parallelization** - Complex tasks distributed across specialized agents
- **Persistent execution** - Won't give up until the job is verified complete
- **Cost optimization** - Smart model routing saves 30-50% on tokens
- **Learn from experience** - Automatically extracts and reuses problem-solving patterns
- **Real-time visibility** - HUD statusline shows what's happening under the hood

---

## Features

### Orchestration Modes

Multiple strategies for different use cases — from Team-backed orchestration to token-efficient refactoring. [Learn more →](https://docs/REFERENCE.md/docs.html#execution-modes)

| Mode                    | What it is                                                                              | Use For                                                |
| ----------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Team (recommended)**  | Canonical staged pipeline (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Coordinated Copilot agents on a shared task list        |
| **omp team (CLI)**      | tmux CLI workers — real `copilot`/`codex`/`gemini` processes in split-panes              | Codex/Gemini CLI tasks; on-demand spawn, die when done |
| **ccg**                 | Tri-model advisors via ask-codex + ask-gemini, Copilot synthesizes                         | Mixed backend+UI work needing both Codex and Gemini    |
| **Autopilot**           | Autonomous execution (single lead agent)                                                | End-to-end feature work with minimal ceremony          |
| **Ultrawork**           | Maximum parallelism (non-team)                                                          | Burst parallel fixes/refactors where Team isn't needed |
| **Ralph**               | Persistent mode with verify/fix loops                                                   | Tasks that must complete fully (no silent partials)    |
| **Pipeline**            | Sequential, staged processing                                                           | Multi-step transformations with strict ordering        |
| **Ultrapilot (legacy)** | Deprecated compatibility mode (autopilot pipeline alias)                                | Existing workflows and older docs                      |

### Intelligent Orchestration

- **32 specialized agents** for architecture, research, design, testing, data science
- **Smart model routing** - Haiku for simple tasks, Opus for complex reasoning
- **Automatic delegation** - Right agent for the job, every time

### Developer Experience

- **Magic keywords** - `ralph`, `ulw`, `team` for explicit control
- **HUD statusline** - Real-time orchestration metrics in your status bar
- **Skill learning** - Extract reusable patterns from your sessions
- **Analytics & cost tracking** - Understand token usage across all sessions

[Full feature list →](docs/REFERENCE.md)

---

## Magic Keywords

Optional shortcuts for power users. Natural language works fine without them.

| Keyword                | Effect                                 | Example                                        |
| ---------------------- | -------------------------------------- | ---------------------------------------------- |
| `team`                 | Canonical Team orchestration           | `/team 3:executor "fix all TypeScript errors"` |
| `omp team`             | tmux CLI workers (codex/gemini/copilot) | `omp team 2:codex "security review"`           |
| `ccg`                  | ask-codex + ask-gemini synthesis       | `/ccg review this PR`                          |
| `autopilot`            | Full autonomous execution              | `autopilot: build a todo app`                  |
| `ralph`                | Persistence mode                       | `ralph: refactor auth`                         |
| `ulw`                  | Maximum parallelism                    | `ulw fix all errors`                           |
| `ralplan`              | Iterative planning consensus           | `ralplan this feature`                         |
| `deep-interview`       | Socratic requirements clarification    | `deep-interview "vague idea"`                  |
| `deepsearch`           | Codebase-focused search routing        | `deepsearch for auth middleware`               |
| `ultrathink`           | Deep reasoning mode                    | `ultrathink about this architecture`           |
| `ado triage`           | Azure DevOps work item triage          | `ado triage`                                   |
| `ado setup`            | Configure Azure DevOps integration     | `ado setup`                                    |
| `cancelomc`, `stopomc` | Stop active OMP modes                  | `stopomc`                                      |

**Notes:**

- **ralph includes ultrawork**: when you activate ralph mode, it automatically includes ultrawork's parallel execution.
- `swarm` compatibility alias has been removed; migrate existing prompts to `/team` syntax.
- `plan this` / `plan the` keyword triggers were removed; use `ralplan` or explicit `/oh-my-copilot:omg-plan`.

## Azure DevOps Integration

oh-my-copilot supports Azure DevOps natively — auto-detection, work item management, PR operations, and triage workflows.

### Auto-Detection

When your git remote points to `dev.azure.com` or `*.visualstudio.com`, OMP automatically:
- Detects the ADO platform on session start
- Injects available `mcp__azure-devops__*` MCP tool context into agent prompts
- Reads `.omg/config.json` for project-specific settings

### Setup

```bash
/oh-my-copilot:omg-ado-setup
```

This configures your ADO connection — verifies `az` CLI auth, auto-detects org/project from git remote, and writes `.omg/config.json`:

```json
{
  "version": 1,
  "platform": "azure-devops",
  "ado": {
    "org": "my-org",
    "project": "my-project",
    "defaultWorkItemType": "User Story",
    "areaPath": "MyProject\\Team Alpha",
    "iterationPath": "MyProject\\Sprint 5"
  }
}
```

Cross-project support: when code and work items live in different ADO projects, add `workItemOrg` and `workItemProject` fields.

### Triage

```bash
/oh-my-copilot:omg-ado-triage
```

Scans 5 ADO surfaces in parallel and produces a prioritized summary:
- Untriaged work items
- Your active work items
- Open pull requests with review status
- Pipeline build status
- Security alerts

Uses MCP tools when available, falls back to `az` CLI.

### Agent Awareness

Five agents have built-in ADO knowledge (planner, verifier, debugger, analyst, explore). They automatically use ADO MCP tools for:
- Work item queries and CRUD
- PR creation and review
- Build log investigation
- Cross-repo code search
- Wiki documentation lookup

### Provider API

The `AzureDevOpsProvider` exposes programmatic access:

| Method | Description |
|--------|-------------|
| `listWorkItems()` | WIQL queries with injection prevention |
| `createWorkItem()` | Create with type, area/iteration paths, tags |
| `addTag()` / `removeTag()` | Work item tag management |
| `addComment()` | Add discussion comments |
| `listPullRequests()` | List PRs by status |
| `createPullRequest()` | Create PR with source/target branches |
| `mergePullRequest()` | Complete a PR |

All commands use `execFileSync` with WIQL escaping for security.

---

## Utilities

### Provider Advisor (`omp ask`)

Run local provider CLIs and save a markdown artifact under `.omg/artifacts/ask/`:

```bash
omp ask copilot "review this migration plan"
omp ask codex --prompt "identify architecture risks"
omp ask gemini --prompt "propose UI polish ideas"
omp ask copilot --agent-prompt executor --prompt "draft implementation steps"
```

Canonical env vars:

- `OMC_ASK_ADVISOR_SCRIPT`
- `OMC_ASK_ORIGINAL_TASK`

Phase-1 aliases `OMX_ASK_ADVISOR_SCRIPT` and `OMX_ASK_ORIGINAL_TASK` are accepted with deprecation warnings.

### Rate Limit Wait

Auto-resume Copilot CLI sessions when rate limits reset.

```bash
omp wait          # Check status, get guidance
omp wait --start  # Enable auto-resume daemon
omp wait --stop   # Disable daemon
```

**Requires:** tmux (for session detection)

### Monitoring & Analytics

Use the HUD for live observability and `omp` for cost/session reporting:

- HUD analytics preset: `/oh-my-copilot:hud setup` then set `"omcHud": { "preset": "analytics" }`
- Cost reports: `omp cost daily|weekly|monthly`
- Session history/backfill: `omp sessions`, `omp backfill`
- Raw logs: `.omg/state/token-tracking.jsonl`, `.omg/state/agent-replay-*.jsonl`

### Notification Tags (Teams/Telegram/Discord/Slack)

You can configure who gets tagged when stop callbacks send session summaries.

```bash
# Set/replace tag list
omp config-stop-callback teams --enable --webhook <url> --tag-list "John Doe:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
omp config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omp config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"
omp config-stop-callback slack --enable --webhook <url> --tag-list "<!here>,<@U1234567890>"

# Incremental updates
omp config-stop-callback telegram --add-tag charlie
omp config-stop-callback discord --remove-tag @here
omp config-stop-callback discord --clear-tags
```

Tag behavior:

- Teams: `DisplayName:AAD-Object-ID` pairs for @mentions in Adaptive Cards (e.g. `"John Doe:xxxxxxxx-..."`).
- Telegram: `alice` becomes `@alice`
- Discord: supports `@here`, `@everyone`, numeric user IDs, and `role:<id>`
- Slack: supports `<@MEMBER_ID>`, `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^GROUP_ID>`
- `file` callbacks ignore tag options

---

## Documentation

- **[Full Reference](docs/REFERENCE.md)** - Complete feature documentation
- **[CLI Reference](https://docs/REFERENCE.md/docs.html#cli-reference)** - All `omp` commands, flags, and tools
- **[Notifications Guide](https://docs/REFERENCE.md/docs.html#notifications)** - Discord, Telegram, Slack, Teams, and webhook setup
- **[Recommended Workflows](https://docs/REFERENCE.md/docs.html#workflows)** - Battle-tested skill chains for common tasks
- **[Release Notes](https://docs/REFERENCE.md/docs.html#release-notes)** - What's new in each version
- **[Website](https://docs/REFERENCE.md)** - Interactive guides and examples
- **[Migration Guide](docs/MIGRATION.md)** - Upgrade from v2.x
- **[Architecture](docs/ARCHITECTURE.md)** - How it works under the hood
- **[Performance Monitoring](docs/PERFORMANCE-MONITORING.md)** - Agent tracking, debugging, and optimization

---

## Requirements

- [Copilot CLI](https://docs.github.com/copilot-cli) CLI

### Platform & tmux

OMP features like `omp team` and rate-limit detection require **tmux**:

| Platform       | tmux provider                                            | Install                |
| -------------- | -------------------------------------------------------- | ---------------------- |
| macOS          | [tmux](https://github.com/tmux/tmux)                    | `brew install tmux`    |
| Ubuntu/Debian  | tmux                                                     | `sudo apt install tmux`|
| Fedora         | tmux                                                     | `sudo dnf install tmux`|
| Arch           | tmux                                                     | `sudo pacman -S tmux`  |
| Windows        | [psmux](https://github.com/marlocarlo/psmux) (native)   | `winget install psmux` |
| Windows (WSL2) | tmux (inside WSL)                                        | `sudo apt install tmux`|

> **Windows users:** [psmux](https://github.com/marlocarlo/psmux) provides a native `tmux` binary for Windows with 76 tmux-compatible commands. No WSL required.

### Optional: Multi-AI Orchestration

OMP can optionally orchestrate external AI providers for cross-validation and design consistency. These are **not required** — OMP works fully without them.

| Provider                                                  | Install                             | What it enables                                  |
| --------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Design review, UI consistency (1M token context) |
| [Codex CLI](https://github.com/openai/codex)              | `npm install -g @openai/codex`      | Architecture validation, code review cross-check |

**Cost:** 3 Pro plans (Copilot + Gemini + ChatGPT) cover everything for ~$60/month.

---

## License

MIT

---

<div align="center">

**Inspired by:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [copilot-hud](https://github.com/ryanjoachim/copilot-hud) • [Superpowers](https://github.com/obra/superpowers) • [everything-copilot-cli](https://github.com/affaan-m/everything-copilot-cli) • [Ouroboros](https://github.com/Q00/ouroboros)

**Zero learning curve. Maximum power.**

</div>

