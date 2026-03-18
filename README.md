# oh-my-copilot

[![npm version](https://img.shields.io/npm/v/oh-my-copilot?color=cb3837)](https://www.npmjs.com/package/oh-my-copilot)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-copilot?color=blue)](https://www.npmjs.com/package/oh-my-copilot)
[![GitHub stars](https://img.shields.io/github/stars/RobinNorberg/oh-my-copilot?style=flat&color=yellow)](https://github.com/RobinNorberg/oh-my-copilot/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

> oh-my-copilot is a fork of [oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode) by Yeachan Heo, adapted for GitHub Copilot CLI.

> **For Codex users:** Check out [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) — the same orchestration experience for OpenAI Codex CLI.

**Multi-agent orchestration for Copilot CLI. Zero learning curve.**

_Don't learn Copilot CLI. Just use OMC._

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
- **Automatic parallelization** — complex tasks distributed across 18 specialized agents
- **Persistent execution** — won't give up until the job is verified complete
- **Smart model routing** — Haiku for simple tasks, Opus for complex reasoning (30–50% token savings)
- **Azure DevOps native** — auto-detection, work item management, PR operations, triage workflows

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

| Keyword                | Effect                                  | Example                                        |
| ---------------------- | --------------------------------------- | ---------------------------------------------- |
| `team`                 | Canonical Team orchestration            | `/team 3:executor "fix all TypeScript errors"` |
| `omc team`             | tmux CLI workers (codex/gemini/copilot) | `omc team 2:codex "security review"`           |
| `ccg`                  | ask-codex + ask-gemini synthesis        | `/ccg review this PR`                          |
| `autopilot`            | Full autonomous execution               | `autopilot: build a todo app`                  |
| `ralph`                | Persistence mode                        | `ralph: refactor auth`                         |
| `ulw`                  | Maximum parallelism                     | `ulw fix all errors`                           |
| `ralplan`              | Iterative planning consensus            | `ralplan this feature`                         |
| `deep-interview`       | Socratic requirements clarification     | `deep-interview "vague idea"`                  |
| `deepsearch`           | Codebase-focused search routing         | `deepsearch for auth middleware`               |
| `ultrathink`           | Deep reasoning mode                     | `ultrathink about this architecture`           |
| `ado triage`           | Azure DevOps work item triage           | `ado triage`                                   |
| `ado setup`            | Configure Azure DevOps integration      | `ado setup`                                    |
| `cancelomc`, `stopomc` | Stop active OMC modes                   | `stopomc`                                      |

**Notes:**

- **ralph includes ultrawork**: when you activate ralph mode, it automatically includes ultrawork's parallel execution.
- `swarm` compatibility alias has been removed; migrate existing prompts to `/team` syntax.

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

### Optional: Multi-AI Orchestration

OMC can optionally orchestrate external AI providers for cross-validation and design consistency. These are **not required** — OMC works fully without them.

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
