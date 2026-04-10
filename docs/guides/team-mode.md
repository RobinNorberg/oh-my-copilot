# Team Mode

**Team** is the canonical orchestration surface in OMC.

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

## tmux CLI Workers

Use the CLI-first Team runtime (`omcp team ...`) to spawn real tmux worker panes:

```bash
omcp team 2:claude "review auth architecture"
omcp team 2:codex "review auth module for security issues"
omcp team 2:gemini "redesign UI components for accessibility"
omcp team 1:copilot "implement the payment flow"
omcp team status auth-review
omcp team shutdown auth-review
```

For multi-model work in one command, use the **`/c3g`** skill (routes via `ask-claude` + `ask-codex` + `ask-gemini`, then Copilot synthesizes):

```bash
/c3g Review this PR — architecture (Claude) security (Codex) and UI components (Gemini)
```

## Worker Surface Comparison

| Surface                    | Workers                 | Best For                                      |
| -------------------------- | ----------------------- | --------------------------------------------- |
| `omcp team N:claude "..."`  | N Claude Code CLI panes | Deep reasoning, architecture, complex analysis |
| `omcp team N:codex "..."`   | N Codex CLI panes       | Code review, security analysis                |
| `omcp team N:gemini "..."`  | N Gemini CLI panes      | UI/UX design, docs, large-context tasks       |
| `omcp team N:copilot "..."` | N Copilot CLI panes     | General tasks via Copilot CLI in tmux         |
| `/c3g`                     | ask-claude + ask-codex + ask-gemini | Quad-model advisor synthesis          |

Workers spawn on-demand and die when their task completes — no idle resource usage. Requires the respective CLI tool installed and an active tmux session.

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
