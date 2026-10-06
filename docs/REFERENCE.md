# Reference Documentation

Complete reference for oh-my-copilot. For quick start, see the main [README.md](../README.md).

For v5.7.0, the plugin ships 20 agents, 61 skills, 21 command files, and one configured MCP server exposing exactly 56 tools.

---

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Runtime storage and goal artifacts](#runtime-storage-and-goal-artifacts)
- [Plugin directory flags](#plugin-directory-flags)
- [CLI Commands: ask/team/session](#cli-commands-askteamsession)
- [Legacy MCP Team Runtime Tools (Deprecated)](#legacy-mcp-team-runtime-tools-deprecated-opt-in-only)
- [Agents (20 Total)](#agents-20-total)
- [Goal Workflow UX: `/goal`, Ralph, Team, Ultragoal](#goal-workflow-ux-goal-ralph-team-ultragoal)
- [Skills (61 Total)](#skills-61-total)
- [Slash Commands](#slash-commands)
- [Shipyard Methodology](./shipyard.md) — governed delivery & shared harness map
- [Claude Code `/goal` Adapter Design](#claude-code-goal-adapter-design)
- [Hooks System](#hooks-system)
- [Magic Keywords](#magic-keywords)
- [Platform Support](#platform-support)
- [Performance Monitoring](#performance-monitoring)
- [Troubleshooting](#troubleshooting)
- [Changelog](#changelog)

---

## Installation

OMC has two supported public surfaces. Use the plugin (GitHub Copilot CLI or Claude Code) for in-session slash commands, hooks, agents, skills, and statusline behavior. Use the npm-installed `omg` CLI for terminal commands, setup/update automation, and CI-safe checks.

### Plugin

The plugin is `oh-my-copilot` in the marketplace `omc`, so its full id is `oh-my-copilot@omc`.

```bash
# Inside a session
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot
/plugin install oh-my-copilot@omc

# Or from your shell (GitHub Copilot CLI)
copilot plugin marketplace add RobinNorberg/oh-my-copilot
copilot plugin install oh-my-copilot@omc
```

Update with `copilot plugin update oh-my-copilot@omc`, and uninstall with `copilot plugin uninstall oh-my-copilot@omc` (or `/plugin uninstall oh-my-copilot@omc` in a session).

Copilot CLI loads the plugin through the root `plugin.json`, which points at the generated `copilot/hooks.json` and `copilot/agents/`. Claude Code reads `.claude-plugin/plugin.json`, `hooks/hooks.json` and `agents/`. See [Copilot CLI hook projection](HOOKS.md#copilot-cli-hook-projection).

Every hook runs `node`, so `node` must be on PATH for the host CLI process. Under Copilot a PreToolUse hook that cannot start denies the tool call.

### Terminal CLI

```bash
npm i -g oh-my-copilot@latest
omg setup
```

The npm package exposes both `oh-my-copilot` and `omg`; examples prefer `omg` unless troubleshooting needs the long alias. The CLI does not make in-session slash skills available by itself; install the plugin for `/oh-my-copilot:autopilot`, `/oh-my-copilot:ralph`, `/oh-my-copilot:execute`, `/oh-my-copilot:team`, and other interactive skills.

### Requirements

- [GitHub Copilot CLI](https://github.com/github/copilot-cli) with a Copilot subscription, or [Claude Code](https://docs.anthropic.com/claude-code) with a Claude Max/Pro subscription or `ANTHROPIC_API_KEY`
- Node.js on PATH (every hook and the MCP server run `node`; `omg doctor conflicts` checks it)

---

## Configuration

### Project-Scoped Configuration (Recommended)

Configure omc for the current project only:

```
/oh-my-copilot:omc-setup --local
```

- Creates `./.claude/CLAUDE.md` in your current project
- Configuration applies only to this project
- Won't affect other projects or global settings
- **Safe**: Preserves your global CLAUDE.md

### Global Configuration

Configure omc for all Claude Code sessions:

```
/oh-my-copilot:omc-setup
```

- Creates `~/.claude/CLAUDE.md` globally
- Configuration applies to all projects
- **Default**: explicitly overwrites existing `~/.claude/CLAUDE.md`
- **Optional preserve mode**: keeps the base file, writes OMC to `~/.claude/CLAUDE-omc.md`, and lets `omg` force-load that companion config at launch while plain `claude` stays unchanged

### What Configuration Enables

| Feature           | Without     | With omc Config         |
| ----------------- | ----------- | ----------------------- |
| Agent delegation  | Manual only | Automatic based on task |
| Keyword detection | Disabled    | supported prompt triggers |
| Todo continuation | Basic       | Enforced completion     |
| Model routing     | Default     | Smart tier selection    |
| Skill composition | None        | Auto-combines skills    |

### Configuration Precedence

If both configurations exist, **project-scoped takes precedence** over global:

```
./.claude/CLAUDE.md  (project)   →  Overrides  →  ~/.claude/CLAUDE.md  (global)
```

### Environment Variables

| Variable                   | Default              | Description                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COPILOT_HOME`             | `~/.copilot`         | Host config directory. This is GitHub Copilot CLI's own variable, and OMC resolves its config directory (settings, hooks, HUD, user config) from the same value, so one setting moves both. The legacy `COPILOT_CONFIG_DIR` is not read; `omg doctor conflicts` warns when it is set. |
| `OMC_STATE_DIR`            | _(unset)_            | Centralized state directory. When set, OMC stores state at `$OMC_STATE_DIR/{project-id}/` instead of `{worktree}/.omg/`. This preserves state across worktree deletions. The project identifier is derived from the git remote URL (or worktree path for local-only repos). |
| `OMC_BRIDGE_SCRIPT`        | _(auto-detected)_    | Path to the Python bridge script                                                                                                                                                                                                                                            |
| `OMC_PARALLEL_EXECUTION`   | `true`               | Enable/disable parallel agent execution                                                                                                                                                                                                                                     |
| `OMC_CODEX_DEFAULT_MODEL`  | _(provider default)_ | Default model for Codex CLI workers                                                                                                                                                                                                                                         |
| `OMC_GEMINI_DEFAULT_MODEL`       | _(provider default)_ | Default model for Gemini CLI workers                                                                                                                                                                                                                                    |
| `OMC_ANTIGRAVITY_DEFAULT_MODEL`  | _(provider default)_ | Default model for Antigravity CLI (`agy`) workers                                                                                                                                                                                                                       |
| `OMC_GROK_DEFAULT_MODEL`         | _(provider default)_ | Default model for Grok Build CLI workers                                                                                                                                                                                                                                |
| `OMC_LSP_TIMEOUT_MS`       | `15000`              | Timeout (ms) for LSP requests. Increase for large repos or slow language servers                                                                                                                                                                                            |
| `OMC_MIGRATE_LEGACY_STATE` | _(unset)_            | Set to `1` to enable one-shot legacy→session-scoped state migration on next read. See [Legacy state migration](#legacy-state-migration-omc_migrate_legacy_state) below.                                                                                                      |
| `OMC_DISABLE_MULTIREPO`    | _(unset)_            | Set to `1` to disable workspace-marker resolution and fall back to git-root + cwd resolution order. `OMC_STATE_DIR` is still honoured. See [Rollback / disable multi-repo](#rollback--disable-multi-repo-omc_disable_multirepo) below.                                       |
| `DISABLE_OMC`              | _(unset)_            | Set to `1` or `true` to disable all OMC hooks |
| `OMC_SKIP_HOOKS`           | _(unset)_            | Comma-separated list of hook names to skip                                                                                                                                                                                                                                  |
| `OMC_GIT_GUARDRAILS`       | _(unset)_            | `1` force-enables the destructive-git PreToolUse guard in any session; `0` always disables it (immediate exit, wins over everything). With the variable unset, the guard is on by default while an active unattended mode (ralph/autopilot/team/ultragoal) is detected.      |
| `OMC_RUN_BUDGET_TOKENS`    | _(unset)_            | Opt-in session token budget for unattended modes. Ralph and autopilot compare spend at iteration/phase boundaries (via the `trace_summary` tool): warn at 90%, stop with a resumable budget report at 100%. Advisory today — the model reads the tool output.               |
| `OMC_STALE_RUN_HOURS`      | `2`                  | Stale-run watchdog threshold in hours. A SessionStart hook reports unattended-mode state files left `active: true` with no mtime progress for this long (the signature of a crashed run). Advisory only — the watchdog never mutates state or resumes runs.                |
| `OMC_HOST_LOAD_THRESHOLD` | _(dynamic)_ | CPU load threshold (1-minute average). Gate blocks operations when load exceeds this. Default: 80% of available cores. Set to negative value to disable. |
| `OMC_FREE_MEMORY_THRESHOLD` | `256` | Free memory threshold in MB. Gate blocks operations when free memory falls below this. Set to negative value to disable. |
| `OMC_MAX_SIBLING_SESSIONS` | `8` | Maximum concurrent OMC sessions before gating expensive operations. Set to negative value to disable. |
| `OMC_HOST_LOAD_GATE_DISABLED` | _(unset)_ | Set to any value to disable the host load gate entirely. |
| `OMC_CHAIN_LINK` | _(set by the spawner)_ | Internal. The chain-link id of a Copilot factory link, set on the spawned `copilot` process by the factory listener or the SessionEnd worker. Do not set it yourself: SessionEnd only trusts it when it names a `host: "copilot"` ledger, and a finished link is a no-op. See [Factory chains on Copilot](#factory-chains-on-copilot). |

#### Host Load Gate

OMC monitors host resources (CPU load, free memory, concurrent sessions) to prevent resource exhaustion when multiple sessions are active. When thresholds are exceeded, expensive operations (browser launches, test runners, package installs) are gated with a back-off message.

**Behavior**:
- **Fail-open**: if metrics are unavailable, the gate allows operations immediately (never deadlocks)
- **Configurable thresholds**: set environment variables or override via code
- **Disable-able**: set `OMC_HOST_LOAD_GATE_DISABLED=1` to bypass gating entirely

**Example**: limit concurrent sessions to 4 and free memory to 512 MB:

```bash
export OMC_MAX_SIBLING_SESSIONS=4
export OMC_FREE_MEMORY_THRESHOLD=512
```

**Timeout**: gates wait up to 30 seconds by default before allowing operations (fail-open).

#### Centralized State with `OMC_STATE_DIR`

By default, OMC stores state in `{worktree}/.omg/`. This is lost when worktrees are deleted. To preserve state across worktree lifecycles, set `OMC_STATE_DIR`:

```bash
# In your shell profile (~/.bashrc, ~/.zshrc, etc.)
export OMC_STATE_DIR="$HOME/.claude/omc"
```

> Shell rc files are not sourced by GUI-launched editors. For those sessions the
> supported delivery channel is `settings.json` `env` (verified: keys defined only
> there are present in spawned hook and statusline processes):
>
> ```json
> { "env": { "OMC_STATE_DIR": "/home/you/.claude/omc" } }
> ```
> Set it in `~/.copilot/settings.json` (or `$COPILOT_HOME/settings.json`;
> `COPILOT_HOME` is Copilot CLI's own config-directory variable, and OMC
> resolves its config directory from the same variable).

This resolves to `~/.claude/omc/{project-identifier}/` where the project identifier uses a hash of the git remote URL (stable across worktrees/clones) with a fallback to the directory path hash for local-only repos.

If both a legacy `{worktree}/.omg/` directory and a centralized directory exist, OMC logs a notice. Processes that inherit `OMC_STATE_DIR` use the centralized directory; misconfigured processes that do not inherit it use the legacy directory and now also warn (legacy branch mirrors the centralized-branch check by discovering `OMC_STATE_DIR` from `settings.json` `env` when present). You can then migrate data from the legacy directory and remove it.

#### OMC state, gitignore, worktree, and workspace contract

OMC's project-local state root is `.omg/` unless `OMC_STATE_DIR` or `.omc-workspace` changes the root resolution described below. The default root contains runtime and audit artifacts such as:

- `.omg/state/` and `.omg/state/sessions/{sessionId}/` — mode state, session-scoped state, replay markers, and recovery metadata.
- `.omg/notepad.md` and `.omg/project-memory.json` — local session notes and project memory.
- `.omg/plans/`, `.omg/research/`, `.omg/logs/`, `.omg/artifacts/`, `.omg/handoffs/`, and `.omg/ultragoal/` — generated plans, research outputs, logs, advisor artifacts, team handoffs, and ultragoal ledgers.
- `.omg/team/` — opt-in native team worker worktrees when team worktree mode creates them.
- `.omg/skills/` — the only project-local `.omg` subtree intended to be committed when the team wants to share OMC-authored skills.

Git handling is intentionally conservative. The repository `.gitignore` keeps `.omg/` itself visible, ignores `.omg/*`, and then re-includes `.omg/skills/` plus `.omg/skills/**`. That means generated state stays untracked by default, while project skills can be reviewed and committed explicitly. Do not force-add runtime `.omg` files unless you are deliberately attaching a sanitized artifact to an issue or test fixture; runtime state can include prompts, transcripts, absolute paths, machine identifiers, and workflow history.

Worktree behavior follows the resolved state root:

- **Default single repo / monorepo**: `getOmcRoot()` uses the git toplevel, so every package below one git root shares `{repo}/.omg/`.
- **Git-less directories**: all cwd variants use the canonical `$HOME/.omg/` root; with `OMC_STATE_DIR`, they use `$OMC_STATE_DIR/non-git`. Existing cwd-local `.omg/` trees are never adopted or mutated implicitly. Protected locations such as `~/.ssh`, `~/.claude`, `~/.config`, user content directories, and descendants of system temp/OS roots are rejected as migration sources. Use the explicit `state_migrate_non_git` tool for owner-checked, non-overwriting migration. Session ownership still comes from `session_id`, and no time-based cleanup is performed.
- **Linked git worktrees**: without `OMC_STATE_DIR`, each linked worktree has its own `{worktree}/.omg/`; removing that worktree removes its local OMC state. Re-run setup from the worktree you are actively using so installed hooks and generated instructions match that checkout.
- **Persistent state across worktree deletion**: set `OMC_STATE_DIR`; OMC writes to `$OMC_STATE_DIR/{project-id}/`, where the project id is stable across linked worktrees when a remote or primary git dir is available.
- **Multi-repo workspace**: add `.omc-workspace` to a non-git parent when independent sibling repos should share `{parent}/.omg/`. This is for multi-repo workspaces, not ordinary monorepos.

State MCP tools honor an explicit `workingDirectory`. In a git-less session, it identifies the legacy source for explicit migration while state storage follows the canonical non-git root; in a git-backed session, repository and linked-worktree boundary checks remain enforced. A path from another repository or a failed Git probe is rejected rather than silently substituted with the session cwd.

The `state_migrate_non_git` tool is the only supported non-git legacy migration
path. It requires the exact owning `session_id`, reads only
`.omg/state/sessions/<session_id>/*.json`, copies records whose embedded owner
matches that ID into the canonical root, never overwrites an existing
destination, preserves source bytes, and reports copied/skipped/rejected
filenames. It never deletes or mutates the legacy source and refuses Git,
sensitive, system-temp, and symlinked legacy roots.

#### Session-scoped state cannot capture another session (#3873)

Mode-state files that carry a `session_id` under `.omg/state/sessions/<id>/` are authoritative only for that session. They cannot attach to, resume, or disarm a different session. Only legacy flat-layout files without a `session_id` can bind to whatever session starts next in that directory.

Do not treat idle time as evidence that a session has ended. OMC performs no time-based cancellation of session-scoped state; cleanup tooling must preserve session-owned files and must not use a time threshold to delete active state.

When migrating to `OMC_STATE_DIR`, remember that setting the variable does not migrate existing contents. Copy or migrate legacy state first, then enable the centralized root; otherwise old plans, notepads, and project memory remain in their original `.omg/` location and are no longer visible.

Plan persistence follows the same rule. Default generated plans under `.omg/plans/` are local operational artifacts and are ignored. If a plan should become durable project documentation, move it to a tracked docs path or configure `planOutput.directory` to a reviewed directory such as `docs/plans`; keep machine-local session state in `.omg/`.

Cleanup rule of thumb: after OMC sessions are stopped, it is safe to delete ignored runtime subtrees such as `.omg/state/`, `.omg/logs/`, `.omg/artifacts/`, `.omg/research/`, or `.omg/ultragoal/` if you no longer need their recovery/audit history. Do not delete `.omg/skills/` unless you intend to remove project-scoped skills.

#### Multi-repo workspaces with `.omc-workspace`

When you have several independent git repos under one parent directory and the parent itself is **not** a git repo, OMC cannot infer a shared root via `git rev-parse --show-toplevel`. Each sub-repo would get its own isolated `.omg/`. To anchor a single `.omg/` at the parent, drop a `.omc-workspace` marker file there:

```bash
cd /path/to/my-workspace            # parent dir (not a git repo)
echo '{}' > .omc-workspace          # empty JSON is fine
```

From any sub-directory (including inside any sub-git-repo), OMC resolves `.omg/` to `/path/to/my-workspace/.omg/`. The marker may also carry an explicit project identifier so all sessions share state regardless of the parent dir name:

```json
{ "id": "my-org-bidchex" }
```

Resolution order inside `getOmcRoot()`:

1. `OMC_STATE_DIR` (centralized).
2. `.omc-workspace` marker (multi-repo workspace).
3. `git rev-parse --show-toplevel` (monorepo / single repo).
4. `process.cwd()` (last resort).

Once a workspace is anchored, multiple Claude Code sessions in different sub-repos can run `/oh-my-copilot:ultragoal`, `/oh-my-copilot:ralph`, `/oh-my-copilot:execute`, and `/oh-my-copilot:autopilot` in parallel without bleeding state. For `/oh-my-copilot:ultragoal` specifically, pass `--plan-id <id>` or `--auto-plan-id` on `create-goals` so each session writes to `.omg/ultragoal/plans/{planId}/` instead of the shared `goals.json` — see "ultragoal multi-plan" below. The PARALLEL SESSION WARNING in `session-start.mjs` performs a PID-aware liveness check and no longer suppresses restore when the owner session is dead.

#### `.omg/handoffs/` shared contract

`.omg/handoffs/` is intentionally **shared across team runs** by design. Its purpose is inter-session message passing: team stage handoffs (plan → prd → exec → verify) accumulate here so a later `team` run can resume from the last non-terminal stage without losing decision history.

**Only the `team` skill writes to `.omg/handoffs/`.** All other code that reads the directory does so read-only. This is enforced by the lint test `tests/lint/handoffs-writers.test.ts`, which scans `src/**` and `templates/**` and fails if any file outside `src/team/` or `src/hooks/team-pipeline/` references `handoffs/` as a write target.

- Handoff files survive team cancellation and OMC state cleanup intentionally — they are post-mortem artifacts. Claude Code 2.1.178+ removed native `TeamCreate`/`TeamDelete`; teams use the implicit agent team with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, spawning teammates through the Agent/Task tool with distinct `name` values.
- Do **not** session-scope `.omg/handoffs/` unless the `team` skill explicitly evolves to per-session inboxes (tracked as a follow-up in the ADR).

#### Branded path types (`ReadPath` / `WritePath`)

State-file path resolution returns a branded struct from `resolveSessionStatePaths()` in `src/lib/worktree-paths.ts`:

```ts
interface SessionStatePaths {
  sessionScoped: string;
  legacy: string;
  effectiveRead: ReadPath;   // string & { __brand: 'ReadPath' }
  effectiveWrite: WritePath; // string & { __brand: 'WritePath' }
}
```

The brand prevents a hook from silently passing a read-fallback path to a writer (or vice versa) — TypeScript rejects the cross-assignment at compile time. The only legitimate producer of the brand is `resolveSessionStatePaths()` itself; an ESLint `no-restricted-syntax` rule in `eslint.config.js` blocks `as ReadPath` / `as WritePath` casts anywhere outside `worktree-paths.ts` and its tests. Compile-time regression guard at `src/lib/__tests__/session-state-paths.type-test.ts`.

#### Legacy state migration (`OMC_MIGRATE_LEGACY_STATE`)

When you adopt `OMC_STATE_DIR` or `.omc-workspace` on a repo that already has existing `{worktree}/.omg/state/` files, you can opt in to a one-shot copy of legacy state into the new session-scoped path:

```bash
export OMC_MIGRATE_LEGACY_STATE=1
```

Semantics:
- **Trigger**: checked once per state-file read by callers that wrap their write through the migration helper.
- **Operation**: copies `{omcRoot}/state/{name}-state.json` → `{omcRoot}/state/sessions/{sessionId}/{name}-state.json` using an atomic `.migrating` sentinel + rename for crash recovery.
- **Idempotent**: a second run with the flag set is a no-op if the session-scoped file already exists.
- **Opt-in only**: never triggers automatically; only when `OMC_MIGRATE_LEGACY_STATE=1` is set.
- **No auto-trigger**: do not set this permanently in your shell profile; set it once for the migration session, then unset it.

#### Rollback / disable multi-repo (`OMC_DISABLE_MULTIREPO`)

If the workspace-marker resolution causes unexpected behaviour (e.g., after dropping a stale `.omc-workspace` marker), you can disable multi-repo path resolution in one env-var flip:

```bash
export OMC_DISABLE_MULTIREPO=1
```

Exact semantics:
- **Skips** `.omc-workspace` marker detection — `findWorkspaceRoot()` returns `null` immediately.
- **Falls back** to the standard `git rev-parse --show-toplevel` → `process.cwd()` resolution order.
- **Preserves** `OMC_STATE_DIR` if set — centralized state storage still works.
- **Scope**: per-process; set in the shell session where you run `claude`, not project-wide.

To restore multi-repo behaviour, unset the variable:

```bash
unset OMC_DISABLE_MULTIREPO
```

#### Ultragoal multi-plan layout

Default layout (single plan, monorepo / single session):

```
.omg/ultragoal/brief.md
.omg/ultragoal/goals.json
.omg/ultragoal/ledger.jsonl
```

Multi-plan layout, enabled by `--plan-id <id>` or `--auto-plan-id` on `omg ultragoal create-goals`:

```
.omg/ultragoal/plans/{planId}/brief.md
.omg/ultragoal/plans/{planId}/goals.json
.omg/ultragoal/plans/{planId}/ledger.jsonl
```

`--auto-plan-id` derives `{epochMs}-{slug}` from the brief title, so two parallel sessions running `omg ultragoal create-goals --auto-plan-id ...` never collide. Subsequent commands (`status`, `add-goal`, `complete-goals`, `checkpoint`, `record-review-blockers`) auto-resolve the plan when there is exactly one; when there are multiple, they require `--plan-id <id>`. `omg ultragoal list-plans` enumerates the available plan ids.

### When to Re-run Setup

- **First time**: Run after installation (choose project or global)
- **After updates**: Re-run to get the latest configuration
- **Different machines**: Run on each machine where you use Claude Code
- **New projects**: Run `/oh-my-copilot:omc-setup --local` in each project that needs omc

> **NOTE**: After updating the plugin (via `npm update`, `git pull`, or Claude Code's plugin update), you MUST re-run `/oh-my-copilot:omc-setup` to apply the latest CLAUDE.md changes.

### Remote OMC / Remote MCP Access

Issue #1653 asked whether OMC can "connect to a remote OMC" so one development machine can browse files on lab/test machines without opening an interactive SSH session.

The narrow, coherent answer today is:

- **Supported**: connect to a **remote MCP server** through the unified MCP registry
- **Not implemented**: a general "OMC cluster", shared remote filesystem view, or automatic remote-OMC federation
- **Still appropriate for full remote shell workflows**: SSH, worktrees, or a mounted/network filesystem

If a remote host already exposes an MCP endpoint, add it to your MCP registry (or Claude settings and then re-run setup so OMC syncs the registry to Codex too):

```json
{
  "mcpServers": {
    "remoteOmc": {
      "url": "https://lab.example.com/mcp",
      "timeout": 30
    }
  }
}
```

This gives OMC a coherent remote connection surface for MCP-backed tools. It does **not** make all remote files magically appear as a local workspace, and it does **not** replace SSH for arbitrary shell access.

If you need richer cross-machine behavior in the future, that would require a separate authenticated remote execution/filesystem design rather than stretching the current local-workspace architecture.

### Company Context via MCP

OMC also supports a narrow company-context contract on top of the existing MCP surface.

Configure it in the standard OMC config files:

- Project: `.claude/omc.jsonc`
- User: `~/.config/claude-omc/config.jsonc`

```jsonc
{
  "companyContext": {
    "tool": "mcp__vendor__get_company_context",
    "onError": "warn",
  },
}
```

- `tool` is the full MCP tool name to call.
- `onError` controls prompt-level fallback: `warn`, `silent`, or `fail`.
- The MCP server itself is still registered through the normal Claude/OMC MCP setup path.

This remains a prompt-level workflow contract, not runtime enforcement. For the full interface, trigger stages, and trust boundary, see [company-context-interface.md](./company-context-interface.md).

### Agent Customization

Edit agent files in `~/.claude/agents/` to customize behavior:

```yaml
---
name: architect
description: Your custom description
tools: Read, Grep, Glob, Bash, Edit
model: opus # or sonnet, haiku
# Optional: effort inherits from the parent Claude Code session unless you add an explicit override.
# effort: high
---
Your custom system prompt here...
```

Bundled OMC agent prompts currently do **not** ship an `effort:` frontmatter field. Any effort language inside `agents/*.md` is behavioral guidance for the prompt body, while runtime effort inherits from the parent Claude Code session unless the agent markdown explicitly declares an override.

**Per-agent model overrides on Copilot.** The `agents.<name>.model` override in `omg.jsonc` is applied by the PreToolUse enforcer through `updatedInput`, which Copilot CLI does not support, so it is a no-op there. On Copilot, each agent's model comes from the `models:` fallback list in the generated `copilot/agents/<name>.md` (from the agent's tier alias), or from Copilot's own `subagents.agents.<name>.model` setting in `$COPILOT_HOME/settings.json`. Under Claude Code the override works as documented.

### Project-Level Config

Create `.claude/CLAUDE.md` in your project for project-specific instructions:

```markdown
# Project Context

This is a TypeScript monorepo using:

- Bun runtime
- React for frontend
- PostgreSQL database

## Conventions

- Use functional components
- All API routes in /src/api
- Tests alongside source files
```

### Stop Callback Notification Tags

Configure tags for Telegram/Discord stop callbacks with `omg config-stop-callback`.

```bash
# Set/replace tags
omg config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omg config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"

# Incremental updates
omg config-stop-callback telegram --add-tag charlie
omg config-stop-callback discord --remove-tag @here
omg config-stop-callback discord --clear-tags

# Inspect current callback config
omg config-stop-callback telegram --show
omg config-stop-callback discord --show
```

Tag behavior:

- Telegram: `alice` is normalized to `@alice`
- Discord: supports `@here`, `@everyone`, numeric user IDs (`<@id>`), and role tags (`role:<id>` -> `<@&id>`)
- `file` callbacks ignore tag options

---

## Runtime storage and goal artifacts

OMC documentation should describe goal and workflow artifacts by their logical role first, then map that role to the runtime-specific storage root. Do not treat `.omx/` as a universal path: it is the legacy OMX runtime root, while OMC uses `.omg/` for local project state.

### Runtime root mapping

| Runtime                      | Project-local root     | User/global root            | Notes                                                                                                                                                   |
| ---------------------------- | ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OMC                          | `.omg/`                | `~/.omg/`                   | Canonical OMC storage for project-local state, plans, notepads, logs, research, and ask artifacts.                                                      |
| OMX compatibility/runtime-v1 | `.omx/`                | `~/.omx/`                   | Compatibility root for older OMX sessions and cross-runtime handoffs. Mention only when documenting OMX-specific behavior.                              |
| OMO native                   | runtime-owned OMO path | runtime-owned OMO user path | OMO-native storage is owned by that runtime. OMC docs should name the logical artifact role unless an OMO command explicitly documents a concrete path. |

### Logical goal artifact roles

Use these names when writing docs or handoffs so the same concept remains portable across OMC, OMX compatibility, and OMO-native runtimes:

| Logical role            | OMC path                                                                   | OMX compatibility path                                                     | Purpose                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal/spec artifact      | `.omg/specs/<slug>.md` or `.omg/plans/<slug>.md`                           | `.omx/specs/<slug>.md` or `.omx/plans/<slug>.md`                           | Durable statement of the user goal, constraints, acceptance criteria, and execution handoff.                                                                                       |
| Approved execution plan | `.omg/plans/<slug>.md`                                                     | `.omx/plans/<slug>.md`                                                     | Reviewed implementation plan consumed by execution workflows such as team or ralph.                                                                                                |
| Task/runtime state      | `.omg/state/<mode>.json` or `.omg/state/sessions/<session-id>/<mode>.json` | `.omx/state/<mode>.json` or `.omx/state/sessions/<session-id>/<mode>.json` | Machine-readable workflow state. Session-scoped state wins over legacy flat files when present.                                                                                    |
| Team coordination state | `.omg/state/team/<team-name>/...`                                          | `.omx/state/team/<team-name>/...`                                          | Worker task files, mailbox, status, events, and dispatch metadata. Worktree-backed workers should use `OMC_TEAM_STATE_ROOT`/compat env to find the leader-owned coordination root. |
| Ask/advisor artifacts   | `.omg/artifacts/ask/<provider>-<slug>-<timestamp>.md`                      | `.omx/artifacts/ask/<provider>-<slug>-<timestamp>.md`                      | Persisted advisor output from `omg ask` or compatibility wrappers.                                                                                                                 |
| Plan-scoped notepad     | `.omg/notepads/<plan-name>/`                                               | `.omx/notepads/<plan-name>/`                                               | Durable notes gathered while planning or executing a named goal.                                                                                                                   |
| Project memory          | `.omg/project-memory.json` and `.omg/notepad.md`                           | `.omx/project-memory.json` and `.omx/notepad.md`                           | Reusable project facts and session notes.                                                                                                                                          |

When an environment variable such as `OMC_STATE_DIR` centralizes storage, resolve the OMC project-local root through that setting before expanding the paths above. In docs, phrase this as "the OMC state root" or "the team coordination root" when the exact filesystem path may vary.

### `/goal` interoperability notes

Claude Code's `/goal` feature owns its hidden goal state. OMC integrations should not mutate hidden Claude Code goal storage directly. When OMC needs a goal-related artifact, create or update an explicit OMC artifact such as `.omg/specs/<slug>.md`, `.omg/plans/<slug>.md`, or `.omg/state/<mode>.json` and record any `/goal` relationship as metadata or prose in that artifact.

For cross-runtime handoffs:

- Prefer logical names such as "approved execution plan" or "team coordination root" over hardcoded `.omx/...` paths.
- Use `.omg/...` examples for OMC-facing docs and commands.
- Use `.omx/...` examples only for OMX compatibility behavior.
- For OMO-native behavior, link to or quote the OMO command's documented path instead of inventing an OMC/OMX path.

---

## Plugin directory flags

When you launch OMC via a local development checkout instead of the marketplace plugin, you can configure how OMC discovers agents, skills, and commands.

> **Recommended for local development**: Use `omg --plugin-dir <path>` (paired with `omg setup --plugin-dir-mode`). Unlike `claude plugin marketplace add`, this flow loads agents/skills directly from your checkout with **no plugin cache**, so edits are picked up on the next session without `marketplace update` / `plugin update` round-trips — much faster iteration.

### `omg --plugin-dir <path>`

**Usage**: Non-consuming launcher flag that captures your local checkout path.

```bash
omg --plugin-dir /path/to/oh-my-copilot setup --plugin-dir-mode
```

- **What it does**: Parses `--plugin-dir <path>` (or `--plugin-dir=<path>`), resolves it to an absolute path, sets `OMC_PLUGIN_ROOT` environment variable, then passes the flag through to Claude Code untouched.
- **Non-consuming**: The flag stays in the argument list so Claude Code's plugin loader still sees it.
- **Precedence**: Explicit `--plugin-dir` flag wins over any pre-existing `OMC_PLUGIN_ROOT` env var (with a warning if they disagree).
- **Resolution**: Relative paths are resolved to absolute via `path.resolve()`. Note: `~` is **not** expanded — use `$HOME` or an absolute path instead.
- **Pair with setup**: `--plugin-dir` alone only affects the current Claude session. You must **also** run `omg setup --plugin-dir-mode` (or let auto-detection kick in from `OMC_PLUGIN_ROOT`) so HUD, hooks, and CLAUDE.md are installed for the linked checkout. Skipping this step leaves `~/.claude/` pointing at a stale plugin root.

### `claude --plugin-dir <path>` (direct)

**Usage**: When you launch Claude Code directly without the `omg` shim.

```bash
export OMC_PLUGIN_ROOT=/path/to/oh-my-copilot
claude --plugin-dir /path/to/oh-my-copilot
```

- **Requirement**: You must manually set `OMC_PLUGIN_ROOT` environment variable so the HUD wrapper and other env-aware components can resolve the same path as the plugin loader.
- **Why**: The HUD bundle needs to know where agents/skills/commands are located so they stay in sync with the plugin instance.
- **Note**: Plain `claude` (without `omg`) does not automatically capture `--plugin-dir` for you.

### `omg setup --plugin-dir-mode`

**Usage**: Explicit flag to enable dev plugin-dir mode during setup.

```bash
omg setup --plugin-dir-mode
```

- **What it does**: Skips copying agents and bundled skills into `~/.claude/` because the plugin already provides them at runtime via `--plugin-dir`.
- **Still installs**:
  - HUD bundle (`~/.claude/hud/`)
  - Git hooks (`.git/hooks/`, if applicable)
  - CLAUDE.md configuration files
  - `.omc-config.json` state
- **Conflicts with `--no-plugin`**: If both flags are set, `--no-plugin` takes precedence (with a warning).
- **Auto-detection**: If `OMC_PLUGIN_ROOT` is already set in the environment, `--plugin-dir-mode` is auto-enabled (unless `--no-plugin` overrides it).

### `omg doctor --plugin-dir <path>` (NEW)

**Usage**: Run diagnostics with a specific plugin directory.

```bash
omg doctor --plugin-dir /path/to/oh-my-copilot
omg doctor conflicts --plugin-dir /path/to/oh-my-copilot
```

- **What it does**: Resolves the provided path to absolute, sets `OMC_PLUGIN_ROOT` before the doctor action runs, matching `launch.ts` semantics.
- **Precedence**: Explicit `--plugin-dir` flag wins over pre-existing `OMC_PLUGIN_ROOT` env var (with a warning if they disagree).
- **Subcommand support**: Works with both `omg doctor` and `omg doctor conflicts`.
- **Output**: Diagnostic results reflect the plugin directory you specified.

### `OMC_PLUGIN_ROOT` environment variable

**Usage**: Authoritative source for the active plugin root when launching Claude Code.

```bash
export OMC_PLUGIN_ROOT=/path/to/oh-my-copilot
claude --plugin-dir /path/to/oh-my-copilot
```

- **Set by**: `omg --plugin-dir <path>` launcher (via `src/cli/launch.ts`).
- **Read by**: HUD wrapper, setup auto-detect, doctor diagnostics.
- **Required when**: Using `claude --plugin-dir` directly (without the `omg` shim), so downstream components can resolve the same path.
- **Precedence**: Explicit CLI flags override this env var (with warnings).

### Decision matrix: which flag/mode to use?

| Your setup                            | Launch command                                               | Setup command                   | Expected behavior                                                   |
| ------------------------------------- | ------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------- |
| **Marketplace plugin** (recommended)  | `omg` or `claude` (default)                                  | `omg setup`                     | Normal: agents/skills copied to `~/.claude/`                        |
| **Local dev checkout, want OMC shim** | `omg --plugin-dir /path`                                     | `omg setup --plugin-dir-mode`   | Dev mode: agents/skills loaded from `/path`, not copied             |
| **Local dev checkout, no OMC shim**   | `claude --plugin-dir /path` + `export OMC_PLUGIN_ROOT=/path` | `omg setup --plugin-dir-mode`   | Dev mode + manual env: agents/skills loaded from `/path`            |
| **Local dev, want bundled skills**    | `omg --plugin-dir /path`                                     | `omg setup --no-plugin`         | Forces local bundled skills to `~/.claude/skills/`, ignoring plugin |
| **Troubleshooting a specific path**   | N/A                                                          | `omg doctor --plugin-dir /path` | Diagnostics show status for `/path`                                 |

---

## CLI Commands: ask/team/session

### `omg ask`

```bash
omg ask claude "review this patch"
omg ask codex "review this patch from a security perspective"
omg ask gemini --prompt "suggest UX improvements"
omg ask antigravity --prompt "suggest UX improvements"
omg ask cursor --prompt "apply this implementation plan"
omg ask claude --agent-prompt executor --prompt "create an implementation plan"
```

- Provider matrix: `claude | codex | gemini | antigravity | grok | cursor`
- Artifacts: `.omg/artifacts/ask/{provider}-{slug}-{timestamp}.md`
- Canonical env vars: `OMC_ASK_ADVISOR_SCRIPT`, `OMC_ASK_ORIGINAL_TASK`
- Phase-1 aliases (deprecated warning): `OMX_ASK_ADVISOR_SCRIPT`, `OMX_ASK_ORIGINAL_TASK`
- Skill entrypoint: `/oh-my-copilot:ask <claude|codex|gemini|antigravity|grok|cursor> <prompt>` routes to this command

### `omg team` (CLI runtime surface)

```bash
omg team 2:codex "review auth flow"
omg team status review-auth-flow
omg team shutdown review-auth-flow --force
omg team api claim-task --input '{"team_name":"auth-review","task_id":"1","worker":"worker-1"}' --json
```

Supported entrypoints: direct start (`omg team [N:agent] "<task>"`), `status`, `shutdown`, and `api`.

Startup reserves the team name for an immutable instance. Shutdown and job cleanup
require matching instance and worker-launch evidence; `--force` skips graceful
waits but does not bypass ownership checks. Missing or corrupt evidence preserves
resources, and an old job cannot clean up a newer same-name team. Keep external
cleanup receipts when retrying a partial state removal. See
[Team Instance Ownership](MIGRATION.md#unreleased-team-instance-ownership).
API `cleanup` and `orphan-cleanup` follow the same evidence rules. SessionEnd
validates Claude-session ownership from config `leader_session_id` before
delegating instance-bound shutdown.
Tmux effects require the original socket and precise server process identity;
reused pane IDs after a server restart do not grant ownership.

Native team worker worktrees are an opt-in/config-gated runtime-v2 rollout. See [Native Team Worktree Mode](TEAM-WORKTREE-MODE.md) for the worktree path contract, canonical `OMC_TEAM_STATE_ROOT` behavior, status fields, and dirty-worktree cleanup policy.

Topology behavior:

- inside classic tmux (`$TMUX` set): reuse the current tmux surface for split-pane or `--new-window` layouts
- inside cmux (`CMUX_SURFACE_ID` without `$TMUX`): create native cmux splits for visible team workers
- plain terminal: launch a detached tmux session for team workers

#### Windows (psmux)

On native Windows, `omg team` runs on [psmux](https://github.com/marlocarlo/psmux) (`winget install psmux`, ≥ 3.3.7 required for honored `-L <ns>` namespaces). Teams always launch detached into a private, randomly-named psmux namespace, never the shared default namespace, so they never show up in a bare `psmux ls`. Attach to a running team with:

```bash
tmux -L <ns> attach
```

`<ns>` is shown by `omg team status <team>` and recorded as the basename of `tmux_server_identity.socket_path` in `.omg/state/team/<team>/config.json`. If a startup is left unverified (status reports it as incomplete), clean up the leftover namespace directly:

```bash
tmux -L <ns> kill-server
```

#### Team worker permissions

Worker types are `claude`, `copilot`, `codex`, `gemini`, `grok`, `cursor` and `antigravity`: `omg team 3:copilot "fix the failing tests"`. Without an explicit `N:agent-type`, OMC uses `team.ops.defaultAgentType` or `team.roleRouting.<role>.provider`, and falls back to the host CLI: `copilot` on a Copilot host, `claude` on a Claude Code host. The host is Copilot when Copilot session markers are present; otherwise `CLAUDE_CODE_ENTRYPOINT` selects Claude Code.

Worker panes run unattended, so each provider launches with its own auto-approve flags. Copilot workers get `--allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user` (no `--yolo`, no `--autopilot`). Deny rules from `.copilot/omg.jsonc` are appended as `--deny-tool=<pattern>` and `--deny-url=<pattern>`, and in Copilot CLI deny beats allow:

```jsonc
{
  "permissions": {
    "workerDenyTools": ["shell(git push)", "shell(rm:*)", "write(.env)"],
    "workerDenyUrls": ["https://*.internal.example"]
  }
}
```

- Patterns use Copilot's `--deny-tool` / `--deny-url` syntax. Each entry must be a non-empty string; entries starting with `-` or containing NUL are rejected at config load.
- Only copilot workers enforce the lists. `deniedUrls` in `$COPILOT_HOME/settings.json` also applies, because workers inherit `COPILOT_HOME`.
- The flags are stored in the worker launch descriptor, so restarts and scale-up reuse them.
- At startup `omg team` prints one stderr line per provider. For other providers the line says the list is NOT enforced:

  ```text
  [omg team] copilot workers (x3): --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user; deny: shell(git push), https://*.internal.example
  [omg team] codex workers (x1): permissions.workerDenyTools NOT enforced (vendor flags: --dangerously-bypass-approvals-and-sandbox)
  ```

- `disableExternalLLM` / `OMC_SECURITY=strict` allows only the current host CLI's workers. See [SECURITY.md](../SECURITY.md).

#### Headless SDK workers (`--transport sdk`, experimental)

`omg team 2:copilot --transport sdk "<task>"` (or `team.transport: "sdk"`) runs each copilot worker as a detached `omg team sdk-host` process that owns one `@github/copilot-sdk` session, with no pane and no multiplexer. It needs `@github/copilot-sdk` installed (`npm i -g @github/copilot-sdk --omit=optional --ignore-scripts`).

- **No allow-all.** The host answers every permission request. Writes are allowed only inside the worker's worktree and the team state root. Reads also allow the plugin root. MCP calls are allowed only to the plugin server.
- **The shell policy is a denylist, not a sandbox.** It rejects team control other than `team api`, `omg smoke`, `tmux`/`psmux` and `git push`, plus `shell(<prefix>)` entries of `workerDenyTools`, including quoted spellings such as `"omg" team shutdown`. A command built indirectly (a script file, an alias, `Invoke-Expression`, an encoded command) is not caught. Treat the write-path check, the credit cap and the per-worker `COPILOT_HOME` as the boundaries.
- **Sub-agent tools are removed**: `task`, `run_dynamic_workflow`, `dynamic_workflows_manage`, `write_agent`, `read_agent`, `list_agents`, `search_code_subagent` and the plugin's `host_smoke`.
- **Credit cap.** `team.sdk.maxCreditsPerWorker` (default 10, must be a positive number; env `OMC_TEAM_SDK_MAX_CREDITS`) is enforced by the host: at the cap it aborts the turn and takes no more prompts, and `omg team status` shows the worker as `capped` with a reassign recommendation.
- **Unsupported under sdk:** `--auto-merge`, non-copilot workers, scaling, dead-worker recovery, and an **explicitly** assigned reviewer role with a verdict contract (`critic`, `code-reviewer`, `security-reviewer`, `test-engineer` — set directly via a task's `role` or via `team.roleRouting`); startup rejects them. A contract role merely *inferred* from task text (with no explicit assignment) is not rejected: the role is dropped and the worker runs as a plain executor instead, since an SDK host never exits between turns and so could never have its verdict file read anyway.

### `omg session search`

```bash
omg session search "team leader stale"
omg session search notify-hook --since 7d
omg session search provider-routing --project all --json
```

- Defaults to the current project/worktree scope
- Use `--project all` to search across all local Claude project transcripts
- Supports `--limit`, `--session`, `--since`, `--context`, `--case-sensitive`, and `--json`
- MCP/tool surface: `session_search` returns structured JSON for agents and automations

### `omg session friction report`

```bash
omg session friction report --since 24h
omg session friction report --project all --json
```

- Local-only/offline report over Claude transcript files, `.omg/sessions/*.json`, and `.omg/state/agent-replay-*.jsonl`
- Does not print raw prompt, response, or tool-result content by default; output uses counts, sizes, timestamps, and signal codes
- Highlights context-bloat and operator-friction indicators such as high estimated context usage, large JSONL entries, tool error rates, long idle gaps, failed agents, and hook noise
- Supports `--limit`, `--session`, `--since`, `--project`, and `--json`

### `omg checkpoint`

Workspace snapshot/rollback for autonomous runs, built on git "shadow commits": the full working tree (tracked, modified, and untracked non-ignored files) is captured into `refs/omc/checkpoints/` without touching HEAD, the index, or the worktree.

```bash
omg checkpoint create --label "before ralph run"
omg checkpoint list
omg checkpoint rollback <id> --force
```

- `create` never touches HEAD or the working tree; restore points appear only under `refs/omc/checkpoints/`
- `rollback` restores the worktree and index and removes files created after the snapshot (`git clean -fd` keeps ignored paths such as `node_modules`)
- `rollback` refuses to discard uncommitted changes unless `--force` is passed
- Requires a git repository; no external storage is involved

### `omg lookout`

Pre-flight danger scan for autonomous runs. Before an unattended effort starts (graph run, autopilot, launch, a multi-agent team), lookout scans the task briefing and the workspace state and reports machine-readable findings. Advisory by design: it never blocks, never mutates, and has no skip-file backdoor.

```bash
omg lookout scan --brief "Migrate billing to v2 and update the deploy config"
omg lookout scan --brief @task-brief.md --json
omg lookout scan --strict   # exit 1 when review is recommended (for scripts)
```

- Briefing rules flag the dangerous operation itself — force operations, destructive SQL, test deletion/skipping, direct pushes to protected branches (high severity); secret, CI, and deployment surfaces (medium severity)
- Workspace rules flag tracked secret-looking files and a dirty worktree; `repo` is `null` outside a git repository
- Every finding carries `id`, `severity`, `confidence`, `actionable`, `evidence`, and `advice` — the same vocabulary drydock's `--check` audit documents, so a structured contract can be shared by both surfaces
- `--json` emits the full report; exit codes: `0` for every successful non-strict scan and for strict scans without a review-recommended verdict, `1` for `--strict` with a review-recommended verdict, `2` for a usage/scan error
- High-risk verdicts pair with approval gates and checkpoints: `omg graph run --approval-mode remote --checkpoint`, `omg checkpoint create`

### `omg factory`

`omg factory init` seeds the project route table `.omg/factory-routes.json`, `omg factory listen` runs the HMAC-verified tracker intake daemon, and `omg factory status [--json]` is the read-only chain audit. A chain is a series of headless AFK links: when a link's session ends, the SessionEnd hook routes its `outcome:reason` through the route table and the detached SessionEnd worker spawns the next link. Guardrails apply per link: one active link per intent (serial lock) and a daily cap of 10 (`OMC_DAILY_CHAIN_LIMIT`).

#### Factory chains on Copilot

Each link has a chain-link id and a ledger `.omg/state/factory/chain-<id>.json`, written by whoever spawns the link (the listener for the first link, the SessionEnd worker for later ones). The SessionEnd hook must find that ledger, so the link id has to reach the ending session:

- **Claude Code** pins it with `--session-id <id>`; the host session id is the link id.
- **Copilot CLI** has no `--session-id`, so the spawner sets `OMC_CHAIN_LINK=<id>` on the `copilot` process. Copilot passes its env to hook processes, and SessionEnd resolves the link as `OMC_CHAIN_LINK` first, then the host session id.

`OMC_CHAIN_LINK` is trusted only when `chain-<id>.json` exists and records `host: "copilot"` and `chainLink: <id>`, and the ending session is not a Claude session (`CLAUDE_CODE_ENTRYPOINT` unset). Otherwise SessionEnd falls back to the host session id and records `chain-link-rejected` in `chain-decisions.jsonl`. A ledger that already has `closedAt` resolves but enqueues nothing (`already-closed`). So setting the variable alone can neither inject a chain nor replay a finished link. If the hand-off to the worker fails after the decision, the ledger's `decision` is corrected to `manifest-unavailable` or `worker-spawn-failed`. The detached SessionEnd worker never forwards `OMC_CHAIN_LINK`: the chain identity rides the durable manifest payload, and every spawned link gets its own value. `COPILOT_ALLOW_ALL` stays forced to `false` on every link, and the AFK permission profile is unchanged.

| Ledger field | Meaning |
|---|---|
| `chainLink`, `host`, `createdAt`, `parentLink` | Written at spawn: the link id, `copilot` or `claude`, and the link that spawned it. |
| `closedAt`, `hostSessionId`, `endReason`, `outcome`, `decision` | Written once by the link's SessionEnd. A closed ledger is never enqueued again and is never reported as stalled. |
| `maxStageVisits` | Stage-visit cap, carried from the first ledger to every later link (default 2). |

Copilot's SessionEnd reason for a finished `-p` link is `complete` (CLI 1.0.91), which counts as `success` alongside Claude's `other`, `prompt_input_exit`, and `logout`; route keys such as `success:*` match both hosts. When OMC runs from a dev plugin root (`omg --plugin-dir`, which sets `OMC_PLUGIN_ROOT`), Copilot links also get `--plugin-dir <root>`, and the SessionEnd worker forwards `OMC_PLUGIN_ROOT`, so every link loads the same plugin. Limitation: Copilot fires `sessionEnd` after every turn, also in `-p` mode, so a link that a Stop hook keeps going into a second turn hands off after its first turn. The closed ledger stops later turns from enqueuing again, but the next link may start while this one still runs. A single-prompt link is not affected. `omg factory status` lists each intent's links in spawn order with host, link id, and closeout, for example `环 2 link-2 [copilot] link=<id> 已结束 success→chain-loop-capped session=<host session>`.

### `omg smoke copilot`

Headless smoke check of a plugin root against the real GitHub Copilot CLI, in a throwaway `COPILOT_HOME`. Use it on a local build before opening a PR or tagging a release.

```bash
omg smoke copilot                     # tier 0: load check, no model call
omg smoke copilot --tier 1            # tier 0 + one live session, prompt on stdin (one premium request)
omg smoke copilot --plugin-root /path/to/oh-my-copilot --json
omg smoke copilot --tier 1 --keep-home --delegate --model <id> --max-credits 30 --timeout 180000
omg smoke copilot --sdk-static        # tier 2 SDK static checks only, no model call
omg smoke copilot --tier 2            # tier 2 default scenarios smoke,guardrail (~2 premium requests, 1 per scenario)
omg smoke copilot --tier 2 --scenario skill,delegate   # or --scenario all
omg smoke copilot --tier 2 --scenario chain            # opt-in: a real two-link factory chain (~2 premium requests)
```

- **Tier 0** checks: `plugin.manifest`, `plugin.hooks`, `copilot.binary`, `copilot.plugin_list`, `copilot.skill_list`, `copilot.agents`, `mcp.list_tools`. `mcp.list_tools` spawns `dist/mcp/standalone-server.js`, so run `npm run build` first.
- **Tier 1** adds `session.exit`, `session.events`, `hooks.*` (including `hooks.adapter_errors`), `plugins.loaded`, `mcp.server_loaded`, `state.written`, and with `--delegate` `subagent.selected`. Hooks run with `OMC_HOOK_FAIL_CLOSED=1`; a `hook.end` without `success: true` fails its check, and `hooks.adapter_errors` fails on any `[omg-hook]` error line.
- **Tier 2** drives the installed `copilot` binary through the optional peer `@github/copilot-sdk` (install it with `npm i -g @github/copilot-sdk --omit=optional --ignore-scripts`; a nested `@github/copilot-sdk-<platform>` runtime package is unused and can be deleted, see [DEVELOPERS.md](./DEVELOPERS.md#tier-2--sdk-scenarios)). It runs the tier 0 checks, then the SDK static checks `sdk.available`, `sdk.runtime`, `sdk.plugins`, `sdk.skills`, `sdk.agents`, `sdk.mcp`, `sdk.tools_excluded` (our `<server>-host_smoke` tool is absent from the session's tool list), then the chosen scenarios. It does not run the tier 1 `-p` session. `--sdk-static` runs no scenario and makes no model call.
- **Tier 2 scenarios** yield checks prefixed `scn.<name>.`. Each one also gets `scn.<name>.exit`, `scn.<name>.adapter_errors` (fails on any `[omg-hook]` or `[run.cjs]` hook stderr line, such as a hook timeout), and `scn.<name>.cost`. Each scenario costs about one premium request, so the default run costs about two.

| Scenario | Prompt exercises | Key checks |
|---|---|---|
| `smoke` (default) | a plain reply, no tools | `scn.smoke.reply`, `scn.smoke.hooks`, `scn.smoke.no_tools` |
| `guardrail` (default) | `git push --force` with `OMC_GIT_GUARDRAILS=1` against a bare remote | `scn.guardrail.denied`, `scn.guardrail.no_push`, `scn.guardrail.hooks` |
| `skill` | `/oh-my-copilot:plan` | `scn.skill.invoked` |
| `delegate` | a hand-off to `oh-my-copilot:architect` | `scn.delegate.selected`, `scn.delegate.hooks`, `scn.delegate.completed` |
| `chain` (opt-in, never in `all`) | two real `copilot -p` factory links: link 1 replies with one token, link 2 runs the project skill `/chain-ack` | `scn.chain.link1`, `scn.chain.spawned`, `scn.chain.inherited`, `scn.chain.closed`, `scn.chain.premium` |

- **`chain` scenario.** It does not use an SDK session. It seeds the sandbox with `omg factory init` plus a `success:*` route to stage `link-2`, pre-writes link 1's ledger, and spawns link 1 like a factory link (AFK profile, `--plugin-dir`, `OMC_CHAIN_LINK`). The chain then runs itself through the SessionEnd hook and worker, and stops at the stage-visit cap after link 2. The checks read the ledgers, decisions, stop marker, and both link sessions' `events.jsonl`: link 1 was resolved by `OMC_CHAIN_LINK`, link 2 was spawned and ended under its own inherited identity, the chain closed out (`loop-capped:link-2`, no open ledger), and both links together cost at most 2 premium requests. The links run on the CLI's default model without `--max-ai-credits`, because a factory link's argv carries no credit cap, so `--max-credits` does not bound them. `--timeout` applies to link 1 and again to the wait for link 2.

- **Tier 2 report** adds `sdk` (SDK version, runtime version, protocol version), `cost` (premium requests and credits summed over scenarios), and `artifacts.events` with one events JSONL path per scenario. Human output groups the `sdk.*` checks and each scenario's `scn.<name>.*` checks under a heading.
- **Model:** `--model` is optional. Copilot auto-selects when it is omitted (1.0.91 picked `mai-code-1.1-flash`); explicit ids may be rejected as unavailable.
- **Auth:** tier 1 reuses the login identity from your Copilot config, so `copilot /login` is enough. When a login is found the session drops `GH_TOKEN` and `GITHUB_TOKEN`, which would otherwise shadow it. `COPILOT_GITHUB_TOKEN` always passes through, and without a stored login (CI) all three do.
- `--max-credits` must be at least 30, the Copilot CLI minimum. At tier 1 it is passed as `--max-ai-credits`. At tier 2 it caps the whole run: the runtime also gets `--max-ai-credits`, a scenario whose credits pass what is left is aborted, and the remaining scenarios fail with `skipped: credit cap reached`. `--model` applies to tiers 1 and 2. `--timeout` applies per subprocess at tier 0, to the session at tier 1, and per scenario at tier 2; the MCP check is fixed at 10 s.
- Under a test runner (`VITEST` or `NODE_ENV=test`), a run that would call a model is refused with one `cli.guard` check before anything is spawned, unless `OMC_LIVE_SMOKE=1` (tier 1) or `OMC_LIVE_SMOKE=2` (tier 2 scenarios) is set.
- Exit codes: `0` all checks pass, `1` a check failed or an option was invalid, `2` skipped because the `copilot` binary or, at tier 2, `@github/copilot-sdk` did not resolve and nothing else failed. Resolution order is PATH, then `COPILOT_CLI_PATH`, then the WinGet install location on Windows, so a `copilot` on PATH wins over `COPILOT_CLI_PATH`.
- `--json` always prints a `SmokeReport`, with one `cli.error` check for invalid options. `--keep-home` keeps the temp homes and project and reports them as `artifacts.listHome` (tier 0) and `artifacts.copilotHome` (tier 1).
- The same check is exposed as the MCP tool `host_smoke` (arguments `tier`, `pluginRoot`, `model`, `maxCredits`, `timeoutMs`, `keepHome`, `delegate`, `scenarios`). It returns the report JSON with `isError` set when any check fails. Tier 1 and tier 2 with scenarios need `OMC_SMOKE_ALLOW_LIVE=1` in the MCP server env; tier 2 with `scenarios: []` is free and needs no opt-in, and a `pluginRoot` other than the server's own package root needs `OMC_SMOKE_ALLOW_ANY_ROOT=1`. To call it from Claude Code against a local build, register the standalone server:

```bash
claude mcp add omg-dev -- node C:/Code/OMC/dist/mcp/standalone-server.js
```

`OMC_DISABLE_TOOLS=smoke` hides `host_smoke`. See [DEVELOPERS.md](./DEVELOPERS.md#headless-smoke-against-a-local-build) for the developer workflow.

### Graph approval gates (remote approvals)

Graph runtime `human-approval` nodes support two gate styles via `omg graph run`:

```bash
omg graph run ./my-graph.json --approval-mode stdin    # default: interactive y/n
omg graph run ./my-graph.json --approval-mode remote --checkpoint
```

- `--approval-mode remote` persists each pending gate under `.omg/graph-runs/<run_id>/approvals/` and dispatches an `approval-request` notification (Telegram/Discord/Slack/webhook, following your notification config)
- Reply `approved`/`denied` (or `y`/`n`, `批准`/`拒绝`) to the notification message to decide from your phone; the reply-listener daemon writes the decision artifact
- Decide from any shell on the machine: `omg graph approvals list`, then `omg graph approvals decide <runId> <activationId> approved|denied`
- `--approval-timeout <seconds>` bounds the wait; an expired gate resolves to `--approval-timeout-policy deny` (default, fail-closed) or `approve`
- `--checkpoint` snapshots the working tree before the run; after a denial you can restore it: `omg graph approvals decide <runId> <activationId> denied --rollback <checkpointId>`
- Malformed decision artifacts are ignored, never trusted; the runner journal remains the record of outcomes

### Non-interactive automation and CI/CD

Use OMC's terminal and library surfaces in non-interactive environments:

- Run CLI commands that have deterministic exit codes, for example `omg setup`, `omg ask ...`, `omg session search ... --json`, or repo-owned verification scripts such as `npm run sync-metadata:verify`.
- Provide authentication through runner environment variables (`ANTHROPIC_API_KEY`) or pre-authenticated provider CLIs for `codex`, `gemini`, `antigravity`, `grok`, or `cursor` when using `omg ask` / `omg team`.
- Keep state explicit for ephemeral runners by setting `OMC_STATE_DIR` when state must survive worktree deletion or checkout replacement.
- Avoid interactive slash skills (`/oh-my-copilot:autopilot`, `/oh-my-copilot:ralph`, `/oh-my-copilot:execute`, `/oh-my-copilot:deep-interview`, `/oh-my-copilot:team`) in CI jobs; they require an active Claude Code session and user-visible conversation loop.
- OMC does not currently provide a VS Code extension or VS Code-specific automation contract. The documented IDE path is to use Claude Code's own integrations, then install OMC through the Claude Code plugin surface.
- Programmatic Agent SDK usage is supported through the exported TypeScript helpers and the in-process MCP server helpers in this package; it is a Node.js library surface, not an interactive plugin installer.

---

## Legacy MCP Team Runtime Tools (Deprecated, Opt-In Only)

The Team MCP runtime server is **not enabled by default**. If manually enabled, runtime tools are still **CLI-only deprecated** and return a deterministic error envelope:

```json
{
  "code": "deprecated_cli_only",
  "message": "Legacy team MCP runtime tools are deprecated. Use the omg team CLI instead."
}
```

Use `omg team ...` replacements instead:

| Tool                   | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `omc_run_team_start`   | **Deprecated** → `omg team [N:agent-type] "<task>"`        |
| `omc_run_team_status`  | **Deprecated** → `omg team status <team-name>`             |
| `omc_run_team_wait`    | **Deprecated** → monitor via `omg team status <team-name>` |
| `omc_run_team_cleanup` | **Deprecated** → `omg team shutdown <team-name> [--force]` |

Optional compatibility enablement (manual only):

```json
{
  "mcpServers": {
    "team": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bridge/team-mcp.cjs"]
    }
  }
}
```

### Runtime status semantics

- **Artifact-first terminal convergence**: team monitors prefer finalized state artifacts when present.
- **Deterministic parse-failure handling**: malformed result artifacts are treated as terminal `failed`.
- **Cleanup scope**: shutdown/cleanup only clears `.omg/state/team/{teamName}` for the target team (never sibling teams).

### Artifact descriptors and bounded handoff

OMC handoffs follow an artifact-first discipline:

- **Control plane** data stays small and operational: queue state, worker claims, session state, and interop task/message envelopes.
- **Data plane** artifacts stay durable: plans, prompts, specs, traces, and result files.
- Large payloads should be referenced by descriptor instead of copied into control-plane state.
- Current low-risk call sites follow this split explicitly:
  - shared interop state writes oversized task descriptions, task results, and shared messages to `.omg/state/interop/artifacts/**`
  - prompt persistence keeps durable prompt/response files in `.omg/prompts/**` and exposes descriptor metadata through job status records

Canonical descriptor fields:

| Field          | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| `kind`         | Artifact type such as `plan`, `prompt`, `result`, or `trace` |
| `path`         | Durable artifact path                                        |
| `contentHash?` | Optional integrity hint                                      |
| `createdAt`    | Artifact creation timestamp                                  |
| `producer`     | Owning worker/tool/skill                                     |
| `sizeBytes?`   | Optional size for threshold checks                           |
| `retention`    | Retention/ownership hint                                     |
| `expiresAt?`   | Optional expiry for short-lived artifacts                    |

Bounded handoff policy:

1. Keep small payloads inline only when the call site's explicit threshold allows it.
2. For larger payloads, pass a short summary plus the descriptor.
3. Keep durable content in artifact paths such as `.omg/plans/`, `.omg/prompts/`, and related artifact stores rather than embedding full bodies into queue or status records.

## Agents (20 Total)

Model-tier aliases are shown in the table below; the shipped agent catalog contains 20 base agents.

Always use `oh-my-copilot:` prefix when calling via Task tool.

### By Domain and Tier

| Domain             | LOW (Haiku)             | MEDIUM (Sonnet)       | HIGH (Opus)         |
| ------------------ | ----------------------- | --------------------- | ------------------- |
| **Analysis**       | `architect-low`         | `architect-medium`    | `architect`         |
| **Execution**      | `executor-low`          | `executor`            | `executor-high`     |
| **Search**         | `explore`               | -                     | `explore-high`      |
| **Research**       | -                       | `document-specialist` | -                   |
| **Frontend**       | `designer-low`          | `designer`            | `designer-high`     |
| **Docs**           | `writer`                | -                     | -                   |
| **Visual**         | -                       | `vision`              | -                   |
| **Planning**       | -                       | -                     | `planner`           |
| **Critique**       | -                       | -                     | `critic`            |
| **Pre-Planning**   | -                       | -                     | `analyst`           |
| **Testing**        | -                       | `qa-tester`           | -                   |
| **Tracing**        | -                       | `tracer`              | -                   |
| **Security**       | `security-reviewer-low` | -                     | `security-reviewer` |
| **Build**          | -                       | `debugger`            | -                   |
| **TDD**            | -                       | `test-engineer`       | -                   |
| **Code Review**    | -                       | -                     | `code-reviewer`     |
| **Data Analysis** | -                       | `scientist`           | `scientist-high`    |
| **Git**            | -                       | `git-master`          | -                   |
| **Simplification** | -                       | -                     | `code-simplifier`   |
| **Verification**   | -                       | `verifier`            | -                   |
| **Pre-Push Critique** | -                    | -                     | `devils-advocate`   |

### Agent Selection Guide

| Task Type                      | Best Agent                                                             | Model  |
| ------------------------------ | ---------------------------------------------------------------------- | ------ |
| Quick code lookup              | `explore`                                                              | haiku  |
| Find files/patterns            | `explore`                                                              | haiku  |
| Complex architectural search   | `explore-high`                                                         | opus   |
| Simple code change             | `executor-low`                                                         | haiku  |
| Feature implementation         | `executor`                                                             | sonnet |
| Complex refactoring            | `executor-high`                                                        | opus   |
| Debug simple issue             | `architect-low`                                                        | haiku  |
| Debug complex issue            | `architect`                                                            | opus   |
| UI component                   | `designer`                                                             | sonnet |
| Complex UI system              | `designer-high`                                                        | opus   |
| Write docs/comments            | `writer`                                                               | haiku  |
| Research docs/APIs             | `document-specialist` (repo docs first; optional Context Hub / `chub`) | sonnet |
| Analyze images/diagrams        | `vision`                                                               | sonnet |
| Strategic planning             | `planner`                                                              | opus   |
| Review/critique plan           | `critic`                                                               | opus   |
| Pre-planning analysis          | `analyst`                                                              | opus   |
| Test CLI interactively         | `qa-tester`                                                            | sonnet |
| Evidence-driven causal tracing | `tracer`                                                               | sonnet |
| Security review                | `security-reviewer`                                                    | sonnet |
| Quick security scan            | `security-reviewer-low`                                                | haiku  |
| Fix build errors               | `debugger`                                                             | sonnet |
| Simple build fix               | `debugger` (model=haiku)                                               | haiku  |
| TDD workflow                   | `test-engineer`                                                        | sonnet |
| Quick test suggestions         | `test-engineer` (model=haiku)                                          | haiku  |
| Code review                    | `code-reviewer`                                                        | opus   |
| Quick code check               | `code-reviewer` (model=haiku)                                          | haiku  |
| Data analysis/stats            | `scientist`                                                            | sonnet |
| Quick data inspection          | `scientist` (model=haiku)                                              | haiku  |
| Deep data analysis            | `scientist-high`                                                       | opus   |
| Git operations                 | `git-master`                                                           | sonnet |
| Code simplification            | `code-simplifier`                                                      | opus   |
| Completion verification        | `verifier`                                                             | sonnet |
| Pre-push critique of commits   | `devils-advocate`                                                      | opus   |

---

## Goal Workflow UX: `/goal`, Ralph, Team, Ultragoal

OMC exposes several ways to pursue a goal-shaped task. They are complementary, not interchangeable. Choose one primary loop authority per session and use the others as evidence producers or handoff targets.

| Surface                 | Runtime owner                                     | User-facing promise                                           | Completion evidence                                                          | Notes                                                                                                                                                           |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code `/goal`     | Claude Code native session loop                   | Keep working toward one stated completion condition           | Evidence surfaced in the conversation for the `/goal` evaluator              | Cite Claude Code/Anthropic docs or changelog only for `/goal` behavior. The evaluator must not be described as independently running commands or reading files. |
| Ralph                   | OMC skill + Stop-hook enforcement                 | Persistent single-owner implementation until PRD stories pass | Tests/build/lint/typecheck plus reviewer verification                        | Prefer when correctness depends on OMC's PRD, progress, and reviewer gates.                                                                                     |
| Team                    | OMC native/team or CLI team runtime               | Coordinated multi-agent execution over assigned tasks         | Worker task results, commits, staged `team-verify`/`team-fix` evidence       | Prefer when ownership boundaries and parallel lanes matter.                                                                                                     |
| Artifact-only Ultragoal | Durable goal ledger/checkpoints/handoff artifacts | Track goal state without starting another active loop         | Goal artifact, checkpoints, handoff prompt, attached command/review evidence | Prefer when `/goal` is unavailable, unsafe, or conflicts with an active OMC loop.                                                                               |

### `/goal` source and evidence boundary

Use Claude Code/Anthropic sources for `/goal` facts, including:

- Claude Code `/goal` documentation: <https://code.claude.com/docs/en/goal>
- Anthropic Claude Code changelog: <https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>

Do not cite OpenAI/Codex documentation as authority for Claude Code `/goal`. In OMC docs, examples, and handoff prompts, keep this limitation explicit: the `/goal` evaluator judges visible conversation evidence. It should not be described as independently executing shell commands, reading files, inspecting hidden state, or replacing OMC's final review gates.

### Recommended conflict handling

When multiple loops could apply, use this deterministic policy:

1. **refuse**: if Ralph, Team, autopilot, or another Stop-hook loop is already active and a new `/goal` would compete for continuation authority.
2. **adopt_existing**: if Claude Code `/goal` is already active and the OMC workflow can attach evidence to that same condition without changing loop ownership.
3. **artifact_only**: if `/goal` is unavailable because of hooks/trust/settings, or if the user only needs durable planning, checkpointing, and evidence capture.

`/goal` evaluator success can be useful evidence, but OMC completion should still require the relevant durable proof: command output, changed files, reviewer verdicts, task results, or release artifacts.

For the shorter user-facing chooser, see [Mode Selection Guide](./shared/mode-selection-guide.md#goal-oriented-workflow-selection).

### Ralph PRD criterion amendments (evidence-preserving supersession)

Ralph's PRD freezes acceptance criteria at dispatch time. When implementation **empirically refutes** an active criterion (e.g. the dispatching brief says "all 16 files" but measurement finds 12), the criterion can stop governing ONLY through the evidence-preserving amendment path — never by silent deletion or by "satisfying" a falsified requirement.

Per story, `acceptanceCriteria` holds the currently governing criteria, and the optional `criterionAmendments` ledger retains every refuted original verbatim:

```jsonc
{
  "kind": "replaced", // or "superseded" (no replacement governs)
  "original": "All 16 files that set FDFT_WHALE_STREAM=1 are classified affected/not-affected WITH EVIDENCE",
  "replacement": "All 12 files that set FDFT_WHALE_STREAM=1 are classified affected/not-affected WITH EVIDENCE",
  "reason": "The brief count was wrong: 7 listed names are readers/asserters/doc-recipes, not setters",
  "evidence": "Enumerated setters via grep FDFT_WHALE_STREAM=1: 12 setters, 16 total matches",
  "authority": "ses_<ralph-session-id>",
  "timestamp": "2026-08-10T03:15:00.000Z"
}
```

Programmatic API (from `src/hooks/ralph`): `amendCriterion(dir, storyId, { original, replacement, reason, evidence, authority })` replaces an active criterion and inserts the corrected one at its position; `supersedeCriterion(dir, storyId, { original, reason, evidence, authority })` removes it with no replacement. Both require non-empty reason/authority and bounded evidence (`MIN_CRITERION_EVIDENCE_LENGTH = 10`); failures return closed error codes and never mutate the PRD.

Fail-closed invariants: a malformed ledger entry, an amended original that is still active, or an original amended twice makes the PRD invalid on read (`readPrd` → `null`), matching existing invalid-PRD startup behavior. Legacy PRDs without `criterionAmendments` still read and format normally, but a completion or architect-verification claim lacking its governing-criteria revision is reopened and requires current-criteria re-verification before it can progress. An empty `[]` ledger is treated as absent. Older builds that rewrite a PRD serialize only fields their own normalizer knows, so amendment records are only preserved by builds that ship this schema. See [ADR 03664](./adr/03664-ralph-prd-criterion-amendment.md) for the decision record.

## Named autopilot stage profiles (v1)

A named profile is selected only by `/oh-my-copilot:autopilot --workflow <name> <task>`; it is not a dynamic slash command, prompt alias, mode, plugin, filename, or independent state identity. Existing `/oh-my-copilot:autopilot <task>` behavior remains the legacy no-profile path.

Named profiles require Linux with the `flock` utility in v1. Their authenticated transcript boundary depends on Linux no-follow file-descriptor traversal and their recoverable mutation lock depends on kernel advisory locking; unsupported environments reject explicit `--workflow` activation before state mutation while legacy autopilot remains supported.

Configure profiles only in the user or project JSONC configuration under `autopilot.workflows`:

```jsonc
{
  "autopilot": {
    "workflows": {
      "plan-build-qa": {
        "version": 1,
        "stages": ["ralplan", "execution", "qa"]
      }
    }
  }
}
```

A v1 profile has exactly the required `version` (the number `1`) and `stages` keys. The name must match `^[a-z][a-z0-9-]{0,62}$`, must not collide with reserved stage/mode/legacy-alias names, and is metadata only. The only legal stage lists are:

```text
[ralplan, execution]
[ralplan, execution, ralph]
[ralplan, execution, qa]
[ralplan, execution, ralph, qa]
```

`ralplan` creates the canonical plan required by `execution`; `execution` creates the implemented workspace required by `ralph` and `qa`. Other lists, reordering, duplicates, and non-built-in stages are rejected. Each user and project source is validated before composition. Different names coexist; a same-name project profile replaces the entire user profile rather than deep-merging it. Environment configuration cannot define or replace a profile.

A successful selected run atomically initializes the existing session-scoped autopilot state with an immutable descriptor and selected-only pipeline tracking. The descriptor records the workflow name, profile version, canonical stages, and a deterministic lowercase SHA-256 hash of canonical JSON for `{descriptorVersion:1, workflowName, profileVersion:1, stages}`. It excludes task text, full config, model settings, and mutable progress. Resume and Stop recheck the hash; an invalid descriptor fails as `workflow_descriptor_integrity_failed`, without reloading live config or emitting a stage prompt.

Autopilot continues to own cancel, resume, cleanup, state inspection, HUD, and Stop continuation. Plugin and standalone-installed Stop hooks accept only an owner-session assistant completion record for the current stage after its persisted activation transcript boundary. Bounded, regular, session-bound transcript handling rejects stale, pre-activation, user, tool, local-command output, malformed, wrong-stage, wrong-session, and symlink evidence. A compare-before-write tracking revision guard makes duplicate or concurrent Stop handling advance exactly once. Public state, HUD, and Stop output expose only safe workflow metadata and progress; they do not disclose task text, private descriptor data, transcript paths, offsets, or evidence hashes.

V1 deliberately defers `stageModels` and all model/provider/role routing, inline/no-spawn execution, dynamic commands/modes/state files, arbitrary stages/prompts/plugins and control-flow extensions, and the separate custom-skill inline-array frontmatter parser mismatch. See [ADR 03487](./adr/03487-named-autopilot-stage-profiles.md) for the decision record.

## Skills (61 Total)

Includes bundled workflow, utility, domain, and compatibility skills. Runtime truth comes from the builtin skill loader scanning `skills/*/SKILL.md` and expanding aliases declared in frontmatter.

Marketplace/plugin installs compact the native plugin `skills/*/SKILL.md` files during `omg setup`: Claude Code receives concise registry descriptions for every bundled skill, while the full on-demand instructions are preserved under `skill-bodies/*/SKILL.md` and loaded by OMC when a skill is invoked. Source checkouts and standalone installs keep the full `skills/*/SKILL.md` bodies in place.



| Skill                     | Description                                                                    | Manual Command                              |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| `ai-slop-cleaner`         | Anti-slop cleanup workflow with optional reviewer-only `--review` pass        | `/oh-my-copilot:ai-slop-cleaner`         |
| `agent-doc-discipline`    | Writing-time discipline for agent-facing documents: checkable rules with a why, steps first, one meaning one home | `/oh-my-copilot:agent-doc-discipline` |
| `architecture-survey`     | Shipyard survey: report ranked architecture-deepening candidates with evidence, never edit code | `/oh-my-copilot:architecture-survey`     |
| `ask`                     | Ask Claude, Codex, Gemini, Antigravity, Grok, or Cursor via local CLI          | `/oh-my-copilot:ask`                     |
| `ask-navigator`           | Shipyard navigator: chart foggy efforts into decision-ticket maps, hand off to launch | `/oh-my-copilot:ask-navigator`    |
| `autopilot`               | Full autonomous execution from idea to working code                            | `/oh-my-copilot:autopilot`               |
| `autoresearch`            | Stateful evaluator-driven improvement loop                                     | `/oh-my-copilot:autoresearch`            |
| `cancel`                  | Unified cancellation for active modes                                          | `/oh-my-copilot:cancel`                  |
| `cancel-ralph`            | Deprecated compatibility alias for `cancel`                                   | `/oh-my-copilot:cancel-ralph`            |
| `configure-notifications` | Configure Telegram, Discord, and Slack notification integrations               | `/oh-my-copilot:configure-notifications` |
| `critique`                | Critique all unpushed commits before pushing to remote                          | `/oh-my-copilot:critique`                |
| `debug`                   | Diagnose the current OMC session or repository state                           | `/oh-my-copilot:debug`                   |
| `deep-interview`          | Socratic deep interview with ambiguity gating                                  | `/oh-my-copilot:deep-interview`                |
| `deep-review`             | Multi-pass code review with security, quality, structural analysis, and validation | `/oh-my-copilot:deep-review`         |
| `deepinit`                | Generate hierarchical AGENTS.md documentation                                  | `/oh-my-copilot:deepinit`                |
| `diagram`                 | Model-invoked visual explanations — smallest view (pseudocode, tree, Mermaid, diff) that carries the point | `/oh-my-copilot:diagram`                |
| `discover`                | Parallel specialist scan of the codebase producing a prioritized improvement backlog | `/oh-my-copilot:discover`          |
| `drydock`                 | Shipyard harness scaffold: 4-pillar shared environment, --check drift audit    | `/oh-my-copilot:drydock`                 |
| `execute`                 | Carry an approved task through to working, verified code                       | `/oh-my-copilot:execute`                |
| `external-context`        | Parallel document-specialist research                                          | `/oh-my-copilot:external-context`       |
| `graph`                   | Deterministic orchestration graph runtime: declarative DAG pipelines with journal-based crash recovery | `/oh-my-copilot:graph` |
| `harbor`                  | Shipyard intake gate: verify external issues and PRs, hand a signature docket  | `/oh-my-copilot:harbor`                  |
| `hud`                     | Configure HUD/statusline                                                        | `/oh-my-copilot:hud`                     |
| `intent`                  | Internal requirements intake for non-engineer contributors                      | `/oh-my-copilot:intent`                  |
| `launch`                  | Shipyard governed delivery pipeline: spec, tickets, frontier execution          | `/oh-my-copilot:launch`                  |
| `loft`                    | Shipyard shape-before-steel discipline: throwaway artifacts answer design questions | `/oh-my-copilot:loft`              |
| `map`                     | The yard's skill map: which skill owns which job, in delivery-loop order; routes, never executes | `/oh-my-copilot:map`                  |
| `minimal-code-discipline` | YAGNI-ladder writing-time discipline: reuse first, shortest correct diff        | `/oh-my-copilot:minimal-code-discipline` |
| `minimal-prose-discipline` | Writing-time discipline for the agent's own prose: protected core, no filler, close on the action | `/oh-my-copilot:minimal-prose-discipline` |
| `omc-ado-auto-review`     | Auto-review Azure DevOps PRs where you are an assigned reviewer                 | `/oh-my-copilot:omc-ado-auto-review`     |
| `omc-ado-review`          | Review Azure DevOps pull requests: diffs, reviewers, comments, votes, threads   | `/oh-my-copilot:omc-ado-review`          |
| `omc-ado-setup`           | Set up or troubleshoot the Azure DevOps integration (`.omg/config.json`)        | `/oh-my-copilot:omc-ado-setup`           |
| `omc-ado-sprint`          | Azure DevOps sprint planning: iterations, capacity, backlog grooming            | `/oh-my-copilot:omc-ado-sprint`          |
| `omc-ado-triage`          | Azure DevOps project health: work items, PRs, pipeline failures, security alerts | `/oh-my-copilot:omc-ado-triage`         |
| `omc-doctor`              | Diagnose and fix installation issues                                           | `/oh-my-copilot:omc-doctor`              |
| `omc-gh-auto-review`      | Auto-review GitHub PRs where you are a requested reviewer                       | `/oh-my-copilot:omc-gh-auto-review`      |
| `omc-gh-project`          | Manage GitHub Projects (v2) boards: items, status, iterations                   | `/oh-my-copilot:omc-gh-project`          |
| `omc-gh-review`           | Review GitHub pull requests: diffs, review comments, approve or request changes | `/oh-my-copilot:omc-gh-review`           |
| `omc-gh-setup`            | Set up or troubleshoot the GitHub integration (`.omg/config.json`)              | `/oh-my-copilot:omc-gh-setup`            |
| `omc-gh-triage`           | GitHub project health: open issues, PRs needing review, failing CI, security alerts | `/oh-my-copilot:omc-gh-triage`       |
| `omc-plan`                | Strategic planning with optional interview and consensus modes                 | `/oh-my-copilot:omc-plan`               |
| `omc-review`              | Evaluate finished work for defects, risk, and simplification                   | `/oh-my-copilot:omc-review`             |
| `omc-setup`               | Install or refresh OMC for plugin, npm, and local-development setups           | `/oh-my-copilot:omc-setup`              |
| `pr`                      | PR body assembly from OMC's paper trail: smallest visual, verify evidence, ADR-test reversibility | `/oh-my-copilot:pr` |
| `project-session-manager` | Manage isolated development environments (git worktrees + tmux)                | `/oh-my-copilot:project-session-manager` |
| `psm`                     | Deprecated compatibility alias for `project-session-manager`                    | `/oh-my-copilot:psm`                     |
| `ralph`                   | Persistence loop until verified completion                                     | `/oh-my-copilot:ralph`                   |
| `ralph-experiment`        | Hypothesis-driven experiment loop with notebook, git checkpoint/revert, and agent delegation | `/oh-my-copilot:ralph-experiment` |
| `ralplan`                 | Consensus planning entrypoint                                                   | `/oh-my-copilot:ralplan`                 |
| `release`                 | Automated release workflow                                                      | `/oh-my-copilot:release`                 |
| `refit`                   | Cross-session retrospective; instrument evidence to user-approved environment fixes | `/oh-my-copilot:refit` |
| `remember`                | Save and retrieve durable session memory                                        | `/oh-my-copilot:remember`                |
| `research`                | Investigate an open question and return grounded findings                       | `/oh-my-copilot:research`               |
| `self-improve`            | Autonomous evolutionary code improvement engine                                | `/oh-my-copilot:self-improve`           |
| `skill`                   | Manage local skills (list/add/remove/search/edit)                              | `/oh-my-copilot:skill`                   |
| `skillify`                | Extract a reusable skill from the current session                              | `/oh-my-copilot:skillify`                |
| `team`                    | Coordinated multi-agent workflow                                               | `/oh-my-copilot:team`                    |
| `tdd`                     | Test-first discipline at pre-agreed seams                                     | `/oh-my-copilot:tdd`                     |
| `trace`                   | Evidence-driven tracing lane with parallel tracer hypotheses                   | `/oh-my-copilot:trace`                  |
| `ultragoal`               | Durable multi-goal workflow with checkpointed artifacts                        | `/oh-my-copilot:ultragoal`              |
| `verify`                  | Verify that a change really works before claiming completion                    | `/oh-my-copilot:verify`                 |
| `visual-verdict`          | Structured visual QA verdict for screenshot/reference comparisons              | `/oh-my-copilot:visual-verdict`        |
| `wiki`                    | Persistent markdown knowledge base that compounds across sessions              | `/oh-my-copilot:wiki`                   |


---

## Slash Commands

Most installed skills are exposed as `/oh-my-copilot:<registered-name>`. The plugin ships 21 command files alongside the 61 skill entrypoints listed above; the commands below list both surfaces. Compatibility keyword modes like `deep-analyze` and `tdd` are prompt-triggered behaviors, not standalone slash commands. OMC's manual compaction helper is plugin-scoped as `/oh-my-copilot:compact`; bare `/compact` remains Claude Code's native command and is not shadowed by OMC. The helper preserves the user's note and instructs them to run bare `/compact`; OMC does not invoke native compaction itself because Claude Code's built-in `/compact` is not a prompt skill.

| Command                                                  | Description                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/oh-my-copilot:ai-slop-cleaner <target>`             | Run the anti-slop cleanup workflow (`--review` for reviewer-only pass)                        |
| `/oh-my-copilot:agent-doc-discipline`                 | Apply the writing-time discipline for agent-facing documents                                   |
| `/oh-my-copilot:ask <claude\|codex\|gemini\|antigravity\|grok\|cursor> <prompt>` | Route a prompt through the selected advisor CLI and capture an ask artifact                   |
| `/oh-my-copilot:architecture-survey [area]`           | Survey the repo for architecture-deepening candidates with evidence; reports only, never edits  |
| `/oh-my-copilot:ask-navigator <idea\|map>`            | Chart a foggy effort into a map of decision tickets (or work the open map), then hand off to launch |
| `/oh-my-copilot:autopilot <task>`                     | Full autonomous execution                                                                     |
| `/oh-my-copilot:autoresearch <task>`                  | Run a bounded evaluator-driven improvement mission                                             |
| `/oh-my-copilot:cancel [--force] [--all]`            | Cancel current-session modes; `--force` skips graceful waits, `--all` explicitly selects all sessions |
| `/oh-my-copilot:cancel-ralph [--force] [--all]`      | Deprecated alias with the same force/scope distinction                                         |
| `/oh-my-copilot:configure-notifications`              | Configure notification integrations                                                           |
| `/oh-my-copilot:compact [note]`                       | Prepare an OMC-safe manual handoff telling the user to run bare `/compact [note]`              |
| `/oh-my-copilot:debug`                                | Diagnose the current OMC session or repository state                                          |
| `/deep-interview <idea>`                                 | Socratic interview with ambiguity scoring before execution                                    |
| `/oh-my-copilot:deepinit [path]`                      | Index codebase with hierarchical AGENTS.md files                                              |
| `/oh-my-copilot:diagram`                              | Explain the current topic with the smallest visual that carries it                            |
| `/oh-my-copilot:execute <task>`                      | Carry an approved task through to working, verified code                                      |
| `/oh-my-copilot:external-context <topic>`             | Run parallel document-specialist research                                                     |
| `/oh-my-copilot:harbor [sweep\|look at #N\|what's ready?]` | Sweep external issues and PRs, verify claims, hand a signature docket                    |
| `/oh-my-copilot:hud [setup\|minimal\|focused\|full\|status]` | Configure HUD/statusline                                                               |
| `/oh-my-copilot:drydock [--check]`                   | Lay the shipyard harness keel in a repo (5 surfaces); --check audits drift                     |
| `/oh-my-copilot:launch <brief\|spec-path> [--serial]` | Run the shipyard governed delivery pipeline (spec -> tickets -> frontier)                      |
| `/oh-my-copilot:loft <design-question>`               | Loft the shape before cutting steel: a throwaway artifact answers a design question prose cannot settle |
| `/oh-my-copilot:minimal-code-discipline`              | Apply the YAGNI-ladder writing-time discipline while implementing                              |
| `/oh-my-copilot:minimal-prose-discipline`             | Apply the writing-time discipline for the agent's own prose                                    |
| `/oh-my-copilot:omc-doctor`                           | Diagnose and fix installation issues                                                          |
| `/oh-my-copilot:omc-plan <description>`               | Start planning session (supports consensus structured deliberation)                           |
| `/oh-my-copilot:omc-review [path]`                    | Review finished work for defects and risk                                                       |
| `/oh-my-copilot:omc-setup`                            | Install or refresh OMC                                                                        |
| `/oh-my-copilot:pr`                                   | Assemble a PR body from existing paper-trail evidence                                           |
| `/oh-my-copilot:project-session-manager <arguments>`  | Manage isolated dev environments with git worktrees + tmux                                    |
| `/oh-my-copilot:psm <arguments>`                      | Deprecated alias for project session manager                                                  |
| `/oh-my-copilot:ralph <task>`                         | Persistence loop until task completion (`--critic=architect \| critic \| codex`)             |
| `/oh-my-copilot:ralplan <description>`                | Iterative planning with consensus structured deliberation                                     |
| `/oh-my-copilot:release`                              | Automated release workflow                                                                    |
| `/oh-my-copilot:refit [--scope <area>] [--last <N sessions>]` | Retrospect on OMC instrumentation and propose user-approved environment fixes            |
| `/oh-my-copilot:remember <note>`                      | Save durable session memory                                                                   |
| `/oh-my-copilot:research <question>`                  | Investigate an open question and return grounded findings                                      |
| `/oh-my-copilot:self-improve <topic>`                 | Run the autonomous code-improvement workflow                                                   |
| `/oh-my-copilot:skill <action>`                       | Manage local skills                                                                           |
| `/oh-my-copilot:skillify`                             | Extract a reusable skill from the current session                                             |
| `/oh-my-copilot:team <N>:<agent> <task>`               | Coordinated native team workflow                                                              |
| `/oh-my-copilot:tdd`                                  | Test-first discipline at pre-agreed seams                                                     |
| `/oh-my-copilot:trace`                                | Evidence-driven tracing lane                                                                  |
| `/oh-my-copilot:ultragoal <condition>`                | Track a durable multi-goal workflow                                                           |
| `/oh-my-copilot:verify <target>`                      | Verify that a change really works before claiming completion                                  |
| `/oh-my-copilot:visual-verdict <task>`                | Structured visual QA verdict for screenshot/reference comparisons                             |
| `/oh-my-copilot:wiki <action>`                        | Query or update the persistent markdown knowledge base                                         |


### Skill Pipeline Metadata (Preview)

Built-in skills and slash-loaded skills can now declare a lightweight pipeline/handoff contract in frontmatter:

```yaml
pipeline: [deep-interview, plan, autopilot]
next-skill: plan
next-skill-args: --consensus --direct
handoff: .omg/specs/deep-interview-{slug}.md
```

When present, OMC appends a standardized **Skill Pipeline** section to the rendered skill prompt so the current stage, handoff artifact, and explicit next `Skill("oh-my-copilot:...")` invocation are carried forward consistently.

Pipeline metadata may use on-disk directory keys such as `plan`; invoke the registered workflow as `/oh-my-copilot:omc-plan` (and use `/oh-my-copilot:omc-review` for the review workflow).

### Skills 2.0 Compatibility (MVP)

OMC's canonical project-local skill directory remains `.omg/skills/`, and the runtime also reads Claude Code project skills from `.claude/skills/` plus compatibility skills from `.agents/skills/`.

For builtin and slash-loaded skills, OMC also appends a standardized **Skill Resources** section when the skill directory contains bundled assets such as helper scripts, templates, or support libraries. This helps agents reuse packaged skill resources instead of recreating them ad hoc.

---

## Claude Code `/goal` Adapter Design

OMC treats Claude Code `/goal` as a native execution loop that can be handed off to, not as the durable source of truth for OMC completion. The design contract is documented in [docs/design/CLAUDE_CODE_GOAL_ADAPTER.md](./design/CLAUDE_CODE_GOAL_ADAPTER.md).

Key contract points:

- Claude Code `/goal` facts must cite Claude Code or Anthropic sources only. OpenAI/Codex references are comparison sources, not authority for Claude Code behavior.
- The adapter renders a measurable `/goal <condition>` handoff; it must not mutate hidden Claude Code session state directly.
- The deterministic conflict policy is exactly one of `refuse`, `adopt_existing`, or `artifact_only`; competing Ralph/autopilot/Stop-hook/Team loops must not continue with only a warning.
- `/goal` evaluator success is evidence for OMC final review, not completion by itself; OMC still requires surfaced command/test/docs evidence.
- OMC stores durable goal ledgers and evidence under OMC-owned logical artifacts and `.omg/`-resolved paths, not hardcoded `.omx/` paths.

---

## Hooks System

OMC registers 21 hook scripts across 11 Claude Code lifecycle events. For detailed documentation, see [HOOKS.md](./HOOKS.md).

### Hooks by Lifecycle Event

| Event                  | Scripts                                                                                                           | Timeout                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **UserPromptSubmit**   | `keyword-detector.mjs`, `skill-injector.mjs`                                                                      | 30s outer fuse per command; 8s, 12s trusted Worker limits |
| **SessionStart**       | `session-start.mjs`, `project-memory-session.mjs`, `setup-init.mjs` (init), `setup-maintenance.mjs` (maintenance) | 5s, 5s, 30s, 60s |
| **PreToolUse**         | `pre-tool-enforcer.mjs`                                                                                           | 5s trusted Worker |
| **PermissionRequest**  | `permission-handler.mjs` (Bash only)                                                                              | 5s               |
| **PostToolUse**        | `post-tool-verifier.mjs`, `project-memory-posttool.mjs`, `post-tool-rules-injector.mjs`                          | 5s, 3s, 3s trusted Workers |
| **PostToolUseFailure** | `post-tool-use-failure.mjs`                                                                                       | 3s               |
| **SubagentStart**      | `subagent-tracker.mjs start`                                                                                      | 3s               |
| **SubagentStop**       | `subagent-tracker.mjs stop`, `verify-deliverables.mjs`                                                            | 5s, 5s           |
| **PreCompact**         | `pre-compact.mjs`, `project-memory-precompact.mjs`                                                                | 10s, 5s          |
| **Stop**               | `context-guard-stop.mjs`, `workflow-drift-guard.mjs`, `persistent-mode.mjs`, `code-simplifier.mjs`                | 5s, 3s, 10s, 5s  |
| **SessionEnd**         | `session-end.mjs`                                                                                                 | 30s              |

For each UserPromptSubmit command, 30s is the outer host fuse, including any launcher delay before `run.cjs`. Exact canonical targets use the trusted Worker branch only when their manifest event matches: the prompt hooks receive the 8s keyword-detector or 12s skill-injector execution caps, while the PreToolUse and PostToolUse hooks retain their manifest-derived inner budgets. Generic targets, untrusted paths, event mismatches, and invocations with extra arguments retain the isolated child-process path. A command that never starts the runner can take the entire 30s per-command fuse, and host scheduling does not imply an aggregate latency.

The `workflow-drift-guard` blocks only supported source-associated local selection forks with a known minimum of two live alternatives—including exact binary questions and cardinality templates; explicit open input and every unsupported or ambiguous form fail open.

> **Note**: autopilot and ralph are **skills** (activated via keyword-detector), not hooks. The `persistent-mode.mjs` hook enforces their continuation by blocking the Stop event. A fresh unconfirmed ultragoal does not enforce matching `/goal`; confirmed runs remain fail-closed.

### Code Simplifier Hook

The `code-simplifier` Stop hook automatically delegates recently modified source files to the
`code-simplifier` agent after each Claude turn. It is **disabled by default** and must be
explicitly enabled via the global OMC config file:

- Linux/Unix default: `${XDG_CONFIG_HOME:-~/.config}/omc/config.json`
- macOS/Windows legacy/default path: `~/.omg/config.json`
- Existing legacy `~/.omg/config.json` continues to be read as a fallback where applicable.

**Enable:**

```json
{
  "codeSimplifier": {
    "enabled": true
  }
}
```

**Full config options:**

```json
{
  "codeSimplifier": {
    "enabled": true,
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"],
    "maxFiles": 10
  }
}
```

| Option       | Type       | Default                                         | Description                        |
| ------------ | ---------- | ----------------------------------------------- | ---------------------------------- |
| `enabled`    | `boolean`  | `false`                                         | Opt-in to automatic simplification |
| `extensions` | `string[]` | `[".ts",".tsx",".js",".jsx",".py",".go",".rs"]` | File extensions to consider        |
| `maxFiles`   | `number`   | `10`                                            | Maximum files simplified per turn  |

**How it works:**

1. When Claude stops, the hook runs `git diff HEAD --name-only` to find modified files
2. If modified source files are found, the hook injects a message asking Claude to delegate to the `code-simplifier` agent
3. The agent simplifies the files for clarity and consistency without changing behavior
4. A turn-scoped marker prevents the hook from triggering more than once per turn cycle

---

## Magic Keywords

Use these trigger phrases in natural language prompts to activate enhanced modes:

| Keyword                                                                        | Effect                                                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `autopilot`, `build me`, `I want a`, `handle it all`, `end to end`, `e2e this` | Full autonomous execution                                                                     |
| `deslop`, `anti-slop`, cleanup/refactor + slop smells                          | Anti-slop cleanup workflow (`ai-slop-cleaner`)                                                |
| `ralph`, `don't stop`, `must complete`, `until done`                           | Persistence until verified complete                                                           |
| `ralplan`                                                                      | Iterative planning consensus with structured deliberation (`--deliberate` for high-risk mode) |
| `deep interview`, `ouroboros`                                                  | Deep Socratic interview with mathematical clarity gating                                      |
| `deepsearch`, `search the codebase`, `find in codebase`                        | Codebase-focused search mode                                                                  |
| `deepanalyze`, `deep-analyze`                                                  | Deep analysis mode                                                                            |
| `ultrathink`, `think hard`, `think deeply`                                     | Deep reasoning mode                                                                           |
| `tdd`, `test first`, `red green`                                               | TDD workflow enforcement                                                                      |
| `code review`, `review code`                                                   | Comprehensive code review mode                                                                |
| `security review`, `review security`                                           | Security-focused review mode                                                                  |
| `cancelomc`, `stopomc`                                                         | Unified cancellation                                                                          |

### Localized triggers (Korean / Japanese)

The keyword detector recognizes localized aliases in addition to the English trigger phrases above. Each alias maps to the same skill/mode as its English counterpart:

| Keyword          | Korean      | Japanese           |
| ---------------- | ----------- | ------------------ |
| `ralph`          | 랄프        | ラルフ             |
| `autopilot`      | 오토파일럿  | オートパイロット   |
| `ralplan`        | 랄플랜      | ラルプラン         |
| `ultrathink`     | 울트라씽크  | ウルトラシンク     |
| `deep-interview` | 딥인터뷰    | ディープインタビュー |
| `tdd`            | 테스트 퍼스트 | テスト ファースト |
| `code-review`    | 코드 리뷰   | コード レビュー    |
| `security-review`| 보안 리뷰   | セキュリティ レビュー |
| `deepsearch`     | 딥 서치     | ディープ サーチ    |
| `analyze`        | 딥 분석     | ディープ アナライズ |

`cancelomc` / `stopomc` have no localized alias (cancellation is matched only by the English tokens).

#### Localized routing behavior

- **Substring matching (aggressive routing).** Korean and Japanese have no ASCII word boundary, so localized aliases are matched as substrings rather than whole words. This is intentional: a localized alias embedded in a longer noun phrase still routes — e.g. `コードレビュー記事を要約して` ("summarize this code-review article") activates **code-review** mode. Prefer the English form, or phrase around the alias, if you do not want that behavior.
- **Reviewer-suffix guard.** `code-review` / `security-review` use a negative lookahead so "reviewer"-style nouns do not trigger review mode: `(?!어)` blocks Korean 리뷰어, and `(?!ア)` blocks any Japanese レビューア… form (e.g. レビューアー).
- **Informational suppression.** Help-style questions are suppressed and pass through without activating a mode — e.g. Korean `뭐야` / Japanese `とは` / `使い方` near an alias.
- **Difference questions.** Japanese "difference" phrasing — `…の違いを教えて`/`違いを説明`/`違いを知りたい` and `どう違う`/`何が違う`/`どこが違う` (e.g. `ディープサーチと普通の検索の違いを教えて`) — is treated as informational and suppressed. A work verb after `違い` (e.g. `違いを修正して`) is **not** suppressed and still activates.

### Examples

```bash
# In Claude Code:

# Enhanced search
deepsearch for files that import the utils module

# Deep analysis
deep-analyze why the tests are failing

# Autonomous execution
autopilot: build a todo app with React

# Parallel autonomous execution
team 3:executor "build a fullstack todo app"

# Persistence mode
ralph: refactor the authentication module

# Planning session
ralplan this feature

# TDD workflow
tdd: implement password validation

# Stop active orchestration
stopomc
```

---

## Platform Support

### Operating Systems

| Platform    | Install Method              | Hook Type      |
| ----------- | --------------------------- | -------------- |
| **Windows** | WSL2 recommended (see note) | Node.js (.mjs) |
| **macOS**   | Claude Code Plugin          | Bash (.sh)     |
| **Linux**   | Claude Code Plugin          | Bash (.sh)     |

> **Note**: Bash hooks are fully portable across macOS and Linux (no GNU-specific dependencies).

> **Windows**: Native Windows (win32) support is experimental. Features that launch tmux-backed worker panes require a tmux-compatible binary. OMC supports native [psmux](https://github.com/psmux/psmux) for PowerShell 7+ users who want visible Claude Code teammate panes in interactive team workflows, and recommends WSL2 as the fallback when no compatible `tmux` command is installed or native Windows behavior is insufficient. psmux does not force worktree agents, non-interactive/print-mode agents, or model-selected in-process agents into visible panes. Native Windows issues may have limited support.

> **Advanced**: Set `OMC_USE_NODE_HOOKS=1` to use Node.js hooks on macOS/Linux.

### Available Tools

| Tool          | Status       | Description           |
| ------------- | ------------ | --------------------- |
| **Read**      | ✅ Available | Read files            |
| **Write**     | ✅ Available | Create files          |
| **Edit**      | ✅ Available | Modify files          |
| **Bash**      | ✅ Available | Run shell commands    |
| **Glob**      | ✅ Available | Find files by pattern |
| **Grep**      | ✅ Available | Search file contents  |
| **WebSearch** | ✅ Available | Search the web        |
| **WebFetch**  | ✅ Available | Fetch web pages       |
| **Task**      | ✅ Available | Spawn subagents       |
| **TodoWrite** | ✅ Available | Track tasks           |

### LSP Tools (Real Implementation)

| Tool                        | Status         | Description                                 |
| --------------------------- | -------------- | ------------------------------------------- |
| `lsp_hover`                 | ✅ Implemented | Get type info and documentation at position |
| `lsp_goto_definition`       | ✅ Implemented | Jump to symbol definition                   |
| `lsp_find_references`       | ✅ Implemented | Find all usages of a symbol                 |
| `lsp_document_symbols`      | ✅ Implemented | Get file outline (functions, classes, etc.) |
| `lsp_workspace_symbols`     | ✅ Implemented | Search symbols across workspace             |
| `lsp_diagnostics`           | ✅ Implemented | Get errors, warnings, hints                 |
| `lsp_prepare_rename`        | ✅ Implemented | Check if rename is valid                    |
| `lsp_rename`                | ✅ Implemented | Rename symbol across project                |
| `lsp_code_actions`          | ✅ Implemented | Get available refactorings                  |
| `lsp_code_action_resolve`   | ✅ Implemented | Get details of a code action                |
| `lsp_servers`               | ✅ Implemented | List available language servers             |
| `lsp_diagnostics_directory` | ✅ Implemented | Project-level type checking                 |

> **Note**: LSP tools require language servers to be installed (typescript-language-server, ty, rust-analyzer, gopls, etc.). Use `lsp_servers` to check installation status.

### AST Tools (ast-grep Integration)

| Tool               | Status         | Description                                  |
| ------------------ | -------------- | -------------------------------------------- |
| `ast_grep_search`  | ✅ Implemented | Pattern-based code search using AST matching |
| `ast_grep_replace` | ✅ Implemented | Pattern-based code transformation            |

> **Note**: AST tools use [@ast-grep/napi](https://ast-grep.github.io/) for structural code matching. Supports meta-variables like `$VAR` (single node) and `$$$` (multiple nodes).

---

## Performance Monitoring

oh-my-copilot includes comprehensive monitoring for agent performance, token usage, and debugging parallel workflows.

For complete documentation, see **[Performance Monitoring Guide](./PERFORMANCE-MONITORING.md)**.

### Quick Overview

| Feature                   | Description                                           | Access                                 |
| ------------------------- | ----------------------------------------------------- | -------------------------------------- |
| **Agent Observatory**     | Real-time agent status, efficiency, bottlenecks       | HUD / API                              |
| **Session-End Summaries** | Persisted per-session summaries and callback payloads | `.omg/sessions/*.json`, `session-end`  |
| **Session Replay**        | Event timeline for post-session analysis              | `.omg/state/agent-replay-*.jsonl`      |
| **Session Search**        | Search prior local transcript/session artifacts       | `omg session search`, `session_search` |
| **Intervention System**   | Auto-detection of stale agents, cost overruns         | Automatic                              |

### CLI Commands

```bash
omg hud                              # Render the current HUD statusline
omg team status <team-name>          # Inspect a running team job
tail -20 .omg/state/agent-replay-*.jsonl
ls .omg/sessions/*.json
```

### HUD Presets

Enable a supported preset for agent and context visibility in your status line:

```json
{
  "omcHud": {
    "preset": "focused"
  }
}
```

### External Resources

- **[MarginLab.ai](https://marginlab.ai)** - SWE-Bench-Pro performance tracking with statistical significance testing for detecting Claude model degradation

---

## Troubleshooting

### Diagnose Installation Issues

```bash
/oh-my-copilot:omc-doctor
```

Checks for:

- Missing dependencies
- Configuration errors
- Hook installation status
- Agent availability
- Skill registration

From a shell, `omg doctor conflicts` checks for configuration conflicts. Among its checks:

- **Legacy `COPILOT_CONFIG_DIR`**: warns when it is set. OMC reads only `COPILOT_HOME`, Copilot CLI's own variable; rename it.
- **`node` on PATH**: every hook runs `node`, and under Copilot a PreToolUse hook that cannot start denies the tool call, so a missing `node` blocks every tool.

### Configure HUD Statusline

```bash
/oh-my-copilot:hud setup
```

Installs or repairs the HUD statusline for real-time status updates.

### HUD Configuration (settings.json)

Configure HUD elements in `~/.claude/settings.json`:

```json
{
  "omcHud": {
    "preset": "focused",
    "elements": {
      "cwd": true,
      "gitRepo": true,
      "gitBranch": true,
      "showTokens": true
    }
  }
}
```

| Element      | Description                                                                                                          | Default |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | ------- |
| `cwd`        | Show current working directory                                                                                       | `false` |
| `gitRepo`    | Show git repository name                                                                                             | `false` |
| `gitBranch`  | Show current git branch                                                                                              | `false` |
| `omcLabel`   | Show [OMC] label                                                                                                     | `true`  |
| `updateNotification` | Show available-update prompt text after the OMC label                                                                  | `true`  |
| `contextBar` | Show context window usage                                                                                            | `true`  |
| `agents`     | Show active agents count                                                                                             | `true`  |
| `todos`      | Show todo progress                                                                                                   | `true`  |
| `ralph`      | Show ralph loop status                                                                                               | `true`  |
| `autopilot`  | Show autopilot status                                                                                                | `true`  |
| `showTokens` | Show transcript-derived token usage (`tok:i1.2k/o340`, plus `r...` reasoning and `s...` session total when reliable) | `false` |

Additional `omcHud` layout and label options (top-level):

| Option     | Description                                                                       | Default    |
| ---------- | --------------------------------------------------------------------------------- | ---------- |
| `maxWidth` | Maximum HUD line width (terminal columns)                                         | unset      |
| `wrapMode` | `truncate` (ellipsis) or `wrap` (break at `\|` boundaries) when `maxWidth` is set | `truncate` |
| `locale`   | HUD label preset. Supported values: `en`, `zh-CN`                                 | `en`       |
| `labels`   | Per-label HUD text overrides; supported keys only                                 | unset      |

`locale` and `labels` affect only HUD labels. English remains the default, unsupported locale values and unknown label keys are ignored, and explicit `labels` override the locale preset. Supported label keys are `context`, `tokens`, `tool`, `agent`, `skill`, `ralph`, `background`, `thinking`, `staged`, `modified`, `untracked`, `ahead`, and `behind`.

Example:

```json
{
  "omcHud": {
    "locale": "zh-CN",
    "labels": {
      "context": "CTX"
    }
  }
}
```

Available presets: `minimal`, `focused`, `full`, `dense`, `analytics`, `opencode`

### Common Issues

| Issue                 | Solution                                                                         |
| --------------------- | -------------------------------------------------------------------------------- |
| Commands not found    | Re-run `/oh-my-copilot:omc-setup`                                             |
| Hooks not executing   | Check hook permissions: `chmod +x ~/.claude/hooks/**/*.sh`                       |
| Agents not delegating | Verify CLAUDE.md is loaded: check `./.claude/CLAUDE.md` or `~/.claude/CLAUDE.md` |
| LSP tools not working | Install language servers: `npm install -g typescript-language-server`            |
| Token limit errors    | Use `/oh-my-copilot:` for token-efficient execution                           |

### Auto-Update

Oh-my-copilot includes a silent auto-update system that checks for updates in the background.

Features:

- **Rate-limited**: Checks at most once every 24 hours
- **Concurrent-safe**: Lock file prevents simultaneous update attempts
- **Cross-platform**: Works on both macOS and Linux

To manually update, re-run the plugin install command or use Claude Code's built-in update mechanism.

### Uninstall

Use Claude Code's plugin management:

```
/plugin uninstall oh-my-copilot@oh-my-copilot
```

Or remove only files left by an older standalone OMC install:

```bash
# Leave Claude Code native commands untouched; OMC uses `omc-plan`/`omc-review`.
rm ~/.claude/agents/{architect,document-specialist,explore,designer,writer,vision,critic,analyst,executor,qa-tester}.md
rm ~/.claude/commands/{analyze,autopilot,deepsearch}.md
```

---

## Changelog

See [CHANGELOG.md](../CHANGELOG.md) for version history and release notes.

---

## License

MIT - see [LICENSE](../LICENSE)

## Credits

Inspired by [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) by code-yeongyu.
