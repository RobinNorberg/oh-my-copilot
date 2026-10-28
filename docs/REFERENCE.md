# Reference Documentation

Complete reference for oh-my-copilot. For quick start, see the main [README.md](../README.md).

For v5.12.1, the plugin ships 20 agents, 63 skills, 21 command files, and one configured MCP server exposing exactly 56 tools.

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
- [Skills (63 Total)](#skills-63-total)
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

#### Opt out of global CLAUDE.md management

If you maintain your own `~/.copilot/CLAUDE.md` and do not want installs or updates to merge the OMC block into it, set `claudeMdEnabled` to `false` in `~/.copilot/.omc-config.json`:

```json
{ "claudeMdEnabled": false }
```

- Default is `true`; only an explicit `false` opts out
- `omg install`, `omg update` and the global `/oh-my-copilot:omc-setup` step then leave `~/.copilot/CLAUDE.md` and `~/.copilot/CLAUDE-omc.md` untouched and log a skip line
- `omg doctor` reports missing OMC markers as informational (legacy-guide and marker-structure warnings remain); SessionStart omits CLAUDE.md from its drift check, while other component drift notices still apply
- A `CLAUDE-omc.md` left by an earlier preserve-mode install is still loaded by `omg` launch; delete it if you no longer want it
- Project-scoped setup (`--local`) is unaffected
- Removing the key (or setting it to `true`) restores the default merge behavior on the next install, update or setup

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
| `OMC_AFK_INCLUDE_USER_SETTINGS` | `0` | Set to `1` to load user-level settings and hooks in factory chain links and `omg ralph afk` on Claude Code (no effect on Copilot CLI links); see the AFK settings note below. |
| `OMC_BRIDGE_SCRIPT`        | _(auto-detected)_    | Path to the Python bridge script                                                                                                                                                                                                                                            |
| `OMC_PARALLEL_EXECUTION`   | `true`               | Enable/disable parallel agent execution                                                                                                                                                                                                                                     |
| `OMC_CODEX_DEFAULT_MODEL`  | _(provider default)_ | Default model for Codex CLI workers                                                                                                                                                                                                                                         |
| `OMC_GEMINI_DEFAULT_MODEL`       | _(provider default)_ | Default model for Gemini CLI workers                                                                                                                                                                                                                                    |
| `OMC_ANTIGRAVITY_DEFAULT_MODEL`  | _(provider default)_ | Default model for Antigravity CLI (`agy`) workers                                                                                                                                                                                                                       |
| `OMC_GROK_DEFAULT_MODEL`         | _(provider default)_ | Default model for Grok Build CLI workers                                                                                                                                                                                                                                |
| `OMC_LSP_TIMEOUT_MS`       | `15000`              | LSP timeout in positive whole milliseconds (maximum `2147483647`; invalid or out-of-range values use the default). Increase for large repos or slow language servers                                                                                                                                                                                            |
| `OMC_MIGRATE_LEGACY_STATE` | _(unset)_            | Set to `1` to enable one-shot legacy→session-scoped state migration on next read. See [Legacy state migration](#legacy-state-migration-omc_migrate_legacy_state) below.                                                                                                      |
| `OMC_DISABLE_MULTIREPO`    | _(unset)_            | Set to `1` to disable workspace-marker resolution and fall back to git-root + cwd resolution order. `OMC_STATE_DIR` is still honoured. See [Rollback / disable multi-repo](#rollback--disable-multi-repo-omc_disable_multirepo) below.                                       |
| `DISABLE_OMC`              | _(unset)_            | Set to `1` or `true` to disable all OMC hooks |
| `OMC_SKIP_HOOKS`           | _(unset)_            | Comma-separated list of hook names to skip                                                                                                                                                                                                                                  |
| `OMC_GIT_GUARDRAILS`       | _(unset)_            | `1` force-enables the destructive-git PreToolUse guard in any session; `0` always disables it (immediate exit, wins over everything). With the variable unset, the guard is on by default while an active unattended mode (ralph/autopilot/team/ultragoal) is detected.      |
| `OMC_BUDGET_GOVERNOR`      | _(unset)_            | `0` turns the [AI Credits budget](#omg-budget-ai-credits-budget) governor off: no ledger writes, hook messages, HUD element or team fan-out check. |
| `OMC_RUN_BUDGET_TOKENS`    | _(unset)_            | Opt-in session token budget for unattended modes. Ralph and autopilot compare spend at iteration/phase boundaries (via the `trace_summary` tool): warn at 90%, stop with a resumable budget report at 100%. Advisory today — the model reads the tool output.               |
| `OMC_STALE_RUN_HOURS`      | `2`                  | Stale-run watchdog threshold in hours. A SessionStart hook reports unattended-mode state files left `active: true` with no mtime progress for this long (the signature of a crashed run). Advisory only — the watchdog never mutates state or resumes runs.                |
| `OMC_HOST_LOAD_THRESHOLD` | _(dynamic)_ | CPU load threshold (1-minute average). Gate blocks operations when load exceeds this. Default: 80% of available cores. Zero is valid; empty, malformed, negative, or non-finite values use the default. |
| `OMC_FREE_MEMORY_THRESHOLD` | `256` | Free memory threshold in MB. Gate blocks operations when free memory falls below this. Zero is valid; empty, malformed, negative, fractional, or unsafe integer values use the default. |
| `OMC_MAX_SIBLING_SESSIONS` | `8` | Maximum concurrent OMC sessions before gating expensive operations. Zero is valid; empty, malformed, negative, fractional, or unsafe integer values use the default. |
| `OMC_HOST_LOAD_GATE_DISABLED` | _(unset)_ | Set to any value to disable the host load gate entirely. |
| `OMC_CHAIN_LINK` | _(set by the spawner)_ | Internal. The chain-link id of a Copilot factory link, set on the spawned `copilot` process by the factory listener or the SessionEnd worker. Do not set it yourself: SessionEnd only trusts it when it names a `host: "copilot"` ledger, and a finished link is a no-op. See [Factory chains on Copilot](#factory-chains-on-copilot). |

#### Headless factory and AFK settings

Factory chain links and `omg ralph afk` use Claude Code's `project,local` setting sources by default, so user-level settings and hooks do not run in these unattended sessions. Set `OMC_AFK_INCLUDE_USER_SETTINGS=1` in the environment that launches OMC to include the `user` source (`user,project,local`). Factory chains capture this choice in the initial link ledger and carry it through later links and recovery, so a recovering process's environment cannot change the chain's setting sources. This is opt-in because user-level settings may run arbitrary hooks in unattended sessions; enable it only when those hooks are trusted. Copilot CLI links have no setting-sources equivalent: they always load the user configuration, and the variable has no effect on them.

#### Host Load Gate

OMC monitors host resources (CPU load, free memory, concurrent sessions) to prevent resource exhaustion when multiple sessions are active. When thresholds are exceeded, expensive operations (browser launches, test runners, package installs) are gated with a back-off message.

**Behavior**:
- **Fail-open**: if metrics are unavailable, the gate allows operations immediately (never deadlocks)
- **Configurable thresholds**: set environment variables or override via code
- **Invalid environment values**: empty, malformed, negative, non-finite, or out-of-range thresholds use the documented defaults. Negative thresholds supplied through a code config override still disable that individual check.
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

- Project: `.copilot/omg.jsonc`
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

**Per-agent model overrides on Copilot.** Copilot CLI does not support the PreToolUse `updatedInput` rewrite Claude Code uses, so `omg setup` applies explicit `agents.<name>.model` overrides from your user config (`%APPDATA%\claude-omc\config.jsonc` on Windows, `~/.config/claude-omc/config.jsonc` elsewhere; project overrides in `.copilot/omg.jsonc` are not synced) another way: it writes `subagents.agents["oh-my-copilot:<name>"].model` into `$COPILOT_HOME/settings.json` (Copilot's own per-agent override, which beats the agent file). `oh-my-copilot:<name>` is the expected key, matching the runtime agent name, but it is unverified as a settings key; confirm with `/subagents`. Tier aliases (`opus`, `sonnet`, `haiku`, `fable`, any case) resolve to the first Copilot model of that tier in `src/config/copilot-models.json`; dashed Claude Code ids (`claude-sonnet-5-5`) are rewritten to Copilot's dotted form; the result is written only when it is in that file's `knownModels`, and setup prints a warning for each skipped value. The merge keeps every other settings key, writes `settings.json.bak` first, replaces the file atomically, and does nothing when the file already matches. Overrides removed from the config are not removed from `settings.json`. Without an override, each agent's model comes from the `models:` fallback list in the generated `copilot/agents/<name>.md`. Under Claude Code the override works as documented.

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
omg ask muse --agent-prompt critic --prompt "review this plan"
omg ask claude --agent-prompt executor --prompt "create an implementation plan"
```

- Provider matrix: `claude | codex | gemini | antigravity | grok | cursor | muse`
- Artifacts: `.omg/artifacts/ask/{provider}-{slug}-{timestamp}.md`
- Canonical env vars: `OMC_ASK_ADVISOR_SCRIPT`, `OMC_ASK_ORIGINAL_TASK`
- Phase-1 aliases (deprecated warning): `OMX_ASK_ADVISOR_SCRIPT`, `OMX_ASK_ORIGINAL_TASK`
- Skill entrypoint: `/oh-my-copilot:ask <claude|codex|gemini|antigravity|grok|cursor|muse> <prompt>` routes to this command
- Muse and Grok require CLI versions supporting `--prompt-file`; role prompts are passed through a private temporary file. Muse disables approval prompts while preserving its configured sandbox behavior.

### `omg team` (CLI runtime surface)

```bash
omg team 2:codex "review auth flow"
omg team status review-auth-flow
omg team status review-auth-flow --json
omg team status --json             # auto-resolves the team name when exactly one team is active
omg team shutdown review-auth-flow --force
omg team api claim-task --input '{"team_name":"auth-review","task_id":"1","worker":"worker-1"}' --json
```

Supported entrypoints: direct start (`omg team [N:agent] "<task>"`), `status`, `shutdown`, and `api`.

`team status [team-name] --json` prints the same status data as the human-readable
report (team/instance id, phase, workspace/worktree mode, worker list with worktree
metadata, SDK worker fields — provider liveness, state, turns, AI credits, legacy premium
requests — task counts, and leader guidance) as a single JSON document instead of
text, with `ok: false` when no team state is found. `--json` can appear before or
after the team name and is never mistaken for one; when the team name is omitted
and exactly one team is active, it is resolved automatically.

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

#### Headless SDK workers (`--transport sdk`, the default under Copilot CLI)

`omg team 2:copilot "<task>"` runs each copilot worker as a detached `omg team sdk-host` process that owns one `@github/copilot-sdk` session, with no pane and no multiplexer. It needs `@github/copilot-sdk` installed (`npm i -g @github/copilot-sdk --omit=optional --ignore-scripts`).

**Choosing the transport.** `--transport` takes `sdk`, `pane` (aliases `tmux`, `psmux`) or `auto`. Without the flag, `team.transport` in the project config decides, and without that `omg team` uses `auto`:

| Host signal | `auto` picks |
|---|---|
| Copilot CLI (`COPILOT_CLI` / `COPILOT_AGENT_SESSION_ID`) | `sdk` |
| Claude Code (`CLAUDE_CODE_ENTRYPOINT`) | `pane` |
| None (a plain terminal) | `pane` |

`auto` picks `sdk` only when the Copilot CLI host is positively detected. Elsewhere the fork still defaults to the copilot host for routing, but a plain terminal gets panes; pass `--transport sdk` there to run headless workers.

`auto` never fails a start the sdk transport would reject. It falls back to `pane` and prints the reason on stderr (`[omg team] transport auto: using pane workers, not sdk (<reason>)`) for `--auto-merge`, a non-copilot worker, an explicitly assigned reviewer-contract role, or `@github/copilot-sdk` not installed. An explicit `--transport sdk` still rejects those. Programmatic `startTeamV2` callers and the `omc team` job runner keep the `pane` default.

**Launch.** SDK hosts start concurrently, up to `team.sdk.launchConcurrency` at once (default 4, a positive integer; env `OMC_TEAM_SDK_LAUNCH_CONCURRENCY`; 1 restores serial launch). Each launch still waits for its own worker's task claim. A worker whose launch fails is a startup failure of that worker only. A launch whose cleanup cannot be verified stops further launches, lets the running ones finish, and rolls the team back. The start prints `[omg team] sdk workers launched: N in X ms` on stderr.

**In-process tools.** `team.sdk.inProcessTools: true` (env `OMC_TEAM_SDK_INPROCESS_TOOLS=1`/`true` or `0`/`false`; default `false`) runs the plugin MCP tools inside each sdk host instead of a `t` MCP server per worker. Tool names, schemas and results are unchanged. It saves one node process per worker, not start time; see [DEVELOPERS.md](./DEVELOPERS.md#sdk-in-process-tools).

**Status.** `omg team status --json` carries `transport` (`sdk` or `pane`) and, per sdk worker in `workers.sdk`, `host_pid`, `runtime_pid`, `session_id`, `attempt_id`, `state`, `updated_at`, `last_event_type`/`last_event_at`, `turns`, `queued`, `task_state`, `current_task_id`, `credits` (AI Credits) and `credits_final` (true once the runtime's `session.shutdown` total replaced the running sum), and the legacy `premium_requests` and `premium_requests_final`. A session file left by an earlier launch attempt is not reported.

**One team per leader session.** The `one_team_per_leader_session` guard counts an sdk team as live while any of its hosts is: its session file belongs to the worker's current launch attempt and is not `closed`/`failed`, and the host pid still has the process start identity recorded in the attempt's `provider-started.json`. A crashed host whose pid was reused does not block a new team.

**Worker commits at shutdown.** Workers often commit in their worktrees, and the sdk transport has no `--auto-merge`. `omg team shutdown` keeps a clean worker worktree whose HEAD has commits the leader HEAD does not contain, along with its `omc-team/<team>/<worker>` branch in named mode. The shutdown still succeeds and disposes the team state. stderr names each kept path, branch and commit count, and `omg team status <team> --json` then answers `ok: false` with a `preserved_worktrees` list. Merge or cherry-pick the commits, then `git worktree remove` the path. Untracked files under the worktree's `.omg/state/` are runtime state and never keep a worktree; anything else untracked, including `.omg/skills/`, `.omg/plans/` or `.omg/notepad.md`, does.

- **No allow-all.** The host answers every permission request. Writes are allowed only inside the worker's worktree and the team state root. Reads also allow the plugin root. MCP calls are allowed only to the plugin server.
- **The shell policy is a denylist, not a sandbox.** It rejects team control other than `team api`, `omg smoke`, `tmux`/`psmux` and `git push`, git aliases and includes (`git -c alias.*`, `--config-env`, `git config alias.*`) and `GIT_CONFIG_*` env overrides, plus `shell(<prefix>)` entries of `workerDenyTools`, including quoted spellings such as `"omg" team shutdown`. A command built indirectly (a script file, `Invoke-Expression`, an encoded command, a shell escape) is not caught. Treat the write-path check, the credit cap and the per-worker `COPILOT_HOME` as the boundaries. This holds for team workers, which are not OS-sandboxed. `copilot_run` jobs and `omg factory run` lanes add the OS sandbox: see [Sandboxed lanes](#sandboxed-lanes).
- **Sub-agent tools are removed**: `task`, `run_dynamic_workflow`, `dynamic_workflows_manage`, `write_agent`, `read_agent`, `list_agents`, `search_code_subagent` and the plugin's `host_smoke` and `copilot_run_*` tools.
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

### `omg ship`

The deterministic half of the `/oh-my-copilot:ship` workflow (executor lane → independent verifier lane → fix rounds by a fresh agent → housekeeping → merge-readiness). The skill runs the agent lanes; these commands record verdicts, do the mechanical steps, and refuse the unsafe ones. State: `.omg/state/ship/<pr>.json`, written under the state file lock, so a run survives restarts.

```bash
omg ship init 241 --implementer executor-1        # start a run; the implementer can never approve
omg ship verdict 241 --reviewer verifier-1 --sha <reviewed sha> --approve   # or --request-changes --notes "..."
omg ship prepare 241 --push                        # merge origin/<base>, checks, inventory LAST, plain push
omg ship gates 241 --watch                         # exit 0 green, 1 failed, 8 still pending (run again)
omg ship gates 241 --drive --detach                # watch until green or a real failure, outliving the session
omg ship merge 241                                 # refuses, or prints / runs the admin merge
omg ship status 241 --json
```

- **Phases:** `review` → `fix` (changes requested; up to `ship.maxFixRounds`, default 2, then `blocked`) → `prepare` (approved) → `gates` → `ready` → `merged`. A later changes-requested verdict reopens any non-terminal phase.
- **Merge rule (`gates`):** green only when every check outside `ship.advisoryChecks` (default `No Committed Build Artifacts`, `Authorize generated artifacts from base trust root`, and the Socket Security GitHub App checks `Socket Security: Pull Request Alerts` / `Socket Security: Project Report`) is `SUCCESS` or `SKIPPED`, every name in `ship.requiredChecks` has been reported (default: the 18 checks this repo's CI reports on a PR, including the late `needs:` jobs `Build`, `npm pack + install test` and `Copilot smoke (tier 2)`; a missing one is pending), and every Actions workflow run for the head sha (`gh run list --commit <head>`) has status `completed`. Pending: `PENDING`, `QUEUED`, `IN_PROGRESS`, `WAITING`, `REQUESTED`, `EXPECTED`. Any other state is failed. No required checks yet is pending, never green. The latest run of a workflow that completed with a conclusion other than `success` / `skipped` / `neutral` and reported no check (a startup failure) is failed. `gates` resolves the head (`headRefOid`) first, reads the checks and runs for it, and re-reads the head; a head that moved is pending. No checks and no workflow runs at all is pending with the reason `no-workflows-triggered` (a PR opened or pushed with the Actions `GITHUB_TOKEN` triggers no workflows: push from a PAT, or close and reopen the PR). A test (`src/ship/__tests__/workflow-checks.test.ts`) parses `.github/workflows/*.yml` and fails when the PR jobs (matrix names expanded like GitHub) differ from the default required + advisory lists; the tag-only `Create GitHub Release` and the external Socket checks are the documented exclusions.
- **Known-flaky failures:** for a failed Actions job, `gates` reads `gh run view --job <id> --log` and parses the vitest `FAIL` lines. When every failing test of every failed required check matches `.github/known-flaky-tests.json` as committed on the base branch (`git show origin/<base>:<file>`, never the PR head; `file` plus a required `title` substring, so a file-level collection error never matches) and the log shows no `Unhandled Errors`, no `Failed Suites` and no `##[error]` in a step without a failing test, the verdict is `flaky` and the output suggests `gh run rerun <id> --failed`. Analyses are matched to checks by job id. `--watch` reruns each such run once (the budget is recorded in the run state before the rerun is issued, and holds across invocations) once the run has no pending jobs; the same test failing again is a real failure. `--no-rerun` or `ship.autoRerunFlaky: false` turns the rerun off.
- **Watch window:** one `--watch` lasts `ship.watchTimeoutMinutes` (default 9, below the 10-minute cap of background watchers), polling every `ship.pollIntervalSeconds` (30). Exit 8 = still pending (also when the window ends while a flaky run's rerun or sibling jobs are still going): run the same command again.
- **Drive (`gates --drive`):** `--watch` without the watch window: it polls until green (exit 0) or a real failure (exit 1), never exit 8, with the same rerun budget, and stops as blocked (exit 1) after `--drive-max <hours>` (default 6). A transient GitHub error while reading the gates (5xx, GraphQL "Something went wrong") is retried at the next poll instead of stopping. Progress events go to `.omg/progress/ship-<pr>.log` (or `$OMG_PROGRESS_FILE`) under `agent=ship-<pr>`: `start`, a `heartbeat` at most every 5 minutes, and a terminal `done` / `fail` / `blocked` whose note names the next command. A single-driver lock `.omg/state/ship/<pr>.drive.json` refuses a second driver while the first lives. `--detach` runs the drive as a detached process (log `.omg/state/ship/<pr>.drive.log`) and prints the `omg progress watch --file <log> --until settled` command to arm; `--status` prints the lock and the last events, `--stop` ends the driver.
- **`prepare`:** refuses unless HEAD is the run's PR branch and contains the latest verdict's sha (`git merge-base --is-ancestor`); refuses a detached HEAD, the base/main branch, a dirty tree, staged changes in the index (`git diff --cached --quiet`), a merge/rebase/cherry-pick/revert in progress, and a base, branch or remote that is option-shaped or fails `git check-ref-format --branch`. Then `git remote get-url origin` (`insteadOf` applied) must name the PR's repository (`gh pr view --json url`) → `git fetch origin <base>` → `refs/remotes/origin/<base>` must equal GitHub's `baseRefOid` (all fail closed) → `git merge --no-ff --no-edit --no-verify <baseRefOid>`, by sha, so a local tag or branch named `origin/<base>` cannot shadow the base (a conflict only under `inventory/` is resolved with `git checkout --theirs -- inventory`; any other conflict stops for a fix lane) → `tsc --noEmit`, eslint on changed `src` files, the tests mapped from the diff (`X.test.ts` beside or in `__tests__/` next to each changed `src/**/X.ts`, changed tests, the skills suite for `skills/`), the generator `--verify` scripts for `skills/`, `agents/`, `hooks/` → `scripts/generate-inventory-graph.mjs --write` + `--verify` as the last commit (`git commit --no-verify -m <msg> -- inventory`, so a file another lane stages during the checks stays out; a failing `git add -- inventory` stops it) → `--push` (plain, to `refs/heads/<run's branch>`). Every engine merge and commit runs with `--no-verify`, so `pre-commit`, `pre-merge-commit` and `commit-msg` hooks never shape it. The commits it makes are recorded as housekeeping.
- **`merge`:** refuses unless the PR is open, not a draft, on the run's base, the gates are green, the state passes its integrity check, and the latest verdict is an approval from someone other than the implementer whose reviewed sha is the head or is followed only by housekeeping commits (`git rev-list --first-parent --parents <reviewed>..<head>`: the chain leads from the head back to the reviewed sha, every commit on it is one `prepare` recorded, every recorded merge has two parents, the second the current `baseRefOid` or its ancestor, and every recorded commit is inventory-only by content: a one-parent commit changes nothing outside `inventory/` against its parent (`git diff --name-only --no-renames -z <parent> <commit>`), a merge differs from the tree `git merge-tree --write-tree <parent1> <parent2>` rebuilds (the first stdout line, a tree even on a conflict) only under `inventory/`, and a merge is refused outright while any `merge.<name>.driver` is configured (`git config --get-regexp '^merge\..*\.driver$'`); anything else, including a git read that fails, needs a new verdict), and the PR's changed files touch none of `.copilot/omg.jsonc`, `.copilot/omc.jsonc`, `.github/known-flaky-tests.json` (or the configured `knownFlakyFile`) and `.github/workflows/` unless `OMG_SHIP_HUMAN=1`. The changed files are computed locally between GitHub's base and head shas (`git diff --name-only --no-renames -z <baseRefOid>...<headRefOid>`, replace refs off; unreadable = refused): a rename lists its old path too, non-ASCII paths are not quoted, and `gh pr diff`'s 300-file cap no longer applies. It also refuses when `git fetch origin <base>` fails or `refs/remotes/origin/<base>` differs from GitHub's `baseRefOid`. Then it prints `gh pr merge <pr> --admin --merge --match-head-commit <head>`, or runs it only when the owner set `ship.allowAdminMerge: true` and the base is in `ship.trustedBases` (there is no CLI flag for it).
- **Base from GitHub:** `init`, `prepare`, `gates` and `merge` take the base, `baseRefOid`, `headRefOid` and the PR's repository `url` from `gh pr view`; before any fetch of the base, `git remote get-url origin` must name that repository (`gates` warns and uses the defaults on a mismatch, `prepare` and `merge` refuse). `prepare` also refuses a PR whose base on GitHub differs from the run's. `init --base` must equal the PR's base on GitHub when `gh` answers (retarget the PR instead); `gates` warns when the run's recorded base differs.
- **Known limits:** a lane with write access to `.git/objects` can forge loose objects (git trusts its object store, so content behind a correct sha is not re-verified); environment and `PATH` overrides are advisory (see the trust model); `gh` resolves the repository from the checkout's remotes, so the remote check catches `origin` pointing away from the repository `gh` reports, not a checkout whose every remote and `gh` default were repointed; engine commits are checked by content, not trusted by provenance: `--no-verify` skips the commit hooks, but `post-commit` / `post-merge` hooks and custom merge drivers still run in the engine's git, so `merge` rejects any recorded commit whose content goes beyond `inventory/` (see above) rather than trusting that `prepare` made it.
- **`init --force`:** replaces a non-terminal run and keeps the old one in `previousRuns`. A run with verdicts (now or in a replaced run) keeps its implementer, `fixRounds` and `maxFixRounds`; a different `--implementer` is refused. Replacing a `blocked` or `merged` run, a state that fails its integrity check, or resetting a reviewed run needs `OMG_SHIP_HUMAN=1` (owner-only; lane briefs forbid it). `history` and `previousRuns` entries are shape-checked on read.
- **Trust model:** implementer/reviewer names, `OMG_SHIP_HUMAN` and every other environment input are advisory against a hostile lane (a process that controls the environment can set them or put another `git` first on `PATH`). Engine children run with a scrubbed environment: every `GIT_*` variable except commit identity, `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT` and `GIT_SSL_CAINFO` / `GIT_SSL_CAPATH` is dropped (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*` / `GIT_CONFIG_PARAMETERS`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_EXEC_PATH`, `GIT_SSH_COMMAND`, ...), `GH_REPO` / `GH_HOST` are dropped, `GH_TOKEN` / `GITHUB_TOKEN` pass through for authentication, and `GIT_NO_REPLACE_OBJECTS=1` is set. The state file is not tamper-proof: every engine write stores a sha256 over the state in `integrity`, and later updates and `merge` refuse a mismatch, which catches hand edits but not someone who recomputes the hash. `verdict --sha` must be hex.
- **Safety guard (allowlist):** every command the engine spawns must match one of the exact shapes the engine builds: `git rev-parse|check-ref-format|status|remote get-url <remote>|fetch|merge-base|merge --no-ff --no-edit <sha40>|diff|checkout --theirs -- inventory|add -- inventory|commit|push <remote> HEAD:refs/heads/<branch>|cat-file|rev-list|log|show`, `git show <base sha>:<repo path>`, `git rev-parse --verify refs/remotes/<remote>/<branch>`, `git diff --name-only --no-renames -z <sha>...<sha>`, `gh pr view|checks|merge <pr> --admin --merge --match-head-commit <sha>`, `gh run view|list|rerun <id> --failed`, and the node repo scripts (`tsc`, `eslint`, `vitest run`, the generators). Everything else is refused before it spawns, including global options before the subcommand (`-c`, `--config-env`, `--namespace`, `gh -R`), option-shaped operands (`--upload-pack=…`), reads by ref name (a tag `origin/dev` would shadow the remote-tracking ref), any extra environment except `GIT_NO_REPLACE_OBJECTS=1` on git, forced or deleting refspecs, a push to `main` / `master` / `dev` or the run's base (case-insensitive), `--auto`, `--delete-branch`, `gh api`, `.cmd` shims and every npm command.
- **Config** (key `ship`, owner-edited): `base`, `advisoryChecks`, `requiredChecks`, `knownFlakyFile`, `maxFixRounds`, `allowAdminMerge`, `autoRerunFlaky`, `pollIntervalSeconds`, `watchTimeoutMinutes`, `trustedBases`. Ill-typed values are an error, not ignored. The safety keys `allowAdminMerge`, `advisoryChecks`, `requiredChecks` and `knownFlakyFile` come only from the user config at its default location, then `.copilot/omg.jsonc` as committed on the PR's base branch, then the defaults; the same keys in the working-tree project file (which a lane can drop in untracked) or the PR head are ignored with a warning. The default user-config location is derived from the account's home as the OS reports it (`os.userInfo()`): `<home>/.config/claude-omc/config.jsonc`, on Windows `<home>/AppData/Roaming/claude-omc/config.jsonc`; when `XDG_CONFIG_HOME` / `APPDATA` select another file, its safety keys are ignored with a warning. The base layer is read only for a base in `ship.trustedBases` (user config only; default `dev`, `main`, `master`), after `git fetch origin <base>` and a check that `refs/remotes/origin/<base>` equals GitHub's `baseRefOid`, as `git show <baseRefOid>:.copilot/omg.jsonc` with `GIT_NO_REPLACE_OBJECTS=1`; when the check fails `gates` warns and uses the defaults, `merge` refuses. A base-branch file that is not valid JSONC, or whose `ship` is not an object, is an error. The legacy `.copilot/omc.jsonc` name is never read from the base; a working-tree file under that name gets a single warning. The other keys use defaults < base-branch file < user config < working-tree file. `knownFlakyFile` must be a repo-relative path. The default `requiredChecks` are what a PR to `dev` reports: `ci.yml` and `upgrade-test.yml` filter on `pull_request.branches: [main, dev]`, so on a PR to another base those checks stay pending until the user config lists that base's checks.

### `omg release`

Maintainer-only release pipeline as ordered, resumable phases. The prose (`CHANGELOG.md` with the `# oh-my-copilot vX.Y.Z` H1 and the `## [X.Y.Z]` section, `.github/release-body.md`) is written first; the script checks it and does the rest. Run it on `release/vX.Y.Z` branched from `origin/dev`.

```bash
omg release 5.13.0 --dry-run                # print the plan, run nothing
omg release 5.13.0 --to suite --suite full --baseline last-good.json   # release commit + full suite, no AI credits
omg release 5.13.0 --live-smoke             # resume at smoke (two prompts, about 0.6 AI credits): pr, promote, tag (confirms), verify
omg release 5.13.0 --from verify --json
omg release 5.13.0 --drive --detach --yes   # drive pr .. verify to a terminal state in a detached process
omg release 5.13.0 --status                 # the driver, the last progress events, the phase table
omg release 5.13.0 --flaky-candidates       # known-flaky candidates of the full-suite triage, for owner approval
```

- **Phases:** `preflight` (clean tree apart from the release prose files, on `release/vX.Y.Z` containing `origin/dev`, version above `origin/dev`'s and npm's `latest`, `gh auth status`, no `.git/index.lock` (the holder is reported, the lock is never deleted), tag absent on origin) → `bump` (refuses without the prose, then `npm version --no-git-tag-version --ignore-scripts`, the version stamps of `scripts/sync-version.sh` plus `CLAUDE.md`, `.github/CLAUDE.md`, the prompt-projection golden fixture and `.github/upstream-port.json`, then the prompt projections) → `build` (`npm run build`, `git add -f dist bridge`, tracked dist outputs without a `src` source fail unless `--fix-orphans` removes them, no untracked dist/bridge files, probes: import `dist/index.js`, `--version` of `dist/cli/index.js` and `bridge/cli.cjs`, the standalone MCP server starts and exits) → `gates` (`tsc --noEmit`, `eslint src` (0 errors, warnings allowed, the scope of CI's Lint job), `verify:prompt-projections`, the copilot hook/agent generators `--verify`, `scripts/ci/check-multirepo-paths.mjs`) → `commit` (`chore(release): vX.Y.Z`, then the inventory regenerated last and committed if changed, `--verify`, clean tree) → `suite` (after the commit, because some tests read committed state: `--suite targeted` (vitest related to `src` changed since the last `v*` tag) or `--suite full` (JSON report under `.omg/release/`, failing only on titles absent from `--baseline`, a vitest JSON report or one `<file> > <title>` per line, after the flake triage below); `--suite none` records the phase as skipped with a warning) → `smoke` (live `smoke copilot --tier 2 --json` only with `--live-smoke` or `--force-smoke`, else skipped with a warning that the tag confirmation repeats; a green smoke with the same input hash is reused, see below) → `pr` (plain push, PR to `dev`, reused when one exists; refuses a skipped smoke unless `--allow-skipped-smoke` is given) → `promote` (PR `dev` → `main`) → `tag` (annotated `vX.Y.Z` on main's merge commit; `vX.Y.Z^{}` must equal it locally and on origin after the push; `--yes` or an interactive confirmation) → `verify` (the `ci.yml` push run whose `headBranch` is the tag, the `Copilot smoke (tier 2)` job, `npm view <pkg>@X.Y.Z version dist-tags.latest dist.attestations`, `gh release view`).
- **CI gate and merge (`pr`, `promote`):** the `omg ship gates` engine and config (`ship.advisoryChecks`, `ship.requiredChecks`, known-flaky list, from the user config and the base's committed `.copilot/omg.jsonc`). Each failed workflow run is rerun once (`gh run rerun <id> --failed`, budget recorded in the state); a second failure stops with the failing test titles from the job logs. The merge is `gh pr merge <pr> --admin --merge --match-head-commit <head>`, run only with `ship.allowAdminMerge` and a base in `ship.trustedBases`; otherwise the phase is blocked and prints it for you to run, and the next run picks the merge up. A transient GitHub error on the merge (5xx, GraphQL "Something went wrong") is retried twice with backoff; a policy or conflict refusal is not. Before reading any check, the `pr` phase waits (every 5 s, up to 3 min) until the PR's `headRefOid` is the pushed local HEAD, and every verdict re-reads the head: a verdict read while the head moved is pending, and only workflow runs whose `headSha` is the current head count, so a previous head's failed runs are never rerun or reported. `verify` reruns a failed tag run once the same way.
- **State and resume:** `.omg/release/<version>.json` records each phase's status, note and details plus the PR numbers, main merge sha and tag run id. Without `--from` a run resumes at the first phase not yet ok; `--from <phase>` re-runs from there and voids the records of every later phase; `--to <phase>` stops after it. `--suite` and `--baseline` are recorded for the release: a later run without them reuses the recorded values, a lower `--suite` is refused, and raising it after the suite ran lower blocks `pr` until `--from suite` runs it at the new level. After a fix commit, re-run with `--from build --to suite`. The suite and the live smoke fail when they leave files in the working tree, and skipping past `commit` needs a clean tree. `--timeout <minutes>` (default 60) bounds the CI waits of one run; a blocked wait says to re-run.
- **Smoke reuse:** a green live smoke records `lastSmoke` (`inputHash`, `headSha`, `at`) at the top level of the state, outside `phases`, so voiding the smoke record keeps it. The input hash is sha256 over `<path> <object id>` lines for HEAD's `dist`, `bridge`, `hooks`, `agents`, `skills`, `commands`, `copilot`, `scripts`, `templates`, `.claude-plugin`, `.mcp.json`, `plugin.json`, `package.json` and `package-lock.json` (`git rev-parse HEAD:<path>`; an absent path counts as absent). A smoke phase whose hash equals `lastSmoke.inputHash` is `ok` without a run and without `--live-smoke`, with the note `reused the green Tier 2 smoke of <sha> run at <time> (inputs identical, hash <hash>, Copilot CLI <version>)` and the full hash in its details, so `pr` needs no `--allow-skipped-smoke` after a test-only `--from build` or `--from suite`. A changed hash runs the smoke again (with `--live-smoke`; without it the skip names the change). `--force-smoke` always runs it and implies `--live-smoke`. A red smoke drops `lastSmoke`.
- **Flake triage (`--suite full`):** each failing title not in the baseline is rerun alone, `--triage-runs <n>` times (default 3), sequentially with the suite environment and a per-rerun timeout (`--triage-timeout <min>`, default 5; a timeout is a failed rerun): `vitest run <file> --testNamePattern=<escaped title> --reporter=json`, passing only when vitest exits 0 and the report says the test passed. More than 20 new titles fail at once without triage. A title that fails every isolated rerun, or a file-level collection error, is `real`: the phase fails. One that fails some reruns is `mixed`: the phase is blocked, since it may be a real race. One that passes every rerun is `load-flaky`: the phase passes with a warning. Each title emits a `heartbeat` progress event with its class, and the results are recorded as `suiteTriage` (a re-run on the same HEAD reuses them). Load-flaky and mixed titles are written to `.omg/release/<v>-flaky-candidates.json` as `.github/known-flaky-tests.json` entries (`file`, `title`, `note`) plus `evidence`; the engine never edits or commits `.github/known-flaky-tests.json`, and adding an entry needs the owner's approval. The `done` event notes how many candidates await approval; `--flaky-candidates` prints them ready to paste and runs nothing.
- **Drive (`--drive`):** the run continues until done, a real failure or a decision only you can make. A CI wait that outlives `--timeout` (in `pr`, `promote`, `verify`), or a transient GitHub error from a `gh` call (5xx, GraphQL "Something went wrong", also after the merge's own two retries), ends the run as pending: the waiting phase keeps no record, and the run is resumed after one minute (resume semantics re-check every skipped phase). `--drive-max <hours>` (default 6) turns an endless wait into `blocked`. A drive never prompts: the `tag` phase without `--yes` is blocked ("needs confirmation") and drive never implies `--yes`; the merge rule is unchanged. Heartbeats are written at most every 5 minutes. A single-driver lock `.omg/release/<v>.drive.json` (`pid`, `startedAt`, `argv`, `host`, process start identity) refuses a second driver while the first lives and is taken over when its pid is dead or reused. `--detach` re-spawns the same command with `--drive` as a detached `node` process (outside the session's job object, so it outlives the session; log `.omg/release/<v>.drive.log`) and prints the Monitor command `omg progress watch --file <progress log> --until settled --stall 30m`. `--status` prints the lock, the last 5 events and the phase table; `--stop` kills the driver's process tree (only when its start identity matches the lock), removes the lock and writes a `blocked` event. After a session restart run `--status`: re-arm the Monitor when the driver lives, else `--drive --detach` again.
- **Progress:** one line per phase start / end and per CI poll, `<ISO-UTC> phase=<id> status=<start|ok|fail|blocked|heartbeat|done> note=<..>`, to `$OMG_PROGRESS_FILE` or `.omg/progress/release.log`.
- Exit codes: `0` ok, `1` a phase failed or is blocked, `2` usage error. `--json` prints the phase results (or the plan with `--dry-run`).

### `omg port drive`

Maintainer-only automated upstream port. Run it in a clean checkout of `dev` after `git fetch upstream dev`; it works on `port/upstream-<short sha>`.

```bash
omg port drive --head <upstream sha>                         # apply, gates, commit, push, draft PR
omg port drive --head <sha> --reconcile-lane --max-credits 40  # conflicts: run the brief as a paid write lane
omg port drive --head <sha> --continue                       # after a human resolved what blocked the run
```

- **Phases:** `preflight` (clean tracked tree; creates `port/upstream-<short>`, refuses an existing one without `--continue`) → `apply` (`scripts/port/upstream-drift.mjs --apply --head <sha>`, then `--report`) → `junk` (unstages known upstream junk such as a committed `.gjc/` session dir; the drift script already drops it from the range) → `delta` (`--package-delta`: a `version`-only change is ignored; any `scripts`, `files`, dependency, `bin`, `exports` or other key change is listed in `.omg/port/<short>/package-delta.json` for a human) → `reconcile` (conflicts: writes `.omg/port/<short>/brief.md` with the conflict list, the THEIRS-for-our-returning-fixes rule and the runbook's "Fork Features to Preserve"; only with `--reconcile-lane` it starts one write lane through the factory LaneBackend at the pre-port commit, capped by the mandatory `--max-credits`, `--lane-timeout` minutes (default 60); a lane still running at the timeout is cancelled, and nothing is read until the cancel confirms its end. The shared git state (refs, common and global git config with its includes, `hooks/`, `info/`, worktree entries, the main checkout's status), the main index (`git ls-files -s`) and its assume-unchanged and skip-worktree flags (`git ls-files -v`), a content hash of every tracked, applied and conflicted file of the main checkout (read from disk, not through git's stat cache), and the gates' node_modules entry files (`package.json` and the bin file of typescript, eslint and vitest) are snapshotted before the lane and compared after it, and any difference parks the run with no commit and no push. The lane's tree may differ from the pre-lane index only on the conflicted paths, only as regular files (a symlink or gitlink blocks), never on a protected one (ship's protected paths, the drift script's excluded and skipped paths, `scripts/ci`, `scripts/port`, `scripts/copilot`, the generators, eslint and vitest config, `.gitattributes`, the port engine). Only those paths are adopted, proven equal to the lane tree; a lane that left conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in any changed file, or no commit, blocks) → `gates` (`tsc --noEmit`, `eslint src` (0 errors), `scripts/ci/check-multirepo-paths.mjs`, prompt projections and copilot hook/agent generators `--verify`, vitest on the tests selected from the staged files) → `commit` (the port commit, then the inventory regenerated as the last commit) → `pr` (plain push to `port/upstream-<short>`, `gh pr create --draft --base dev`; `--no-push` stops after the commits).
- **Human gates** (stop `blocked` with the next command): a package.json delta beyond `version`; conflicts without `--reconcile-lane`; any conflict under `src/release/`, `src/ship/`, `src/installer/` or `src/hooks/permission-handler/` (no lane is started); new `oh-my-claudecode` lines in `src agents skills hooks` (leak sweep; `--accept-leaks <upstream head sha>` accepts that head's lines and records them in `.omg/port/<short>/accepted-leaks.json`, the port commit and the PR body). The merge of the draft PR is always human. The lane is started only when nothing else would block the run, so no credits are spent on a run that stops anyway.
- **Resume:** fix, stage, then `--continue` on the port branch: apply is skipped, the delta check is skipped once it ran (it reruns when the run stopped before it), and conflicts, leaks and unstaged files are re-checked. When the port commit already exists (inventory, push or `gh pr create` failed), `--continue` resumes at that step.
- **Host git:** every engine git command is an allowlisted shape run with an empty `core.hooksPath`, `core.fsmonitor=false`, no pager, no external diff or textconv, and every configured filter driver blanked; the drift script and the inventory generator get the same hooks and fsmonitor settings. The drift script's `git apply --3way` still runs the merge drivers and filters your own git config defines, and upstream's committed `.gitattributes` can name them for upstream paths: review your configured `merge.*.driver` and `filter.*` entries before a port.
- **Trust:** the gates (tsc, eslint, the generators, vitest on the touched tests) execute upstream code and, after a reconcile lane, lane-authored code on the host, with your credentials. The path rules keep the lane's tree off the gate scripts and their config; the content hash of every tracked file of the main checkout is what catches a lane that rewrites them (or any other tracked file) in place, and the tamper check also covers the node_modules package.json and entry files of typescript, eslint and vitest. The conflicted source and test files the lane resolved still run, and so does every other node_modules file the gates load (a lane worktree that reaches node_modules through a junction can rewrite them). Review the lane's diff before you trust a green gate run from it.
- **Residual risk:**
  - Ignored files are only partly covered: `node_modules` beyond the hashed gate entry files is not hashed, and a planted nested `node_modules` can shadow imports.
  - A process that outlives the lane can rewrite files after the tamper check and before the gates, because the lane runs with an unrestricted shell until sandboxed lanes cover the reconcile lane.
  - Mitigation: only conflicted, non-protected paths are committed, the push opens a DRAFT PR, and CI re-runs every gate. The merge is always human.
- **Progress:** `agent=port` lines to `--progress-file`, `$OMG_PROGRESS_FILE` or `.omg/progress/port.log`; the run ends with `phase=report status=<done|blocked|fail>`.
- Exit codes: `0` done, `1` a phase failed, `2` usage error, `3` blocked on a human. `--json` prints the result.

### `omg progress`

Agent progress events: lanes push one line per phase boundary, and a lead watches them (Claude Code's Monitor tool) instead of polling agents. Lead recipe and brief snippet: `.omc/skills/agent-progress-events.md`. Library: `src/lib/agent-progress.ts` (`emitProgress({ phase, status, note, agent, file })`, never throws).

```bash
omg progress emit build start --note "tsc + tests" --agent lane-1 --file <dir>/lane-1.log
omg progress emit build ok --agent lane-1 --file <dir>/lane-1.log --field pr=42
omg progress watch --dir <dir> --agents lane-1,lane-2 --stall 10m   # stream new events + status=stalled; exits when all are done
omg progress watch --dir <dir> --once           # report failed / blocked / stalled agents and exit
omg progress status --dir <dir> --json          # latest event and state per agent
```

- **Line format** (one event per line, append-only, UTF-8): `<ISO-8601 UTC> phase=<id> status=<status> [note=<v>] [agent=<v>] [k=v ...]`. Writers use `start`, `ok`, `fail`, `blocked`, `heartbeat`, `done`; readers synthesize `stalled`. A value made only of `A-Z a-z 0-9 . _ : / @ + , % # ~ -` is written bare; anything else is double-quoted with `\\`, `\"`, `\n`, `\r`, `\t` escaped, so a note never breaks the line. Keys are `[A-Za-z][A-Za-z0-9_.-]*`. Lines that do not parse are skipped. Key=value text is the one canonical form (grep-able, `echo`-able by an agent without `omg`); there is no JSON variant.
- **Location:** `--file`, else `$OMG_PROGRESS_FILE`, else `<state root>/progress/<agent>.log` (`.omg/progress/` or `$OMC_STATE_DIR/<project>/progress/`). The agent is `--agent`, else `$OMG_PROGRESS_AGENT`, else `agent`; a line without `agent=` belongs to its file's basename. Notes are cut at 500 code points, phases and extra values at 200; a log over 1 MiB is renamed to `<file>.1` before the next append (best effort under concurrent writers: a writer that loses the race puts the fresh log back, so lines may reorder but are kept).
- **States:** the latest event per agent decides: `done` → done, `fail` → failed, `blocked` → blocked (reported at once), `start` / `heartbeat` / `ok` older than `--stall` (default `10m`; a bare number is minutes) → stalled (an `ok` closes a phase, so the next `start` or `done` is due).
- **`watch`:** sources are every `--file` (watched before it exists), else every `*.log` in `--dir` (files created later are picked up), else `$OMG_PROGRESS_FILE`, else `<state root>/progress/`. Existing lines set the state silently (`--replay` prints them); agents already failed, blocked or stalled are reported at startup. Each new event prints once as a canonical line with `agent=` filled in; a stall prints one `status=stalled` line (`note="no event for 12m after status=start" idle=12m last_ts=<ts>`) until the agent writes again. Polls every `--interval` (default 1000 ms); a rotated file (new inode / birth time, or shrunk where the platform reports neither) is finished from `<file>.1` at the old offset, then read from the start; a file truncated in place is reread from the start. Only new events count towards exiting: written after the watch started, or at or after `--since <ISO time | duration ago>`, or every event with `--replay`. The tracked agents are those with a new event plus every `--agents a,b,c` name (pending until its first new event; one `phase=pending status=stalled` line after `--stall`). Exits 0 when there is at least one tracked agent, every `--file` has a new event, and every tracked agent's latest event is `done` (`--until settled`: `done`, `fail` or `blocked`). Older logs are reported once at startup but never end or block the watch.
- **Exit codes:** `0` ok (`emit` too when the write fails: it warns on stderr, so `&&` chains keep going), `2` usage error.

### `omg factory`

`omg factory init` seeds the project route table `.omg/factory-routes.json`, `omg factory listen` runs the HMAC-verified tracker intake daemon, and `omg factory status [--json]` is the read-only chain audit. A chain is a series of headless AFK links: when a link's session ends, the SessionEnd hook routes its `outcome:reason` through the route table and the detached SessionEnd worker spawns the next link. Guardrails apply per link: one active link per intent (serial lock) and a daily cap of 10 (`OMC_DAILY_CHAIN_LIMIT`).

#### Factory chains on Copilot

Each link has a chain-link id and a ledger `.omg/state/factory/chain-<id>.json`, written by whoever spawns the link (the listener for the first link, the SessionEnd worker for later ones). The SessionEnd hook must find that ledger, so the link id has to reach the ending session:

- **Claude Code** pins it with `--session-id <id>`; the host session id is the link id.
- **Copilot CLI** has no `--session-id`, so the spawner sets `OMC_CHAIN_LINK=<id>` on the `copilot` process. Copilot passes its env to hook processes, and SessionEnd resolves the link as `OMC_CHAIN_LINK` first, then the host session id.

The link's own SessionStart binds the link to its host session: the first session that starts with `OMC_CHAIN_LINK` naming an open Copilot ledger records itself as `boundSessionId` (an exclusive `chain-<id>.json.bind` file). `OMC_CHAIN_LINK` is trusted at SessionEnd only when `chain-<id>.json` exists, records `host: "copilot"` and `chainLink: <id>`, is bound to the ending host session, and the ending session is not a Claude session (`CLAUDE_CODE_ENTRYPOINT` unset). A nested session that inherited the variable (a verify command's `copilot -p`, an MCP child, a team worker) therefore cannot end its parent's link. Otherwise SessionEnd falls back to the host session id and records `chain-link-rejected` in `chain-decisions.jsonl`. A link is decided once: a duplicate SessionEnd of the same host session gets the chain it enqueued back (`already-closed`, `replayed: enqueued`), so whichever hook's manifest wins still carries the chain, and the one job per host session spawns it once. A concurrent duplicate waits briefly for the deciding hook (`chain-<id>.json.claim`), then records `duplicate-session-end`. So setting the variable alone can neither inject a chain nor replay a finished link. If the hand-off fails after the decision, the ledger's `decision` is corrected to `manifest-unavailable`, `worker-spawn-failed`, or `enqueued-failed`, and the stored chain is dropped so it is never replayed. The detached SessionEnd worker never forwards `OMC_CHAIN_LINK`: the chain identity rides the durable manifest payload, and every spawned link gets its own value. `COPILOT_ALLOW_ALL` stays forced to `false` on every link, and the AFK permission profile is unchanged.

| Ledger field | Meaning |
|---|---|
| `chainLink`, `host`, `createdAt`, `parentLink` | Written at spawn: the link id, `copilot` or `claude`, and the link that spawned it. |
| `boundSessionId`, `boundAt` | Copilot only: the host session that started the link. |
| `closedAt`, `hostSessionId`, `endReason`, `outcome`, `decision`, `enqueuedChain` | Written once by the link's SessionEnd. The watchdog skips a closed ledger only when its decision advanced the chain or left a stop marker (`enqueued`, `chain-terminal`, `chain-loop-capped`, `human-gate`, `no-route` on failure); a link dropped by a guardrail, an invalid ledger, or an error is still flagged. |
| `maxStageVisits` | Stage-visit cap, carried from the first ledger to every later link (default 2, values above 99 clamp to 99). |

Copilot's SessionEnd reason for a finished `-p` link is `complete` (CLI 1.0.91), which counts as `success` alongside Claude's `other`, `prompt_input_exit`, and `logout`; route keys such as `success:*` match both hosts. When OMC runs from a dev plugin root (`omg --plugin-dir`, which sets `OMC_PLUGIN_ROOT`), Copilot links also get `--plugin-dir <root>`, and the SessionEnd worker forwards `OMC_PLUGIN_ROOT`, so every link loads the same plugin. The root is dropped when it overlaps the link's working directory, because an AFK link may write there and could rewrite the plugin's hooks; a chain over the plugin's own repo needs the plugin installed. On Windows a root containing `%` is dropped as well. Limitation: Copilot fires `sessionEnd` after every turn, also in `-p` mode, so a link that a Stop hook keeps going into a second turn hands off after its first turn. The closed ledger stops later turns from enqueuing again, but the next link may start while this one still runs. A single-prompt link is not affected. `omg factory status` lists each intent's links in spawn order with host, link id, and closeout, for example `环 2 link-2 [copilot] link=<id> 已结束 success→chain-loop-capped session=<host session>`.

#### `omg factory run` (experimental)

`omg factory run <issue>` drives one GitHub issue to a PR that is ready to merge. An implement lane commits in its own worktree. The engine pushes `factory/issue-<n>` and opens a draft PR. A fresh review lane checks the exact head, and fix rounds run on fresh lanes. The engine then runs ship's prepare step, watches the CI gates, and parks at `awaiting-human: merge`. Merge is always a human step. The run starts only when you start it by hand; the listener never starts it.

The engine is deterministic code that owns every transition. LLM work happens only inside lanes, and the engine treats a lane's output as untrusted data that it validates. Lanes are `copilot_run` jobs used in-process, behind a host-neutral lane interface.

```bash
omg factory run <issue> [--json]          # start, or resume at the recorded phase
omg factory run <issue> --dry-run         # read the issue and plan and print the next step; no state, lanes or pushes
omg factory run status <issue> [--json]   # the persisted state, read-only; --json adds integrityOk and runCredits
omg factory run cancel <issue> [--json]   # ask the running engine to cancel its lane and stop; keeps the PR, branch and worktrees
omg factory run clean <issue> [--json]    # remove the worktrees and local branches of a merged or cancelled run
```

| Exit code | Meaning |
|---|---|
| `0` | Parked at `awaiting-human: merge`, merged, cancelled, a dry run, or a successful `status`, `cancel` or `clean` |
| `4` | Any other `awaiting-human` stop, or `clean` kept a worktree |
| `1` | A failure: an engine step failed, or the state is `failed` |
| `2` | A usage error, such as a missing issue number, or `status` for an issue with no run |

`omg factory run` without `--dry-run` is itself the opt-in to live, billed lanes; no `OMG_COPILOT_RUN_ALLOW` is needed. The first Ctrl+C or SIGTERM cancels the lane after the current poll. A second one exits at once, and the next run treats the lane as lost.

##### Phases

```
intake → plan → implement → publish → review ─approve─→ prepare → gates ─green─→ merge ─human merges─→ merged
                                ▲          │                │         │
                                │   changes-requested    conflict   failed
                                │          ▼                ▼         ▼
                                └─ publish ◄─ fix ◄── conflict-fix   ci-fix ─→ publish → review
any phase ─cancel─→ cancelled          any phase ─gate─→ awaiting-human ─rerun─→ same phase
```

| Phase | What the engine does |
|---|---|
| `intake` | Reads the issue with `gh issue view`. A closed issue ends the run as `cancelled`. An open PR that already uses the factory branch stops at `pr-exists`. |
| `plan` | Resolves the spec. An `omg-plan: <repo path>` line wins. It counts in the body when the issue's author owns the repository or has commented as an owner, member or collaborator, and in a comment by an owner, member or collaborator. The plan file is read from the base branch. Otherwise the issue body counts when it has an `Acceptance criteria` heading. |
| `implement` | One write lane at `origin/<base>`. The prompt carries the issue and the plan and says to commit, not push. The lane must leave at least one commit that descends from its start. |
| `publish` | The engine pushes the lane head to `refs/heads/factory/issue-<n>` with a plain refspec. The first publish opens a draft PR with `Closes #<n>` and starts ship state with implementer `factory-impl-<n>`. Before pushing, the engine re-reads the remote branch and the PR, so a crash between push and record repeats nothing. |
| `review` | One review lane at the exact head. Its prompt has the issue, the plan and the diff against the base, never the implementer's summary. See [Review lanes and verdicts](#review-lanes-and-verdicts). |
| `fix` | A fresh write lane at the PR head with the review's findings. It never resumes the implementer session. |
| `prepare` | Marks the PR ready, then runs ship's `runPrepare` with push off in an engine-owned checkout: `.omg/team/factory-run/worktrees/issue-<n>` on the local branch `omc-team/factory-run/issue-<n>`. The engine pushes prepare's housekeeping commits itself and records them in ship state, so they need no new review. |
| `conflict-fix` | Prepare's base merge conflicted outside `inventory/`. A fresh write lane merges the base and resolves. A merge by a lane is not housekeeping, so it goes back through publish and review. At most 2 rounds. |
| `gates` | Loops ship's `watchGates` in-process, one ship watch window per call. A window that times out is a heartbeat, not a stop. A read counts only when the PR head is still the pushed head and every check belongs to a workflow run for that head. |
| `ci-fix` | A real check failure, from prepare or CI. A fresh write lane gets the failing check names and up to 50 failing test titles from the job logs. At most 1 round. |
| `merge` | Asks ship's merge rule (`decideMerge`) about the current head, comments the decision and the exact merge command on the PR, and parks at `awaiting-human: merge`. |

`merged`, `cancelled` and `failed` are terminal. `awaiting-human` is not a phase: the phase stays, and the gate is recorded next to it.

##### State and resume

- **State file.** `.omg/state/factory/run-<issue>.json`. The engine writes it under a file lock with an atomic write and seals it with a sha256 `integrity` field. It holds the phase, the gate, the issue and plan snapshot, the PR, the pushed head, every lane with its cap, usage and verdict, retries, history and elapsed time. Next to it are `run-<issue>.owner`, the single-runner owner file, and `run-<issue>.cancel`, the cancel request.
- **Single runner.** A live owner refuses a second run. A dead pid on the same host is taken over and noted in the history. An owner on another host always refuses.
- **Resume.** Rerun `omg factory run <issue>`. The engine clears the gate and re-evaluates the recorded phase. There is no `--from` and no `--reset`.
- **Re-read before acting.** `publish` checks the remote branch and an existing PR before pushing or creating. `review` and `gates` read the PR's `headRefOid`. A head the engine did not push stops at `head-moved-externally`.
- **Ship state.** The engine follows the PR's ship state when it is further along. It adopts a ship verdict only when a review lane it ran carries that verdict's hash.
- **Lost lanes.** A lane recorded `running` at resume is lost. The engine checks its recorded Copilot child by pid and start time and kills it if it still runs. It keeps the worktree for inspection and respawns one fresh lane. A second loss of the same kind in a row stops at `lane-lost`. A lost lane's unknown usage counts as its whole credit cap.
- **Failed state.** A state that fails its seal, or that the engine's record does not hold, is `failed` and is not resumed. Move the file aside to start over.
- **Cancel.** `omg factory run cancel` writes the request file and never touches the state. A running engine sees it between steps and during lane waits, cancels the lane, and moves to `cancelled`. Without a running engine, the next run finishes the cancel. Cancel never closes the PR, deletes branches or removes worktrees.
- **Clean.** `omg factory run clean <issue>` works only on a merged or cancelled run and refuses while an engine runs. It removes each lane's `copilot_run` worktree and the prepare checkout through the team worktree remover, which unlinks junctions such as `node_modules` first. It keeps a dirty worktree. It also keeps a worktree or branch with a commit that is not in the main checkout's HEAD, the fetched base or the PR branch on `origin`. It never deletes the PR branch on GitHub.
- **Progress.** The engine writes progress events to `<state root>/progress/factory-<issue>.log`. Lane waits and gate polls emit a heartbeat, so `omg progress watch` sees no false stall.

##### Human gates

Every gate posts one issue comment that names the gate, the reason and the command to resume. It is posted once per gate and head. Fix the cause, then rerun `omg factory run <issue>`.

| Gate | Cause | What to do |
|---|---|---|
| `needs-plan` | No `Acceptance criteria` heading and no trusted `omg-plan:` line, or the linked plan is missing or empty on the base | Add acceptance criteria or a plan link |
| `pr-exists` | An open PR already uses `factory/issue-<n>` | Close that PR or finish it by hand |
| `implement-failed`, `fix-failed`, `ci-fix-failed` | A write lane failed, timed out, hit its cap, left no changes, or committed itself, after one fresh retry | Read the lane's worktree and the history in `status`; sharpen the plan or raise a limit |
| `conflict-fix-failed` | The conflict-fix lane's head does not contain the base | Resolve the conflict by hand, or rerun for a fresh lane |
| `merge-conflicts` | The base still conflicts after 2 conflict-fix rounds | Merge the base into the PR branch by hand |
| `review-invalid` | The review lane failed, or its output broke the contract, after one fresh retry | Read the lane's final message; rerun for a fresh review |
| `review-identity` | A review job id is also a write lane's job | Inspect the state file; this is an engine invariant |
| `fix-rounds-spent` | Ship blocked the PR after `maxFixRounds` changes-requested rounds | Raise `factory.run.maxFixRounds` or `ship.maxFixRounds` in the user config, or fix the PR by hand |
| `protected-paths` | A lane, or the prepared head, changed paths that ship's merge rule protects | Nothing was pushed; review the change by hand |
| `lane-tampered`, `review-tampered` | A lane, or prepare's checks, changed shared git state outside its own branch and worktree | Nothing was pushed and the verdict is dropped; inspect the repository by hand (see [Security model](#security-model)) |
| `sandbox-unavailable` | A lane refused to run because its OS sandbox was not confirmed (see [Sandboxed lanes](#sandboxed-lanes)) | Install the sandbox backend, or set `factory.run.sandbox.writeUnsandboxed: "detect-only"` in the user config to run write lanes unsandboxed |
| `sandbox-escaped` | A lane's shell call ran without the runtime's `sandboxed: true`, its worktree's git links changed, or it added a nested repository, a directory link or a path that resolves outside its worktree | Nothing was committed or pushed; inspect the lane worktree by hand |
| `lane-unconfirmed` | The engine cannot confirm that a lane's Copilot process stopped | Stop the process yourself; your rerun counts as your word that it stopped |
| `lane-lost` | Two lanes of the same kind in a row were lost | Find out why the engine died |
| `state-tampered` | The run state, its owner or lock files, or the PR's ship state changed outside the engine | The changed file is kept as `<file>.tampered-<time>` and the engine's copy is restored; inspect it |
| `head-moved-externally` | The PR head or the remote branch is at a commit the engine did not push | Reset the branch to the engine's head, or move the change into the plan |
| `pr-not-open`, `base-changed` | The PR was closed, or retargeted to another base | Reopen or retarget it |
| `ci-failed` | A real check failure after the ci-fix round | Fix the PR by hand |
| `ci-flaky` | Known-flaky failures are out of rerun budget | Rerun the job on GitHub |
| `no-workflows` | No checks and no workflow runs for the head after 5 minutes | Check that workflows trigger for the branch |
| `gates-timeout` | Gates did not settle within `factory.run.gatesTimeoutMinutes` | Rerun to continue the loop |
| `gates-disagree` | The merge rule's one-shot read kept disagreeing with the gates loop | Check the PR's checks by hand |
| `budget` | The run reached `factory.run.maxRunCredits`, or less than the 30-credit lane minimum is left | Raise the limit in the user config |
| `wall-time` | The run passed `factory.run.maxRunWallTimeMinutes` | Raise the limit in the user config |
| `merge-refused` | Ship's merge rule refuses the head | Read the reasons in the PR comment and resolve them |
| `merge` | Review approved and gates are green on the head | See [The merge gate](#the-merge-gate) |

##### The merge gate

Merge is always human. There is no `factory.merge` key and no auto mode, and the engine's command guard refuses `gh pr merge` outright. At the `merge` gate the PR carries the review findings as a comment, the diff, and a comment with the exact command that merges the head the gates checked. Read the diff and run that command yourself. Then run `omg factory run <issue>` once more: the engine reads the PR state and finishes as `merged`.

##### Review lanes and verdicts

- **Identity.** Every write lane runs as `factory-impl-<n>`. Each review lane is `factory-review-<n>-<jobId>`, and ship refuses a verdict from the implementer.
- **Fresh context.** Each review is a new session in its own worktree at the head, on `copilot_run`'s `review` profile, which cannot write files or commit.
- **Contract.** The lane's final message must end with exactly one fenced `json` block: `verdict` (`approve` or `request-changes`), `sha` (the 40-hex head), `findings` (each with `severity` `blocker`, `major`, `minor` or `nit`, a `summary`, and optional `file` and `line`) and optional `notes` of at most 500 characters.
- **Fail closed.** No block, two blocks, text after the block, a wrong sha, bad fields, an edited worktree or a moved PR head make the review `invalid`, and no verdict is recorded. An `approve` with a `blocker` or `major` finding counts as `request-changes`.
- **Posting.** The engine posts the findings as one PR comment, so the merge gate sees filtered findings next to the diff.

##### Configuration

Keys live under `factory.run`. The engine reads them from the user config at its default location: `<home>/.config/claude-omc/config.jsonc`, on Windows `<home>/AppData/Roaming/claude-omc/config.jsonc`. The working-tree project config, `.copilot/omg.jsonc`, can only lower a value. A higher one is ignored with a warning, because a lane can drop that file into the checkout. An ill-typed value is an error.

| Key | Default | Meaning |
|---|---|---|
| `laneMaxCredits` | `30` | AI-credit cap passed to every lane. Mandatory, and at least 30, the Copilot CLI minimum. |
| `maxRunCredits` | unset | Cap on the run's measured AI credits, checked at step boundaries. Each lane's cap is lowered to what is left. Must be at least `laneMaxCredits`. |
| `laneTimeoutMinutes` | `30` | Wall time of one lane, at most `copilot_run`'s maximum timeout |
| `maxRunWallTimeMinutes` | `240` | Engine wall time across all invocations of one run |
| `maxRetries` | `1` | Fresh retries of a failed lane per phase |
| `maxFixRounds` | `2` | Changes-requested rounds before ship blocks the run. Defaults to `ship.maxFixRounds`, which the user config may also set. |
| `maxCiFixRounds` | `1` | CI-fix rounds; a value above 1 uses 1 |
| `gatesTimeoutMinutes` | `90` | Overall bound of one gates phase across its watch windows |

The base branch comes from `ship.base`. The gates and the merge rule use ship's config. `requiredChecks`, `advisoryChecks` and the known-flaky list load in strict mode: from the user config, or from `.copilot/omg.jsonc` as committed at GitHub's base sha, never from the working tree or the PR head. A base the engine cannot verify stops the step. See [`omg ship`](#omg-ship) for the ship keys.

##### Security model

Lanes read untrusted issue and PR content, so any lane may be prompt-injected. The design assumes a lane tries anything its tools allow, and the engine decides what counts.

- **Lane rights.** Lanes run in the Copilot OS sandbox, as described under [Sandboxed lanes](#sandboxed-lanes). On top of that, `copilot_run`'s worker policy applies: write lanes keep a shell denylist that includes `git push`, review lanes get a shell allowlist, file writes are confined to the worktree, and ship's protected paths are refused. No lane commits: the engine commits a write lane's changes. Lanes have no push or PR rights. Only the engine pushes and talks to GitHub. Its command guard allows a fixed list of `gh` and `git` forms, including a plain push of a 40-hex sha to the factory branch, never a `+` refspec and never a protected branch.
- **Protected paths.** Before every push the engine checks the change against ship's merge-rule paths. A hit stops at `protected-paths`.
- **Tamper checks.** The engine compares the shared git state before and after every lane, write or review. The comparison covers refs, config, `hooks/`, `info/`, `worktrees/`, `modules/`, alternates, your global git config (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` or `GIT_CONFIG_GLOBAL`) and every file a config includes, both HEADs, the main checkout's status and a short list of ignored files such as `.env*` and `node_modules/.bin`. A `worktrees/` or `modules/` entry that is a symlink or junction, or a live worktree entry that disappears, also counts as a change. A lane may add only its own branch and worktree. Any other change stops the run at `review-tampered` or `lane-tampered`, drops the verdict and pushes nothing. The check runs again at every step boundary, before the engine's next git command and before every push. A lost lane is compared when it is found. Prepare's checks run the PR's own code, so the engine snapshots around prepare the same way.
- **Engine-owned state.** The engine keeps its own record of every state file it writes, outside the repository: in `~/.omg/factory-ledger/`, or in `$OMC_STATE_DIR/factory-ledger/` when that is set. Any other change to the run state, its owner or lock files, or the PR's ship state stops the run at `state-tampered`. The sha256 seal on the state file only catches accidental edits, because anyone can recompute it.
- **Hardened engine git.** The engine runs its own git, including the fetch in `clean`, with an empty `core.hooksPath` and `core.fsmonitor=false`. A hook or fsmonitor that a lane plants never runs in the engine, and the repository's own hooks do not run on factory pushes either.
- **Residual risk.** The sandbox is new, and some of its behaviour is still unverified; see the open questions and residual risks under [Sandboxed lanes](#sandboxed-lanes). With `writeUnsandboxed: "detect-only"`, or on a host where the sandbox is switched off, a write lane's shell runs as you: it can reach your home directory, rewrite the engine's record there, or read your credentials. The checks above narrow that, and a human merge always comes last.

##### Sandboxed lanes

Every `copilot_run` session asks the Copilot CLI's OS sandbox to confine its shell commands and its local MCP and LSP servers. That includes every `omg factory run` lane. The sandbox is Microsoft Execution Containers, which uses bubblewrap with slirp4netns on Linux, Seatbelt on macOS, and a process container on Windows. Built-in file tools are not OS-sandboxed. The permission handler's write-path check still confines them.

**Confirmation.** Before the first turn the job does three things:

1. It probes the host with `sandbox.getHostSupport`, which must report the `shell` capability. On Linux it then runs one trial launch, `bwrap --ro-bind / / --dev /dev --unshare-all --die-with-parent -- true`, once per process. When that fails, the host counts as unsupported with the reason, and `host.launchFailed` is `true`. See [Linux: restricted user namespaces](#linux-restricted-user-namespaces).
2. It applies the policy below, with `options.update` on SDK 1.0.16, or at create on an SDK whose `createSession` takes it.
3. It reads `sandbox.getEnforcementStatus`.

The sandbox is confirmed only when all three succeed and enforcement is not `blocked`. After that, every shell call must carry the runtime's `sandboxed: true` attestation. The first call without it stops the session as `sandbox-escaped`. Sandbox bypass requests are always rejected, and `allowBypass` is never set.

###### Linux: restricted user namespaces

Ubuntu 23.10 and later, including 24.04, ship with `kernel.apparmor_restrict_unprivileged_userns=1`. An unprivileged process can still create a user namespace, but that namespace gets no capabilities. bwrap then fails when it sets up the sandbox's network namespace, with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. `sandbox.getHostSupport` still reports the host as supported. Without the trial launch, every sandboxed shell would fail at launch. With it, the host reads `unsupported (unprivileged user namespaces are restricted ...)`, and the fail-closed modes above apply: reviews run without a shell, and writes refuse with `sandbox-unavailable`.

To let bwrap run, pick one of two fixes:

- **An AppArmor profile for bwrap (preferred).** This grants user namespaces to bwrap only. Write `/etc/apparmor.d/bwrap` and load it with `sudo apparmor_parser -r /etc/apparmor.d/bwrap`. If bwrap lives somewhere other than `/usr/bin/bwrap`, use that path.

  ```
  abi <abi/4.0>,
  include <tunables/global>

  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,
    include if exists <local/bwrap>
  }
  ```

- **The sysctl.** `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` lifts the restriction for every program until reboot. Add it to a file in `/etc/sysctl.d/` to keep it.

The trial result is cached per process, so after either fix, restart a long-lived process such as the plugin MCP server.

**Security note.** The restriction exists because unprivileged user namespaces expose kernel code paths to every local process, and many kernel privilege escalations need one. The sysctl reopens that for all programs. The profile reopens it only for bwrap, which drops the namespace's capabilities before it runs the sandboxed command. Use the profile on machines you care about. Keep the sysctl for throwaway machines such as CI runners.

| Mode | When | Review lane | Write lane |
|---|---|---|---|
| `enforced` | Confirmed | The shell allowlist below, inside the sandbox. The worktree and the git dir are read-only, and there is no network. | A shell inside the sandbox. It can write the worktree and the job home's temp and profile dirs. The git dir is read-only, and there is no network unless `writeNetwork` allows it. |
| `read-only-no-shell` | A review that is not confirmed, with the default `reviewUnsandboxed: "no-shell"`, or with the sandbox switched off | Only `view`, `grep` and `glob`. There is no shell tool, and the engine already puts the diff in the prompt. | Not used |
| `refused` | A write that is not confirmed (the default), or a review with `reviewUnsandboxed: "refuse"` | No session is created. The run parks at `awaiting-human: sandbox-unavailable` with the host's reason. | As for review |
| `detect-only` | A write that is not confirmed with `writeUnsandboxed: "detect-only"`, or with the sandbox switched off | Not used | The lane runs unsandboxed, as it did before the sandbox. |

- **Review lanes.** The tool set is limited to `view`, `grep`, `glob` and the turn bookkeeping tools. The shell tools are added only when the sandbox is enforced. Every shell command must pass a parsed allowlist (`src/team/shell-allowlist.ts`). It accepts read-only `git` subcommands (`status`, `diff`, `log`, `show`, `blame` and the like, with no `-c`, `-C`, `--git-dir`, `--output` or `--ext-diff`), `rg`, `grep`, `findstr`, `select-string`, `cat`, `type`, `get-content`, `head`, `tail`, `wc`, `ls`, `dir`, `get-childitem`, `pwd`, and `find` without `-exec` or `-delete`. A command has at most three `|` segments, and the later segments must be filters. None of `` ` $ ; & > < ( ) { } [ ] @ ! `` may appear, and every path must resolve under the worktree. The runtime's own parse of the command must name only allowed commands too. Review lanes run no tests, because running PR code belongs to the engine's gates.
- **Write lanes.** A write lane can write its worktree and two dirs of the job home: the relocated temp dir (`<job home>/tmp`) and profile (`<job home>/profile`). It cannot write the rest of the job home, which holds what the unsandboxed runtime reads back (`config.json`, `session-state`, `logs`, the session store, the package cache in `<job home>/.cache/copilot`), nor the job dir, which holds the engine's `events.jsonl`. A review lane gets the same two dirs and nothing else read-write. Both profiles read the lane's global git config read-only (`<job home>/git`). A write lane can read the plugin root and the target of a linked `node_modules`. The network is off by default. `writeNetwork: "registry"` allows `registry.npmjs.org`, `*.npmjs.org` and `allowedHosts` through the sandbox proxy, and `github.com` is never added. When the host reports `denied_paths`, the real home's `.ssh`, `.gitconfig`, `.omg` and `.copilot` are denied. Windows cannot deny per path. In an `omg factory run` lane the whole common git dir is read-only, so the lane leaves its changes uncommitted and the engine commits them. A plain `copilot_run` write job may also write `objects/` and its own `worktrees/<name>` admin dir. It commits on a detached `HEAD`, and the host moves the job's branch.
- **Tool dirs.** `allowDevToolAccess` stays off, so the runtime grants no `PATH` entry, and on Windows the sandbox then denies starting any program outside the system dirs, such as `C:\Program Files\nodejs\node.exe`. Both lane profiles get two programs read-only, never read-write: node (the dir of the engine's own binary and of the `node` on the lane's `PATH`, which the plugin hooks and the plugin MCP server run) and git (the Git for Windows install root, found from `git --exec-path`, or elsewhere the git binary's dir and its exec path). They are granted by name rather than all of `PATH`, because `PATH` can hold per-user dirs with config or credentials, and `PATH` entries under a `node_modules` dir are skipped, so an npx shim cannot stand in for them. A dir that is a filesystem root, or holds the real home, the worktree, the common git dir or the job dir, is never granted: a `D:\dev\node.exe` with every repository beside it would expose those repositories. On Linux and macOS the system dirs stay granted anyway, so this matters there only for a toolchain outside them, such as nvm, a CI tool cache or Homebrew's Cellar. Any other program a lane needs goes in `extraReadonlyPaths`.
- **Environment.** The runtime gets an allowlisted env, and the profile variables `USERPROFILE`, `HOME` and `XDG_CONFIG_HOME` point into `<job home>/profile`. `GIT_CONFIG_GLOBAL` (`<job home>/git/config`) and `COPILOT_CACHE_HOME` (`<job home>/.cache/copilot`) sit outside it, because the runtime runs git and loads its package from that cache unsandboxed: a lane that could write them could plant `core.fsmonitor`, a filter driver or a `runtime.node`. `NODE_DISABLE_COMPILE_CACHE=1` keeps node's compile cache, which defaults to the lane-writable temp dir, off. `TEMP`, `TMP` and `TMPDIR` point at `<job home>/tmp`, never the caller's: the runtime grants the sandbox read-write on the dir its own `TEMP` names, and the host value was the user's whole temp dir. On Windows the sandbox cannot launch any process, hook or shell, without `SystemRoot` and `LOCALAPPDATA`, so both pass with their host values. `LOCALAPPDATA` keeps the HOST value on purpose: the sandbox grants `%LOCALAPPDATA%Programs` read-only from it, which per-user tools on `PATH` need. Lane-launched code that resolves host paths from it (python-repl runtime dir, data and state dirs) therefore sees host paths, where sandboxed writes are denied: breakage or shared read state, not escalation. A job on a Windows host without them refuses at start and names the missing variable. `GH_TOKEN`, `GITHUB_TOKEN`, `NODE_OPTIONS`, and cloud and npm tokens are dropped. `COPILOT_GITHUB_TOKEN` goes to the session over the RPC, never into the env that shell children inherit.
- **State.** The `copilot_run` report and each factory lane record carry `sandbox`. Its fields are `mode`, `host` (`supported`, `reason`, `capabilities`), `applied` (`create`, `options.update` or `none`), `enforcement`, `canary`, `unsandboxedCalls`, `cliVersion`, `sdkVersion`, and a `reason` when the mode is not `enforced`. No canary runs yet, so `canary` is `skipped`.

**Configuration.** The block is `copilotRun.sandbox`, which applies to every `copilot_run` job. For factory lanes, `factory.run.sandbox` overrides it key by key. Both are read from the user config at its default location, as for the `factory.run` keys above. The working-tree project config, `.copilot/omg.jsonc`, can only tighten them: it may set `enabled: true`, `reviewUnsandboxed: "refuse"`, `writeUnsandboxed: "refuse"` and `writeNetwork: "none"`. A looser value, and any `allowedHosts` or extra paths, are ignored with a warning, because a lane can drop that file into the checkout. A malformed block refuses the job.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` switches the sandbox off. Write lanes then run `detect-only` and review lanes `read-only-no-shell`, with a warning. |
| `reviewUnsandboxed` | `"no-shell"` | An unconfirmed review runs without a shell (`"no-shell"`), or not at all (`"refuse"`) |
| `writeUnsandboxed` | `"refuse"` | An unconfirmed write lane refuses (`"refuse"`), or runs unsandboxed (`"detect-only"`) |
| `writeNetwork` | `"none"` | `"registry"` lets write lanes reach the npm registry |
| `allowedHosts` | `[]` | Extra hosts when `writeNetwork` is `"registry"` |
| `extraReadonlyPaths`, `extraReadwritePaths` | `[]` | Absolute paths added to the policy. A read-write path must be under the worktree. |

`OMG_SANDBOX=off` in the env of the MCP server or the engine switches the sandbox off for debugging. It never comes from a config file, and it is recorded as `detect-only`.

**`writeUnsandboxed: "detect-only"`.** This restores the behaviour from before the sandbox. A write lane on a host without a confirmed sandbox runs with a shell that acts as you, with your home directory and the network. The engine prints `omg factory run: <kind> lane <id> ran without an OS sandbox`, records `sandbox.mode: "detect-only"` on the lane, and names those lanes in the PR body. Unsandboxed shell calls are counted but do not stop the lane. Use it only on repositories and issues you trust.

**Git 2.41 or newer.** While the sandbox is on, `copilot_run_start` refuses with an older host git. The host reads a sandboxed worktree with `GIT_ATTR_SOURCE` set to the empty tree, so no attribute the lane wrote can select a filter or a diff driver, and git before 2.41 ignores that variable. Upgrade git, or set `enabled: false`.

**Host git hardening.** The worktree's `.git` file and its admin dir stay lane-writable, so host git never trusts them. In summary:

- The links are recorded when the worktree is created, and every host git call pins `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR` to them. A changed link stops the job as `sandbox-escaped`, and no host git runs in that worktree.
- Every call runs with an empty `core.hooksPath`, `core.fsmonitor=false`, and a fixed pager, editor, ssh command, gpg program and credential helper. Every filter and diff driver a non-system config level names is blanked.
- The engine commits with `write-tree` and `commit-tree` under a fixed `omg factory` identity. No hook or signing program runs, and nothing the lane wrote picks the author.
- Before staging, the engine walks the lane worktree without following links. It refuses a directory link, any link on Windows, a new symlink entry, a staged path whose real folder is outside the worktree, a new or changed file with more than one hard link, and a nested repository. The lane then parks at `sandbox-escaped` and the index is reset, because host git runs with your read rights and Git for Windows follows a junction in `add -A`.
- A write lane may not change `.github/`, `.copilot/`, `.omg/skills/`, `.omc/skills/`, `AGENTS.md` or `CLAUDE.md`, on top of ship's merge-rule paths. Such a change parks at `protected-paths`.

[Git state in the worktree](#mcp-tools-copilot_run_-delegate-a-task-to-copilot) has the details.

**Open questions, and how the smoke answers them.** `omg smoke copilot --tier 2 --sdk-static` makes no model call. Its `sdk.sandbox` check reports host support and the review policy's enforcement on this machine. The opt-in `--scenario sandbox-lane` scenario (about 3 AI credits estimated) answers the rest, one result line each:

| Question | Check | What it does |
|---|---|---|
| Q1: Is the default user-profile grant read-write? Does it follow `USERPROFILE`, so that relocation moves it? | `scn.sandbox-lane.q1_profile` | The write lane writes the real home and the relocated profile. It fails when the real-home write landed: then add the real home to `readonlyPaths`. The relocated-profile result says whether the grant follows `USERPROFILE`/`HOME`. |
| Q2: Does the CLI grant the common git dir read-write for linked worktrees, over our `readonlyPaths` entry? | `scn.sandbox-lane.q2_git_dir` | The write lane writes the common git dir. It fails when the write landed: then write lanes are not confined, and an upstream feature request is needed. |
| Q5: Is `session.rpc.shell.executeUserRequested` sandboxed, and does it pass `onPermissionRequest`? | `scn.sandbox-lane.q5_canary_rpc` | A canary lane runs the probe through that RPC before its first turn. It passes when the call was attested `sandboxed: true`, the outside write was blocked and the worktree write landed. The detail says whether the permission handler was consulted. A failure means a free canary is not possible and needs a model turn. |

Q1 on Copilot CLI 1.0.105 (Windows, from the free canary's `policies/*.json`): the runtime adds no profile grant of its own. Its read-write set is `<job home>/tmp` (its `TEMP`), `session-state/<id>/files`, and our `<job home>/tmp` and `<job home>/profile`. It adds `<job home>/logs` and the package's `builtin` dir read-only. Lanes keep the profile read-write because tools write there: `npm` keeps its cache and logs in `~/.npm` and fails without them, node writes `~/.node_repl_history`, and Windows tools write `%USERPROFILE%\AppData`. Git writes nothing under the home.

Still open: whether the plugin MCP server should run in lanes at all (Q3), raising the SDK peer range for `createSession.sandboxConfig` (Q4), the same policies for `omg team --transport sdk` workers (Q6), and whether `writeNetwork: "none"` is workable for lanes that install dependencies (Q7).

**Residual risks.**

- Built-in file tools follow the policy on a best-effort basis only. The write-path check is their boundary.
- The runtime launches the plugin hooks inside the sandbox, with the lane's env and policy: on Windows a hook that cannot start reports `Failed to start hook in the sandbox`, and one whose `node` is not granted fails with `Access is denied`. They are our own code, but they handle lane-influenced input.
- The sandbox grants the temp dir and your user profile by default. Whether the profile grant is read-write is Q1. The tamper checks therefore stay: the common git dir snapshot, the global git config and include-chain hash, and the engine's own state record.
- The temp grant is read-write on whatever dir the runtime's `TEMP` names. With the caller's `TEMP` (Copilot CLI 1.0.105 on Windows) that was the user's whole `%TEMP%`, so a lane could write every other job's home and every repository under it, the smoke repositories included. Lanes now get `TEMP`, `TMP` and `TMPDIR` set to `<job home>/tmp`, created before the runtime starts. On 1.0.105 the policy then holds that dir and no longer the user's `%TEMP%`, as the canary's policy file shows. What remains: if a future runtime grants the OS temp dir from another source, such as `GetTempPath` or a fallback when the job dir is missing, the old exposure returns, so read the canary's `policies/*.json` after a CLI upgrade. The runtime keeps its own temp files in the job's temp dir, and so do the processes it launches, the plugin hooks and MCP server included, because they inherit its `TEMP`. A lane can therefore plant a link at any name in that dir. The hooks' debug logs (`*-debug.log`, written when a `*_DEBUG=1` variable is set) are opened without following a symlink or junction and are skipped when the file has a second hard link. Temp files the engine itself creates, such as the empty credential dir that `GH_CONFIG_DIR` names in a credential-free lane, stay in the host's temp dir, which the lane can no longer read. That still leaves `gh` with no credentials.
- The engine runs unsandboxed and writes the job dir. Its one write while the session runs is `<job dir>/events.jsonl`, which the lane cannot reach: the OS grant stops at the home's `tmp` and `profile` dirs, and the file tools' write check at its `tmp` dir. The engine also opens the file once, before the runtime starts, with `O_CREAT|O_EXCL` (plus `O_NOFOLLOW` where defined; `CREATE_NEW` on Windows, which refuses an existing link), and writes only through that fd. A name that already exists fails the job, and a later rename or replace of the name cannot redirect the writes. Every other engine write into the job's home happens before the runtime starts: the home and its `tmp`, profile and `git` dirs, `config.json`, and the seeded git identity in `<job home>/git/config`. Host git never reads that file: the engine's git runs on the engine's own env. At the end the engine deletes the home (completed jobs) or the job dir (`copilot_run_cleanup`), and `rmSync` removes a link without following it.
- The Copilot runtime itself also runs unsandboxed, and three dirs it writes are lane-writable: its temp files in `<job home>/tmp`, whatever it writes under the relocated profile (on 1.0.105 `.config` and `AppData`), and `session-state/<id>/files`, which the runtime itself grants read-write. A lane can plant a symlink or junction at any name in them before the runtime writes it. The runtime follows it, so that write can land outside the home with the account's rights. A lane can also change what the runtime reads back from them. We cannot make the runtime open its files without following links. A lane on Linux or macOS can plant a symlink without privileges, and on Windows a junction (a directory link) is always possible, and a file symlink needs Developer Mode or the symlink right. The rest of the job home (`config.json`, `session-state` outside `files`, the session store, `logs`, the package cache, the git config) is not lane-writable through the sandbox or the file tools.
- Windows cannot deny per path, so `deniedPaths` has no effect there.
- On Windows, Git for Windows's MSYS `sh.exe` cannot start inside the sandbox: it exits `0xC0000142` (`STATUS_DLL_INIT_FAILED`) in the MXC AppContainer, with the Git root granted (Copilot CLI 1.0.105). So git commands that go through `sh` do not work in Windows lanes: hooks, `!` aliases, the shell-script commands `git submodule`, `git mergetool` and `git filter-branch`, `git difftool` (its helper is a script), and filters or credential helpers given as shell commands. Builtins such as `status`, `diff`, `log`, `add` and `commit` work. Factory lanes need no hooks, because the engine commits for them with hardened host git. A plain `copilot_run` write job commits in its lane, so in a repository with an active commit hook (husky or `.git/hooks/pre-commit`) its `git commit` fails on Windows. The plugin hooks and the plugin MCP server start `node` directly and never call `sh`.
- No canary runs in a lane. Confirmation rests on host support, the applied policy, enforcement and the per-call attestation. The free `sdk.sandbox` spawn canary in `omg smoke copilot` checks that a lane-shaped session can start node and git.
- Node and git are granted read-only from their install dirs. A lane can therefore read anything in those dirs, and run any program in them, such as the other binaries in the Git for Windows tree.
- On SDK 1.0.16 the policy arrives through `options.update`, so the session's local MCP servers start unsandboxed for a moment before they restart (Q4).
- The sandbox cannot stop semantic attacks, such as a review talked into approving bad code. The human merge gate covers that.
- `omg team` sdk workers are not sandboxed. They keep the shell denylist (Q6).
- The team merge-orchestrator, merge-coordinator, mcp-team-bridge and runtime-v2 paths still run unhardened git in worker worktrees. This is a known follow-up, described under [`copilot_run`'s git state](#mcp-tools-copilot_run_-delegate-a-task-to-copilot). Do not use those paths with sandboxed lanes.

##### Cost

AI Credits is the unit. Premium requests are legacy and limit nothing here, and the plugin budget governor is not consulted. Each lane is one `copilot_run` session with its own cap. Copilot checks the cap after each model call, so a lane can overshoot it by one call. Lane usage is measured from the session's shutdown event and goes to the budget ledger for reporting.

| Run shape | Lanes |
|---|---|
| Approved at the first review | 2: implement and review |
| Each changes-requested round | +2: fix and review |
| Each conflict-fix round | +2: conflict-fix and review |
| The ci-fix round | +2: ci-fix and review |
| Each retry or lost-lane respawn | +1 |

With the default limits the worst case is 12 lanes before retries, which is 360 AI credits of caps. Lanes usually spend far less than their cap: the `factory-run` smoke scenario's implement and review lanes are estimated at about 2 AI credits together on a small model. Set `maxRunCredits` to bound a run, and use Copilot admin budgets as the hard stop.

##### Smoke scenarios

Two opt-in tier 2 scenarios run the engine in-process against a sandbox repository with a bare `origin` and a scripted `gh`, so nothing touches GitHub. Neither runs in `all`.

```bash
omg smoke copilot --tier 2 --scenario factory-run       # implement and review lanes, up to the merge gate (~2 AI credits estimated)
omg smoke copilot --tier 2 --scenario factory-run-fix   # adds one changes-requested round (~4 AI credits estimated)
omg smoke copilot --tier 2 --scenario sandbox-lane      # review, write and canary lanes in the OS sandbox (~3 AI credits estimated)
```

`sandbox-lane` checks the lanes' sandbox rather than the engine's phases. See [`omg smoke copilot`](#omg-smoke-copilot) for the checks.

#### `omg factory heal` (experimental)

`omg factory heal scan` reads recent `ci.yml` runs and classifies new red runs. It makes no LLM call and no GitHub write. It starts no lane, and a rerun is recorded as an intent but never issued. `omg factory heal run` diagnoses one signature in a read-only debugger lane and then stops for a human. `omg factory heal approve` turns an approved diagnosis into a draft fix PR that parks at the human merge.

```bash
omg factory heal scan [--dry-run] [--json]       # classify new red runs; --dry-run writes no state
omg factory heal status [<sig8>] [--json]        # list recorded signatures, or one classification and diagnosis
omg factory heal run <sig8> [--dry-run] [--json] # debugger lane; --dry-run writes the evidence bundle and prints the prompt
omg factory heal approve <sig8> [--dry-run] [--json] # a human approves the diagnosis: the ci-heal run to the human merge; also resumes it
omg factory heal cancel <sig8> [--json]          # cancel the ci-heal run; keeps the PR, branch and worktrees
omg factory heal close <sig8> [--json]           # close a heal run parked at heal-approve or heal-diagnosis
```

- **Candidates:** a red push run on the integration branch, or one failure signature on PR runs of two or more head branches in 72 hours. Cancelled, skipped and in-progress runs never count. Jobs in `factory.heal.ignoreJobs` never count. The defaults are "No Committed Build Artifacts" and "Version Consistency Check".
- **Signature:** each failed job contributes its name and its sorted failing tests. A job with no failing test contributes its failing step and its first `##[error]` line, normalized. The sha256 of the job signatures is the dedupe key, and its first 8 hex characters are the `sig8`.
- **Classes:** the classifier checks, in order, infra patterns, the known-flaky list at `origin/<base>`, the dev history and an environment diff. The diff covers image, image version, runner, git, node and npm. When the environment changed and the red sha adds no code the green sha lacks, the class is `env-change`. A sha that is green on one image version and red on another is also `env-change`. The other classes are `infra`, `known-flaky`, `intermittent`, `regression`, `regression-or-env` and `unknown`.
- **State and limits:** each signature is stored in `.omg/state/factory/heal/<sig8>.json`. A run is counted once per signature. The fixed limits are one open heal run and one recorded rerun per signature. The user config sets `factory.heal.dailyRuns` (default 3) and `factory.heal.dailyDebugLanes` (default 4). The project config can only lower them. Over a limit, a signature is queued as `blocked: rate-limit`.
- **Untrusted logs:** CI logs are only matched against fixed patterns, never run or put into a command. A log is capped at 8 MiB and each line at 4000 characters. All `gh` and `git` calls go through a read-only allowlist.
- **Evidence bundle:** `heal run` writes `.omg/state/factory/heal/<sig8>/evidence/`. It holds the classification, the environment diff, the setup lines, the commits, the failing test paths, a window per failing test and a tail per failed step. Every line is cleaned of ANSI and control characters and capped at 400 characters, JSON files included. GitHub tokens, AWS key ids, bearer tokens, private key blocks and URL credentials are replaced by `[redacted]`. Each file is capped at 64 KiB and the bundle at 160 KiB. In the prompt every file sits between lines that carry a random per-run delimiter, and a log line that looks like a delimiter is dropped.
- **Who starts a lane:** only a signature seen on a red push run of the integration branch, at a first red sha on `origin/<base>`. A PR run only adds weight to such a signature and never replaces its classification, because a lane checks out that sha and may run its tests on this host.
- **Confinement:** the lane has no OS confinement yet, so a non-dry-run `heal run` refuses unless `OMG_HEAL_UNCONFINED=1` is set. The opt-in prints a warning and the lane record keeps it. Every lane starts without `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, other secret-named variables, ssh-agent or git credential helpers, and with `GH_CONFIG_DIR` at an empty directory. Copilot keeps its stored login or `COPILOT_GITHUB_TOKEN`, which the lane's shell can still read.
- **Debugger lane:** the lane uses the `review` profile at the first red sha, with an AI-credit cap of `factory.heal.debugLaneMaxCredits` (default and minimum 30). The engine's tamper check runs around it, the same one `omg factory run` uses. The lane answers with one fenced JSON block holding a class, a root cause, evidence citations, a reproduced flag and a fix proposal. A citation must name a bundle file and a line in it, or a key of a JSON file. A valid diagnosis parks the heal run at `awaiting-human: heal-approve`. An invalid, rejected or tampered one parks at `awaiting-human: heal-diagnosis`, and `heal run` may retry it. `heal close` ends a parked heal run and frees the one open-run slot. Class `flaky` and fixes that touch `.github/workflows/`, `.github/known-flaky-tests.json` or `.copilot/omg.jsonc` are always rejected. Exit codes are 4 for a park, 3 for a limit refusal, 1 for a failure and 2 for a usage error.
- **Credit limits:** `factory.heal.maxRunCredits` (default 120) caps one heal run and `factory.heal.dailyCredits` (default 150) caps all heal lanes per UTC day. The counters and a seal of each heal record are mirrored outside the repository, under the factory ledger directory. `heal status` reports a seal mismatch.
- **Scan-time record:** when `heal scan` classifies a run from GitHub data, it also writes the class and classification to `heal/<hash>/<sig8>.subject.json` in the factory ledger directory, with its source (`push` or `pr`) and an unkeyed integrity hash (detects corruption, not tampering). A PR run never rewrites a record whose source is `push`; the source comes from that record or from the GitHub run event, never from `.omg/`, and the seal covers it too. `heal run` and `heal approve` take the class and classification only from there, never from `.omg/`. If the in-repo record differs, they warn and ignore it. A missing or corrupt record refuses `heal run`; the next `heal scan` classifies the signature's runs again from GitHub and rewrites it. While a heal run is open, `heal run` requires a matching seal and reuses the subject sealed at its first lane, so a class edited in `.omg/` between two lanes changes nothing. Only a fresh heal run, after the previous one closed, takes a new subject from the scan-time record. A record whose seal no longer matches, or a record stripped of the heal run its seal covers, is refused.
- **ci-heal run:** `heal approve` runs the `omg factory run` engine with the `ci-heal` kind. Its state is `.omg/state/factory/run-heal-<sig8>.json`, its engine record is `run-heal-<sig8>.json` in the factory ledger, and its branch is `factory/heal-<sig8>`. It starts only from an open heal run with a valid diagnosis at `heal-approve` whose out-of-repo seal matches. The engine copies the validated diagnosis fields once and never re-reads the heal record. Intake reads only the repository url (`gh repo view --json url`), and the plan is an engine-rendered template of the diagnosis. Every lane-derived text in the plan and the PR body is fenced and labelled as untrusted. The plan always adds the acceptance line "the failing test(s) listed in classification.json pass, and `npm test` passes". From implement on the run is a normal factory run: review lane, fix rounds, prepare, gates, and the park at `awaiting-human: merge`, which prints the merge command. Merge is always a human step. The draft PR is titled `fix(ci): self-heal for CI signature <sig8>` and its body links the failing runs and shows the environment diff and the diagnosis.
- **ci-heal gates:** without an approval the run parks at `awaiting-human: heal-approve`. `factory.heal.autoImplement` (default `false`) skips that approval. Only the user config can turn it on, and it never applies to `regression-or-env`. When `heal run` reaches a valid diagnosis with `autoImplement` on, it continues into the ci-heal run. A sealed diagnosis that no longer meets the contract (class `flaky`, no fix, a protected path) parks at `awaiting-human: heal-diagnosis`, even after an approval. After any later gate, `heal approve` resumes the run. `heal cancel` cancels it at once when it is parked, and a merged or cancelled run closes its heal run.
- **ci-heal caps:** every lane keeps `factory.run.laneMaxCredits`. The run's credits are bounded by what `factory.heal.maxRunCredits` leaves after the debugger lanes. Before every lane start `factory.heal.dailyCredits` is checked against the heal day counters and the budget ledger's `factory-lane:heal-*` records. Each engine lane is reserved in the counters at its full cap. Too little left parks the run at `awaiting-human: budget`.
- **Known-flaky list:** nothing writes `.github/known-flaky-tests.json`. A diagnosis of class `flaky` gets a proposal of `file`, `title` and `note` entries that `heal status` and `heal run` print. You add the entries by hand on a reviewed PR. A write lane that edits the file parks the run at `awaiting-human: protected-paths`, and `omg ship merge` refuses a PR that touches it.
- **Sandbox:** the ci-heal write lanes use the same lane profiles and the same `factory.run.sandbox` settings as `omg factory run`. The debugger lane is a local `review` session: it has no write tool and no MCP tools, and it gets a shell only when the OS sandbox is confirmed. That shell runs only the read-only allowlist, with every path inside its worktree, so the debugger lane cannot write files. A local lane that the sandbox does not confine, such as a write lane under `writeUnsandboxed: "detect-only"`, runs with your user's file access. Such a lane can write the factory ledger directory directly, including the scan-time record, the seal and the counters mirror. The seal and the scan-time record fully hold only for sandboxed lanes.
- **Webhook:** `omg factory listen` accepts HMAC-signed `workflow_run` events. A completed, failed `push` run of `.github/workflows/ci.yml` on `dev` only adds its run id to `.omg/state/factory/heal/webhook-queue.json`. The next scan puts queued runs first, re-reads them through `gh` and clears them. The webhook never starts a lane.

### `omg smoke copilot`

Headless smoke check of a plugin root against the real GitHub Copilot CLI, in a throwaway `COPILOT_HOME`. Use it on a local build before opening a PR or tagging a release.

```bash
omg smoke copilot                     # tier 0: load check, no model call
omg smoke copilot --tier 1            # tier 0 + one live session, prompt on stdin (one prompt, about 0.4 to 0.9 AI credits measured)
omg smoke copilot --plugin-root /path/to/oh-my-copilot --json
omg smoke copilot --tier 1 --keep-home --delegate --model <id> --max-credits 30 --timeout 180000
omg smoke copilot --sdk-static        # tier 2 SDK static checks only, no model call
omg smoke copilot --tier 2            # tier 2 default scenarios smoke,guardrail (one prompt each, ~0.3 AI credits each measured)
omg smoke copilot --tier 2 --scenario skill,delegate   # or --scenario all
omg smoke copilot --tier 2 --scenario chain            # opt-in: a real two-link factory chain (one prompt per link)
omg smoke copilot --tier 2 --scenario factory-run      # opt-in: omg factory run with a real implement and review lane up to the merge gate (~2 AI credits estimated)
omg smoke copilot --tier 2 --scenario sandbox-lane     # opt-in: review, write and canary copilot_run lanes in the OS sandbox (~3 AI credits estimated)
omg smoke copilot --tier 2 --scenario filetools        # opt-in: pre/postToolUse hooks on the file tools (~0.5 AI credits measured)
omg smoke copilot --tier 2 --scenario continuation,prompt-context,events   # opt-in CLI scenarios (~1.4 AI credits measured)
```

- **Tier 0** checks: `plugin.manifest`, `plugin.hooks`, `copilot.binary`, `copilot.plugin_list`, `copilot.skill_list`, `copilot.agents`, `mcp.list_tools`. `mcp.list_tools` spawns `dist/mcp/standalone-server.js`, so run `npm run build` first.
- **Tier 1** adds `session.exit`, `session.events`, `hooks.*` (including `hooks.adapter_errors`), `plugins.loaded`, `mcp.server_loaded`, `state.written`, and with `--delegate` `subagent.selected`. Hooks run with `OMC_HOOK_FAIL_CLOSED=1`; a `hook.end` without `success: true` fails its check, and `hooks.adapter_errors` fails on any `[omg-hook]` error line.
- **Tier 2** drives the installed `copilot` binary through the optional peer `@github/copilot-sdk` (install it with `npm i -g @github/copilot-sdk --omit=optional --ignore-scripts`; a nested `@github/copilot-sdk-<platform>` runtime package is unused and can be deleted, see [DEVELOPERS.md](./DEVELOPERS.md#tier-2--sdk-scenarios)). It runs the tier 0 checks, then the SDK static checks `sdk.available`, `sdk.runtime`, `sdk.plugins`, `sdk.skills`, `sdk.agents`, `sdk.mcp`, `sdk.tools_excluded` (our `<server>-host_smoke` tool is absent from the session's tool list) and `sdk.sandbox`, then the chosen scenarios. `sdk.sandbox` reports `sandbox.getHostSupport` and its capabilities. On a supported host it applies `copilot_run`'s review policy to the static session and reads the enforcement status. Then it runs a free spawn canary: a second runtime with the env a `copilot_run` lane gets, the review policy with the lane tool grants on its session, and one shell call through `shell.executeUserRequested`, with no model turn. That call runs the engine's node and the `node` on the lane's `PATH` (the one the hooks and the plugin MCP server run) with `--version`, then `git --version`, and on Windows git's `usr\bin\sh.exe -c`, which git hooks need. It launches real programs, not a shell builtin, so a sandbox that denies every child process fails it. It fails when the probe gets no answer, when a supported host reports enforcement `blocked`, when node or git does not print its line, or when the launch is not attested `sandboxed: true`. The `sh.exe` result is reported but does not fail the check: on Copilot CLI 1.0.105 it exits `0xC0000142` (`STATUS_DLL_INIT_FAILED`, the MSYS runtime cannot initialize inside the sandbox) with the Git root granted, so git hooks and anything else git runs through `sh` cannot run in Windows lanes. On Windows, a git that is not a Git for Windows install has no `sh.exe` to check, and the detail says so. An unsupported host passes, because its lanes fail closed, and the detail starts with `unsupported`. The exception is a Linux host that the runtime reports as supported but where the trial bwrap launch fails, for example under [restricted user namespaces](#linux-restricted-user-namespaces). That check fails with a detail that starts with `launch-blocked` and names the reason, and the canary does not run. It does not run the tier 1 `-p` session. `--sdk-static` runs no scenario and makes no model call.
- **Tier 2 scenarios** yield checks prefixed `scn.<name>.`. Each one also gets `scn.<name>.exit`, `scn.<name>.adapter_errors` (fails on any `[omg-hook]` or `[run.cjs]` hook stderr line, such as a hook timeout), and `scn.<name>.cost`. Each scenario sends one prompt, measured at 0.29 to 0.91 AI credits on small models, so the default run costs about 0.6 AI credits.

| Scenario | Prompt exercises | Key checks |
|---|---|---|
| `smoke` (default) | a plain reply, no tools | `scn.smoke.reply`, `scn.smoke.hooks`, `scn.smoke.no_tools` |
| `guardrail` (default) | `git push --force` with `OMC_GIT_GUARDRAILS=1` against a bare remote | `scn.guardrail.denied`, `scn.guardrail.no_push`, `scn.guardrail.hooks` |
| `skill` | `/oh-my-copilot:plan` | `scn.skill.invoked` |
| `delegate` | a hand-off to `oh-my-copilot:architect` | `scn.delegate.selected`, `scn.delegate.hooks`, `scn.delegate.completed` |
| `filetools` (opt-in, never in `all`) | view and edit `filetools/notes.txt`, create `filetools/new/created.txt`; each directory holds a `README.md` with a fresh nonce | `scn.filetools.tools`, `scn.filetools.hooks`, `scn.filetools.pre`, `scn.filetools.post`, `scn.filetools.matcher`, `scn.filetools.payload`, `scn.filetools.injected`, `scn.filetools.injected_write` |
| `chain` (opt-in, never in `all`) | two real `copilot -p` factory links: link 1 replies with one token, link 2 runs the project skill `/chain-ack` | `scn.chain.link1`, `scn.chain.spawned`, `scn.chain.inherited`, `scn.chain.closed`, `scn.chain.credits` |
| `factory-run` (opt-in, never in `all`; ~2 AI credits estimated) | `omg factory run` in-process on a sandbox repository with a bare `origin` and a scripted `gh`: a real implement lane writes `greet.txt`, a real review lane approves, prepare and green gates, then the park at `awaiting-human: merge` | `scn.factory-run.lanes`, `.implemented`, `.reviewed_on_head`, `.verdict_recorded`, `.tamper`, `.draft_pr`, `.parked`, `.no_merge`, `.no_lane_push`, `.state_resumable`, `.credits` |
| `factory-run-fix` (opt-in, never in `all`; ~4 AI credits estimated) | as `factory-run`, but the first review requests changes, a fix lane runs, and a new review approves the new head | the `factory-run` checks under `scn.factory-run-fix.` |
| `sandbox-lane` (opt-in, never in `all`; ~3 AI credits estimated) | three `copilot_run` lanes in the OS sandbox with the default settings. A review lane tries to write. A write lane runs a probe against targets outside its grant, the network and its worktree, and the engine commits its change. A canary lane runs the probe through `shell.executeUserRequested`. | `scn.sandbox-lane.host`, `.review_no_write`, `.write_inside`, `.write_outside_blocked`, `.network_blocked`, `.attested`, `.engine_commit`, `.q1_profile`, `.q2_git_dir`, `.q5_canary_rpc`, `.credits` |
| `continuation` (opt-in CLI, 0.31 AI credits measured) | a stub Stop hook blocks the first stop once with a nonce reason | `scn.continuation.blocked`, `scn.continuation.reason_injected`, `scn.continuation.stop_hook_active`, `scn.continuation.echo` |
| `prompt-context` (opt-in CLI, 0.29) | a stub UserPromptSubmit `additionalContext` nonce the model must echo | `scn.prompt-context.accepted`, `scn.prompt-context.reached_model` |
| `events` (opt-in CLI, 0.76) | view a missing file, a shell call under default permissions, then `/compact` on the resumed session | `scn.events.post_tool_use_failure`, `scn.events.permission_request`, `scn.events.pre_compact` |
| `ultragoal` (opt-in CLI, 0.65; pending lane g-cont) | ultragoal activated by our UserPromptSubmit group, past the confirmation TTL; tools must not be denied | `scn.ultragoal.seeded`, `scn.ultragoal.tools_allowed` |

- **CLI scenarios.** `continuation`, `prompt-context`, `events` and `ultragoal` run headless `copilot` sessions with the plugin under test, not SDK sessions; see [DEVELOPERS.md](./DEVELOPERS.md#tier-2--sdk-scenarios) for what each one sets up. A scenario in `PENDING_SCENARIOS` is written to behaviour another lane delivers: its failing checks start with a `[PENDING …]` note.

- **`filetools` scenario.** The model gets no shell and may read and write only under the sandbox project. The session loads a second plugin next to ours, a probe whose `PreToolUse`, `PostToolUse`, `PostToolUse` with our `Read|Write|Edit|MultiEdit` matcher, `preToolUse` and `postToolUse` entries append their stdin payload to `<home>/filetools-probe.jsonl`. A record belongs to the tool call whose arguments equal its tool input, since neither payload carries the call id. `pre`, `post` and `matcher` fail when a completed file tool call has no record of that entry; `payload` checks that the Claude-format records name the tool `Read`, `Write` or `Edit` and carry its path (for `apply_patch`, the patch text's file lines). `injected` passes when the nonce from `filetools/README.md` is in a `postToolUse` `hook.end` output and in the result of a view call, which is the text the runtime sends the model; `injected_write` does the same for `filetools/new/README.md` and a write call (`create`, `edit` or `apply_patch`). A view of a README itself never counts. Whether the model echoed the nonce is reported, not required. The model picks its tools: `auto` has used `edit` and `create`, or one `apply_patch` for both files.
- **`chain` scenario.** It does not use an SDK session. It seeds the sandbox with `omg factory init` plus a `success:*` route to stage `link-2`, pre-writes link 1's ledger, and spawns link 1 like a factory link (AFK profile, `--plugin-dir`, `OMC_CHAIN_LINK`). The chain then runs itself through the SessionEnd hook and worker, and stops at the stage-visit cap after link 2. The checks read the ledgers, decisions, stop marker, and both link sessions' `events.jsonl`: link 1 was resolved by `OMC_CHAIN_LINK`, link 2 was spawned and ended under its own inherited identity, the chain closed out (`loop-capped:link-2`, no open ledger), and both links together cost at most 6 AI credits (`scn.chain.credits`, a ceiling against a runaway link). The links run on the CLI's default model without `--max-ai-credits`, because a factory link's argv carries no credit cap, so `--max-credits` does not bound them. `--timeout` applies to link 1 and again to the wait for link 2.
- **`factory-run` and `factory-run-fix` scenarios.** Neither uses an SDK session. The factory engine runs in-process with the real `copilot_run` lane backend, which uses the installed binary, the plugin under test and the smoke home's login. Nothing touches GitHub. Every lane is capped at the 30-credit runtime minimum, with at most one fix round and no retry, so the lane count is fixed: two for `factory-run`, four for `factory-run-fix`. `scn.<name>.credits` sums the lane usage the engine recorded. It fails above 6 or 12 AI credits, which is 3 per lane: a ceiling against a runaway lane, as for `chain`. `.no_merge` fails on any `gh pr merge` that reaches the scripted `gh`, or on a moved base branch in the bare remote. The engine's factory guard refuses a merge before that. See [DEVELOPERS.md](./DEVELOPERS.md#tier-2--sdk-scenarios) for the setup.
- **`sandbox-lane` scenario.** It uses no SDK session of the driver. It runs `copilot_run` lanes in-process, each capped at 30 credits, with the default sandbox settings. Your user config and `OMG_SANDBOX` do not apply. Each check:
  - `host`: the host is supported and all three lanes ran `enforced`.
  - `review_no_write`: the review lane completed, at least one of its shell calls succeeded, and nothing it was told to write landed. A lane whose commands never ran fails: a target that did not land proves nothing then.
  - `write_inside`: the write lane created its worktree file.
  - `write_outside_blocked`: the probe ran (its output line is in the lane's events) and its writes to the main checkout and to a shared directory outside the temp dir were blocked. `q1_profile` and `q2_git_dir` also need the probe output. The detail notes when the main checkout lies under the temp dir, which the default grant includes.
  - `network_blocked`: the loopback listener got no request, and `https://github.com` was unreachable.
  - `attested`: every shell call carried `sandboxed: true`.
  - `engine_commit`: the engine committed exactly the worktree file.
  - `credits`: every lane capped at 30, and at most 9 AI credits in total. The detail names the model each lane ran on.

  The lanes of `sandbox-lane`, `factory-run` and `factory-run-fix` run on the session's model: `--model`, else the cheap model the driver picked. With runtime auto (no cheap model listed) lanes measured about 3.6 AI credits each on Sonnet and fail the `credits` ceiling. The cost line's `model` says what the lanes were pinned to and what they ran on.

  `q1_profile`, `q2_git_dir` and `q5_canary_rpc` each answer an open question in one line; see [Sandboxed lanes](#sandboxed-lanes). The host checks every target itself and deletes what landed, but only files named after the run's nonce. The relocated profile is the exception: the job deletes its home, so that write comes from the probe's own report. See [DEVELOPERS.md](./DEVELOPERS.md#tier-2--sdk-scenarios) for the setup.

- **Tier 2 report** adds `sdk` (SDK version, runtime version, protocol version), `cost` (AI credits and legacy premium requests summed over scenarios), and `artifacts.events` with one events JSONL path per scenario. Human output groups the `sdk.*` checks and each scenario's `scn.<name>.*` checks under a heading.
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

### `omg hooks doctor`

Checks the Copilot hook wiring as Copilot CLI runs it: `node` on PATH, `copilot/hooks.json` in sync with `scripts/copilot/build-hooks.mjs` (read only), every hook script path present, a dry dispatch of each entry with a recorded Copilot payload (timing and stderr, which Copilot only writes to its debug log), and the installed Copilot CLI against the verified target 1.0.91.

```bash
omg hooks doctor                    # all checks; the hooks run in a throwaway project and home
omg hooks doctor --event Stop       # dispatch one event
omg hooks doctor --no-dispatch --json
```

Each check is `ok`, `WARN` (hook stderr, a run over 80% of its timeout, a CLI version other than the target) or `FAIL` (node missing, drift, a missing script, a non-zero exit, a timeout, non-JSON stdout). Exit `1` when a check failed. Details: [DEVELOPERS.md](./DEVELOPERS.md#copilot-hooks-per-event-dispatcher).

### MCP tools `copilot_run_*` (delegate a task to Copilot)

The standalone MCP server can hand a task to GitHub Copilot as a background job: one headless `@github/copilot-sdk` session per job, driven like an sdk team worker. Claude Code (or any MCP client) starts the job, waits for it, and reviews the result in a separate git worktree.

| Tool | Arguments | What it does |
|------|-----------|--------------|
| `copilot_run_start` | `prompt`, `cwd?`, `model?`, `timeoutMs?`, `maxCredits?`, `isolation?`, `startRef?`, `profile?` | Starts the job and returns its `jobId` (`cr-<12 hex>`) at once. |
| `copilot_run_status` | `jobId` | The job report, without waiting. |
| `copilot_run_wait` | `jobId`, `timeoutMs?` | Waits until the job ends or `timeoutMs` passes (default 300000, max 3600000), then returns the report. |
| `copilot_run_cancel` | `jobId` | Aborts the turn and stops the session. The worktree and its changes stay. |
| `copilot_run_cleanup` | `jobId` | Removes a finished job's worktree and branch, only when nothing in them would be lost. |

The report is JSON: `status` (`starting`, `running`, `completed`, `failed`, `timeout`, `cancelled`), `profile`, `startRef` (when given), `stopRequested` (`cancelled`, `timeout` or `capped` from the moment a stop is asked for, while the teardown may still run; else `null`), `finalText` (the last assistant message), `sessionId`, `model`, `error`, `usage` (`credits` in AI Credits, the legacy `premiumRequests`, `source`: `measured` once the session's `session.shutdown` totals arrived, else `estimated`), `worktree` (`path`, `branch`, `repoRoot`, `baseCommit`, `removed`), and once the job has ended `changes` (`diffStat` from `git diff --stat <baseCommit>`, `changedFiles`, `untrackedFiles`, `protectedChanges`; taken at the repository root with root-relative paths, also when `cwd` is a subdirectory). `deniedPermissions` lists refused requests, `notes` carries setup warnings (uncommitted changes, `isolation: "none"`), and `eventsPath` is the session's event log.

- **Opt-in.** `copilot_run_start` runs a live, billed session and refuses unless `OMG_COPILOT_RUN_ALLOW=1` is set in the MCP server env. The other tools work on existing jobs and need no opt-in. All five are always listed; `OMC_DISABLE_TOOLS=copilot-run` hides them. In-process callers of the job library (the `omg factory run` lanes) pass an explicit `allowLive` opt-in instead of the env var. No MCP argument reaches it.
- **Start ref.** `startRef` (a commit sha or a branch) creates the job worktree at that commit instead of `HEAD`, and `worktree.baseCommit` is its sha. It needs `isolation: "worktree"`. A ref that starts with `-`, holds whitespace or control characters, is longer than 256 characters, or does not resolve to a commit is refused before anything is created. Your uncommitted changes are irrelevant then, so no note warns about them.
- **Profile.** `profile: "write"` (default) is the worker policy below. `profile: "review"` also denies the write tool entirely, any global `git -c` or `--config-env`, `git fetch` with a refspec, and the git subcommands that change the tree, its refs or its config: `commit`, `reset`, `checkout`, `merge`, `rebase`, `stash`, `switch`, `restore`, `cherry-pick`, `revert`, `apply`, `am`, `branch`, `tag`, `update-ref`, `symbolic-ref`, `worktree`, `notes`, `replace`, `push` and `config`. They are matched like the `git push` rule. Read-only git such as `git diff`, `git log` and `git merge-base` stays allowed. On top of that, a review session's shell commands must pass the read-only allowlist, and it gets a shell at all only inside a confirmed OS sandbox. See [Sandboxed lanes](#sandboxed-lanes). Still check that `changes` is empty after a review job.
- **Stop continuations.** In-process lanes also turn off the blocking Stop hooks in their session (`OMC_SKIP_HOOKS=persistent-mode,workflow-drift-guard,code-simplifier`), so no Stop block silently costs a request. The drift guard would otherwise block on a review verdict that quotes a TODO. The other hooks, git guardrails among them, keep running. The MCP tools leave the hooks as they are.
- **Budget ledger.** The spend is recorded in the [`omg budget`](#omg-budget-ai-credits-budget) ledger as session `copilot-run:<jobId>` (in-process lanes: `factory-lane:<laneId>`): a live estimate, replaced by the measured totals at the end. The budget never refuses a job; `maxCredits` (below) caps it.
- **Isolation.** `isolation: "worktree"` (default) creates a git worktree and branch from the repository's `HEAD` (or `startRef`) at `.omg/team/copilot-run/worktrees/<jobId>`, branch `omc-team/copilot-run/<jobId>`, with the team worktree code. Uncommitted changes in your tree are not in it (a note says so). Copilot works only there; `cwd` must be inside a git repository. `isolation: "none"` lets Copilot edit `cwd` directly, and its `changes` then include edits that were already there.
- **Permissions.** As for sdk team workers: no allow-all, writes only inside the working directory and the job's temp dir (`<job home>/tmp`, never the rest of the job home or the job dir with `events.jsonl`), reads also in the plugin root, MCP calls only to the plugin server, the same shell denylist (`git push`, team control, `omg smoke`, multiplexers). Writes to the `omg ship` merge-rule paths (`.copilot/omg.jsonc`, `.copilot/omc.jsonc`, `.github/known-flaky-tests.json`, `.github/workflows/`, plus a non-default `ship.knownFlakyFile` from your user config or the repository's `.copilot/omg.jsonc`) are refused, and `changes.protectedChanges` flags any such file that changed anyway. The shell denylist is not a sandbox. The OS sandbox confines shell commands, and without a confirmed sandbox a write job refuses unless `copilotRun.sandbox.writeUnsandboxed` is `"detect-only"`. See [Sandboxed lanes](#sandboxed-lanes). The session cannot start jobs of its own: the `copilot_run_*`, `host_smoke` and sub-agent tools are excluded and `OMG_COPILOT_RUN_ALLOW` is stripped from its env.
- **Limits.** `timeoutMs` defaults to 900000 (15 min), at most 3600000, counted from start; at the timeout the turn is aborted and the status is `timeout`. `maxCredits` (default 30) aborts the turn once the session's AI credits pass it (status `failed`); the runtime also gets `--max-ai-credits` of at least 30, the CLI minimum. At most 2 jobs run at once per MCP server.
- **Cleanup.** `copilot_run_cleanup` refuses while the worktree has uncommitted changes or commits your `HEAD` does not contain: merge the branch (or discard the changes), then call it again. Files git ignores (build output such as `dist/`, `.env`, `node_modules`) are not protected work: they are deleted with the worktree. Symlinks and junctions in it (a linked `node_modules`) are unlinked first, so their targets are never emptied. Nothing is removed automatically.
- **Git state in the worktree.** The session commits on a detached `HEAD`. When the session ends, the job's branch is moved to that commit from your repository root. In the OS sandbox no ref is writable, so one job cannot rewrite another job's branch. The session can still write its worktree's `.git` file and its admin dir under `.git/worktrees/<name>`. The job records the `.git`, `gitdir` and `commondir` files at creation. Host git runs in the worktree only while they match, and only with the recorded `--git-dir` and `--work-tree`. If they changed, the job fails as `sandbox-escaped`, no git runs in the worktree, and `copilot_run_cleanup` removes the worktree and its admin dir by path. The branch is then kept for inspection. Host git pins `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR` to the recorded paths, so it reads no link file after the check. The job also kills the runtime's process tree when the session ends, clean or not, before any host git. The repository config of a job worktree counts as session-controlled, including `config.worktree` when the repository sets `extensions.worktreeConfig` (sparse-checkout does). Every host git command in job and team worktrees therefore runs with an empty `core.hooksPath`, `core.fsmonitor=false`, `core.pager=cat`, an empty `diff.external` and `credential.helper`, and fixed `core.sshCommand`, `gpg.program`, `core.editor` and `sequence.editor`. Commands that touch work-tree files (`status`, `diff`, `ls-files`, `checkout` and the like) also get an empty `core.attributesFile` and blank every filter and diff driver a non-system config level names. `-c extensions.worktreeConfig=false` does not help: git still reads `config.worktree`. `copilot_run_cleanup` removes a job worktree and its admin dir by path, not with `git worktree remove`. The review tamper check reads the lane worktree the same way. `objects/info/alternates` stays writable because `objects/` must be. It runs no code and cannot forge an object, since git names objects by the hash of their content.
- **Known follow-up: unhardened team git.** The team merge-orchestrator, merge-coordinator, mcp-team-bridge and runtime-v2 paths still run plain git in worker worktrees, which discovers the git dir through the worker-writable `.git` file and reads worker-writable config. That code predates the sandbox and is not on the `copilot_run` path. Until it moves to the hardened runner, do not use it with sandboxed lanes.
- **Lifetime.** Jobs live in the MCP server process. When the server shuts down (a signal, or its stdin closing), it cancels the running jobs, waits up to 3 s for their teardown and then kills the Copilot runtimes still alive; the job ids are gone, and the worktrees and branches stay for review. A server killed outright stops nothing, and its runtimes can outlive it. The job's `COPILOT_HOME` (`.omg/state/copilot-run/<jobId>/home`) is deleted after a completed job and kept otherwise; the events log stays until cleanup.
- **Requirements.** `@github/copilot-sdk` and the `copilot` CLI, resolved like `omg smoke copilot` tier 2. The session reuses your Copilot login identity.

```bash
claude mcp add omg-dev -e OMG_COPILOT_RUN_ALLOW=1 -- node C:/Code/OMC/dist/mcp/standalone-server.js
```

```json
{ "tool": "copilot_run_start", "arguments": { "prompt": "Add a --dry-run flag to scripts/release.mjs and a test for it. Commit your change.", "cwd": "C:/Code/OMC" } }
{ "tool": "copilot_run_wait", "arguments": { "jobId": "cr-3f9a1c2b7d4e", "timeoutMs": 600000 } }
```

### `omg budget` (AI Credits budget)

Copilot bills usage in AI Credits since 2026-06-01 (they replaced premium requests). The budget governor keeps a ledger of the AI Credits this project's Copilot sessions and teams used and warns once at an optional soft limit. It is reporting only: it never blocks a session, and `omg team` never clamps or refuses a launch on budget. Premium requests stay in the ledger as a legacy field, because Copilot CLI still reports them.

To cap spend, use Copilot's own limits:

- **Per session:** `copilot --max-ai-credits <n>` or the SDK's `sessionLimits.maxAiCredits`. It is a soft cap checked after each model call, and since Copilot CLI 1.0.67 it cannot be below 30. `omg team` sdk workers get it from `team.sdk.maxCreditsPerWorker`, and `copilot_run_start` from `maxCredits`.
- **Per user, cost center or organization:** Copilot admin budgets in US dollars ($0.01 per AI credit). They are hard stops with no cheaper-model fallback.

```bash
omg budget                  # usage since the last reset against the soft limit
omg budget status --json    # the full ledger: sessions, teams, measured vs estimated records
omg budget reset            # start a new accounting period
```

Configure it in `.copilot/omg.jsonc` (or the user config). Nothing warns until you set `softLimit`:

```jsonc
{
  "budget": {
    "softLimit": 150             // AI credits: one warning per period, never a block
  }
}
```

`mode`, `hardLimit`, `perTeamLimit` and `"unit": "premiumRequests"` are deprecated no-ops. They still parse, and a config that sets any of them gets one deprecation warning naming [MIGRATION.md](./MIGRATION.md#unreleased-budget-unit-is-ai-credits). `"unit": "credits"` is accepted and changes nothing.

**Units.** Usage and `softLimit` count AI Credits. One AI Credit is $0.01, and Copilot prices each model call per input, output and cached token by model ([models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)). Copilot writes usage as `totalNanoAiu` (nano-AIU); the governor divides it by 1e9 to get AI credits, the same convenience conversion the SDK documents. Cost per prompt varies by model, by the tokens sent and received, and by the number of model calls a prompt triggers. There is no fixed figure per prompt. Short smoke prompts measured 0.29 to 0.91 AI credits on Copilot CLI 1.0.91 with small models (`omg smoke copilot`). A `softLimit` written for premium requests now counts AI Credits; [MIGRATION.md](./MIGRATION.md) shows how to convert it.

**What is measured.** The ledger lives at `.omg/state/budget-ledger.json`. Each record holds `credits` and the legacy `premiumRequests` and is labelled `measured` or `estimated`:

- **Copilot CLI sessions** are read from `$COPILOT_HOME/session-state/<session id>/events.jsonl`. Its `session.shutdown` and `session.usage_checkpoint` events carry `totalNanoAiu` (AI Credits x 1e9) and the legacy `totalPremiumRequests`; those are measured. Copilot CLI 1.0.91 writes them when the session ends and does not persist the per-call `assistant.usage` events, so a running session is an estimate: 1 AI credit (and one legacy premium request) per top-level prompt. The file is read incrementally (the record keeps a byte offset and count, at most 8 MB per hook call), so an estimate only grows. The next SessionStart checks up to 20 estimated records (sessions and pane team workers, in rotation) by reading the last 64 KB of their events file, skips files unchanged since the last check, replaces an estimate with the measured totals once they exist, and marks a record final when its events file is gone.
- **SDK team workers** (`omg team` sdk transport) are recorded by their host from the live `assistant.usage` events: AI Credits as billed, and legacy premium requests counted x1 per user-initiated call. The record is an estimate until the `session.shutdown` totals replace it when the worker stops. Pane team workers are recorded by their own hooks under the team.
- A measured record is never replaced by an estimate, and an estimate never goes down. If a session's measured total ever drops (for example a resumed session that restarts its counter), the ledger keeps the larger credits and premium request values and says so in the record's `detail`.
- `omg budget reset` starts a new period for running sessions too: prompts before the reset no longer count, and a session's later cumulative totals have its pre-reset usage subtracted (an estimate when that pre-reset part was estimated).
- A non-zero `estimatedRecords` means part of the total is estimated: the summary line and threshold notices add `; N record(s) estimated` / `(N record(s) estimated)`, and the HUD value gets a leading `~`.
- A pane team worker started without `OMC_TEAM_LEADER_CWD` records into the ledger of its own working directory (usually its worktree), not the leader's; `omg team` sets the variable for the workers it launches.
- A corrupt or foreign-version ledger is copied to `budget-ledger.json.corrupt` before it is rebuilt.

**Hooks.** `scripts/premium-budget.mjs` (the file keeps its name) runs in the SessionStart, UserPromptSubmit and Stop groups of the per-event dispatcher. SessionStart prints one summary line when `softLimit` or a deprecated key is set; the line carries the deprecation warning. Stop records the turn's usage and, on the first crossing of `softLimit` per period, stores a notice that the next prompt delivers as context; raising the limit re-arms the notice. The phase arguments are `start`, `turn` and `submit`. Each hook waits at most 250 ms for the ledger lock, and the SessionStart refresh is bounded (above). The hook fails open: an error, a missing build or an unreadable ledger produces no output. It never blocks a session.

**HUD.** The `creditBudget` element shows `cr:4.2/150`, AI credits used against `softLimit`, yellow once the soft limit is reached. It appears only when `softLimit` is set, except under Copilot CLI, where without a limit it shows the session's credits from the statusline payload (`cr:0.4`, hidden at zero); `"creditBudget": false` under `elements` hides it. The old name `premiumBudget` still works as the toggle and in `layout` / `elementOrder` while `creditBudget` is unset.

**Teams.** `omg team` starts every requested worker whatever the ledger holds. It does not project, clamp or refuse a launch. `--budget-override` is a deprecated no-op that prints one warning.

`omg budget` always exits 0. `omg doctor conflicts` warns about invalid and deprecated `budget` values; the governor ignores both and keeps its defaults. `OMC_BUDGET_GOVERNOR=0` turns everything off.

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
- For `omg ask muse`, install and authenticate the Muse CLI before running automation.
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

### By Domain

| Domain             | Agent                   | Default Model | Alternative Models      |
| ------------------ | ----------------------- | ------------- | ----------------------- |
| **Analysis**       | `architect`             | sonnet        | haiku (simple), opus (complex) |
| **Execution**      | `executor`              | sonnet        | haiku (trivial), opus (complex) |
| **Search**         | `explore`               | haiku         | -                       |
| **Research**       | `document-specialist`   | sonnet        | -                       |
| **Frontend**       | `designer`              | sonnet        | haiku (simple), opus (complex) |
| **Docs**           | `writer`                | haiku         | -                       |
| **Visual**         | `vision`                | sonnet        | -                       |
| **Planning**       | `planner`               | opus          | -                       |
| **Critique**       | `critic`                | opus          | -                       |
| **Pre-Planning**   | `analyst`               | opus          | -                       |
| **Testing**        | `qa-tester`             | sonnet        | -                       |
| **Tracing**        | `tracer`                | sonnet        | -                       |
| **Security**       | `security-reviewer`     | sonnet        | opus (complex audit)    |
| **Build**          | `debugger`              | sonnet        | -                       |
| **TDD**            | `test-engineer`         | sonnet        | -                       |
| **Code Review**    | `code-reviewer`         | sonnet        | -                       |
| **Data Analysis**  | `scientist`             | sonnet        | opus (complex analysis) |
| **Git**            | `git-master`            | sonnet        | -                       |
| **Simplification** | `code-simplifier`       | sonnet        | -                       |

### Agent Selection Guide

| Task Type                      | Best Agent                                                             | Model  |
| ------------------------------ | ---------------------------------------------------------------------- | ------ |
| Quick code lookup              | `explore`                                                              | haiku  |
| Find files/patterns            | `explore`                                                              | haiku  |
| Complex architectural search   | `architect`                                                            | opus   |
| Simple code change             | `executor` (model="haiku")                                             | haiku  |
| Feature implementation         | `executor`                                                             | sonnet |
| Complex refactoring            | `executor` (model="opus")                                              | opus   |
| Debug simple issue             | `architect` (model="haiku")                                            | haiku  |
| Debug complex issue            | `architect`                                                            | opus   |
| UI component                   | `designer`                                                             | sonnet |
| Complex UI system              | `designer` (model="opus")                                              | opus   |
| Write docs/comments            | `writer`                                                               | haiku  |
| Research docs/APIs             | `document-specialist` (repo docs first; optional Context Hub / `chub`) | sonnet |
| Analyze images/diagrams        | `vision`                                                               | sonnet |
| Strategic planning             | `planner`                                                              | opus   |
| Review/critique plan           | `critic`                                                               | opus   |
| Pre-planning analysis          | `analyst`                                                              | opus   |
| Test CLI interactively         | `qa-tester`                                                            | sonnet |
| Evidence-driven causal tracing | `tracer`                                                               | sonnet |
| Security review                | `security-reviewer`                                                    | sonnet |
| Quick security scan            | `security-reviewer` (model="haiku")                                     | haiku  |
| Fix build errors               | `debugger`                                                             | sonnet |
| Simple build fix               | `debugger` (model=haiku)                                               | haiku  |
| TDD workflow                   | `test-engineer`                                                        | sonnet |
| Quick test suggestions         | `test-engineer` (model=haiku)                                          | haiku  |
| Code review                    | `code-reviewer`                                                        | opus   |
| Quick code check               | `code-reviewer` (model=haiku)                                          | haiku  |
| Data analysis/stats            | `scientist`                                                            | sonnet |
| Quick data inspection          | `scientist` (model=haiku)                                              | haiku  |
| Deep data analysis            | `scientist` (model="opus")                                             | opus   |
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

## Skills (63 Total)

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
| `ship`                    | Task or PR to merge-ready: executor lane, independent verifier lane, bounded fix rounds, `omg ship` gates | `/oh-my-copilot:ship` |
| `session-flow`            | Reorient in the current session with an evidence-backed map of its flow        | `/oh-my-copilot:session-flow`           |
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

Most installed skills are exposed as `/oh-my-copilot:<registered-name>`. The plugin ships 21 command files alongside the 63 skill entrypoints listed above; the commands below list both surfaces. Compatibility keyword modes like `deep-analyze` and `tdd` are prompt-triggered behaviors, not standalone slash commands. OMC's manual compaction helper is plugin-scoped as `/oh-my-copilot:compact`; bare `/compact` remains Claude Code's native command and is not shadowed by OMC. The helper preserves the user's note and instructs them to run bare `/compact`; OMC does not invoke native compaction itself because Claude Code's built-in `/compact` is not a prompt skill.

| Command                                                  | Description                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/oh-my-copilot:ai-slop-cleaner <target>`             | Run the anti-slop cleanup workflow (`--review` for reviewer-only pass)                        |
| `/oh-my-copilot:agent-doc-discipline`                 | Apply the writing-time discipline for agent-facing documents                                   |
| `/oh-my-copilot:ask <claude\|codex\|gemini\|antigravity\|grok\|cursor\|muse> <prompt>` | Route a prompt through the selected advisor CLI and capture an ask artifact                   |
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
| `/oh-my-copilot:drydock [--check]`                   | Lay the shipyard harness keel in a repo (two faces seeded day one; every other surface appears on first use); --check audits drift |
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
| `/oh-my-copilot:ship <task> \| --pr <n>`              | Take a task or PR to merge-ready through independent review and the `omg ship` gate engine     |
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
| **UserPromptSubmit**   | `keyword-detector.mjs`, `skill-injector.mjs`, `premium-budget.mjs submit`                                        | 30s outer fuse per command; 8s, 12s trusted Worker limits (5s for `premium-budget.mjs submit`) |
| **SessionStart**       | `session-start.mjs`, `project-memory-session.mjs`, `premium-budget.mjs start`, `setup-init.mjs` (init), `setup-maintenance.mjs` (maintenance) | 5s, 5s, 5s, 30s, 60s |
| **PreToolUse**         | `pre-tool-enforcer.mjs`                                                                                           | 5s trusted Worker |
| **PermissionRequest**  | `permission-handler.mjs` (Bash only)                                                                              | 5s               |
| **PostToolUse**        | `post-tool-verifier.mjs`, `project-memory-posttool.mjs`, `post-tool-rules-injector.mjs`, `post-tool-directory-context-injector.mjs` | 5s, 3s, 3s, 3s trusted Workers |
| **PostToolUseFailure** | `post-tool-use-failure.mjs`                                                                                       | 3s               |
| **SubagentStart**      | `subagent-tracker.mjs start`                                                                                      | 3s               |
| **SubagentStop**       | `subagent-tracker.mjs stop`, `verify-deliverables.mjs`                                                            | 5s, 5s           |
| **PreCompact**         | `pre-compact.mjs`, `project-memory-precompact.mjs`                                                                | 10s, 5s          |
| **Stop**               | `context-guard-stop.mjs`, `workflow-drift-guard.mjs`, `persistent-mode.mjs`, `premium-budget.mjs turn`, `code-simplifier.mjs` | 5s, 3s, 10s, 5s, 5s |
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
| **macOS**   | Claude Code Plugin          | Node.js (.mjs) |
| **Linux**   | Claude Code Plugin          | Node.js (.mjs) |

> **Windows**: Native Windows (win32) support is experimental. Features that launch tmux-backed worker panes require a tmux-compatible binary. OMC supports native [psmux](https://github.com/psmux/psmux) for PowerShell 7+ users who want visible Claude Code teammate panes in interactive team workflows, and recommends WSL2 as the fallback when no compatible `tmux` command is installed or native Windows behavior is insufficient. psmux does not force worktree agents, non-interactive/print-mode agents, or model-selected in-process agents into visible panes. Native Windows issues may have limited support.

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

`omg doctor conflicts --json` prints the full conflict report (every check above, plus
`hasConflicts`) as a single JSON document on stdout instead of the coloured human
report; the human report is unchanged when `--json` is omitted. `--json` and
`--plugin-dir` work both on `omg doctor` (flag form, e.g. `omg doctor --team-routing
--json`) and on `omg doctor conflicts`/`omg doctor team-routing` directly.

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
| `omcLabel`   | Show the `[oh-my-copilot#version]` label. `omgLabel` is an alias, and both names work in `layout` and `elementOrder`  | `true`  |
| `updateNotification` | Show the available-update arrow after the label and the `updateHint` line with the update command                    | `true`  |
| `contextBar` | Show context window usage                                                                                            | `true`  |
| `agents`     | Show active agents count                                                                                             | `true`  |
| `todos`      | Show todo progress                                                                                                   | `true`  |
| `ralph`      | Show ralph loop status                                                                                               | `true`  |
| `autopilot`  | Show autopilot status                                                                                                | `true`  |
| `showTokens` | Show transcript-derived token usage (`tok:i1.2k/o340`, plus `r...` reasoning and `s...` session total when reliable) | `false` |

**Host matrix.** The HUD detects the host from the statusline payload and applies a Copilot overlay over the preset, under your own config. Claude Code output is unchanged.

| Element | Claude Code | Copilot CLI | Copilot data source |
| --- | --- | --- | --- |
| `omcLabel` (`omgLabel`) | on | on | label `[oh-my-copilot#version]` on both hosts |
| `contextBar` | on | on | payload `context_window` |
| `sessionHealth` | on | on | payload `cost.total_duration_ms` |
| `creditBudget` | on | on | payload `ai_used.total_nano_aiu` (`cr:0.4`), or the budget ledger when a `softLimit` is set |
| `agents`, `activeSkills`, `lastSkill`, call counts (`T:` `A:` `S:`), `showLastTool`, `showRecentTools` | on | on | the tail of the session's `events.jsonl` |
| `ralph`, `autopilot`, `prdStory`, `backgroundTasks` | on | on | OMC state files |
| `copilotMode` | off | on | `session.mode_changed` events (`mode:plan` or `mode:autopilot`) and the payload `allow_all_enabled` (`mode:yolo`), combined as `mode:plan+yolo` |
| `team` | off | on | live `omg team` run state under `.omg/state/team/`, repo-wide |
| `ultragoal` | off | on | open ultragoal plan in `.omg/ultragoal/goals.json` or `plans/<id>/goals.json`, repo-wide |
| `model`, `effort`, `cwd`, `gitBranch` | model, effort on; cwd, gitBranch per config | off | Copilot's footer already shows them; set `true` to show them anyway |
| `rateLimits`, `enterpriseMode`, `showEnterpriseCost`, `apiKeySource`, `thinking`, `todos`, `sessionSummary`, payload warning | per config | off, forced | no Copilot data source; ignored even when set to `true` |

`copilotMode`, `team` and `ultragoal` are new elements. They are on by default under Copilot and off under Claude Code unless you set them to `true`. `team` and `ultragoal` read repo-wide state, not per session: every session in the repo shows the same live team and the same open plan.

**Under Copilot CLI.** The HUD reads the statusline payload and the session's `events.jsonl` instead of a Claude transcript. Effort, when shown, comes from the `reasoningEffort` of the latest `session.start`, `session.resume` or `session.model_change` event. Session credits come from the payload's nano-AIU total converted to credits, with two decimals below 0.1, and the element is hidden only at exactly zero. `T:`, `A:`, `S:` and the agent counts come from the last 4 MB of `events.jsonl`, so they undercount in long sessions.

**Update hint.** When an OMC update is available, the label reads `[oh-my-copilot#5.13.1] -> 5.13.2` and a detail line gives the command for your install channel:

```
[!] omg 5.13.2 - paste: ! copilot plugin marketplace update omc && copilot plugin update oh-my-copilot@omc
[!] omg 5.13.2 - paste: ! npm i -g oh-my-copilot@latest
```

The first line is for a Copilot CLI plugin install (`copilot plugin marketplace update` added in Copilot CLI 1.0.27; the chain mirrors the Claude hint. Whether `plugin update` alone refreshes the marketplace clone is not documented, so the hint refreshes first), the second for an npm install. Under Claude Code, a plugin install gets `claude plugin marketplace update omc && claude plugin update oh-my-copilot@omc`, and the label and a `[!] claude ...` line also report a Claude Code update. Under Copilot CLI the HUD shows no Claude Code or Copilot CLI hint, because Copilot updates itself. The session-start hook refreshes the update cache at most every 6 hours, and earlier after an update or a channel switch.

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
| Hooks not executing   | Check that `node` 20+ is on `PATH`, then run `/oh-my-copilot:omc-doctor`      |
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
