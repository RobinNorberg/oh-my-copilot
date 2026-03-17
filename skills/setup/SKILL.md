---
name: setup
description: Unified setup entrypoint for install, diagnostics, and MCP configuration
---

# Setup

Use `/oh-my-copilot:setup` as the unified setup/configuration entrypoint.

## Usage

```bash
/oh-my-copilot:setup                # full setup wizard
/oh-my-copilot:setup doctor         # installation diagnostics
/oh-my-copilot:setup mcp            # MCP server configuration
/oh-my-copilot:setup wizard --local # explicit wizard path
```

## Routing

Route by the first argument:

- No argument, `wizard`, `local`, `global`, or `--force` -> run `/oh-my-copilot:omc-setup {{ARGUMENTS}}`
- `doctor` -> run `/oh-my-copilot:omc-doctor {{ARGUMENTS_AFTER_DOCTOR}}`
- `mcp` -> run `/oh-my-copilot:mcp-setup {{ARGUMENTS_AFTER_MCP}}`

Examples:

```bash
/oh-my-copilot:omc-setup {{ARGUMENTS}}
/oh-my-copilot:omc-doctor {{ARGUMENTS_AFTER_DOCTOR}}
/oh-my-copilot:mcp-setup {{ARGUMENTS_AFTER_MCP}}
```

## Notes

- `/oh-my-copilot:omc-setup`, `/oh-my-copilot:omc-doctor`, and `/oh-my-copilot:mcp-setup` remain valid compatibility entrypoints.
- Prefer `/oh-my-copilot:setup` in new documentation and user guidance.

Task: {{ARGUMENTS}}
