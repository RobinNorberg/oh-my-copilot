---
name: hud
description: Configure HUD display options (layout, presets, display elements)
argument-hint: "[setup|minimal|focused|full|dense|opencode|disable|status]"
role: config-writer  # DOCUMENTATION ONLY - This skill writes to ~/.copilot/ paths
scope: ~/.copilot/**  # DOCUMENTATION ONLY - Allowed write scope
level: 2
---

# HUD Skill

Configure the OMC HUD (Heads-Up Display) for the statusline.

Note: All `~/.copilot/...` paths in this guide respect `COPILOT_CONFIG_DIR` when that environment variable is set.

## Quick Commands

| Command | Description |
|---------|-------------|
| `/oh-my-copilot:hud` | Show current HUD status (auto-setup if needed) |
| `/oh-my-copilot:hud setup` | Install/repair HUD statusline |
| `/oh-my-copilot:hud minimal` | Switch to minimal display |
| `/oh-my-copilot:hud focused` | Switch to focused display (default) |
| `/oh-my-copilot:hud full` | Switch to full display |
| `/oh-my-copilot:hud dense` | Switch to dense display (compact with all features) |
| `/oh-my-copilot:hud opencode` | Switch to opencode display (code-focused) |
| `/oh-my-copilot:hud disable` | Disable the HUD statusline |
| `/oh-my-copilot:hud status` | Show detailed HUD status |

## Disable

When the argument is `disable`, remove the `statusLine` field from `~/.copilot/settings.json` using the Edit tool. This disables the HUD entirely. Tell the user to restart Copilot CLI for changes to take effect.

## Auto-Setup

When you run `/oh-my-copilot:hud` or `/oh-my-copilot:hud setup`, the system will automatically:
1. Check if `~/.copilot/hud/omcp-hud.mjs` exists
2. Check if `statusLine` is configured in `~/.copilot/settings.json`
3. If missing, create the HUD wrapper script and configure settings
4. Report status and prompt to restart Copilot CLI if changes were made

**IMPORTANT**: If the argument is `setup` OR if the HUD script doesn't exist at `~/.copilot/hud/omcp-hud.mjs`, you MUST create the HUD files directly using the instructions below.

### Setup Instructions (Run These Commands)

**Step 1:** Check if setup is needed:
```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.copilot');console.log(f.existsSync(p.join(d,'hud','omcp-hud.mjs'))?'EXISTS':'MISSING')"
```

**Step 2:** Verify the plugin is installed:
```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.copilot'),b=p.join(d,'plugins','cache','omc','oh-my-copilot');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));if(v.length===0){console.log('Plugin not installed - run: /plugin install oh-my-copilot');process.exit()}const l=v[v.length-1],h=p.join(b,l,'dist','hud','index.js');console.log('Version:',l);console.log(f.existsSync(h)?'READY':'NOT_FOUND - try reinstalling: /plugin install oh-my-copilot')}catch{console.log('Plugin not installed - run: /plugin install oh-my-copilot')}"
```

**Step 3:** If omcp-hud.mjs is MISSING or argument is `setup`, install the HUD wrapper and its dependency from the canonical template:

```bash
HUD_DIR="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/hud"
mkdir -p "$HUD_DIR/lib"
cp "${COPILOT_PLUGIN_ROOT}/scripts/lib/hud-wrapper-template.txt" "$HUD_DIR/omcp-hud.mjs"
cp "${COPILOT_PLUGIN_ROOT}/scripts/lib/config-dir.mjs" "$HUD_DIR/lib/config-dir.mjs"
```

**IMPORTANT:** Always copy from the canonical template at `scripts/lib/hud-wrapper-template.txt`. Do NOT write the wrapper content inline — the template is the single source of truth and is guarded by drift tests (`src/__tests__/hud-wrapper-template-sync.test.ts`, `src/__tests__/paths-consistency.test.ts`).

**Step 4:** Make it executable (Unix only, skip on Windows):
```bash
node -e "if(process.platform==='win32'){console.log('Skipped (Windows)')}else{require('fs').chmodSync(require('path').join(process.env.COPILOT_CONFIG_DIR||require('path').join(require('os').homedir(),'.copilot'),'hud','omcp-hud.mjs'),0o755);console.log('Done')}"
```

**Step 5:** Update config.json to use the HUD:

Read `${COPILOT_CONFIG_DIR:-~/.copilot}/config.json`, then update/add the `statusLine` field and ensure `experimental` is true.

**IMPORTANT:** Do not use `~` in the command. On Unix, use `$HOME` to keep the path portable across machines. On Windows, use an absolute path because Windows does not expand `~` in shell commands.

If you are on Windows, first determine the correct path:
```bash
node -e "const p=require('path').join(require('os').homedir(),'.copilot','hud','omcp-hud.mjs').split(require('path').sep).join('/');console.log(JSON.stringify(p))"
```

**IMPORTANT:** The command path MUST use forward slashes on all platforms. Copilot CLI executes statusLine commands via bash, which interprets backslashes as escape characters and breaks the path.

Then set the `statusLine` and `experimental` fields in `config.json`:

On **Unix/macOS**:
```json
{
  "experimental": true,
  "statusLine": {
    "type": "command",
    "command": "sh ${COPILOT_CONFIG_DIR:-$HOME/.copilot}/hud/find-node.sh ${COPILOT_CONFIG_DIR:-$HOME/.copilot}/hud/omcp-hud.mjs"
  }
}
```

On **Windows**, first create a `.cmd` wrapper at `~/.copilot/copilot-hud.cmd`:
```cmd
@echo off
node "C:\Users\username\.copilot\hud\omcp-hud.mjs"
```
Then set `config.json`:
```json
{
  "experimental": true,
  "statusLine": {
    "type": "command",
    "command": "C:/Users/username/.copilot/copilot-hud.cmd"
  }
}
```

**IMPORTANT**: On Windows, bash wrappers (.sh) spawn separate console windows and break stdout capture. Always use `.cmd` wrappers on Windows.

Use the Edit tool to add/update these fields while preserving other settings.

**Step 6:** Clean up old HUD scripts (if any):
```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.copilot'),t=p.join(d,'hud','omcp-hud.mjs');try{if(f.existsSync(t)){f.unlinkSync(t);console.log('Removed legacy script')}else{console.log('No legacy script found')}}catch{}"
```

**Step 7:** Tell the user to restart Copilot CLI for changes to take effect.

## Display Presets

### Minimal
Shows only the essentials:
```
[OMC] ralph | ultrawork | todos:2/5
```

### Focused (Default)
Shows all relevant elements:
```
[OMC] branch:main | ralph:3/10 | US-002 | ultrawork skill:planner | ctx:67% | agents:2 | bg:3/5 | todos:2/5
```

### Full
Shows everything including multi-line agent details:
```
[OMC] repo:oh-my-copilot branch:main | ralph:3/10 | US-002 (2/5) | ultrawork | ctx:[████░░]67% | agents:3 | bg:3/5 | todos:2/5
├─ O architect    2m   analyzing architecture patterns...
├─ e explore     45s   searching for test files
└─ s executor     1m   implementing validation logic
```

### Dense
Compact single-line with all features — same as full but compressed:
```
[OMC] main|r:3/10|US-002|ulw|ctx:67%|ag:3|bg:3/5|td:2/5
```

### Opencode
Code-focused display optimized for opencode terminal workflows:
```
[OMC] branch:main | ctx:67% | todos:2/5
```

## Multi-Line Agent Display

When agents are running, the HUD shows detailed information on separate lines:
- **Tree characters** (`├─`, `└─`) show visual hierarchy
- **Agent code** (O, e, s) indicates agent type with model tier color
- **Duration** shows how long each agent has been running
- **Description** shows what each agent is doing (up to 45 chars)

## Display Elements

| Element | Description |
|---------|-------------|
| `[OMC]` | Mode identifier |
| `repo:name` | Git repository name (cyan) |
| `branch:name` | Git branch name (cyan) |
| `ralph:3/10` | Ralph loop iteration/max |
| `US-002` | Current PRD story ID |
| `ultrawork` | Active mode badge |
| `skill:name` | Last activated skill (cyan) |
| `ctx:67%` | Context window usage |
| `agents:2` | Running subagent count |
| `bg:3/5` | Background task slots |
| `todos:2/5` | Todo completion |

## Color Coding

- **Green**: Normal/healthy
- **Yellow**: Warning (context >70%, ralph >7)
- **Red**: Critical (context >85%, ralph at max)

## Configuration Location

HUD config is stored in `~/.copilot/settings.json` under the `omcHud` key (or your custom config directory if `COPILOT_CONFIG_DIR` is set).

Legacy config location (deprecated): `~/.copilot/.omcp/hud-config.json`

## Manual Configuration

You can manually edit the config file. Each option can be set individually - any unset values will use defaults.

```json
{
  "preset": "focused",
  "elements": {
    "omcLabel": true,
    "ralph": true,
    "autopilot": true,
    "prdStory": true,
    "activeSkills": true,
    "lastSkill": true,
    "contextBar": true,
    "agents": true,
    "agentsFormat": "multiline",
    "backgroundTasks": true,
    "todos": true,
    "thinking": true,
    "thinkingFormat": "text",
    "permissionStatus": false,
    "apiKeySource": false,
    "profile": true,
    "promptTime": true,
    "sessionHealth": true,
    "useBars": true,
    "showCallCounts": true,
    "callCountsFormat": "auto",
    "safeMode": true,
    "maxOutputLines": 4
  },
  "thresholds": {
    "contextWarning": 70,
    "contextCompactSuggestion": 80,
    "contextCritical": 85,
    "ralphWarning": 7
  },
  "staleTaskThresholdMinutes": 30,
  "contextLimitWarning": {
    "threshold": 80,
    "autoCompact": false
  }
}
```

### callCountsFormat

Controls the call-count badge icon style:
- `"auto"` (default): emoji on macOS/Linux, ASCII on Windows/WSL
- `"emoji"`: force `🔧 🤖 ⚡`
- `"ascii"`: force `T: A: S:`

### safeMode

When `safeMode` is `true` (default), the HUD strips ANSI codes and uses ASCII-only output to prevent terminal rendering corruption during concurrent updates. This is especially important on Windows and when using terminal multiplexers.

### agentsFormat Options

- `count`: agents:2
- `codes`: agents:Oes (type-coded with model tier casing)
- `codes-duration`: agents:O(2m)es (codes with duration)
- `detailed`: agents:[architect(2m),explore,exec]
- `descriptions`: O:analyzing code | e:searching (codes + what they're doing)
- `tasks`: [analyzing code, searching...] (just descriptions)
- `multiline`: Multi-line display with full agent details on separate lines

## Troubleshooting

If the HUD is not showing:
1. Run `/oh-my-copilot:hud setup` to auto-install and configure
2. Restart Copilot CLI after setup completes
3. If still not working, run `/oh-my-copilot:omc-doctor` for full diagnostics

**Legacy string format migration:** Older OMC versions wrote `statusLine` as a plain string (e.g., `"~/.copilot/hud/omcp-hud.mjs"`). Modern Copilot CLI (v2.1+) requires an object format. Running the installer or `/oh-my-copilot:hud setup` will auto-migrate legacy strings to the correct object format:
```json
{
  "statusLine": {
    "type": "command",
    "command": "node ${COPILOT_CONFIG_DIR:-$HOME/.copilot}/hud/omcp-hud.mjs"
  }
}
```

**Node 24+ compatibility:** The HUD wrapper script imports `homedir` from `node:os` (not `node:path`). If you encounter `SyntaxError: The requested module 'path' does not provide an export named 'homedir'`, re-run the installer to regenerate `omcp-hud.mjs`.

Manual verification:
- HUD script: `~/.copilot/hud/omcp-hud.mjs`
- Config: `~/.copilot/config.json` should have `statusLine` and `experimental: true` configured

---

*The HUD updates automatically every ~300ms during active sessions.*
