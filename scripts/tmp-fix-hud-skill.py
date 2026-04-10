with open('skills/hud/SKILL.md', 'r', encoding='utf-8') as f:
    content = f.read()

# Update Step 4: settings.json -> config.json
content = content.replace(
    '**Step 4:** Update settings.json to use the HUD:',
    '**Step 4:** Update config.json to use the HUD:'
)

content = content.replace(
    'Read `${COPILOT_CONFIG_DIR:-~/.copilot}/settings.json`, then update/add the `statusLine` field.',
    'Read `${COPILOT_CONFIG_DIR:-~/.copilot}/config.json`, then update/add the `statusLine` field and ensure `experimental` is true.'
)

# Update the Unix config example
content = content.replace(
    '''Then set the `statusLine` field. On Unix it should stay portable and look like:
```json
{
  "statusLine": {
    "type": "command",
    "command": "node ${COPILOT_CONFIG_DIR:-$HOME/.copilot}/hud/omcp-hud.mjs"
  }
}
```

On Windows the path uses forward slashes (not backslashes):
```json
{
  "statusLine": {
    "type": "command",
    "command": "node C:/Users/username/.copilot/hud/omcp-hud.mjs"
  }
}
```

Use the Edit tool to add/update this field while preserving other settings.''',
    '''Then set the `statusLine` and `experimental` fields in `config.json`:

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

Use the Edit tool to add/update these fields while preserving other settings.'''
)

# Update the troubleshooting manual verification section
content = content.replace(
    '- Settings: `~/.copilot/settings.json` should have `statusLine` configured as an object with `type` and `command` fields',
    '- Config: `~/.copilot/config.json` should have `statusLine` configured as an object with `type` and `command` fields, and `experimental: true`'
)

with open('skills/hud/SKILL.md', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done")
