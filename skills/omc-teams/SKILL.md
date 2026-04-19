---
name: omc-teams
description: CLI-team runtime for claude, codex, or gemini workers in tmux panes when you need process-based parallel execution
aliases: []
---

# OMC Teams Skill

Spawn N CLI worker processes in tmux panes to execute tasks in parallel. Supports `copilot`, `codex`, and `gemini` agent types.

`/omc-teams` is a legacy compatibility skill for the CLI-first runtime: use `omcp team ...` commands (not deprecated MCP runtime tools).

## Usage

```bash
/oh-my-copilot:omc-teams N:copilot "task description"
/oh-my-copilot:omc-teams N:codex "task description"
/oh-my-copilot:omc-teams N:gemini "task description"
```

### Parameters

- **N** - Number of CLI workers (1-10)
- **agent-type** - `copilot` (Copilot CLI), `codex` (OpenAI Codex CLI), or `gemini` (Google Gemini CLI)
- **task** - Task description to distribute across all workers

### Examples

```bash
/omc-teams 2:copilot "implement auth module with tests"
/omc-teams 2:codex "review the auth module for security issues"
/omc-teams 3:gemini "redesign UI components for accessibility"
```

## Requirements

- **tmux** must be running (`$TMUX` set in the current shell)
- **copilot** CLI: `npm install -g @github/copilot`
- **codex** CLI: `npm install -g @openai/codex`
- **gemini** CLI: `npm install -g @google/gemini-cli`

## Workflow

### Phase 1: Parse input

Extract:

- `N` — worker count (1–10)
- `agent-type` — `copilot|codex|gemini`
- `task` — task description

### Phase 2: Decompose task

Break work into N independent subtasks (file- or concern-scoped) to avoid write conflicts.

### Phase 2.5: Resolve workspace root for multi-repo plans

`omcp team` launches all workers with one shared working directory. For single-repo
tasks, the current repo is usually correct. For multi-repo tasks, especially when a
plan lives in one repo but the implementation touches sibling repos, resolve the
working directory before launch:

- If the task references a plan artifact under one repo (for example
  `tool/.omc/plans/task-1200-gwd-gifs.md`) and target paths in sibling repos
  (for example `api/` and `admin/`), choose the shared workspace root that contains
  all participating repos (for example the parent `inter/` directory).
- Use an **absolute plan path** in the task text so the workers can still find the
  plan after `--cwd` changes the launch directory.
- Include the explicit repo paths or repo names in the task text and subtasks.
- Do not anchor the launch cwd to only the repo containing `.omc/plans/...` when
  target repos are siblings; that strands `codex`, `copilot`, and `gemini` workers in
  the plan repo instead of the implementation workspace.
- If no safe shared workspace root can be identified, do not launch `/omc-teams`.
  Report the single-cwd constraint and ask for, or derive from evidence, the intended
  workspace root.

### Phase 3: Start CLI team runtime

Activate mode state (recommended):

```text
state_write(mode="team", current_phase="team-exec", active=true)
```

Start workers via CLI:

```bash
omcp team <N>:<copilot|codex|gemini> "<task>"
```

For the multi-repo case resolved in Phase 2.5, launch from the shared workspace root
with the existing `--cwd` contract and keep the plan reference absolute:

```bash
omcp team <N>:<copilot|codex|gemini> "<task with absolute plan path and explicit repo paths>" --cwd <workspace-root>
```

Team name defaults to a slug from the task text (example: `review-auth-flow`).

### Phase 4: Monitor + lifecycle API

```bash
omcp team status <team-name>
omcp team api list-tasks --input '{"team_name":"<team-name>"}' --json
```

Use `omcp team api ...` for task claiming, task transitions, mailbox delivery, and worker state updates.

### Phase 5: Shutdown (only when needed)

```bash
omcp team shutdown <team-name>
omcp team shutdown <team-name> --force
```

Use shutdown for intentional cancellation or stale-state cleanup. Prefer non-force shutdown first.

### Phase 6: Report + state close

Report task results with completion/failure summary and any remaining risks.

```text
state_write(mode="team", current_phase="complete", active=false)
```

## Deprecated Runtime Note

Legacy MCP runtime tools are deprecated for execution:

- `omc_run_team_start`
- `omc_run_team_status`
- `omc_run_team_wait`
- `omc_run_team_cleanup`

If encountered, switch to `omcp team ...` CLI commands.

## Error Reference

| Error                        | Cause                               | Fix                                                                                 |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| `not inside tmux`            | Shell not running inside tmux       | Start tmux and rerun                                                                |
| `codex: command not found`   | Codex CLI not installed             | `npm install -g @openai/codex`                                                      |
| `gemini: command not found`  | Gemini CLI not installed            | `npm install -g @google/gemini-cli`                                                 |
| `Team <name> is not running` | stale or missing runtime state      | `omcp team status <team-name>` then `omcp team shutdown <team-name> --force` if stale |
| `status: failed`             | Workers exited with incomplete work | inspect runtime output, narrow scope, rerun                                         |

## Relationship to `/team`

| Aspect       | `/team`                                   | `/omc-teams`                                         |
| ------------ | ----------------------------------------- | ---------------------------------------------------- |
| Worker type  | Copilot CLI native team agents            | copilot / codex / gemini CLI processes in tmux        |
| Invocation   | `TeamCreate` / `Task` / `SendMessage`     | `omcp team [N:agent]` + `status` + `shutdown` + `api` |
| Coordination | Native team messaging and staged pipeline | tmux worker runtime + CLI API state files            |
| Use when     | You want Copilot-native team orchestration | You want external CLI worker execution               |
