---
name: mcp-setup
description: Configure popular MCP servers for enhanced agent capabilities
---

# MCP Setup

Configure Model Context Protocol (MCP) servers to extend Copilot CLI's capabilities with external tools like web search, token optimization, and DevOps integration.

## Overview

MCP servers provide additional tools that Copilot CLI agents can use. This skill helps you configure popular MCP servers using the `copilot mcp add` command-line interface.

## Step 1: Choose a Setup Path

Use **AskUserQuestion** with **one question at a time** and **no more than 3 options per question**. Recent Copilot CLI builds reject larger option payloads as invalid tool parameters, so keep the MCP selection flow staged.

### Step 1.1: First menu

**Question:** "What kind of MCP setup would you like?"

**Options:**
1. **Recommended starter setup** - Fast path for the most common OMCP MCP additions
2. **Individual popular server** - Pick one built-in server from a short follow-up menu
3. **Custom server** - Add your own stdio or HTTP MCP server

### Step 1.2: If the user chooses "Recommended starter setup"

Ask a follow-up **AskUserQuestion**:

**Question:** "Which recommended MCP bundle should I configure?"

**Options:**
1. **Context7 only (Recommended)** - Zero-config docs/context server
2. **Context7 + lean-ctx** - Docs/context plus token-saving compression layer
3. **Full recommended bundle** - Context7, lean-ctx, Exa, and GitHub

Map that choice to the server list you will configure.

### Step 1.3: If the user chooses "Individual popular server"

Ask a follow-up **AskUserQuestion**:

**Question:** "Which server should I configure first?"

**Options:**
1. **Context7 (Recommended)** - Documentation and code context from popular libraries
2. **lean-ctx** - Token-saving compression layer for Read/Grep/Bash tools
3. **More server choices** - Exa, GitHub, Azure DevOps, or the full recommended bundle

If the user chooses **More server choices**, ask one more **AskUserQuestion**:

**Question:** "Which additional MCP option do you want?"

**Options:**
1. **Exa Web Search** - Enhanced web search (replaces built-in websearch)
2. **GitHub / Azure DevOps** - Repository and project management integration
3. **Full recommended bundle** - Configure Context7, lean-ctx, Exa, and GitHub together

### Step 1.4: If the user chooses "Custom server"

Skip directly to the **Custom MCP Server** section below.

## Step 2: Gather Required Information

### For Context7:
No API key required. Ready to use immediately.

### For Exa Web Search:
Ask for API key:
```
Do you have an Exa API key?
- Get one at: https://exa.ai
- Enter your API key, or type 'skip' to configure later
```

### For lean-ctx:
No API key required. Installs automatically. Saves 60-80% input tokens via caching and compression.
More info: https://github.com/yvgude/lean-ctx

### For GitHub:
Ask for token:
```
Do you have a GitHub Personal Access Token?
- Create one at: https://github.com/settings/tokens
- Recommended scopes: repo, read:org
- Enter your token, or type 'skip' to configure later
```

### For Azure DevOps:
Ask for organization:
```
What is your Azure DevOps organization URL?
- Example: https://dev.azure.com/my-org
- Enter your organization URL, or type 'skip' to configure later
```
More info: https://github.com/microsoft/azure-devops-mcp

## Step 3: Add MCP Servers Using CLI

Use the `copilot mcp add` command to configure each MCP server. The CLI automatically handles settings.json updates and merging.

### Context7 Configuration:
```bash
copilot mcp add context7 -- npx -y @upstash/context7-mcp
```

### Exa Web Search Configuration:
```bash
copilot mcp add -e EXA_API_KEY=<user-provided-key> exa -- npx -y exa-mcp-server
```

### lean-ctx Configuration:
```bash
npm install -g lean-ctx-bin && lean-ctx setup
```
> Note: lean-ctx uses its own installer (`lean-ctx setup`) which auto-configures shell and all detected editors. It hooks into existing tools (Read, Grep, Bash) to compress and cache results automatically.


### GitHub Configuration:

**Option 1: Docker (local)**
```bash
copilot mcp add -e GITHUB_PERSONAL_ACCESS_TOKEN=<user-provided-token> github -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server
```

