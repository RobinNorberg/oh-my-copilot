```
     ██████╗ ██╗  ██╗     ███╗   ███╗██╗   ██╗
    ██╔═══██╗██║  ██║     ████╗ ████║╚██╗ ██╔╝
    ██║   ██║███████║     ██╔████╔██║ ╚████╔╝
    ██║   ██║██╔══██║     ██║╚██╔╝██║  ╚██╔╝
    ╚██████╔╝██║  ██║     ██║ ╚═╝ ██║   ██║
     ╚═════╝ ╚═╝  ╚═╝     ╚═╝     ╚═╝   ╚═╝
               ██████╗ ██████╗ ██████╗ ██╗██╗      ██████╗ ████████╗
              ██╔════╝██╔═══██╗██╔══██╗██║██║     ██╔═══██╗╚══██╔══╝
              ██║     ██║   ██║██████╔╝██║██║     ██║   ██║   ██║
              ██║     ██║   ██║██╔═══╝ ██║██║     ██║   ██║   ██║
              ╚██████╗╚██████╔╝██║     ██║███████╗╚██████╔╝   ██║
               ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝    ╚═╝
       Turbocharge your Copilot CLI with multi-agent orchestration
```

<p align="left"  style="padding-left: 100px">
  <img src="assets/omc-character.png" alt="oh-my-copilot" width="400" />
  </br>
  <strong><i>Your Copilot has been working out, learning new ways to improve your life.</i></strong>
</p>

---

