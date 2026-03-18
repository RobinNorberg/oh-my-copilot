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
  <strong><i>Your Copilot has just been steroided.</i></strong>
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

| Keyword | Category | Effect | Example |
| ------- | -------- | ------ | ------- |
| `team` | ![orchestration](https://img.shields.io/badge/orchestration-blue) | Canonical Team orchestration | `team 3:executor "fix all TypeScript errors"` |
| `omc team` | ![orchestration](https://img.shields.io/badge/orchestration-blue) | tmux CLI workers (codex/gemini/copilot) | `omc team 2:codex "security review"` |
| `ccg` | ![orchestration](https://img.shields.io/badge/orchestration-blue) | Quadri-model orchestration | `ccg review this PR` |
| `autopilot` | ![execution](https://img.shields.io/badge/execution-green) | Full autonomous execution | `autopilot: build a todo app` |
| `ralph` | ![execution](https://img.shields.io/badge/execution-green) | Persistence mode | `ralph: refactor auth` |
| `ulw` | ![execution](https://img.shields.io/badge/execution-green) | Maximum parallelism | `ulw fix all errors` |
| `ralplan` | ![planning](https://img.shields.io/badge/planning-orange) | Iterative planning consensus | `ralplan this feature` |
| `experiment` | ![execution](https://img.shields.io/badge/execution-green) | Hypothesis-driven experiment loop | `experiment: optimize API latency` |
| `deep-interview` | ![analysis](https://img.shields.io/badge/analysis-purple) | Socratic requirements clarification | `deep-interview "vague idea"` |
| `deep-review` | ![analysis](https://img.shields.io/badge/analysis-purple) | Multi-pass code review (4 passes) | `deep-review this PR` |
| `discover` | ![analysis](https://img.shields.io/badge/analysis-purple) | Parallel codebase quality scan | `discover src/hooks/` |
| `deepsearch` | ![analysis](https://img.shields.io/badge/analysis-purple) | Codebase-focused search routing | `deepsearch for auth middleware` |
| `ultrathink` | ![analysis](https://img.shields.io/badge/analysis-purple) | Deep reasoning mode | `ultrathink about this architecture` |
| `ado triage` | ![devops](https://img.shields.io/badge/devops-gray) | Azure DevOps work item triage | `ado triage` |
| `ado setup` | ![devops](https://img.shields.io/badge/devops-gray) | Configure Azure DevOps integration | `ado setup` |
| `cancelomc`, `stopomc` | ![control](https://img.shields.io/badge/control-gray) | Stop active OMC modes | `stopomc` |

**Notes:**

- **ralph includes ultrawork**: when you activate ralph mode, it automatically includes ultrawork's parallel execution.

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
