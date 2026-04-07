---
name: setup
description: Use first for install/update routing — sends setup, doctor, or MCP requests to the correct OMC setup flow
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

Process the request by the **first argument only** so install/setup questions land on the right flow immediately:

- No argument, `wizard`, `local`, `global`, or `--force` -> route to `/oh-my-copilot:omc-setup` with the same remaining args
- `doctor` -> route to `/oh-my-copilot:omc-doctor` with everything after the `doctor` token
- `mcp` -> route to `/oh-my-copilot:mcp-setup` with everything after the `mcp` token

Examples:

```bash
/oh-my-copilot:setup --local          # => /oh-my-copilot:omc-setup --local
/oh-my-copilot:setup doctor --json    # => /oh-my-copilot:omc-doctor --json
/oh-my-copilot:setup mcp github       # => /oh-my-copilot:mcp-setup github
```

## Notes

- `/oh-my-copilot:omc-setup`, `/oh-my-copilot:omc-doctor`, and `/oh-my-copilot:mcp-setup` remain valid compatibility entrypoints.
- Prefer `/oh-my-copilot:setup` in new documentation and user guidance.

Task: {{ARGUMENTS}}
