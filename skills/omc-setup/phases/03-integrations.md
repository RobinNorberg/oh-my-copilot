# Phase 3: Integration Setup

**Skip condition**: If resuming and `lastCompletedStep >= 6`, skip this entire phase.

## Step 3.1: Verify Plugin Installation

```bash
CONFIG_DIR="${COPILOT_CONFIG_DIR:-$HOME/.claude}"
case "$CONFIG_DIR" in
  "~") CONFIG_DIR="$HOME" ;;
  "~/"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~/}" ;;
  "~\\"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~\\}" ;;
esac
grep -q "oh-my-copilot" "$CONFIG_DIR/settings.json" && echo "Plugin verified" || echo "Plugin NOT found - run: claude /install-plugin oh-my-copilot"
```

## Step 3.2: MCP Server Configuration (Pointer Only)

MCP servers extend Claude Code with additional tools (web search, GitHub, etc.). OMC no longer ships an MCP setup skill; servers are registered through Claude Code's native MCP surfaces.

If the user asks about MCP servers, point them at the native registration path:

- Claude Code: `claude mcp add <name> ...` (see `claude mcp --help`), or the native MCP config selected by `CLAUDE_MCP_CONFIG_PATH` (by default, the sibling `.claude.json` next to `${COPILOT_CONFIG_DIR:-$HOME/.claude}`)
- OMC keeps its own bundled MCP server (`bridge/mcp-server.cjs`) registered via `.mcp.json`; it requires no user action
- Company-context guidance, if used, is documented in `docs/company-context-interface.md`

Do **not** try to invoke an MCP setup skill — `mcp-setup` was removed in 5.0.0 and has no replacement skill; the native surfaces above are the whole story.

## Step 3.3: Configure Agent Teams (Optional)

Agent teams are an experimental Claude Code feature that lets you spawn N coordinated agents working on a shared task list with inter-agent messaging. **Teams are disabled by default** and require enabling via `settings.json`.

Reference: https://code.claude.com/docs/en/agent-teams

Use AskUserQuestion:

**Question:** "Would you like to enable agent teams? Teams let you spawn coordinated agents (e.g., `/team 3:executor 'fix all errors'`). This is an experimental Claude Code feature."

**Options:**
1. **Yes, enable teams (Recommended)** - Enable the experimental feature and configure defaults
2. **No, skip** - Leave teams disabled (can enable later)

### If User Chooses YES:

#### 3.3.1: Enable Agent Teams in settings.json

**CRITICAL**: Agent teams require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` to be set in `~/.claude/settings.json`. This must be done carefully to preserve existing user settings.

First, read the current settings.json:

```bash
CONFIG_DIR="${COPILOT_CONFIG_DIR:-$HOME/.claude}"
case "$CONFIG_DIR" in
  "~") CONFIG_DIR="$HOME" ;;
  "~/"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~/}" ;;
  "~\\"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~\\}" ;;
esac
SETTINGS_FILE="$CONFIG_DIR/settings.json"

if [ -f "$SETTINGS_FILE" ]; then
  echo "Current settings.json found"
  cat "$SETTINGS_FILE"
else
  echo "No settings.json found - will create one"
