---
name: hud
description: Configure HUD display options (layout, presets, display elements)
role: config-writer  # DOCUMENTATION ONLY - This skill writes to ~/.copilot/ paths
scope: ~/.copilot/**  # DOCUMENTATION ONLY - Allowed write scope
---

# HUD Skill

Configure the OMP HUD (Heads-Up Display) for the statusline.

Note: All `~/.copilot/...` paths in this guide respect `COPILOT_CONFIG_DIR` when that environment variable is set.

## Quick Commands

| Command | Description |
|---------|-------------|
| `/oh-my-copilot:hud` | Show current HUD status (auto-setup if needed) |
| `/oh-my-copilot:hud setup` | Install/repair HUD statusline |
| `/oh-my-copilot:hud minimal` | Switch to minimal display |
| `/oh-my-copilot:hud focused` | Switch to focused display (default) |
| `/oh-my-copilot:hud full` | Switch to full display |
| `/oh-my-copilot:hud status` | Show detailed HUD status |

## Auto-Setup

When you run `/oh-my-copilot:hud` or `/oh-my-copilot:hud setup`, the system will automatically:
1. Check if `~/.copilot/hud/omg-hud.mjs` exists
2. Check if `statusLine` is configured in `~/.copilot/settings.json`
3. If missing, create the HUD wrapper script and configure settings
4. Report status and prompt to restart Copilot CLI if changes were made

**IMPORTANT**: If the argument is `setup` OR if the HUD script doesn't exist at `~/.copilot/hud/omg-hud.mjs`, you MUST create the HUD files directly using the instructions below.

### Setup Instructions (Run These Commands)

**Step 1:** Check if setup is needed:
```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.copilot');console.log(f.existsSync(p.join(d,'hud','omg-hud.mjs'))?'EXISTS':'MISSING')"
```

**Step 2:** Verify the plugin is installed:
```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.copilot'),b=p.join(d,'plugins','cache','omc','oh-my-copilot');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));if(v.length===0){console.log('Plugin not installed - run: /plugin install oh-my-copilot');process.exit()}const l=v[v.length-1],h=p.join(b,l,'dist','hud','index.js');console.log('Version:',l);console.log(f.existsSync(h)?'READY':'NOT_FOUND - try reinstalling: /plugin install oh-my-copilot')}catch{console.log('Plugin not installed - run: /plugin install oh-my-copilot')}"
```

**Step 3:** If omg-hud.mjs is MISSING or argument is `setup`, create the HUD directory and script:

First, create the directory:
```bash
node -e "require('fs').mkdirSync(require('path').join(process.env.COPILOT_CONFIG_DIR||require('path').join(require('os').homedir(),'.copilot'),'hud'),{recursive:true})"
```

Then, use the Write tool to create `~/.copilot/hud/omg-hud.mjs` with this exact content:

```javascript
#!/usr/bin/env node
/**
 * OMP HUD - Statusline Script
 * Wrapper that imports from dev paths, plugin cache, or npm package
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const home = homedir();
  let pluginCacheVersion = null;
  let pluginCacheDir = null;

  // 1. Development paths (only when OMC_DEV=1)
  if (process.env.OMC_DEV === "1") {
    const devPaths = [
      join(home, "Workspace/oh-my-copilot/dist/hud/index.js"),
      join(home, "workspace/oh-my-copilot/dist/hud/index.js"),
      join(home, "projects/oh-my-copilot/dist/hud/index.js"),
    ];

    for (const devPath of devPaths) {
      if (existsSync(devPath)) {
        try {
          await import(pathToFileURL(devPath).href);
          return;
        } catch { /* continue */ }
      }
    }
  }

  // 2. Plugin cache (for production installs)
  // Respect COPILOT_CONFIG_DIR so installs under a custom config dir are found
  const configDir = process.env.COPILOT_CONFIG_DIR || join(home, ".copilot");
  const pluginCacheBase = join(configDir, "plugins", "cache", "omc", "oh-my-copilot");
  if (existsSync(pluginCacheBase)) {
    try {
      const versions = readdirSync(pluginCacheBase);
      if (versions.length > 0) {
        // Filter to only versions with built dist/hud/index.js
        // This prevents picking an unbuilt new version after plugin update
        const builtVersions = versions.filter(version => {
          const pluginPath = join(pluginCacheBase, version, "dist/hud/index.js");
          return existsSync(pluginPath);
        });

        if (builtVersions.length > 0) {
          const latestVersion = builtVersions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse()[0];
          pluginCacheVersion = latestVersion;
          pluginCacheDir = join(pluginCacheBase, latestVersion);
          const pluginPath = join(pluginCacheDir, "dist/hud/index.js");
          await import(pathToFileURL(pluginPath).href);
          return;
        }
      }
    } catch { /* continue */ }
  }

  // 3. npm package (global or local install)
  try {
    await import("oh-my-copilot/dist/hud/index.js");
    return;
  } catch { /* continue */ }

  // 4. Fallback: provide detailed error message with fix instructions
  if (pluginCacheDir && existsSync(pluginCacheDir)) {
    // Plugin exists but dist/ folder is missing - needs build
    const distDir = join(pluginCacheDir, "dist");
    if (!existsSync(distDir)) {
      console.log(`[OMP HUD] Plugin installed but not built. Run: cd "${pluginCacheDir}" && npm install && npm run build`);
    } else {
      console.log(`[OMP HUD] Plugin dist/ exists but HUD not found. Run: cd "${pluginCacheDir}" && npm run build`);
    }
  } else if (existsSync(pluginCacheBase)) {
    // Plugin cache directory exists but no built versions found
    console.log("[OMP HUD] Plugin cache found but no built versions. Run: /oh-my-copilot:omg-setup");
  } else {
    // No plugin installation found at all
    console.log("[OMP HUD] Plugin not installed. Run: /oh-my-copilot:omg-setup");
  }
}

