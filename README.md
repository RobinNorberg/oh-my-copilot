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

> **What's new:** see the [changelog](CHANGELOG.md) and the
> [releases page](https://github.com/RobinNorberg/oh-my-copilot/releases).
> **v5.0.0** rebased the fork onto upstream oh-my-claudecode v5 and renamed the
> CLI to **`omg`**. Runtime state moved to `.omg/` and configuration to
> `.copilot/omg.jsonc`. Upgrading? Read the
> [Migration Guide](docs/MIGRATION.md).

## Quick Start

```bash
# Step 1: Install the plugin (from your shell)
copilot plugin marketplace add RobinNorberg/oh-my-copilot
copilot plugin install oh-my-copilot@omc
# plus the terminal CLI (omg)
npm i -g oh-my-copilot@latest

# Step 2: Setup
/oh-my-copilot:omc-setup  # inside a Copilot CLI session
omg setup                 # or from your terminal

# Step 3: Build something (inside a session)
/oh-my-copilot:autopilot build a todo-app
# or just describe it
autopilot: build a todo-app

# If you enjoy the output, give the repo a ⭐ and tell a friend
```

> **Requirements:** Node.js on PATH (every hook runs `node`; under Copilot a
> hook that cannot start blocks the tool call). The host config directory is
> `~/.copilot`, or `$COPILOT_HOME` when set; OMC follows Copilot's own
> variable. Update with
> `copilot plugin marketplace update omc && copilot plugin update oh-my-copilot@omc`,
> then run `/oh-my-copilot:omc-setup` again. Uninstall with
> `copilot plugin uninstall oh-my-copilot@omc`.
> [Getting Started](docs/GETTING-STARTED.md) covers every install path.

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
/oh-my-copilot:deep-interview I want to build a todo-app
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

## Using the Skills

Skills run inside a Copilot CLI session as `/oh-my-copilot:<skill>`. The short
prefixes `/omc:<skill>` and `/omg:<skill>` route to the same skills. Natural
language works too: describe the task and OMC picks the workflow.

### Start here: plan → execute → review → verify

This loop covers most work. Each step is a separate pass, so the reviewer never
grades its own code.

| Step       | Invocation                  | Example                                                           |
| ---------- | --------------------------- | ----------------------------------------------------------------- |
| 1. Plan    | `/oh-my-copilot:omc-plan`   | `/oh-my-copilot:omc-plan add rate limiting to the public API`     |
| 2. Execute | `/oh-my-copilot:execute`    | `/oh-my-copilot:execute implement the approved rate-limit plan`   |
| 3. Review  | `/oh-my-copilot:omc-review` | `/oh-my-copilot:omc-review src/api/`                              |
| 4. Verify  | `/oh-my-copilot:verify`     | `/oh-my-copilot:verify requests over the limit get a 429`         |

Plan and review carry an `omc-` prefix: bare `/review` is Copilot CLI's own
command, not OMC's.

### All skills by purpose

**Planning**

| Invocation                        | Use it when…                                                  |
| --------------------------------- | ------------------------------------------------------------- |
| `/oh-my-copilot:deep-interview`   | the idea is vague and you want questions before any code      |
| `/oh-my-copilot:ralplan`          | a plan needs planner/architect/critic consensus before a big run |
| `/oh-my-copilot:research`         | you need a sourced answer to an open question                 |
| `/oh-my-copilot:external-context` | you need parallel lookups in external documentation           |
| `/oh-my-copilot:ask-navigator`    | the destination is unclear and you want a map of decisions first |
| `/oh-my-copilot:loft`             | a design question needs a throwaway prototype to settle       |
| `/oh-my-copilot:map`              | you know the job but not which skill owns it                  |

**Building**

| Invocation                 | Use it when…                                                                 |
| -------------------------- | ---------------------------------------------------------------------------- |
| `/oh-my-copilot:autopilot` | you want idea → working code without hand-holding                            |
| `/oh-my-copilot:tdd`       | you want test-first, one red/green step at a time                            |
| `/oh-my-copilot:ship`      | a task or open PR (`--pr <n>`) should reach merge-ready with independent review and CI gates |
| `/oh-my-copilot:pr`        | you need a PR body built from the session's evidence                         |

**Review and verification**

| Invocation                           | Use it when…                                                       |
| ------------------------------------ | ------------------------------------------------------------------ |
| `/oh-my-copilot:deep-review`         | a change needs multi-pass security, quality and structure review   |
| `/oh-my-copilot:critique`            | you want unpushed commits challenged before you push               |
| `/oh-my-copilot:ai-slop-cleaner`     | AI-written code needs deletion-first cleanup (`--review` reports only) |
| `/oh-my-copilot:discover`            | you want a prioritized improvement backlog for a codebase or folder |
| `/oh-my-copilot:architecture-survey` | you want ranked refactoring candidates without code edits          |
| `/oh-my-copilot:trace`               | a bug has several plausible causes to test against evidence        |
| `/oh-my-copilot:debug`               | OMC itself misbehaves (hooks, state, sessions)                     |
| `/oh-my-copilot:visual-verdict`      | a screenshot must match a reference design                         |

**Autonomous loops**

| Invocation                        | Use it when…                                                     |
| --------------------------------- | ---------------------------------------------------------------- |
| `/oh-my-copilot:ralph`            | a task must keep going until a reviewer verifies it complete     |
| `/oh-my-copilot:ultragoal`        | the work spans several ordered goals and sessions                |
| `/oh-my-copilot:autoresearch`     | one mission should improve under a strict evaluator and a time limit |
| `/oh-my-copilot:ralph-experiment` | you want hypothesis-driven experiments with git checkpoints      |
| `/oh-my-copilot:self-improve`     | you want tournament-style evolutionary improvement of code       |

**Teams, pipelines and delivery**

| Invocation              | Use it when…                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `/oh-my-copilot:team`   | N agents should split a task on a shared task list: `/oh-my-copilot:team 3:executor fix all TypeScript errors` |
| `/oh-my-copilot:ask`    | you want a second opinion from claude, codex, gemini, antigravity, grok, cursor or muse        |
| `/oh-my-copilot:graph`  | a pipeline should run as a declarative DAG with crash recovery                                 |
| `/oh-my-copilot:launch` | a mission should go through spec → tickets → governed execution                                |
| `/oh-my-copilot:harbor` | incoming issues and PRs need their claims verified before you decide                           |
| `/oh-my-copilot:intent` | a support or ops problem report must become a requirements brief                               |
| `/oh-my-copilot:drydock`| a repo needs the shared shipyard harness (`--check` audits drift)                              |

For headless runs from the terminal, see `omg team`, `omg factory` and
`omg ship` under [Terminal CLI](#terminal-cli).

**GitHub and Azure DevOps**

| GitHub                              | Azure DevOps                         | Use it when…                                                |
| ----------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| `/oh-my-copilot:omc-gh-setup`       | `/oh-my-copilot:omc-ado-setup`       | connecting the project, or the connection broke             |
| `/oh-my-copilot:omc-gh-triage`      | `/oh-my-copilot:omc-ado-triage`      | you want a health overview: work items, PRs, CI, security alerts |
| `/oh-my-copilot:omc-gh-review`      | `/oh-my-copilot:omc-ado-review`      | you review a PR interactively                               |
| `/oh-my-copilot:omc-gh-auto-review` | `/oh-my-copilot:omc-ado-auto-review` | you want AI comments posted on PRs where you are a reviewer |
| `/oh-my-copilot:omc-gh-project`     | `/oh-my-copilot:omc-ado-sprint`      | you manage a Projects (v2) board / sprint iterations and capacity |

**Setup and maintenance**

| Invocation                               | Use it when…                                                         |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `/oh-my-copilot:omc-setup`               | after install and after every plugin update                          |
| `/oh-my-copilot:omc-doctor`              | the install looks broken                                             |
| `/oh-my-copilot:hud`                     | you want to change the status line                                   |
| `/oh-my-copilot:configure-notifications` | you want Telegram, Discord or Slack alerts                           |
| `/oh-my-copilot:cancel`                  | you need to stop an active mode (ralph, autopilot, team, ultragoal)  |
| `/oh-my-copilot:refit`                   | you want a retrospective across past sessions with proposed fixes    |
| `/oh-my-copilot:skill`                   | you want to list, add, edit or remove local skills                   |
| `/oh-my-copilot:skillify`                | a workflow from this session should become a reusable skill          |
| `/oh-my-copilot:release`                 | you release your own repo (OMC's own releases use maintainer-only `omg release`) |

**Knowledge and utilities**

| Invocation                                | Use it when…                                                   |
| ----------------------------------------- | -------------------------------------------------------------- |
| `/oh-my-copilot:remember`                 | something learned belongs in project memory, notepad or docs   |
| `/oh-my-copilot:wiki`                     | you want a persistent markdown knowledge base across sessions  |
| `/oh-my-copilot:deepinit`                 | a codebase needs hierarchical `AGENTS.md` docs                 |
| `/oh-my-copilot:project-session-manager`  | each issue or PR should get its own worktree (alias `psm`)     |
| `/oh-my-copilot:session-flow`             | a long session lost the thread and you need a map of it        |
| `/oh-my-copilot:diagram`                  | an explanation needs the smallest visual: tree, Mermaid or diff |
| `/oh-my-copilot:minimal-code-discipline`  | you want the shortest correct diff, reuse first                |
| `/oh-my-copilot:minimal-prose-discipline` | you want terse, filler-free replies                            |
| `/oh-my-copilot:agent-doc-discipline`     | you write docs that agents will read                           |

The [Full Reference](docs/REFERENCE.md#skills-63-total) lists every skill with
its arguments.

### Magic keywords

Type these in a normal prompt; no slash needed.

| Keyword                                      | Starts             |
| -------------------------------------------- | ------------------ |
| `autopilot`, `build me an app`, `end to end` | autopilot          |
| `ralph`                                      | ralph              |
| `ralplan`                                    | ralplan            |
| `deep interview`                             | deep-interview     |
| `ultragoal`                                  | ultragoal          |
| `deslop`, `anti-slop`                        | ai-slop-cleaner    |
| `tdd`, `test first`                          | tdd                |
| `code review`, `security review`             | review mode        |
| `ultrathink`, `think hard`                   | extended reasoning |
| `deepsearch`, `search the codebase`          | codebase search    |
| `deep-analyze`                               | analysis mode      |
| `cancelomc`, `stopomc`                       | cancel             |

**Notes:**

- **Informational filtering**: asking "what is ralph?" won't trigger execution — only actionable uses activate keywords.
- Team mode never starts from a keyword; use `/oh-my-copilot:team`.
- v5 retired the legacy workflow names (`ultrawork`, `ultraqa`, `ultrapilot`, `swarm`, `pipeline`, `ccg`, `sciomc`,
  `deep-dive`, and friends) outright — the [Migration Guide](docs/MIGRATION.md) has the full replacement table.

---

## Terminal CLI

The `omg` binary covers setup and the headless workflows:

| Command                                                  | What it does                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `omg setup`, `omg update`, `omg doctor`                  | install, update and diagnose OMC                                     |
| `omg team 3:copilot "fix failing tests"`                 | run a team of workers: headless SDK workers in a Copilot CLI session, tmux panes elsewhere |
| `omg ask codex "identify architecture risks"`            | ask another AI CLI and save the answer as an artifact                |
| `omg factory setup` / `check` / `run <issue>`            | configure the software factory, bucket intake items, drive one issue to a merge-ready PR <!-- verify: factory setup/check are on dev but not yet in a published release (5.18.1) --> |
| `omg ship status <pr>`                                   | show a ship run's review verdicts and gate state                     |
| `omg smoke copilot`                                      | load-check the plugin in a real Copilot CLI                          |
| `omg budget`                                             | show the AI Credits ledger                                           |

`omg --help` lists everything; the [CLI reference](docs/REFERENCE.md#cli-commands-askteamsession) has the details.

### Team workers

```bash
omg team 3:copilot "fix failing tests"
omg team 2:codex "review the auth module for security issues"
omg team status fix-failing-tests
omg team shutdown fix-failing-tests
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

Pane-based `omg team` workers (the default outside a Copilot CLI session, and
for non-Copilot providers) and `omg wait` rate-limit auto-resume require **tmux**:

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

## Credits

oh-my-copilot is a downstream fork of
[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) by
[Yeachan Heo](https://github.com/Yeachan-Heo), who created and leads the
orchestration engine this project builds on. The fork regularly ports upstream
`dev`. If you work primarily in Claude Code, use the original — and consider
[sponsoring him](https://github.com/sponsors/Yeachan-Heo).

**Also inspired by:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [Superpowers](https://github.com/obra/superpowers) • [get-shit-done](https://github.com/gsd-build/get-shit-done) • [Ouroboros](https://github.com/Q00/ouroboros) • [BMAD](https://github.com/bmad-code-org/BMAD-METHOD)

---

## 🤝 Contributing

Contributions welcome! Open an issue or PR on [GitHub](https://github.com/RobinNorberg/oh-my-copilot) against the dev branch.

---

## License

MIT — see [LICENSE](LICENSE).
