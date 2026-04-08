# Phase 1: Install copilot-instructions.md

## Determine Configuration Target

If `--local` flag was passed, set `CONFIG_TARGET=local`.
If `--global` flag was passed, set `CONFIG_TARGET=global`.

Otherwise (initial setup wizard), use AskUserQuestion to prompt:

**Question:** "Where should I configure oh-my-copilot?"

**Options:**
1. **Local (this project)** - Creates `.copilot/copilot-instructions.md` in current project directory. Best for project-specific configurations.
2. **Global (all projects)** - Creates `~/.copilot/copilot-instructions.md` for all Copilot CLI sessions. Best for consistent behavior everywhere.

Set `CONFIG_TARGET` to `local` or `global` based on user's choice.

## Download and Install copilot-instructions.md

**MANDATORY**: Always run this command. Do NOT skip. Do NOT use the Write tool. Use bash curl exclusively.

On **Unix/macOS/WSL**:
```bash
bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-copilot-instructions.sh" <CONFIG_TARGET>
```

On **Windows** (Git Bash available via Copilot CLI):
```bash
bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-copilot-instructions.sh" <CONFIG_TARGET>
```

Replace `<CONFIG_TARGET>` with `local` or `global`.

**IMPORTANT**: Always use the bash script. Do NOT rewrite it as PowerShell. Copilot CLI provides bash even on Windows.

**IMPORTANT**: The download URL is `https://raw.githubusercontent.com/RobinNorberg/oh-my-copilot/main/docs/copilot-instructions.md` — do NOT use any other GitHub user or repository.

**FALLBACK** if bash is truly unavailable, download with this exact URL:
```
https://raw.githubusercontent.com/RobinNorberg/oh-my-copilot/main/docs/copilot-instructions.md
```

**Note**: The downloaded copilot-instructions.md includes Context Persistence instructions with `<remember>` tags for surviving conversation compaction.

**Note**: If an existing copilot-instructions.md is found, it will be backed up before downloading the new version.

## Report Success

If `CONFIG_TARGET` is `local`:
```
OMC Project Configuration Complete
- copilot-instructions.md: Updated with latest configuration from GitHub at ./.copilot/copilot-instructions.md
- Backup: Previous copilot-instructions.md backed up (if existed)
- Scope: PROJECT - applies only to this project
- Hooks: Provided by plugin (no manual installation needed)
- Agents: 28+ available (base + tiered variants)
- Model routing: Haiku/Sonnet/Opus based on task complexity

Note: This configuration is project-specific and won't affect other projects or global settings.
```

If `CONFIG_TARGET` is `global`:
```
OMC Global Configuration Complete
- copilot-instructions.md: Updated with latest configuration from GitHub at ~/.copilot/copilot-instructions.md
- Backup: Previous copilot-instructions.md backed up (if existed)
- Scope: GLOBAL - applies to all Copilot CLI sessions
- Hooks: Provided by plugin (no manual installation needed)
- Agents: 28+ available (base + tiered variants)
- Model routing: Haiku/Sonnet/Opus based on task complexity

Note: Hooks are now managed by the plugin system automatically. No manual hook installation required.
```

## Save Progress

```bash
bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-progress.sh" save 2 <CONFIG_TARGET>
```

## Early Exit for Flag Mode

If `--local` or `--global` flag was used, clear state and **STOP HERE**:
```bash
bash "${COPILOT_PLUGIN_ROOT}/scripts/setup-progress.sh" clear
```
Do not continue to Phase 2 or other phases.
