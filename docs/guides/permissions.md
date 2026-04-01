# Permission Configuration Guide

oh-my-copilot implements a three-tier permission architecture inspired by [Anthropic's auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) to eliminate `/yolo` and `--allow-all` while keeping destructive operations gated.

For the full architecture deep-dive (decision flow, tier definitions, enforcement mechanisms, safety guardrails), see **[Permission Architecture](../architecture/permissions.md)**.

## Quick Summary

| Tier | Behavior | Count |
|------|----------|-------|
| **1** | Always auto-approved (read-only tools) | ~20 |
| **2** | Auto-approved within project (write tools) | ~12 + hooks |
| **3** | Always requires confirmation (destructive tools) | 3 |

## Auto-Configuration

### On Install

`omc-setup` calls `generatePermissionAllowList()` from `src/installer/permissions.ts` and writes all Tier 1 + Tier 2 tool names to `~/.copilot/settings.local.json`.

### Every Session

`setup-maintenance.mjs` (runs on `sessionStart` with 60s timeout) checks for missing permission entries and silently adds them. This auto-heals after plugin updates that add new tools.

### Diagnostics

Run `/oh-my-copilot:omc-doctor` to check permission configuration status:
- Verifies `permissions.allow` exists in `settings.local.json`
- Counts allowlisted vs expected tools
- Reports missing permissions with fix suggestions

## Customization

### Add a Tool to Auto-Approve

Edit `~/.copilot/settings.local.json`:
```json
{
  "permissions": {
    "allow": [
      "mcp__t__tool_name",
      "Bash(my-custom-command)"
    ]
  }
}
```

### Add a Bash Pattern to Auto-Approve

Edit `src/hooks/permission-handler/index.ts` and add to `SAFE_PATTERNS`:
```typescript
/^my-safe-command( |$)/,
```

### Remove Auto-Approval for a Tool

Remove its entry from `permissions.allow` in `settings.local.json`. It will be re-added by `setup-maintenance` unless you also remove it from `generatePermissionAllowList()` in `src/installer/permissions.ts`.

## Key Files

| File | Purpose |
|------|---------|
| `src/hooks/permission-handler/index.ts` | Core permission logic, safe patterns, deny tracking, audit |
| `src/installer/permissions.ts` | Permission allowlist generator, DANGEROUS_TOOLS |
| `src/installer/index.ts` | Writes permissions.allow during install |
| `hooks/hooks.json` | permissionRequest hook registration |
| `scripts/permission-handler.mjs` | Hook script entry point |
| `scripts/setup-maintenance.mjs` | Session auto-heal for missing permissions |
