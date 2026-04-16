# Permission Architecture

> How oh-my-copilot auto-approves safe operations without sacrificing security.

## Design Intent

Traditional CLI agents force a binary choice: approve everything (`/yolo`, `--allow-all`) or click through endless permission prompts. oh-my-copilot takes a third path — a **three-tier permission architecture** inspired by [Anthropic's auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) that auto-approves safe operations and gates destructive ones.

The system was designed around two constraints:

1. **Zero false negatives on destructive operations** — anything that deletes data or has side effects must prompt.
2. **Near-zero latency** — permission checks use regex matching, not model inference, so they add no perceptible delay.

## Enforcement Mechanisms

Three independent mechanisms enforce permissions. Any single mechanism approving is sufficient:

```
Tool call
  │
  ├─ Mechanism 1: MCP Tool Annotations
  │   Copilot CLI reads readOnlyHint/destructiveHint from the tool
  │   definition and auto-approves tools marked as safe.
  │   Defined in: src/tools/*.ts (annotations field on every tool)
  │
  ├─ Mechanism 2: settings.local.json permissions.allow
  │   Explicit allowlist written by the installer and auto-healed
  │   every session by setup-maintenance.mjs.
  │   Located at: ~/.copilot/settings.local.json
  │
  └─ Mechanism 3: permissionRequest Hook
      permission-handler.mjs intercepts the permission prompt and
      returns allow/deny/ask before the user sees anything.
      Registered in: hooks/hooks.json
```

**Why three?** Defence in depth. MCP annotations travel with the tool definition — they work even if the hook is missing. The allowlist covers tools that lack annotations. The hook handles dynamic decisions (Bash commands, deny escalation) that static lists can't express.

## Decision Flow

```
┌──────────────────────────────────────────────────────────────┐
│                      Tool call arrives                        │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  1. ESCALATION CHECK                                          │
│     3+ consecutive denials OR 20+ total denials?              │
│     → DENY and stop (prevent unsafe retry loops)              │
│                                                               │
│  2. MCP TOOL CHECK (mcp__t__*)                                │
│     ├─ Tool in permissions.allow? → ALLOW                     │
│     ├─ readOnlyHint=true + destructiveHint!=true? → ALLOW     │
│     └─ Otherwise → ASK (Copilot CLI native prompt)            │
│                                                               │
│  3. BASH COMMAND CHECK                                        │
│     ├─ Contains shell metacharacters (;&|`$<>)? → REJECT      │
│     ├─ Matches SAFE_PATTERNS regex? → ALLOW                   │
│     ├─ Heredoc with safe base command? → ALLOW                │
│     └─ No match → ASK (Copilot CLI native prompt)             │
│                                                               │
│  4. AUDIT                                                     │
│     Every decision logged to .omcp/logs/permissions.log        │
│     Deny counter updated for escalation tracking              │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

## Tier Definitions

### Tier 1: Always Auto-Approve (~20 tools)

Read-only tools that never modify state.

