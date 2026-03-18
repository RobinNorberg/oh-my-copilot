# Team Mode

Starting in **v4.1.7**, **Team** is the canonical orchestration surface in OMC. The legacy `swarm` keyword/skill has been removed; use `team` directly.

```bash
/team 3:executor "fix all TypeScript errors"
```

Team runs as a staged pipeline:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

## Enabling Native Teams

Enable Copilot CLI native teams in `~/.copilot/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> If teams are disabled, OMC will warn you and fall back to non-team execution where possible.

## tmux CLI Workers — Codex & Gemini (v4.4.0+)

**v4.4.0 removes the Codex/Gemini MCP servers** (`x`, `g` providers). Use the CLI-first Team runtime (`omc team ...`) to spawn real tmux worker panes:

```bash
omc team 2:codex "review auth module for security issues"
omc team 2:gemini "redesign UI components for accessibility"
omc team 1:copilot "implement the payment flow"
omc team status auth-review
omc team shutdown auth-review
```

`/omc-teams` remains as a legacy compatibility skill and now routes to `omc team ...`.

For mixed Codex + Gemini work in one command, use the **`/ccg`** skill (routes via `ask-codex` + `ask-gemini`, then Copilot synthesizes):

```bash
/ccg Review this PR — architecture (Codex) and UI components (Gemini)
```

## Worker Surface Comparison

| Surface                    | Workers                 | Best For                                     |
| -------------------------- | ----------------------- | -------------------------------------------- |
| `omc team N:codex "..."`   | N Codex CLI panes       | Code review, security analysis, architecture |
| `omc team N:gemini "..."`  | N Gemini CLI panes      | UI/UX design, docs, large-context tasks      |
| `omc team N:copilot "..."` | N Copilot CLI panes     | General tasks via Copilot CLI in tmux        |
| `/ccg`                     | ask-codex + ask-gemini  | Tri-model advisor synthesis                  |

Workers spawn on-demand and die when their task completes — no idle resource usage. Requires `codex` / `gemini` CLIs installed and an active tmux session.

## Updating

```bash
# 1. Update the marketplace clone
/plugin marketplace update omc

# 2. Re-run setup to refresh configuration
/omc-setup
```

> If marketplace auto-update is not enabled, you must manually run `/plugin marketplace update omc` to sync the latest version before running setup.

If you experience issues after updating, clear the old plugin cache:

```bash
/omc-doctor
```
