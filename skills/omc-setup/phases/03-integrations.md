# Phase 3: Integration Setup

**Skip condition**: If resuming and `lastCompletedStep >= 6`, skip this entire phase.

## Step 3.1: Verify Plugin Installation

```bash
grep -q "oh-my-copilot" ~/.copilot/settings.json && echo "Plugin verified" || echo "Plugin NOT found - run: copilot /install-plugin oh-my-copilot"
```

## Step 3.2: Offer MCP Server Configuration

MCP servers extend Copilot CLI with additional tools (web search, GitHub, etc.).

Use AskUserQuestion: "Would you like to configure MCP servers for enhanced capabilities? (Context7, Exa search, GitHub, etc.)"

If yes, invoke the mcp-setup skill:
```
/oh-my-copilot:mcp-setup
```

If no, skip to next step.

## Step 3.3: Configure Agent Teams (Optional)

Agent teams let you spawn N coordinated agents working on a shared task list with inter-agent messaging. **Teams are enabled by default** in oh-my-copilot — no additional configuration is needed to use them.

Use AskUserQuestion:

**Question:** "Would you like to customize team defaults? (e.g., `/team 3:executor 'fix all errors'`)"

**Options:**
1. **Keep defaults (Recommended)** - 3 agents, executor type
2. **Customize** - Choose agent count and default type
3. **Skip** - Move on

### If User Chooses Customize:

#### 3.3.1: Configure Team Defaults in omc-config

Use AskUserQuestion with multiple questions:

**Question 1:** "How many agents should teams spawn by default?"

**Options:**
1. **3 agents (Recommended)** - Good balance of speed and resource usage
2. **5 agents (maximum)** - Maximum parallelism for large tasks
3. **2 agents** - Conservative, for smaller projects

**Question 2:** "Which agent type should teammates use by default?"

**Options:**
1. **executor (Recommended)** - General-purpose code implementation agent
2. **debugger** - Specialized for build/type error fixing and debugging
3. **designer** - Specialized for UI/frontend work

Store the team configuration in `~/.copilot/.omc-config.json`:

```bash
CONFIG_FILE="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/.omc-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi

# Replace MAX_AGENTS, AGENT_TYPE with user choices
echo "$EXISTING" | jq \
  --argjson maxAgents MAX_AGENTS \
  --arg agentType "AGENT_TYPE" \
  '. + {team: {maxAgents: $maxAgents, defaultAgentType: $agentType, monitorIntervalMs: 30000, shutdownTimeoutMs: 15000}}' > "$CONFIG_FILE"

echo "Team configuration saved:"
echo "  Max agents: MAX_AGENTS"
echo "  Default agent: AGENT_TYPE"
echo "  Model: teammates inherit your session model"
```

#### Verify Configuration

After modifications, verify the config is valid:

```bash
CONFIG_FILE="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/.omc-config.json"

if [ -f "$CONFIG_FILE" ]; then
  echo "Team configuration:"
  jq '.team' "$CONFIG_FILE"
else
  echo "Using default team settings (3 agents, executor type)"
fi
```

### If User Chooses Keep Defaults or Skip:

Skip this step. Default team configuration (3 agents, executor type) will be used. User can customize later by running `/oh-my-copilot:omc-setup --force`.

## Azure DevOps Integrations (when ADO repo detected)

If the current repository is hosted on Azure DevOps (detected via git remote URL containing `dev.azure.com` or `visualstudio.com`), recommend the following:

### Azure DevOps MCP Server
For enhanced ADO integration with MCP tools (work items, repos, pipelines, wiki, test plans):

```bash
# Install azure-devops-mcp server
# See: https://github.com/microsoft/azure-devops-mcp
```

Add to your `.mcp.json` or Copilot CLI MCP configuration:
```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "npx",
      "args": ["-y", "@microsoft/azure-devops-mcp"],
      "env": {
        "AZURE_DEVOPS_ORG": "https://dev.azure.com/{your-org}",
        "AZURE_DEVOPS_PROJECT": "{your-project}"
      }
    }
  }
}
```

### Azure Skills Plugin (for Azure cloud operations)
If you work with Azure cloud services beyond DevOps (compute, storage, AI, networking, security, deployment), install the azure-skills plugin:

```bash
# Install azure-skills plugin for Copilot CLI
copilot plugin install microsoft/azure-skills
```

This provides 24 specialized skills for Azure cloud operations. oh-my-copilot handles ADO orchestration; azure-skills handles the Azure cloud layer. They are complementary.

### Run ADO Setup
After installing the MCP server, configure your project:
```
/oh-my-copilot:omc-ado-setup
```

## Save Progress

```bash
CONFIG_TYPE=$(jq -r '.configType // "unknown"' ".omg/state/setup-state.json" 2>/dev/null || echo "unknown")
bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-progress.sh" save 6 "$CONFIG_TYPE"
```