main();
```

**Step 3:** Make it executable (Unix only, skip on Windows):
```bash
node -e "if(process.platform==='win32'){console.log('Skipped (Windows)')}else{require('fs').chmodSync(require('path').join(process.env.COPILOT_CONFIG_DIR||require('path').join(require('os').homedir(),'.copilot'),'hud','omg-hud.mjs'),0o755);console.log('Done')}"
```

**Step 4:** Update settings.json to use the HUD:

Read `~/.copilot/settings.json`, then update/add the `statusLine` field.

**IMPORTANT:** The command must use an absolute path, not `~`, because Windows does not expand `~` in shell commands.

First, determine the correct path:
```bash
node -e "const p=require('path').join(require('os').homedir(),'.copilot','hud','omg-hud.mjs').split(require('path').sep).join('/');console.log(JSON.stringify(p))"
```

**IMPORTANT:** The command path MUST use forward slashes on all platforms. Copilot CLI executes statusLine commands via bash, which interprets backslashes as escape characters and breaks the path.

Then set the `statusLine` field using the resolved path. On Unix it will look like:
```json
{
  "statusLine": {
    "type": "command",
    "command": "node /home/username/.copilot/hud/omg-hud.mjs"
  }
}
```

On Windows the path uses forward slashes (not backslashes):
```json
{
  "statusLine": {
    "type": "command",
    "command": "node C:/Users/username/.copilot/hud/omg-hud.mjs"
  }
}
```

Use the Edit tool to add/update this field while preserving other settings.

**Step 5:** Clean up old HUD scripts (if any):
```bash
node -e "const p=require('path'),f=require('fs'),d=process.env.COPILOT_CONFIG_DIR||p.join(require('os').homedir(),'.copilot'),t=p.join(d,'hud','omg-hud.mjs');try{if(f.existsSync(t)){f.unlinkSync(t);console.log('Removed legacy script')}else{console.log('No legacy script found')}}catch{}"
```

**Step 6:** Tell the user to restart Copilot CLI for changes to take effect.

## Display Presets

### Minimal
Shows only the essentials:
```
[OMP] ralph | ultrawork | todos:2/5
```

### Focused (Default)
Shows all relevant elements:
```
[OMP] branch:main | ralph:3/10 | US-002 | ultrawork skill:planner | ctx:67% | agents:2 | bg:3/5 | todos:2/5
```

### Full
Shows everything including multi-line agent details:
```
[OMP] repo:oh-my-copilot branch:main | ralph:3/10 | US-002 (2/5) | ultrawork | ctx:[████░░]67% | agents:3 | bg:3/5 | todos:2/5
├─ O architect    2m   analyzing architecture patterns...
├─ e explore     45s   searching for test files
└─ s executor     1m   implementing validation logic
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
| `[OMP]` | Mode identifier |
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

Legacy config location (deprecated): `~/.copilot/.omg/hud-config.json`

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
3. If still not working, run `/oh-my-copilot:omg-doctor` for full diagnostics

**Legacy string format migration:** Older OMP versions wrote `statusLine` as a plain string (e.g., `"~/.copilot/hud/omg-hud.mjs"`). Modern Copilot CLI (v2.1+) requires an object format. Running the installer or `/oh-my-copilot:hud setup` will auto-migrate legacy strings to the correct object format:
```json
{
  "statusLine": {
    "type": "command",
    "command": "node /home/username/.copilot/hud/omg-hud.mjs"
  }
}
```

**Node 24+ compatibility:** The HUD wrapper script imports `homedir` from `node:os` (not `node:path`). If you encounter `SyntaxError: The requested module 'path' does not provide an export named 'homedir'`, re-run the installer to regenerate `omg-hud.mjs`.

Manual verification:
- HUD script: `~/.copilot/hud/omg-hud.mjs`
- Settings: `~/.copilot/settings.json` should have `statusLine` configured as an object with `type` and `command` fields

---

*The HUD updates automatically every ~300ms during active sessions.*
