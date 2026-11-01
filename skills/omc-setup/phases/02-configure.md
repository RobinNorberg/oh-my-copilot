# Phase 2: Environment Configuration

**Skip condition**: If resuming and `lastCompletedStep >= 4`, skip Steps 2.0–2.3 and begin at Step 2.4 so retired setup values are always cleared before the phase exits.

## Resume Boundary

Capture the original progress marker once when Phase 2 starts. A resumed run that enters at Step 2.4 must not repeat the completed Steps 2.5/2.6 prompts or overwrite a higher progress marker:

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-config.mjs" resume-boundary
```

## Step 2.0: Check Ralph Runtime Prerequisites

Ralph is an agent-driven persistence loop with no external language dependency. Its only hard prerequisites are the Node runtime that already runs OMC's hooks and a writable config directory for `.omg/state/` state files. Verify both without blocking the rest of setup:

```bash
node --version || echo "ERROR: Node is required for OMC hooks and Ralph state persistence."
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-config.mjs" probe-write
```

## Step 2.1: Setup HUD Statusline

**Note**: If resuming and `lastCompletedStep >= 3`, skip to Step 2.2.

The HUD shows real-time status in Claude Code's status bar. Delegate all HUD/statusLine setup to the `hud` skill:

Use the Skill tool to invoke: `hud` with args: `setup`

Do not generate, normalize, or patch `statusLine` paths inline in this phase. This is especially important on Windows, where backslash path handling must stay inside the `hud` skill.

This will:
1. Install the HUD wrapper script to `~/.copilot/hud/omg-hud.mjs`
2. Configure `statusLine` in `~/.copilot/settings.json`
3. Report status and prompt to restart if needed

After HUD setup completes, save progress:
```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-progress.mjs" save 3
```

With no config type argument, `save` carries forward the one already recorded in `.omg/state/setup-state.json`.

## Step 2.2: Repair Stale Plugin Cache References

After a marketplace update, Claude Code may still have old OMC cache paths in the running session or plugin registry. Repair those references before any cache cleanup so setup does not repeatedly emit stale plugin directory errors.

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/repair-plugin-cache.mjs"
```

## Step 2.3: Check for Updates

Notify user if a newer version is available:

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-config.mjs" update-check
```

It detects the installed version (plugin cache, then `.omc-version.json`, then the `CLAUDE.md` header) and compares it against the published version.

## Step 2.4: Clear Retired Setup Values

The `ultrawork` workflow was removed in 5.0.0 and the `defaultExecutionMode` config key is no longer read by any runtime surface. Upgrades from 4.x may still carry a dead persisted value in `.omc-config.json`. Clear it so the config matches the current contract:

The write goes through a temp file, so a failure leaves the existing config untouched:

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-config.mjs" clear-retired
```

**Note:** Never write a new `defaultExecutionMode` value. Generic keywords no longer route through a configured execution mode; invoke `/oh-my-copilot:execute` or `/oh-my-copilot:team` directly instead.

**Resume-only boundary:** If `RESUMED_PHASE_TWO_BOUNDARY` is `true`, stop Phase 2 after this cleanup. Do not execute Steps 2.5 or 2.6, do not prompt for task-tool or team settings again, and do not save a new progress value. Return to the setup orchestrator with the original `RESUME_LAST_COMPLETED_STEP` unchanged.

## Step 2.5: Install OMC CLI Tool

The OMC CLI (`omg` command) provides standalone helper commands such as `omg hud`, `omg teleport`, and `omg team ...`.

First, check if the CLI is already installed:

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-config.mjs" cli-installed
```

If `OMC_CLI_INSTALLED` is `"true"`, skip the rest of this step.

If `OMC_CLI_INSTALLED` is `"false"`, use AskUserQuestion:

**Question:** "Would you like to install the OMC CLI globally for standalone helper commands? (`omg`, `omg hud`, `omg teleport`)"

**Options:**
1. **Yes (Recommended)** - Install `oh-my-copilot` via `npm install -g`
2. **No - Skip** - Skip installation (can install manually later with `npm install -g oh-my-copilot`)

If user chooses **Yes**:

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-config.mjs" install-cli
```

**Note**: The CLI is optional. All core functionality is also available through the plugin system.

## Step 2.6: Select Task Management Tool

First, detect available task tools:

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-config.mjs" detect-task-tools
```

If **neither** beads nor beads-rust is detected, skip this step (default to built-in).

If beads or beads-rust is detected, use AskUserQuestion:

**Question:** "Which task management tool should I use for tracking work?"

**Options:**
1. **Built-in Tasks (default)** - Use Claude Code's native TodoWrite or available task-list surface. Tasks are session-only.
2. **Beads (bd)** - Git-backed persistent tasks. Survives across sessions. [Only if detected]
3. **Beads-Rust (br)** - Lightweight Rust port of beads. [Only if detected]

(Only show options 2/3 if the corresponding tool is detected)

Store the preference:

Pass the user's selection (`builtin`, `beads`, or `beads-rust`) as the argument. The write
goes through a temp file, so a failure leaves the existing config untouched:

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-config.mjs" set-task-tool "USER_CHOICE"
```

**Note:** The beads context instructions will be injected automatically on the next session start.

## Save Progress

If this phase was resumed at the Phase 2 boundary (`RESUMED_PHASE_TWO_BOUNDARY` is true), do NOT save; report `Resumed Phase 2: preserving lastCompletedStep=<RESUME_LAST_COMPLETED_STEP>` instead. Otherwise run:

```bash
node "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-progress.mjs" save 4
```