**Option 2: HTTP (remote)**
```bash
copilot mcp add --transport http github https://api.githubcopilot.com/mcp/
```

> Note: Docker option requires Docker installed. HTTP option is simpler but may have different capabilities.

### Azure DevOps Configuration:
```bash
copilot mcp add azure-devops -- npx -y @microsoft/azure-devops-mcp
```

> Note: Requires Azure DevOps authentication. Run `az login` first or configure a PAT. See https://github.com/microsoft/azure-devops-mcp for setup details.

## Step 4: Verify Installation

After configuration, verify the MCP servers are properly set up:

```bash
# List configured MCP servers
copilot mcp list
```

This will display all configured MCP servers and their status.

## Step 5: Show Completion Message

```
MCP Server Configuration Complete!

CONFIGURED SERVERS:
[List the servers that were configured]

NEXT STEPS:
1. Restart Copilot CLI for changes to take effect
2. The configured MCP tools will be available to all agents
3. Run `copilot mcp list` to verify configuration

USAGE TIPS:
- Context7: Ask about library documentation (e.g., "How do I use React hooks?")
- Exa: Use for web searches (e.g., "Search the web for latest TypeScript features")
- lean-ctx: Automatic — compresses Read/Grep/Bash results to save tokens
- GitHub: Interact with GitHub repos, issues, and PRs
- Azure DevOps: Manage work items, pipelines, repos, and wikis

TROUBLESHOOTING:
- If MCP servers don't appear, run `copilot mcp list` to check status
- Ensure you have Node.js 18+ installed for npx-based servers
- For GitHub Docker option, ensure Docker is installed and running
- Run /oh-my-copilot:omc-doctor to diagnose issues

MANAGING MCP SERVERS:
- Add more servers: /oh-my-copilot:mcp-setup or `copilot mcp add ...`
- List servers: `copilot mcp list`
- Remove a server: `copilot mcp remove <server-name>`
```

## Custom MCP Server

If user selects "Custom":

Ask for:
1. Server name (identifier)
2. Transport type: `stdio` (default) or `http`
3. For stdio: Command and arguments (e.g., `npx my-mcp-server`)
4. For http: URL (e.g., `https://example.com/mcp`)
5. Environment variables (optional, key=value pairs)
6. HTTP headers (optional, for http transport only)

Then construct and run the appropriate `copilot mcp add` command:

**For stdio servers:**
```bash
# Without environment variables
copilot mcp add <server-name> -- <command> [args...]

# With environment variables
copilot mcp add -e KEY1=value1 -e KEY2=value2 <server-name> -- <command> [args...]
```

**For HTTP servers:**
```bash
# Basic HTTP server
copilot mcp add --transport http <server-name> <url>

# HTTP server with headers
copilot mcp add --transport http --header "Authorization: Bearer <token>" <server-name> <url>
```

### Company-context convention

If the custom server is meant to provide organization-specific reference material to OMC workflows, prefer a single tool named `get_company_context` that returns markdown via `{ context: string }`.

Example local registration:

```bash
copilot mcp add company-context -- node examples/vendor-mcp-server/server.mjs
```

Then point OMC at the full tool name in `.copilot/omg.jsonc` or `~/.config/copilot-omg/config.jsonc`:

```jsonc
{
  "companyContext": {
    "tool": "mcp__company-context__get_company_context",
    "onError": "warn"
  }
}
```

This remains advisory prompt context, not runtime enforcement.

## Common Issues

### MCP Server Not Loading
- Ensure Node.js 18+ is installed
- Check that npx is available in PATH
- Run `copilot mcp list` to verify server status
- Check server logs for errors

### API Key Issues
- Exa: Verify key at https://dashboard.exa.ai
- GitHub: Ensure token has required scopes (repo, read:org)
- Azure DevOps: Run `az login` or check PAT permissions
- Re-run `copilot mcp add` with correct credentials if needed

### Agents Still Using Built-in Tools
- Restart Copilot CLI after configuration
- The built-in websearch will be deprioritized when exa is configured
- Run `copilot mcp list` to confirm servers are active

### Removing or Updating a Server
- Remove: `copilot mcp remove <server-name>`
- Update: Remove the old server, then add it again with new configuration