fi
```

Then use the Read tool to read `${COPILOT_CONFIG_DIR:-~/.claude}/settings.json` (if it exists). Use the Edit tool to merge the teams configuration while preserving ALL existing settings.

**MERGE_JSON_FILE** is the portable merge used throughout this phase. It deep-merges a
JSON patch into a file under the active config directory, creates the file when it does
not exist, writes through a temp file so a failure cannot truncate the original, and
refuses to touch a file it cannot parse. It runs unchanged in bash, zsh, and PowerShell,
with no external JSON tooling, no heredoc, and no shell redirection:

```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.claude');const[name,raw]=process.argv.slice(1);const t=p.join(d,name);const patch=JSON.parse(raw);f.mkdirSync(p.dirname(t),{recursive:true});let c={};if(f.existsSync(t)){try{c=JSON.parse(f.readFileSync(t,'utf8'))}catch{console.error('ERROR: '+t+' is not valid JSON. Existing file was not modified.');process.exit(1)}}const merge=(a,b)=>{for(const k of Object.keys(b)){const v=b[k];if(v&&typeof v==='object'&&Array.isArray(v)===false){a[k]=merge(a[k]&&typeof a[k]==='object'?a[k]:{},v)}else{a[k]=v}}return a};merge(c,patch);const tmp=t+'.tmp.'+process.pid;try{f.writeFileSync(tmp,JSON.stringify(c,null,2));f.renameSync(tmp,t);console.log('Updated '+t)}catch(e){f.rmSync(tmp,{force:true});console.error('ERROR: Failed to update '+t+'. Existing file was not modified.');process.exit(1)}" "settings.json" "{\"env\":{\"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\":\"1\"}}"
```

**IMPORTANT**: The Edit tool is preferred for modifying settings.json when possible, since it preserves formatting and comments. The merge command above is the fallback for when the file needs structural merging.

#### 3.3.2: Configure Teammate Display Mode

Use AskUserQuestion:

**Question:** "How should teammates be displayed?"

**Options:**
1. **Auto (Recommended)** - Uses split panes if in tmux, otherwise in-process. Best for most users.
2. **In-process** - All teammates in your main terminal. Use Shift+Up/Down to select. Works everywhere.
3. **Split panes (tmux)** - Each teammate in its own pane. Requires tmux or iTerm2.

If user chooses anything other than "Auto", add `teammateMode` to settings.json:

Run **MERGE_JSON_FILE** with `settings.json` and this patch, where `TEAMMATE_MODE` is
`in-process` or `tmux`. Skip this entirely if the user chose "Auto" (that is the default):

```json
{"teammateMode":"TEAMMATE_MODE"}
```

#### 3.3.3: Configure Team Defaults in omc-config

Use AskUserQuestion with multiple questions:

**Question 1:** "How many agents should teams spawn by default?"

**Options:**
1. **3 agents (Recommended)** - Good balance of speed and resource usage
2. **5 agents (maximum)** - Maximum parallelism for large tasks
3. **2 agents** - Conservative, for smaller projects

**Question 2:** "Which CLI provider should teammates use by default?"

**Options:**
1. **claude (Recommended)** - Default provider with the widest compatibility
2. **codex** - Use Codex CLI workers by default when installed
3. **gemini** - Use Gemini CLI workers by default when installed (enterprise/API-key tier)
4. **antigravity** - Use Antigravity CLI (`agy`) workers by default when installed; Google's successor to the Gemini CLI (install per the [official instructions](https://antigravity.google))

Store the team configuration in the active Claude config directory's `.omc-config.json`:

Run **MERGE_JSON_FILE** with `.omc-config.json` and this patch, substituting the user's
choices for `MAX_AGENTS` (a number, unquoted) and `AGENT_TYPE`:

```json
{"team":{"ops":{"maxAgents":MAX_AGENTS,"defaultAgentType":"AGENT_TYPE","monitorIntervalMs":30000,"shutdownTimeoutMs":15000}}}
```

Then report the saved team configuration: max agents, default provider, and that
teammates inherit your session model.

**Note:** Teammates do not have a separate model default. Each teammate is a full Claude Code session that inherits your configured model. Subagents spawned by teammates can use any model tier.

#### Verify settings.json Integrity

After all modifications, verify settings.json is valid JSON and contains the expected keys:

```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.claude'),t=p.join(d,'settings.json');let c;try{c=JSON.parse(f.readFileSync(t,'utf8'))}catch{console.error('ERROR: settings.json is invalid JSON or missing. Restore it from the backup before continuing.');process.exit(1)}console.log('settings.json: valid JSON');console.log((c.env||{}).CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS?'Agent teams: ENABLED':'WARNING: Agent teams env var not found in settings.json');console.log('');console.log('Final settings.json:');console.log(JSON.stringify(c,null,2))"
```

### If User Chooses NO:

Skip this step. Agent teams will remain disabled. User can enable later by adding to `~/.claude/settings.json`:
```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Or by running `/oh-my-copilot:omc-setup --force` and choosing to enable teams.

## Save Progress

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-progress.mjs" save 6
```

With no config type argument, `save` carries forward the one already recorded in `.omg/state/setup-state.json`.