| Category | Tools |
|----------|-------|
| LSP navigation | `lsp_hover`, `lsp_goto_definition`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_diagnostics`, `lsp_diagnostics_directory`, `lsp_servers`, `lsp_prepare_rename` |
| Code search | `ast_grep_search` |
| State reads | `state_read`, `state_get_status`, `state_list_active` |
| Memory reads | `project_memory_read`, `shared_memory_read`, `shared_memory_list` |
| Other reads | `notepad_read`, `notepad_stats`, `load_omc_skills_local`, `load_omc_skills_global`, `deepinit_manifest`, `check_job_status`, `list_jobs`, `trace_summary`, `trace_timeline` |

**MCP annotation**: `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`

### Tier 2: Auto-Approve Within Project (~12 tools + hooks)

Write tools that mutate state within the project scope. All changes are reviewable via version control.

| Category | Tools |
|----------|-------|
| LSP mutations | `lsp_rename`, `lsp_code_actions`, `lsp_code_action_resolve` |
| Code transforms | `ast_grep_replace` |
| Notepad writes | `notepad_write_priority`, `notepad_write_working`, `notepad_write_manual`, `notepad_prune` |
| Memory writes | `project_memory_write`, `project_memory_add_note`, `project_memory_add_directive` |
| State writes | `state_write`, `state_clear` |
| Other writes | `shared_memory_write`, `python_repl`, `wait_for_job` |
| Hook scripts | All 20 entries in `hooks/hooks.json` (auto-trusted via `PLUGIN_ROOT`) |

**MCP annotation**: `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false`

### Tier 3: Always Prompt (3 tools)

Destructive tools that permanently delete data. Never auto-approved.

| Tool | Risk |
|------|------|
| `shared_memory_delete` | Permanently deletes shared memory entries |
| `shared_memory_cleanup` | Bulk cleanup of shared memory |
| `kill_job` | Terminates running background jobs |

**MCP annotation**: `readOnlyHint: false, destructiveHint: true`

These are explicitly listed in `DANGEROUS_TOOLS` in `src/installer/permissions.ts` and excluded from `permissions.allow`.

## Safe Bash Commands

The `permissionRequest` hook auto-approves these command patterns without user confirmation:

| Category | Patterns |
|----------|----------|
| **Git** | `git status`, `git diff`, `git log`, `git branch`, `git show`, `git fetch` |
| **Node.js** | `npm test`, `npm run test/lint/build/check/typecheck`, `pnpm`/`yarn` equivalents |
| **TypeScript** | `tsc`, `eslint`, `prettier` |
| **Rust** | `cargo test`, `cargo check`, `cargo clippy`, `cargo build` |
| **Python** | `pytest`, `python -m pytest` |
| **.NET** | `dotnet build/test/run/restore/clean`, `dotnet --version/--info` |
| **GitHub CLI** | `gh pr/issue/repo/api/run/workflow view/list/status/diff/checks`, `gh auth status` |
| **Azure CLI** | `az account show`, `az group/resource list`, `az devops project list/configure`, `az pipelines list/show`, `az repos list/show/pr list` |
| **Unix** | `ls`, `grep`, `find`, `wc`, `pwd`, `which`, `echo`, `env` |

### Blocked Patterns

Any command containing shell metacharacters is **always rejected**, regardless of the base command:

```
; & | ` $ ( ) < > \n \r \t \0 \ { } [ ] * ? ~ ! #
```

This prevents command chaining attacks like `ls; rm -rf /` from bypassing safe pattern checks.

### Heredoc Special Case

Multi-line heredoc commands (e.g., `git commit -m "$(cat <<'EOF'...EOF)"`) are auto-approved when the base command matches safe heredoc patterns (`git commit`, `git tag`). This prevents the full heredoc body from polluting `settings.local.json`.

## Safety Guardrails

### Deny Escalation

Inspired by Anthropic's auto mode escalation model:

| Threshold | Action |
|-----------|--------|
| 3 consecutive denials | Stop and deny all further requests |
| 20 total denials in session | Stop and deny all further requests |
| Any allow | Resets consecutive counter |

This prevents the agent from endlessly retrying a blocked operation.

### Audit Trail

Every permission decision is logged to `.omcp/logs/permissions.log`:

```json
{"ts":"2026-03-31T12:00:00Z","tool":"Bash","command":"git status","decision":"allow","reason":"Safe read-only or test command","denials":0,"allows":5}
```

Fields:
- `ts` — ISO timestamp
- `tool` — Tool name (`Bash`, `mcp__t__*`)
- `command` — First 200 chars of the command (truncated for safety)
- `decision` — `allow`, `deny`, or `ask`
- `reason` — Why this decision was made
- `denials` / `allows` — Running session counters

### Shell Injection Prevention

The `DANGEROUS_SHELL_CHARS` regex rejects any command with metacharacters before safe pattern matching. This is a hard security boundary — no exceptions.

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

## Comparison with Copilot CLI's Auto Mode

| Aspect | Copilot CLI Auto Mode | oh-my-copilot |
|--------|-------------------|---------------|
| **Stage 1 filter** | Model-based (Sonnet) | Regex-based (zero latency) |
| **Stage 2 reasoning** | Model-based chain-of-thought | Human prompt (CLI native) |
| **Injection probe** | Server-side PI scanner | Relies on CLI built-in |
| **Deny escalation** | 3 consecutive / 20 total | 3 consecutive / 20 total |
| **Allowed list** | Built-in + user config | Annotations + settings.json + hook |
| **Audit trail** | Internal | `.omcp/logs/permissions.log` |
| **Tool annotations** | MCP readOnlyHint | MCP readOnlyHint (same spec) |

## Key Files

| File | Purpose |
|------|---------|
| `src/hooks/permission-handler/index.ts` | Core permission logic, safe patterns, deny tracking, audit |
| `src/installer/permissions.ts` | Permission allowlist generator, DANGEROUS_TOOLS |
| `src/installer/index.ts` | Writes permissions.allow during install |
| `src/tools/types.ts` | ToolAnnotations interface |
| `hooks/hooks.json` | permissionRequest hook registration |
| `scripts/permission-handler.mjs` | Hook script entry point |
| `scripts/setup-maintenance.mjs` | Session auto-heal for missing permissions |
