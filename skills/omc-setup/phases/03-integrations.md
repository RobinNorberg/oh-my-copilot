# Phase 3: Integration Setup

**Skip condition**: If resuming and `lastCompletedStep >= 6`, skip this entire phase.

## Step 3.1: Verify Plugin Installation

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-config.mjs" plugin-verify
```

## Step 3.2: MCP Server Configuration (Pointer Only)

MCP servers extend Copilot CLI with additional tools (web search, GitHub, etc.). OMC no longer ships an MCP setup skill; servers are registered through Copilot CLI's native MCP surfaces.

If the user asks about MCP servers, point them at the native registration path:

- Copilot CLI: `copilot mcp add <name> -- <command> [args...]` for a local (stdio) server, or `copilot mcp add --transport http <name> <url>` for a remote one (see `copilot mcp --help`). `copilot mcp list` shows every configured server.
- User servers live in `mcp-config.json` in the Copilot config directory (`${COPILOT_HOME:-~/.copilot}/mcp-config.json`); workspace servers in the project's `.mcp.json` or `.github/mcp.json`
- OMC keeps its own bundled MCP server (`bridge/mcp-server.cjs`) registered via the plugin's `.mcp.json`; it requires no user action
- Company-context guidance, if used, is documented in `docs/company-context-interface.md`

Do **not** try to invoke an MCP setup skill — `mcp-setup` was removed in 5.0.0 and has no replacement skill; the native surfaces above are the whole story.

## Step 3.3: Teams (No Setup Needed)

`omg team` and `/team` need no setting or environment variable on Copilot CLI, so do not ask the user anything here and do not write any file. Tell the user:

- `omg team 3:executor "fix all TypeScript errors"` starts three Copilot CLI workers on a shared task list. Without `N:`, a team gets 3 workers.
- Under Copilot CLI the workers run headless as copilot-sdk sessions by default; `--transport pane` runs them in tmux panes (psmux on Windows) instead.
- To change the defaults, set these keys in `.copilot/omg.jsonc` (project) or the user config (`~/.config/claude-omc/config.jsonc`, `%APPDATA%\claude-omc\config.jsonc` on Windows):

```jsonc
{
  "team": {
    "transport": "auto", // sdk | pane | auto (default: sdk under Copilot CLI)
    "ops": {
      "defaultAgentType": "copilot" // worker CLI when the N:agent-type spec names none
    }
  }
}
```

## Save Progress

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-progress.mjs" save 6
```

With no config type argument, `save` carries forward the one already recorded in `.omg/state/setup-state.json`.
