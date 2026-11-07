---
description: ""
---

# OMC omc-setup

This compatibility command keeps `/oh-my-copilot:omc-setup` available without loading the full `omc-setup` skill description in every Claude Code session.

## Dispatch

<!-- Claude Code docs (plugins-reference, "Where each variable resolves"): for "Skill, command, and agent content", `${...}` resolves "Anywhere in the Markdown body". -->

1. Read the full bundled skill instructions from `${CLAUDE_PLUGIN_ROOT}/skills/omc-setup/SKILL.md` (Claude Code substitutes the plugin root; if the placeholder is still literal, use the fallback below).
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If the file is not directly readable from the current working directory, locate it under the active `CLAUDE_PLUGIN_ROOT`/`OMC_PLUGIN_ROOT`, package root, or installed OMC plugin directory, then continue.
