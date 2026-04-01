# oh-my-copilot

[![npm version](https://img.shields.io/npm/v/oh-my-copilot?color=cb3837)](https://www.npmjs.com/package/oh-my-copilot)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-copilot?color=blue)](https://www.npmjs.com/package/oh-my-copilot)
[![GitHub stars](https://img.shields.io/github/stars/RobinNorberg/oh-my-copilot?style=flat&color=yellow)](https://github.com/RobinNorberg/oh-my-copilot/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
<br/>This work is based on [oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode) by Yeachan Heo.



<h1 align="center">Turbocharge your Copilot CLI with multi-agent orchestration.</h1>
<p align="center">
  <img src="assets/omc-character.png" alt="oh-my-copilot" width="400" />
  </br>
  <strong><i>Your Copilot has been working out, learning new ways to improve your life.</i></strong>
</p>

---

## Quick Start

**Step 1: Install**

```bash
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot
/plugin install oh-my-copilot
```

**Step 2: Setup**

```bash
/omc-setup
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

The deep interview uses Socratic questioning to clarify your thinking before any code is written.

---

## Key Features

- **Zero configuration required** — works out of the box with intelligent defaults
- **Team-first orchestration** — staged pipeline with plan, PRD, exec, verify, and fix loop
- **Natural language interface** — no commands to memorize, just describe what you want
- **Automatic parallelization** — complex tasks distributed across our specialized agents
- **Persistent execution** — won't give up until the job is verified complete
- **Smart model routing** — Haiku for simple tasks, Sonnet for average and Opus for complex reasoning (30–50% token savings)
- **Azure DevOps/GitHub native** — auto-detection, work item management, PR operations, triage workflows
- **Stop your yolo abuse** — using a layered permission model to help your agents perform safe work without your interference
---

## Team Mode

**Team** is the canonical orchestration surface. It runs a staged pipeline:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

```bash
/team 3:executor "fix all TypeScript errors"
```

Spawn real tmux workers for cross-model tasks:

```bash
omc team 2:codex "review auth module for security issues"
omc team 2:gemini "redesign UI components for accessibility"
```

[Full Team Mode docs →](docs/guides/team-mode.md)

---

## Azure DevOps

When your git remote points to `dev.azure.com` or `*.visualstudio.com`, OMC auto-detects ADO and injects MCP tool context into all agent prompts. Run `/oh-my-copilot:omc-ado-setup` to configure, and `/oh-my-copilot:omc-ado-triage` for a parallel scan of work items, PRs, pipelines, and security alerts.

[Full Azure DevOps docs →](docs/guides/azure-devops.md)

---

## Magic Keywords

Optional shortcuts for power users. Natural language works fine without them.

| Keyword | Category | Effect | Example |
| ------- | -------- | ------ | ------- |
| `ask claude` | ![orchestration](https://img.shields.io/badge/orchestration-blue) | Delegate to Claude Code CLI | `ask claude "review auth architecture"` |
| `ask codex` | ![orchestration](https://img.shields.io/badge/orchestration-blue) | Delegate to Codex CLI | `ask codex "security analysis"` |
| `ask gemini` | ![orchestration](https://img.shields.io/badge/orchestration-blue) | Delegate to Gemini CLI | `ask gemini "suggest UX improvements"` |
| `ccg` | ![orchestration](https://img.shields.io/badge/orchestration-blue) | Quadri-model orchestration | `ccg review this PR` |
| `omc team` | ![orchestration](https://img.shields.io/badge/orchestration-blue) | tmux CLI workers (codex/gemini/copilot) | `omc team 2:codex "security review"` |
| `team` | ![orchestration](https://img.shields.io/badge/orchestration-blue) | Canonical Team orchestration | `team 3:executor "fix all TypeScript errors"` |
| `code review` | ![analysis](https://img.shields.io/badge/analysis-purple) | Code review mode | `code review the auth module` |
| `deep-analyze` | ![analysis](https://img.shields.io/badge/analysis-purple) | Deep analysis mode | `deep-analyze why tests are failing` |
| `deep-dive` | ![analysis](https://img.shields.io/badge/analysis-purple) | Trace → interview pipeline | `deep-dive why auth is slow` |
| `deep-interview` | ![analysis](https://img.shields.io/badge/analysis-purple) | Socratic requirements clarification | `deep-interview "vague idea"` |
| `deep-review` | ![analysis](https://img.shields.io/badge/analysis-purple) | Multi-pass code review (4 passes) | `deep-review this PR` |
| `deepsearch` | ![analysis](https://img.shields.io/badge/analysis-purple) | Codebase-focused search routing | `deepsearch for auth middleware` |
| `discover` | ![analysis](https://img.shields.io/badge/analysis-purple) | Parallel codebase quality scan | `discover src/hooks/` |
| `security review` | ![analysis](https://img.shields.io/badge/analysis-purple) | Security review mode | `security review the API endpoints` |
| `tdd`, `test first` | ![analysis](https://img.shields.io/badge/analysis-purple) | TDD workflow enforcement | `tdd: implement password validation` |
| `ultrathink` | ![analysis](https://img.shields.io/badge/analysis-purple) | Deep reasoning mode | `ultrathink about this architecture` |
| `ralplan` | ![planning](https://img.shields.io/badge/planning-orange) | Iterative planning consensus | `ralplan this feature` |
| `autopilot` | ![execution](https://img.shields.io/badge/execution-green) | Full autonomous execution | `autopilot: build a todo app` |
| `experiment` | ![execution](https://img.shields.io/badge/execution-green) | Hypothesis-driven experiment loop | `experiment: optimize API latency` |
| `ralph` | ![execution](https://img.shields.io/badge/execution-green) | Persistence mode | `ralph: refactor auth` |
| `ralphthon` | ![execution](https://img.shields.io/badge/execution-green) | Autonomous hackathon mode | `ralphthon: build MVP in 2 hours` |
| `ulw` | ![execution](https://img.shields.io/badge/execution-green) | Maximum parallelism | `ulw fix all errors` |
| `ado setup` | ![devops](https://img.shields.io/badge/devops-gray) | Configure Azure DevOps integration | `ado setup` |
| `ado triage` | ![devops](https://img.shields.io/badge/devops-gray) | Azure DevOps work item triage | `ado triage` |
| `cancelomc`, `stopomc` | ![control](https://img.shields.io/badge/control-gray) | Stop active OMC modes | `stopomc` |

**Notes:**

- **ralph includes ultrawork**: when you activate ralph mode, it automatically includes ultrawork's parallel execution.
- **Informational filtering**: Asking "what is ralph?" or "explain ultrawork" won't trigger execution — only actionable uses activate keywords.

---

## Permissions

oh-my-copilot uses a **three-tier permission architecture** to minimize permission prompts without sacrificing security. No `/yolo` or `--allow-all` needed.

### Auto Permission Mode Flow

```
┌──────────────────────────────────────────────────────────┐
│                    Tool call arrives                     │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─ Escalation check ──→ 3+ consecutive / 20+ total      │
│  │                        denials?                       │
│  │                        → DENY + STOP                  │
│  │                        → ASK Human                    │
│  │                                                       │
│  ├─ MCP tool (mcp__t__*)                                 │
│  │  ├─ In permissions.allow? ────────────→ ALLOW         │
│  │  ├─ readOnlyHint annotation? ─────────→ ALLOW         │
│  │  └─ Otherwise ────────────────────────→ ASK           │
│  │                                                       │
│  ├─ Bash command                                         │
│  │  ├─ Shell metacharacters (;&|$`<>) ──→ REJECT         │
│  │  ├─ Safe pattern match? ──────────────→ ALLOW         │
│  │  │  (git, npm, dotnet, gh, az, tsc,                   │
│  │  │   grep, find, ls, pytest, cargo…)                  │
│  │  ├─ Heredoc with safe base? ──────────→ ALLOW         │
│  │  └─ No match ─────────────────────────→ ASK           │
│  │                                                       │
│  └─ Every decision → audit log (.omc/logs/permissions)   │
│                    → deny tracker (escalation counters)  │
└──────────────────────────────────────────────────────────┘
```

### Three Tiers

| Tier | Behavior | Tools | Count |
|------|----------|-------|-------|
| **1** | Always auto-approved | LSP navigation, code search, state/memory/notepad reads, job status | ~20 |
| **2** | Auto-approved in project | State/memory/notepad writes, AST replace, LSP rename, python REPL | ~12 + hooks |
| **3** | Always requires confirmation | `shared_memory_delete`, `shared_memory_cleanup`, `kill_job` | 3 |

### Three Enforcement Mechanisms

| Mechanism | How | Where |
|-----------|-----|-------|
| **MCP Tool Annotations** | `readOnlyHint`/`destructiveHint` on every tool definition | Copilot CLI reads at tool discovery |
| **permissions.allow** | Explicit allowlist auto-written and session-healed | `~/.copilot/settings.local.json` |
| **permissionRequest Hook** | Programmatic approve/deny at runtime | `hooks/hooks.json` → `permission-handler.mjs` |

### Safe Bash Commands (auto-approved)

```
git status/diff/log/branch/show/fetch    npm/pnpm/yarn test/lint/build
tsc, eslint, prettier                     cargo test/check/clippy
dotnet build/test/run/restore/clean       gh pr/issue/repo view/list/status
az account/devops/pipelines/repos read    grep, find, ls, wc, pwd, which, echo
```

### Customization

Edit `.copilot/settings.local.json` to add or remove tools:
```json
{
  "permissions": {
    "allow": ["mcp__t__tool_name"]
  }
}
```

### Safety Guardrails

- **Deny escalation**: 3 consecutive or 20 total denials → stop and escalate to human
- **Audit trail**: All decisions logged to `.omc/logs/permissions.log`
- **Shell injection prevention**: Commands with metacharacters (`;&|$`) always rejected
- **Dangerous tools**: `shared_memory_delete`, `shared_memory_cleanup`, `kill_job` always prompt

[Full permissions guide →](docs/guides/permissions.md)

---

## Documentation

- [Documentation Home](docs/index.md)
- [Quick Start](docs/get-started/quickstart.md)
- [Full Reference](docs/REFERENCE.md)
- [Team Mode](docs/guides/team-mode.md)
- [Azure DevOps Integration](docs/guides/azure-devops.md)
- [Architecture Overview](docs/architecture/overview.md)
- [Migration Guide](docs/migration/breaking-changes.md)

---

## Requirements

- [Copilot CLI](https://docs.github.com/copilot-cli)

### Platform & tmux

OMC features like `omc team` and rate-limit detection require **tmux**:

| Platform       | tmux provider                                          | Install                 |
| -------------- | ------------------------------------------------------ | ----------------------- |
| macOS          | [tmux](https://github.com/tmux/tmux)                   | `brew install tmux`     |
| Ubuntu/Debian  | tmux                                                   | `sudo apt install tmux` |
| Fedora         | tmux                                                   | `sudo dnf install tmux` |
| Arch           | tmux                                                   | `sudo pacman -S tmux`   |
| Windows        | [psmux](https://github.com/marlocarlo/psmux) (native) | `winget install psmux`  |
| Windows (WSL2) | tmux (inside WSL)                                      | `sudo apt install tmux` |

> **Windows users:** [psmux](https://github.com/marlocarlo/psmux) provides a native `tmux` binary for Windows with 76 tmux-compatible commands. No WSL required.

### Multi-AI Orchestration

OMC can orchestrate multiple AI CLI providers as tmux workers for cross-validation, design consistency, and parallel execution. All four major CLI tools are supported:

| Provider                                                      | Install                                | What it enables                                  |
| ------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| [Copilot CLI](https://docs.github.com/copilot-cli)            | `npm install -g @github/copilot`                     | Core orchestration platform                      |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm install -g @anthropic-ai/claude-code` | Deep reasoning, architecture analysis            |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli)     | `npm install -g @google/gemini-cli`    | Design review, UI consistency (1M token context) |
| [Codex CLI](https://github.com/openai/codex)                  | `npm install -g @openai/codex`         | Architecture validation, code review cross-check |

```bash
omc team 2:claude "review auth architecture"
omc team 2:codex "security analysis"
omc team 2:gemini "UI consistency check"
omc team 1:copilot "review existing tests"
```

Only Copilot CLI is required — the others are optional and add cross-provider validation.

---

## License

MIT

---

<div align="center">

**Inspired by:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [copilot-hud](https://github.com/ryanjoachim/copilot-hud) • [Superpowers](https://github.com/obra/superpowers) • [everything-copilot-cli](https://github.com/affaan-m/everything-copilot-cli) • [Ouroboros](https://github.com/Q00/ouroboros)

**Zero learning curve. Maximum power.**

</div>
