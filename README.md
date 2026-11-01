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
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
<br/>This work is based on [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) by Yeachan Heo, but with a Copilot CLI focus.

> **What's new:** see the [changelog](CHANGELOG.md) and the [releases page](https://github.com/RobinNorberg/oh-my-copilot/releases).

## Quick Start

```bash
# Step 1: Install the plugin (from your shell)
copilot plugin marketplace add RobinNorberg/oh-my-copilot
copilot plugin install oh-my-copilot@omc
# plus the terminal CLI (omg)
npm i -g oh-my-copilot@latest

# Step 2: Setup
/omc-setup  # inside a Copilot CLI session
omg setup                 # or from your terminal

# Step 3: Build something (inside a session)
/autopilot build a todo-app
# or just describe it
autopilot: build a todo-app

# If you enjoy the output, give the repo a ⭐ and tell a friend
```

> **Requirements:** Node.js on PATH (every hook runs `node`; under Copilot a
> hook that cannot start blocks the tool call). The host config directory is
> `~/.copilot`, or `$COPILOT_HOME` when set; OMC follows Copilot's own
> variable. Update with
> `copilot plugin marketplace update omc && copilot plugin update oh-my-copilot@omc`,
> then run `/omc-setup` again. Uninstall with
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
/deep-interview I want to build a todo-app
```

The deep interview uses Socratic questioning to clarify your thinking before any code is written.

### The core loop: plan → execute → review → verify

This loop covers most work. Each step is a separate pass, so the reviewer never
grades its own code.

| Step       | Category | Invocation                  | Example                                                           |
| ---------- | -------- | --------------------------- | ----------------------------------------------------------------- |
| 1. Plan    | ![planning](https://img.shields.io/badge/planning-orange) | `/omc-plan`   | `/omc-plan add rate limiting to the public API`     |
| 2. Execute | ![execution](https://img.shields.io/badge/execution-green) | `/execute`    | `/execute implement the approved rate-limit plan`   |
| 3. Review  | ![review](https://img.shields.io/badge/review-purple) | `/omc-review` | `/omc-review src/api/`                              |
| 4. Verify  | ![verify](https://img.shields.io/badge/verify-purple) | `/verify`     | `/verify requests over the limit get a 429`         |

Plan and review carry an `omc-` prefix: bare `/review` is Copilot CLI's own
command, not OMC's.

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

Skills run inside a Copilot CLI session as `/<skill>`: Copilot CLI registers
plugin skills by their bare name and answers `/oh-my-copilot:<skill>` with
"Unknown command". A few skills carry an `omc-` name because Copilot owns the
bare command (`/omc-plan`, not `/plan`). Natural language works too:
describe the task and OMC picks the workflow.

On Claude Code: `/oh-my-copilot:<skill>`.

### All skills by purpose

![planning](https://img.shields.io/badge/planning-orange) **Planning**

| Invocation                        | Category | Use it when…                                                  |
| --------------------------------- | -------- | ------------------------------------------------------------- |
| `/deep-interview`   | ![planning](https://img.shields.io/badge/planning-orange) | the idea is vague and you want questions before any code      |
| `/ralplan`          | ![planning](https://img.shields.io/badge/planning-orange) | a plan needs planner/architect/critic consensus before a big run |
| `/research`         | ![planning](https://img.shields.io/badge/planning-orange) | you need a sourced answer to an open question                 |
| `/external-context` | ![planning](https://img.shields.io/badge/planning-orange) | you need parallel lookups in external documentation           |

![execution](https://img.shields.io/badge/execution-green) **Building**

| Invocation                 | Category | Use it when…                                                                 |
| -------------------------- | -------- | ---------------------------------------------------------------------------- |
| `/autopilot` | ![execution](https://img.shields.io/badge/execution-green) | you want idea → working code without hand-holding                            |
| `/tdd`       | ![execution](https://img.shields.io/badge/execution-green) | you want test-first, one red/green step at a time                            |
| `/ship`      | ![execution](https://img.shields.io/badge/execution-green) | a task or open PR (`--pr <n>`) should reach merge-ready with independent review and CI gates |
| `/pr`        | ![execution](https://img.shields.io/badge/execution-green) | you need a PR body built from the session's evidence                         |

![review](https://img.shields.io/badge/review-purple) **Review and verification**

| Invocation                           | Category | Use it when…                                                       |
| ------------------------------------ | -------- | ------------------------------------------------------------------ |
| `/deep-review`         | ![review](https://img.shields.io/badge/review-purple) | a change needs multi-pass security, quality and structure review   |
| `/critique`            | ![review](https://img.shields.io/badge/review-purple) | you want unpushed commits challenged before you push               |
| `/ai-slop-cleaner`     | ![review](https://img.shields.io/badge/review-purple) | AI-written code needs deletion-first cleanup (`--review` reports only) |
| `/discover`            | ![review](https://img.shields.io/badge/review-purple) | you want a prioritized improvement backlog for a codebase or folder |
| `/architecture-survey` | ![review](https://img.shields.io/badge/review-purple) | you want ranked refactoring candidates without code edits          |
| `/trace`               | ![review](https://img.shields.io/badge/review-purple) | a bug has several plausible causes to test against evidence        |
| `/debug`               | ![review](https://img.shields.io/badge/review-purple) | OMC itself misbehaves (hooks, state, sessions)                     |
| `/visual-verdict`      | ![review](https://img.shields.io/badge/review-purple) | a screenshot must match a reference design                         |

![loops](https://img.shields.io/badge/loops-yellow) **Autonomous loops**

| Invocation                        | Category | Use it when…                                                     |
| --------------------------------- | -------- | ---------------------------------------------------------------- |
| `/ralph`            | ![loops](https://img.shields.io/badge/loops-yellow) | a task must keep going until a reviewer verifies it complete     |
| `/ultragoal`        | ![loops](https://img.shields.io/badge/loops-yellow) | the work spans several ordered goals and sessions                |
| `/autoresearch`     | ![loops](https://img.shields.io/badge/loops-yellow) | one mission should improve under a strict evaluator and a time limit |

![orchestration](https://img.shields.io/badge/orchestration-blue) **Teams and delivery**

| Invocation              | Category | Use it when…                                                                                   |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `/team`   | ![orchestration](https://img.shields.io/badge/orchestration-blue) | N agents should split a task on a shared task list: `/team 3:executor fix all TypeScript errors` |
| `/ask`    | ![orchestration](https://img.shields.io/badge/orchestration-blue) | you want a second opinion from claude, codex, gemini, antigravity, grok, cursor or muse        |

For headless runs from the terminal, see `omg team`, `omg factory` and
`omg ship` under [Terminal CLI](#terminal-cli).

![github](https://img.shields.io/badge/github-black) ![azure devops](https://img.shields.io/badge/azure_devops-0078D4) **GitHub and Azure DevOps**

| GitHub                              | Azure DevOps                         | Category | Use it when…                                                |
| ----------------------------------- | ------------------------------------ | -------- | ----------------------------------------------------------- |
| `/omc-gh-setup`       | `/omc-ado-setup`       | ![github](https://img.shields.io/badge/github-black) ![azure devops](https://img.shields.io/badge/azure_devops-0078D4) | connecting the project, or the connection broke             |
| `/omc-gh-triage`      | `/omc-ado-triage`      | ![github](https://img.shields.io/badge/github-black) ![azure devops](https://img.shields.io/badge/azure_devops-0078D4) | you want a health overview: work items, PRs, CI, security alerts |
| `/omc-gh-review`      | `/omc-ado-review`      | ![github](https://img.shields.io/badge/github-black) ![azure devops](https://img.shields.io/badge/azure_devops-0078D4) | you review a PR interactively                               |
| `/omc-gh-auto-review` | `/omc-ado-auto-review` | ![github](https://img.shields.io/badge/github-black) ![azure devops](https://img.shields.io/badge/azure_devops-0078D4) | you want AI comments posted on PRs where you are a reviewer |
| `/omc-gh-project`     | `/omc-ado-sprint`      | ![github](https://img.shields.io/badge/github-black) ![azure devops](https://img.shields.io/badge/azure_devops-0078D4) | you manage a Projects (v2) board / sprint iterations and capacity |

![setup](https://img.shields.io/badge/setup-lightgray) **Setup and maintenance**

| Invocation                               | Category | Use it when…                                                         |
| ---------------------------------------- | -------- | -------------------------------------------------------------------- |
| `/omc-setup`               | ![setup](https://img.shields.io/badge/setup-lightgray) | after install and after every plugin update                          |
| `/omc-doctor`              | ![setup](https://img.shields.io/badge/setup-lightgray) | the install looks broken                                             |
| `/hud`                     | ![setup](https://img.shields.io/badge/setup-lightgray) | you want to change the status line                                   |
| `/configure-notifications` | ![setup](https://img.shields.io/badge/setup-lightgray) | you want Telegram, Discord or Slack alerts                           |
| `/cancel`                  | ![setup](https://img.shields.io/badge/setup-lightgray) | you need to stop an active mode (ralph, autopilot, team, ultragoal)  |
| `/skill`                   | ![setup](https://img.shields.io/badge/setup-lightgray) | you want to list, add, edit or remove local skills                   |
| `/skillify`                | ![setup](https://img.shields.io/badge/setup-lightgray) | a workflow from this session should become a reusable skill          |
| `/release`                 | ![setup](https://img.shields.io/badge/setup-lightgray) | you release your own repo (OMC's own releases use maintainer-only `omg release`) |

![utility](https://img.shields.io/badge/utility-lightgray) **Knowledge and utilities**

| Invocation                                | Category | Use it when…                                                   |
| ----------------------------------------- | -------- | -------------------------------------------------------------- |
| `/remember`                 | ![utility](https://img.shields.io/badge/utility-lightgray) | something learned belongs in project memory, notepad or docs   |
| `/wiki`                     | ![utility](https://img.shields.io/badge/utility-lightgray) | you want a persistent markdown knowledge base across sessions  |
| `/deepinit`                 | ![utility](https://img.shields.io/badge/utility-lightgray) | a codebase needs hierarchical `AGENTS.md` docs                 |
| `/project-session-manager`  | ![utility](https://img.shields.io/badge/utility-lightgray) | each issue or PR should get its own worktree (alias `psm`)     |
| `/session-flow`             | ![utility](https://img.shields.io/badge/utility-lightgray) | a long session lost the thread and you need a map of it        |
| `/diagram`                  | ![utility](https://img.shields.io/badge/utility-lightgray) | an explanation needs the smallest visual: tree, Mermaid or diff |

<details>
<summary><img src="https://img.shields.io/badge/shipyard-teal" alt="shipyard"> <b>Shipyard (governed delivery)</b></summary>

These assume a repo set up with `/drydock`.

| Invocation                     | Category | Use it when…                                                         |
| ------------------------------ | -------- | -------------------------------------------------------------------- |
| `/drydock`       | ![shipyard](https://img.shields.io/badge/shipyard-teal) | a repo needs the shared shipyard harness (`--check` audits drift)    |
| `/launch`        | ![shipyard](https://img.shields.io/badge/shipyard-teal) | a mission should go through spec → tickets → governed execution      |
| `/harbor`        | ![shipyard](https://img.shields.io/badge/shipyard-teal) | incoming issues and PRs need their claims verified before you decide |
| `/intent`        | ![shipyard](https://img.shields.io/badge/shipyard-teal) | a support or ops problem report must become a requirements brief     |
| `/ask-navigator` | ![shipyard](https://img.shields.io/badge/shipyard-teal) | the destination is unclear and you want a map of decisions first     |
| `/loft`          | ![shipyard](https://img.shields.io/badge/shipyard-teal) | a design question needs a throwaway prototype to settle              |
| `/map`           | ![shipyard](https://img.shields.io/badge/shipyard-teal) | you know the job but not which skill owns it                         |
| `/refit`         | ![shipyard](https://img.shields.io/badge/shipyard-teal) | you want a retrospective across past sessions with proposed fixes    |

</details>

<details>
<summary><img src="https://img.shields.io/badge/discipline-gray" alt="discipline"> <b>Writing disciplines (loaded by other skills)</b></summary>

Other skills load these; invoke one directly to apply it to your own work.

| Invocation                                | Category | Use it when…                                    |
| ----------------------------------------- | -------- | ----------------------------------------------- |
| `/minimal-code-discipline`  | ![discipline](https://img.shields.io/badge/discipline-gray) | you want the shortest correct diff, reuse first |
| `/minimal-prose-discipline` | ![discipline](https://img.shields.io/badge/discipline-gray) | you want terse, filler-free replies             |
| `/agent-doc-discipline`     | ![discipline](https://img.shields.io/badge/discipline-gray) | you write docs that agents will read            |

</details>

<details>
<summary><img src="https://img.shields.io/badge/loops-yellow" alt="loops"> <b>Advanced loops</b></summary>

| Invocation                        | Category | Use it when…                                                   |
| --------------------------------- | -------- | -------------------------------------------------------------- |
| `/graph`            | ![loops](https://img.shields.io/badge/loops-yellow) | a pipeline should run as a declarative DAG with crash recovery |
| `/ralph-experiment` | ![loops](https://img.shields.io/badge/loops-yellow) | you want hypothesis-driven experiments with git checkpoints    |
| `/self-improve`     | ![loops](https://img.shields.io/badge/loops-yellow) | you want tournament-style evolutionary improvement of code     |

</details>

The [Full Reference](docs/REFERENCE.md#skills-63-total) lists every skill with
its arguments.

### Magic keywords

Type these in a normal prompt; no slash needed.

| Keyword                                      | Category | Starts             |
| -------------------------------------------- | -------- | ------------------ |
| `autopilot`, `build me an app`, `end to end` | ![execution](https://img.shields.io/badge/execution-green) | autopilot          |
| `ralph`                                      | ![loops](https://img.shields.io/badge/loops-yellow) | ralph              |
| `ralplan`                                    | ![planning](https://img.shields.io/badge/planning-orange) | ralplan            |
| `deep interview`                             | ![planning](https://img.shields.io/badge/planning-orange) | deep-interview     |
| `ultragoal`                                  | ![loops](https://img.shields.io/badge/loops-yellow) | ultragoal          |
| `deslop`, `anti-slop`                        | ![review](https://img.shields.io/badge/review-purple) | ai-slop-cleaner    |
| `tdd`, `test first`                          | ![execution](https://img.shields.io/badge/execution-green) | tdd                |
| `code review`, `security review`             | ![review](https://img.shields.io/badge/review-purple) | review mode        |
| `ultrathink`, `think hard`                   | ![analysis](https://img.shields.io/badge/analysis-purple) | extended reasoning |
| `deepsearch`, `search the codebase`          | ![analysis](https://img.shields.io/badge/analysis-purple) | codebase search    |
| `deep-analyze`                               | ![analysis](https://img.shields.io/badge/analysis-purple) | analysis mode      |
| `wiki`                                       | ![utility](https://img.shields.io/badge/utility-lightgray) | wiki               |
| `cancelomc`, `stopomc`                       | ![setup](https://img.shields.io/badge/setup-lightgray) | cancel             |

**Notes:**

- **Informational filtering**: asking "what is ralph?" won't trigger execution — only actionable uses activate keywords.
- Team mode never starts from a keyword; use `/team`.
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
| `omg factory setup` / `check` / `run <issue>`            | configure the software factory, bucket intake items, drive one issue to a merge-ready PR |
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
