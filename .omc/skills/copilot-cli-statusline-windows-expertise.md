# Copilot CLI StatusLine on Windows

## The Insight
On Windows, Copilot CLI executes statusLine commands through bash, which spawns a **separate console window**. This means stdout from the bash process never flows back to Copilot CLI's terminal. The fix is to use a `.cmd` wrapper instead of `.sh` — cmd.exe inherits the parent console and stdout is captured correctly.

## Why This Matters
Without this knowledge, you'll spend hours debugging why the HUD script "works" (proof files get written) but nothing renders in Copilot CLI. The script runs, produces output, but the output goes to a ghost console window that flashes and disappears.

## Recognition Pattern
- HUD statusLine configured in `config.json` with `experimental: true`
- Script is verified to produce output when run manually (`echo '{}' | node script.js`)
- But nothing shows in Copilot CLI on Windows
- Bash terminal windows flash open briefly when Copilot CLI starts

## The Approach
Three facts must all be true for statusLine to work in Copilot CLI:

1. **Config location**: `~/.copilot/config.json` (NOT `settings.json`)
2. **Experimental flag**: `"experimental": true` in config.json
3. **Platform-appropriate wrapper**:
   - **Windows**: `.cmd` file — `@echo off\r\nnode "path\to\hud.js"\r\n`
   - **Unix**: `.sh` file — `#!/bin/bash\ncat | node path/to/hud.js`

The `.cmd` vs `.sh` choice is critical on Windows. Both execute, but only `.cmd` returns stdout to the parent process.

## Example
```cmd
@echo off
node "C:\Users\username\.copilot\installed-plugins\omg\oh-my-copilot\dist\hud\index.js"
```

Config in `~/.copilot/config.json`:
```json
{
  "experimental": true,
  "statusLine": {
    "type": "command",
    "command": "C:/Users/username/.copilot/copilot-hud.cmd"
  }
}
```