[![npm version](https://img.shields.io/npm/v/oh-my-copilot?color=cb3837)](https://www.npmjs.com/package/oh-my-copilot)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-copilot?color=blue)](https://www.npmjs.com/package/oh-my-copilot)
[![GitHub stars](https://img.shields.io/github/stars/RobinNorberg/oh-my-copilot?style=flat&color=yellow)](https://github.com/RobinNorberg/oh-my-copilot/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
<br/>This work is based on [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) by Yeachan Heo, but with a Copilot CLI focus.

> **v5.0.0** rebases the fork onto upstream oh-my-claudecode v5.0.2 and renames the
> CLI to **`omg`**. Runtime state moved to `.omg/` and configuration to
> `.copilot/omg.jsonc`. Upgrading from v4? Read the
> [Migration Guide](docs/MIGRATION.md).

## Quick Start

```bash
# Step 1: Install
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot
/plugin install oh-my-copilot@omc
# or
npm i -g oh-my-copilot@latest

# Step 2: Setup
/omc-setup        # inside a session
omg setup         # or from your terminal

# Step 3: Build something
/autopilot "build a todo-app"
# or just describe it
autopilot: build a todo-app

# If you enjoy the output, give the repo a ⭐ and tell a friend
```

> **Known npm warning:** `npm i -g oh-my-copilot@latest` may print `deprecated prebuild-install@7.1.3`.
> This comes from the `better-sqlite3` native-addon dependency
> (`better-sqlite3 -> prebuild-install`); `prebuild-install@7.1.3` is still the latest
> published version, so there is no safe repo-side dependency bump to remove the
> warning yet. Tracked upstream in
> [Yeachan-Heo/oh-my-claudecode#2913](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/2913);
> it does not by itself mean the install failed.

### Not Sure Where to Start?

If you're uncertain about requirements, have a vague idea, or want to micromanage the design:

```
/deep-interview "I want to build a todo-app"
```

The deep interview uses Socratic questioning to clarify your thinking before any code is written.

---

## Key Features

- **Copilot CLI friendly** — perfect for development in the terminal
- **Natural language interface** — no commands to memorize, just describe what you want
- **Team-first orchestration** — staged pipeline with plan, exec, verify, and fix loop
- **Automatic parallelization** — complex tasks distributed across specialized agents
- **Smart model routing** — light models for simple tasks, heavyweights for complex reasoning
- **Persistent execution** — won't give up until the job is verified complete
- **Azure DevOps/GitHub native** — auto-detection, work item management, PR operations, triage workflows
- **Cross-platform** — first-class Windows support alongside macOS and Linux as of v5
- **Stop your yolo abuse** — a layered permission model helps your agents perform safe work without your interference

---

## Workflows & Magic Keywords

The canonical Tier-0 workflow is `plan → execute → review → verify`. Natural
language works fine without memorizing anything; these are the shortcuts for
power users.

| Invocation                 | Category      | Effect                                          | Example                                        |
| -------------------------- | ------------- | ----------------------------------------------- | ---------------------------------------------- |
| `/team`                    | orchestration | Canonical Team orchestration                    | `/team 3:executor "fix all TypeScript errors"` |
| `/ask <provider>`          | orchestration | Delegate to another CLI (claude, codex, gemini, antigravity, grok, cursor) | `/ask codex "security analysis"` |
| `omg team` (terminal)      | orchestration | tmux CLI workers across providers               | `omg team 2:codex "security review"`           |
| `/plan` / `ralplan`        | planning      | Planning / iterative planning consensus         | `ralplan this feature`                         |
| `/deep-interview`          | planning      | Socratic requirements clarification             | `/deep-interview "vague idea"`                 |
| `/execute`                 | execution     | Carry an approved plan through to verified code | `/execute "refactor auth"`                     |
| `/autopilot` / `autopilot` | execution     | Full autonomous execution                       | `autopilot: build a todo app`                  |
| `/ralph` / `ralph`         | execution     | Persistence mode                                | `ralph: refactor auth`                         |
| `/ultragoal`               | execution     | Durable multi-goal workflow with checkpoints    | `/ultragoal create-goals --brief "..."`        |
| `/self-improve`            | execution     | Autonomous evolutionary code improvement        | `/self-improve the parser module`              |
| `/skillify`                | execution     | Extract a reusable skill from the session       | `/skillify this workflow`                      |
| `/review` / `/deep-review` | analysis      | Code review / multi-pass review                 | `/review this PR`                              |
| `/critique`                | analysis      | Pre-push adversarial critique                   | `/critique my changes`                         |
| `/verify`                  | analysis      | Evidence-based completion checks                | `/verify the fix`                              |
| `/trace`                   | analysis      | Evidence-driven causal tracing                  | `/trace why auth is broken`                    |
| `/debug`                   | analysis      | Session/repo diagnostics                        | `/debug why hooks aren't firing`               |
| `/discover`                | analysis      | Parallel codebase quality scan                  | `/discover src/hooks/`                         |
| `/deepinit`                | analysis      | Deep codebase init with AGENTS.md               | `/deepinit`                                    |
| `deepsearch`               | analysis      | Codebase-focused search routing                 | `deepsearch for auth middleware`               |
| `ultrathink`               | analysis      | Deep reasoning mode                             | `ultrathink about this architecture`           |
| `tdd`, `test first`        | analysis      | TDD workflow enforcement                        | `tdd: implement password validation`           |
| `deslop`, `anti-slop`      | analysis      | AI code slop cleanup (opt-in review lane)       | `deslop the auth module`                       |
| `/omc-gh-*` skills         | github        | Setup, triage, PR review, auto-review, projects | `/omc-gh-triage`                               |
| `/omc-ado-*` skills        | devops        | Azure DevOps setup, sprint, triage, PR review   | `/omc-ado-sprint`                              |
| `/hud`                     | utility       | Configure status line display                   | `/hud setup`                                   |
| `/remember`                | utility       | Save reusable project knowledge                 | `/remember this pattern`                       |
| `/wiki`                    | utility       | Persistent markdown knowledge base              | `/wiki add auth architecture notes`            |
| `cancelomc`, `stopomc`     | utility       | Stop active OMC modes                           | `stopomc`                                      |

**Notes:**

- **Informational filtering**: asking "what is ralph?" won't trigger execution — only actionable uses activate keywords.
- v5 retired the legacy workflow names (`ultrawork`, `swarm`, `pipeline`, `deep-dive`, and friends) outright — the
  [Migration Guide](docs/MIGRATION.md) has the full replacement table.

---

## Orchestration between agents

### Team Mode

**Team** is the canonical orchestration surface. It runs a staged pipeline:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

```bash
/team 3:executor "fix all TypeScript errors"
```

### Provider Advisor

Fan a question out to other AI CLIs and let your session synthesize the results:

```bash
/ask claude "review this migration plan"
/ask codex "identify architecture risks"
/ask antigravity "propose UI polish ideas"
```

### OMG Team Mode

`omg team` spawns real tmux CLI workers for cross-model tasks:

```bash
omg team 1:claude "review the database module for sql issues"
omg team 2:codex "review the auth module for security issues"
omg team 2:antigravity "redesign UI components for accessibility"
omg team status auth-review
omg team shutdown auth-review
```

[Team worktree mode docs →](docs/TEAM-WORKTREE-MODE.md)

---

## Documentation

- [Getting Started](docs/GETTING-STARTED.md)
- [Full Reference](docs/REFERENCE.md)
- [Migration Guide (v4 → v5)](docs/MIGRATION.md)
- [Architecture Overview](docs/ARCHITECTURE.md)
- [Feature List](docs/FEATURES.md)
- [Performance Monitoring](docs/PERFORMANCE-MONITORING.md)
- [Security Guide](SECURITY.md)

---

## Requirements

- [Copilot CLI](https://github.com/github/copilot-cli) — `npm install -g @github/copilot`

---

## Optional enhancements

### Platform & tmux

OMC features like `omg team` and rate-limit detection require **tmux**:

| Platform       | tmux provider                                          | Install                 |
| -------------- | ------------------------------------------------------ | ----------------------- |
| macOS          | [tmux](https://github.com/tmux/tmux)                   | `brew install tmux`     |
| Ubuntu/Debian  | tmux                                                   | `sudo apt install tmux` |
| Fedora         | tmux                                                   | `sudo dnf install tmux` |
| Arch           | tmux                                                   | `sudo pacman -S tmux`   |
| Windows        | [psmux](https://github.com/marlocarlo/psmux) (native)  | `winget install psmux`  |
| Windows (WSL2) | tmux (inside WSL)                                      | `sudo apt install tmux` |

> **Windows users:** [psmux](https://github.com/marlocarlo/psmux) provides a native `tmux` binary for Windows with 76 tmux-compatible commands. No WSL required.

### Multi-AI Orchestration

OMC can orchestrate multiple AI CLI providers as tmux workers for cross-validation, design consistency, and parallel execution:

| Provider                                                      | Install                                                     | What it enables                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| [Copilot CLI](https://github.com/github/copilot-cli)          | `npm install -g @github/copilot`                            | Core orchestration platform                      |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm install -g @anthropic-ai/claude-code`                  | Deep reasoning, architecture analysis            |
| [Codex CLI](https://github.com/openai/codex)                  | `npm install -g @openai/codex`                              | Architecture validation, code review cross-check |
| [Antigravity CLI](https://antigravity.google) (`agy`)         | Per the [official instructions](https://antigravity.google) | Design review, UI consistency                    |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli)     | `npm install -g @google/gemini-cli`                         | Design review, large-context tasks (enterprise/API-key) |
| [Grok Build](https://build.grok.com)                          | Download from build.grok.com                                | Code review, analysis cross-check                |

Only Copilot CLI is required — the others are optional and add cross-provider validation.

---

## Star History

<a href="https://www.star-history.com/?repos=RobinNorberg%2Foh-my-copilot&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=RobinNorberg/oh-my-copilot&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=RobinNorberg/oh-my-copilot&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=RobinNorberg/oh-my-copilot&type=date&legend=top-left" />
 </picture>
</a>

---

## Credits

oh-my-copilot is a downstream fork of
[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) by
[Yeachan Heo](https://github.com/Yeachan-Heo), who created and leads the
orchestration engine this project builds on. v5 tracks upstream v5.0.2. If you
work primarily in Claude Code, use the original — and consider
[sponsoring him](https://github.com/sponsors/Yeachan-Heo).

**Also inspired by:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [Superpowers](https://github.com/obra/superpowers) • [get-shit-done](https://github.com/gsd-build/get-shit-done) • [Ouroboros](https://github.com/Q00/ouroboros) • [BMAD](https://github.com/bmad-code-org/BMAD-METHOD)

---

## 🤝 Contributing

Contributions welcome! Open an issue or PR on [GitHub](https://github.com/RobinNorberg/oh-my-copilot) against the dev branch.

---

## License

MIT — see [LICENSE](LICENSE).
