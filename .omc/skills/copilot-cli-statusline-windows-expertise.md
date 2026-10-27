---
# Copilot CLI StatusLine on Windows

## The Insight
Copilot CLI runs the `statusLine` command itself, feeds the session payload on stdin, and shows stdout. On Windows it spawns the command with `shell: true`, so cmd.exe runs it inside the parent console and stdout comes back. Use a direct `node <script>` command. A bash `.sh` wrapper or a separate console window never returns stdout. (An earlier version of this note said a `.cmd` wrapper was required; a direct node command works and is what the installer writes.)

Facts checked against the Copilot CLI 1.0.103 bundle and changelog (2026-10-27).

## Why This Matters
When a status line is blank, the cause is almost always the command failing, not a missing flag. Knowing the contract below saves hours of guessing.

## Recognition Pattern
- The HUD script prints output when run by hand (`echo {} | node dist/hud/index.js`).
- Nothing shows in Copilot CLI, or the line goes blank after working once.
- One warning appears: "Status line command failed; the status line will be blank."

## The Contract
1. **Config location**: `~/.copilot/settings.json` (or `$COPILOT_HOME/settings.json`), key `statusLine`. Settings moved there from `config.json` in CLI 1.0.35.
2. **No experimental flag.** The bundle has no `STATUS_LINE` gate. `"experimental": true` is not needed.
3. **Command**: `{"type": "command", "command": "node C:/Users/<you>/.copilot/hud/omg-hud.mjs"}`. Use forward slashes. `~` and `$VAR` are expanded by Copilot, but write absolute paths on Windows.
4. **Input**: the payload JSON on stdin, then stdin is closed. The script must not wait for more input.
5. **Timeout**: 10 s, then SIGKILL on Windows.
6. **Failure blanks the line**: a non-zero exit, a signal or a timeout blanks the status line. Keep the HUD fast and have it exit 0 even on internal errors. Run Copilot with `--log-level all` to see stderr (capped at 2048 chars).
7. **Output**: stdout is trimmed and split on newlines. Each line is left-padded by `padding`.
8. **Cadence**: re-runs on payload changes, debounced 200 ms. Set `refreshInterval` (seconds) to add a timer.

## Example
```json
{
  "statusLine": {
    "type": "command",
    "command": "node C:/Users/username/.copilot/hud/omg-hud.mjs"
  }
}
```

The payload field list and a capture recipe are in `docs/DEVELOPERS.md`, section "Copilot CLI facts for the HUD".
