# Migration Guide

This guide covers all migration paths for oh-my-copilot. Find your current version below.

---

## Table of Contents

- [Unreleased: Team MCP Runtime Deprecation (CLI-Only)](#unreleased-team-mcp-runtime-deprecation-cli-only)
- [v3.5.3 → v3.5.5: Test Fixes & Cleanup](#v353--v355-test-fixes--cleanup)
- [v3.5.2 → v3.5.3: Skill Consolidation](#v352--v353-skill-consolidation)
- [v2.x → v3.0: Package Rename & Auto-Activation](#v2x--v30-package-rename--auto-activation)
- [v3.0 → v3.1: Notepad Wisdom & Enhanced Features](#v30--v31-notepad-wisdom--enhanced-features)
- [v3.x → v4.0: Major Architecture Overhaul](#v3x--v40-major-architecture-overhaul)

---

## Unreleased: Team MCP Runtime Deprecation (CLI-Only)

### TL;DR

`omc_run_team_start/status/wait/cleanup` are now hard-deprecated at runtime. Calls return:

```json
{
  "code": "deprecated_cli_only",
  "message": "Legacy team MCP runtime tools are deprecated. Use the omc team CLI instead."
}
```

Use CLI commands instead:

- `omc team [N:agent-type] "<task>"`
- `omc team status <team-name>`
- `omc team shutdown <team-name> [--force]`
- `omc team api <operation> --input '<json>' --json`

### `omc ask` env alias sunset (Phase-1 compatibility)

`OMC_ASK_*` is now canonical for advisor execution. Phase-1 accepts `OMX_ASK_ADVISOR_SCRIPT` and `OMX_ASK_ORIGINAL_TASK` with deprecation warnings. Planned hard sunset for alias removal: **2026-06-30**.

### How to Migrate

1. Replace MCP runtime tool calls with CLI equivalents.
2. Update skills/prompts from `/omg-teams ...` to `omc team ...` syntax.
3. Legacy Team MCP runtime is now opt-in only (not enabled by default). If you enable it manually, treat responses as deprecation-only compatibility output.

### Example mapping

```bash
# Old (deprecated runtime path)
mcp__team__omc_run_team_start(...)
mcp__team__omc_run_team_status({ job_id: ... })
mcp__team__omc_run_team_wait({ job_id: ... })
mcp__team__omc_run_team_cleanup({ job_id: ... })

# New (CLI-first)
omc team 2:codex "review auth flow"
omc team status review-auth-flow
omc team shutdown review-auth-flow --force
omc team api list-tasks --input '{"team_name":"review-auth-flow"}' --json
```

---

## v3.5.3 → v3.5.5: Test Fixes & Cleanup

### TL;DR

Maintenance release fixing test suite issues and continuing skill consolidation from v3.5.3.

### What Changed

**Test Fixes:**

- Delegation-enforcer tests marked as skipped (implementation pending)
- Analytics expectations corrected for agent attribution
- All remaining tests now pass cleanly

**Skill Consolidation:**

- Continued cleanup from v3.5.3
- Removed deprecated `cancel-*` skills (use `/cancel` instead)
- Final skill count: 37 core skills

### Migration Steps

1. **No breaking changes** - All functionality preserved
2. **Test suite** now runs cleanly with `npm run test:run`
3. **Deprecated skills** removed (already replaced in v3.5.3)

### For Developers

If you were depending on deprecated `cancel-*` skills, update to use the unified `/cancel` command which auto-detects the active mode.

---

## v3.5.2 → v3.5.3: Skill Consolidation

### TL;DR

8 deprecated skills have been removed. The unified `/cancel` and `/omg-setup` commands replace them.

### Removed Skills

The following skills have been **completely removed** in v3.5.3:

| Removed Skill        | Replacement                            |
| -------------------- | -------------------------------------- |
| `cancel-autopilot`   | `/oh-my-copilot:cancel`             |
| `cancel-ralph`       | `/oh-my-copilot:cancel`             |
| `cancel-ultrawork`   | `/oh-my-copilot:cancel`             |
| `cancel-ultraqa`     | `/oh-my-copilot:cancel`             |
| `omg-default`        | `/oh-my-copilot:omg-setup --local`  |
| `omg-default-global` | `/oh-my-copilot:omg-setup --global` |
| `planner`            | `/oh-my-copilot:plan`               |

### What Changed

**Before v3.5.3:**

```bash
/oh-my-copilot:cancel-ralph      # Cancel ralph specifically
/oh-my-copilot:omg-default       # Configure local project
/oh-my-copilot:planner "task"    # Start planning
```

**After v3.5.3:**

```bash
/oh-my-copilot:cancel            # Auto-detects and cancels any active mode
/oh-my-copilot:omg-setup --local # Configure local project
/oh-my-copilot:plan "task"       # Start planning (includes interview mode)
```

### New Features

**New skill: `/learn-about-omc`**

- Analyzes your OMP usage patterns
- Provides personalized recommendations
- Identifies underutilized features

**Plan skill now supports consensus mode:**

```bash
/oh-my-copilot:plan --consensus "task"  # Iterative planning with Critic review
/oh-my-copilot:ralplan "task"           # Alias for plan --consensus
```

### Migration Steps

1. **No action required** - The unified `/cancel` command already worked in v3.5
2. **Update any scripts** that reference removed commands
3. **Re-run `/omg-setup`** if you want to update your copilot-instructions.md configuration

### Skill Count

- v3.5: 42 skills
- v3.5.3: 37 skills (8 removed, 3 added)

---

## v2.x → v3.0: Package Rename & Auto-Activation

### TL;DR

Your old commands still work! But now you don't need them.

**Before 3.0:** Explicitly invoke 25+ commands like `/oh-my-copilot:ralph "task"`, `/oh-my-copilot:ultrawork "task"`

**After 3.0:** Just work naturally - Copilot auto-activates the right behaviors. One-time setup: just say "setup omc"

### Project Rebrand

The project was rebranded to better reflect its purpose and improve discoverability.

- **Project/brand name**: `oh-my-copilot` (GitHub repo, plugin name, commands)
- **npm package name**: `oh-my-copilot` (unchanged)

> **Why the difference?** The npm package name `oh-my-copilot` was kept for backward compatibility with existing installations. The project, GitHub repository, plugin, and all commands use `oh-my-copilot`.

#### NPM Install Command (unchanged)

```bash
npm install -g oh-my-copilot
```

### What Changed

#### Before (2.x): Explicit Commands

You had to remember and explicitly invoke specific commands for each mode:

```bash
# 2.x workflow: Multiple commands, lots to remember
/oh-my-copilot:ralph "implement user authentication"       # Persistence mode
/oh-my-copilot:ultrawork "refactor the API layer"          # Maximum parallelism
/oh-my-copilot:planner "plan the new dashboard"            # Planning interview
/oh-my-copilot:deepsearch "find database schema files"     # Deep search
/oh-my-copilot:git-master "commit these changes"           # Git expertise
/oh-my-copilot:deepinit ./src                              # Index codebase
/oh-my-copilot:analyze "why is this test failing?"         # Deep analysis
```

#### After (3.0): Auto-Activation + Keywords

Work naturally. Copilot detects intent and activates behaviors automatically:

```bash
# 3.0 workflow: Just talk naturally OR use optional keywords
"don't stop until user auth is done"                # Auto-activates ralph-loop
"fast: refactor the entire API layer"               # Auto-activates ultrawork
"plan: design the new dashboard"                    # Auto-activates planning
"ralph ulw: migrate the database"                   # Combined: persistence + parallelism
"find all database schema files"                    # Auto-activates search mode
"commit these changes properly"                     # Auto-activates git expertise
```

### Agent Naming Standard

Agent naming is now strictly descriptive and role-based (for example: `architect`, `planner`, `analyst`, `critic`, `document-specialist`, `designer`, `writer`, `vision`, `executor`).

Use canonical role names across prompts, commands, docs, and scripts. Avoid introducing alternate myth-style or legacy aliases in new content.

### Directory Migration

Directory structures have been renamed for consistency with the new package name:

#### Local Project Directories

- **Old**: `.omg/`
- **New**: `.omg/`

#### Global Directories

- **Old**: `~/.omg/`
- **New**: `~/.omg/`

#### Skills Directory

- **Old**: `~/.copilot/skills/omg-learned/`
- **New**: `~/.copilot/skills/omg-learned/`

#### Config Files

- **Old**: `~/.copilot/omc/mnemosyne.json`
- **New**: `~/.copilot/omc/learner.json`

### Environment Variables

All environment variables have been renamed from `OMC_*` to `OMC_*`:

| Old                      | New                      |
| ------------------------ | ------------------------ |
| OMC_USE_NODE_HOOKS       | OMC_USE_NODE_HOOKS       |
| OMC_USE_BASH_HOOKS       | OMC_USE_BASH_HOOKS       |
| OMC_PARALLEL_EXECUTION   | OMC_PARALLEL_EXECUTION   |
| OMC_LSP_TOOLS            | OMC_LSP_TOOLS            |
| OMC_MAX_BACKGROUND_TASKS | OMC_MAX_BACKGROUND_TASKS |
| OMC_ROUTING_ENABLED      | OMC_ROUTING_ENABLED      |
| OMC_ROUTING_DEFAULT_TIER | OMC_ROUTING_DEFAULT_TIER |
| OMC_ESCALATION_ENABLED   | OMC_ESCALATION_ENABLED   |
| OMC_DEBUG                | OMC_DEBUG                |

### Command Mapping

All 2.x commands continue to work. Here's what changed:

| 2.x Command                            | 3.0 Equivalent                                     | Works?                 |
| -------------------------------------- | -------------------------------------------------- | ---------------------- |
| `/oh-my-copilot:ralph "task"`       | Say "don't stop until done" OR use `ralph` keyword | ✅ YES (both ways)     |
| `/oh-my-copilot:ultrawork "task"`   | Say "fast" or "parallel" OR use `ulw` keyword      | ✅ YES (both ways)     |
| `/oh-my-copilot:ultrawork-ralph`    | Say "ralph ulw:" prefix                            | ✅ YES (keyword combo) |
| `/oh-my-copilot:planner "task"`     | Say "plan this" OR use `plan` keyword              | ✅ YES (both ways)     |
| `/oh-my-copilot:plan "description"` | Start planning naturally                           | ✅ YES                 |
| `/oh-my-copilot:review [path]`      | Invoke normally                                    | ✅ YES (unchanged)     |
| `/oh-my-copilot:deepsearch "query"` | Say "find" or "search"                             | ✅ YES (auto-detect)   |
| `/oh-my-copilot:analyze "target"`   | Say "analyze" — routes to debugger/architect agent | ✅ YES (keyword route) |
| `/oh-my-copilot:deepinit [path]`    | Invoke normally                                    | ✅ YES (unchanged)     |
| `/oh-my-copilot:git-master`         | Say "git", "commit", "atomic commit"               | ✅ YES (auto-detect)   |
| `/oh-my-copilot:frontend-ui-ux`     | Say "UI", "styling", "component", "design"         | ✅ YES (auto-detect)   |
| `/oh-my-copilot:note "content"`     | Say "remember this" or "save this"                 | ✅ YES (auto-detect)   |
| `/oh-my-copilot:cancel-ralph`       | Say "stop", "cancel", or "abort"                   | ✅ YES (auto-detect)   |
| `/oh-my-copilot:omg-doctor`         | Invoke normally                                    | ✅ YES (unchanged)     |
| All other commands                     | Work exactly as before                             | ✅ YES                 |

### Magic Keywords

Include these anywhere in your message to explicitly activate behaviors. Use keywords when you want explicit control (optional):

| Keyword             | Effect                                   | Example                           |
| ------------------- | ---------------------------------------- | --------------------------------- |
| `ralph`             | Persistence mode - won't stop until done | "ralph: refactor the auth system" |
| `ralplan`           | Iterative planning with consensus        | "ralplan: add OAuth support"      |
| `ulw` / `ultrawork` | Maximum parallel execution               | "ulw: fix all type errors"        |
| `plan`              | Planning interview                       | "plan: new API design"            |

**ralph includes ultrawork:**

```
ralph: migrate the entire database
    ↓
Persistence (won't stop) + Ultrawork (maximum parallelism) built-in
```

**No keywords?** Copilot still auto-detects:

```
"don't stop until this works"      # Triggers ralph
"fast, I'm in a hurry"             # Triggers ultrawork
"help me design the dashboard"     # Triggers planning
```

### Natural Cancellation

Say any of these to stop:

- "stop"
- "cancel"
- "abort"
- "nevermind"
- "enough"
- "halt"

Copilot intelligently determines what to stop:

```
If in ralph-loop     → Exit persistence loop
If in ultrawork      → Return to normal mode
If in planning       → End planning interview
If multiple active   → Stop the most recent
```

No more `/oh-my-copilot:cancel-ralph` - just say "cancel"!

### Migration Steps

Follow these steps to migrate your existing setup:

#### 1. Uninstall Old Package (if installed via npm)

```bash
npm uninstall -g oh-my-copilot
```

#### 2. Install via Plugin System (Required)

```bash
# In Copilot CLI:
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot
/plugin install oh-my-copilot
```

> **Note**: npm/bun global installs are no longer supported. Use the plugin system.

#### 3. Rename Local Project Directories

If you have existing projects using the old directory structure:

```bash
# In each project directory
mv .omc .omc
```

#### 4. Rename Global Directories

```bash
# Global configuration directory
mv ~/.omc ~/.omc

# Skills directory
mv ~/.copilot/skills/omg-learned ~/.copilot/skills/omg-learned

# Config directory
mv ~/.copilot/omc ~/.copilot/omc
```

#### 5. Update Environment Variables

Update your shell configuration files (`.bashrc`, `.zshrc`, etc.):

```bash
# Replace all OMC_* variables with OMC_*
# Example:
# OLD: export OMC_ROUTING_ENABLED=true
# NEW: export OMC_ROUTING_ENABLED=true
```

#### 6. Update Scripts and Configurations

Search for and update any references to:

- Package name: `oh-my-copilot` → `oh-my-copilot`
- Agent names: Use the mapping table above
- Commands: Use the new slash commands
- Directory paths: Update `.omc` → `.omc`

#### 7. Run One-Time Setup

In Copilot CLI, just say "setup omc", "omc setup", or any natural language equivalent.

This:

- Downloads latest copilot-instructions.md
- Configures 32 agents
- Enables auto-behavior detection
- Activates continuation enforcement
- Sets up skill composition

### Verification

After migration, verify your setup:

1. **Check installation**:

   ```bash
   npm list -g oh-my-copilot
   ```

2. **Verify directories exist**:

   ```bash
   ls -la .omg/  # In project directory
   ls -la ~/.omg/  # Global directory
   ```

3. **Test a simple command**:
   Run `/oh-my-copilot:omg-help` in Copilot CLI to ensure the plugin is loaded correctly.

### New Features in 3.0

#### 1. Zero-Learning-Curve Operation

**No commands to memorize.** Work naturally:

```
Before: "OK, I need to use /oh-my-copilot:ultrawork for speed..."
After:  "I'm in a hurry, go fast!"
        ↓
        Copilot: "I'm activating ultrawork mode..."
```

#### 2. Delegate Always (Automatic)

Complex work auto-routes to specialist agents:

```
Your request              Copilot's action
────────────────────     ────────────────────
"Refactor the database"   → Delegates to architect
"Fix the UI colors"       → Delegates to designer
"Document this API"       → Delegates to writer
"Search for all errors"   → Delegates to explore
"Debug this crash"        → Delegates to architect
```

You don't ask for delegation - it happens automatically.

#### 3. Learned Skills (`/oh-my-copilot:learner`)

Extract reusable insights from problem-solving:

```bash
# After solving a tricky bug:
"Extract this as a skill"
    ↓
Copilot learns the pattern and stores it
    ↓
Next time keywords match → Solution auto-injects
```

Storage:

- **Project-level**: `.omg/skills/` (version-controlled)
- **User-level**: `~/.copilot/skills/omg-learned/` (portable)

#### 4. HUD Statusline (Real-Time Orchestration)

See what Copilot is doing in the status bar:

```
[OMP] ralph:3/10 | US-002 | ultrawork skill:planner | ctx:67% | agents:2 | todos:2/5
```

Run `/oh-my-copilot:hud setup` to install. Presets: minimal, focused, full.

#### 5. Three-Tier Memory System

Critical knowledge survives context compaction:

```
<remember priority>API client at src/api/client.ts</remember>
    ↓
Permanently loaded on session start
    ↓
Never lost through compaction
```

Or use `/oh-my-copilot:note` to save discoveries manually:

```bash
/oh-my-copilot:note Project uses PostgreSQL with Prisma ORM
```

#### 6. Structured Task Tracking (PRD Support)

**Ralph Loop now uses Product Requirements Documents:**

```bash
/oh-my-copilot:ralph-init "implement OAuth with multiple providers"
    ↓
Auto-creates PRD with user stories
    ↓
Each story: description + acceptance criteria + pass/fail
    ↓
Ralph loops until ALL stories pass
```

#### 7. Intelligent Continuation

**Tasks complete before Copilot stops:**

```
You: "Implement user dashboard"
    ↓
Copilot: "I'm activating ralph-loop to ensure completion"
    ↓
Creates todo list, works through each item
    ↓
Only stops when EVERYTHING is verified complete
```

### Backward Compatibility Note

**Note**: v3.0 does not maintain backward compatibility with v2.x naming. You must complete the migration steps above for the new version to work correctly.

---

## v3.0 → v3.1: Notepad Wisdom & Enhanced Features

### Overview

Version 3.1 is a minor release adding powerful new features while maintaining full backward compatibility with v3.0.

### What's New

#### 1. Notepad Wisdom System

Plan-scoped wisdom capture for learnings, decisions, issues, and problems.

**Location:** `.omg/notepads/{plan-name}/`

| File           | Purpose                            |
| -------------- | ---------------------------------- |
| `learnings.md` | Technical discoveries and patterns |
| `decisions.md` | Architectural and design decisions |
| `issues.md`    | Known issues and workarounds       |
| `problems.md`  | Blockers and challenges            |

**API:**

- `initPlanNotepad()` - Initialize notepad for a plan
- `addLearning()` - Record technical discoveries
- `addDecision()` - Record architectural choices
- `addIssue()` - Record known issues
- `addProblem()` - Record blockers
- `getWisdomSummary()` - Get summary of all wisdom
- `readPlanWisdom()` - Read full wisdom for context

#### 2. Delegation Categories

Semantic task categorization that auto-maps to model tier, temperature, and thinking budget.

| Category             | Tier   | Temperature | Thinking | Use For                                         |
| -------------------- | ------ | ----------- | -------- | ----------------------------------------------- |
| `visual-engineering` | HIGH   | 0.7         | high     | UI/UX, frontend, design systems                 |
| `ultrabrain`         | HIGH   | 0.3         | max      | Complex reasoning, architecture, deep debugging |
| `artistry`           | MEDIUM | 0.9         | medium   | Creative solutions, brainstorming               |
| `quick`              | LOW    | 0.1         | low      | Simple lookups, basic operations                |
| `writing`            | MEDIUM | 0.5         | medium   | Documentation, technical writing                |

**Auto-detection:** Categories detect from prompt keywords automatically.

#### 3. Directory Diagnostics Tool

Project-level type checking via `lsp_diagnostics_directory` tool.

**Strategies:**

- `auto` (default) - Auto-selects best strategy, prefers tsc when tsconfig.json exists
- `tsc` - Fast, uses TypeScript compiler
- `lsp` - Fallback, iterates files via Language Server

**Usage:** Check entire project for errors before commits or after refactoring.

#### 4. Session Resume

Background agents can be resumed with full context via `resume-session` tool.

### Migration Steps

Version 3.1 is a drop-in upgrade. No migration required!

```bash
npm update -g oh-my-copilot
```

All existing configurations, plans, and workflows continue working unchanged.

### New Tools Available

Once upgraded, agents automatically gain access to:

- Notepad wisdom APIs (read/write wisdom during execution)
- Delegation categories (automatic categorization)
- Directory diagnostics (project-level type checking)
- Session resume (recover background agent state)

---

## v3.3.x → v3.4.0: Parallel Execution & Advanced Workflows

### Overview

Version 3.4.0 introduces powerful parallel execution modes and advanced workflow orchestration while maintaining full backward compatibility with v3.3.x.

### What's New

#### 1. Ultrapilot: Parallel Autopilot

Execute complex tasks with up to 5 concurrent workers for 3-5x speedup:

```bash
/oh-my-copilot:ultrapilot "build a fullstack todo app"
```

**Key Features:**

- Automatic task decomposition into parallelizable subtasks
- File ownership coordination to prevent conflicts
- Parallel execution with intelligent coordination
- State files: `.omg/state/ultrapilot-state.json`, `.omg/state/ultrapilot-ownership.json`

**Best for:** Multi-component systems, fullstack apps, large refactoring

#### 2. Swarm: Coordinated Agent Teams

N coordinated agents with atomic task claiming:

```bash
/oh-my-copilot:swarm 5:executor "fix all TypeScript errors"
```

**Key Features:**

- Shared task pool with atomic claiming (prevents duplicate work)
- 5-minute timeout per task with auto-release
- Scales from 2 to 10 workers
- Clean completion when all tasks done

#### 3. Pipeline: Sequential Agent Chaining

Chain agents with data passing between stages:

```bash
/oh-my-copilot:pipeline explore:haiku -> architect:opus -> executor:sonnet
```

**Built-in Presets:**

- `review` - explore → architect → critic → executor
- `implement` - planner → executor → tdd-guide
- `debug` - explore → architect → debugger
- `research` - parallel(document-specialist, explore) → architect → writer
- `refactor` - explore → architect-medium → executor-high → qa-tester
- `security` - explore → security-reviewer → executor → security-reviewer-low

#### 4. Unified Cancel Command

Smart cancellation that auto-detects active mode:

```bash
/oh-my-copilot:cancel
# Or just say: "stop", "cancel", "abort"
```

**Auto-detects and cancels:** autopilot, ultrapilot, ralph, ultrawork, ultraqa, swarm, pipeline

**Deprecation Notice:**
Individual cancel commands are deprecated but still work:

- `/oh-my-copilot:cancel-ralph` (deprecated)
- `/oh-my-copilot:cancel-ultraqa` (deprecated)
- `/oh-my-copilot:cancel-ultrawork` (deprecated)
- `/oh-my-copilot:cancel-autopilot` (deprecated)

Use `/oh-my-copilot:cancel` instead.

#### 6. Explore-High Agent

Opus-powered architectural search for complex codebase exploration:

```typescript
Task(
  (subagent_type = "oh-my-copilot:explore-high"),
  (model = "opus"),
  (prompt = "Find all authentication-related code patterns..."),
);
```

**Best for:** Architectural analysis, cross-cutting concerns, complex refactoring planning

#### 7. State Management Standardization

State files now use standardized paths:

**Standard paths:**

- Local: `.omg/state/{name}.json`
- Global: `~/.omg/state/{name}.json`

Legacy locations are auto-migrated on read.

#### 8. Keyword Conflict Resolution

When multiple execution mode keywords are present:

**Conflict Resolution Priority:**
| Priority | Condition | Result |
|----------|-----------|--------|
| 1 (highest) | Single explicit keyword | That mode wins |
| 2 | Generic "fast"/"parallel" only | Read from config (`defaultExecutionMode`) |
| 3 (lowest) | No config file | Default to `ultrawork` |

**Explicit mode keywords:** `ulw`, `ultrawork`
**Generic keywords:** `fast`, `parallel`

Users set their default mode preference via `/oh-my-copilot:omg-setup`.

### Migration Steps

Version 3.4.0 is a drop-in upgrade. No migration required!

```bash
npm update -g oh-my-copilot
```

All existing configurations, plans, and workflows continue working unchanged.

### New Configuration Options

#### Default Execution Mode

Set your preferred execution mode in `~/.copilot/.omg-config.json`:

```json
{
  "defaultExecutionMode": "ultrawork"
}
```

When you use generic keywords like "fast" or "parallel" without explicit mode keywords, this setting determines which mode activates.

### Breaking Changes

None. All v3.3.x features and commands continue to work in v3.4.0.

### New Tools Available

Once upgraded, you automatically gain access to:

- Ultrapilot (parallel autopilot)
- Swarm coordination
- Pipeline workflows
- Unified cancel command
- Explore-high agent

### Best Practices for v3.4.0

#### When to Use Each Mode

| Scenario                | Recommended Mode | Why                                            |
| ----------------------- | ---------------- | ---------------------------------------------- |
| Multi-component systems | `ultrapilot`     | Parallel workers handle independent components |
| Many small fixes        | `swarm`          | Atomic task claiming prevents duplicate work   |
| Sequential dependencies | `pipeline`       | Data passes between stages                     |
| Single complex task     | `autopilot`      | Full autonomous execution                      |
| Must complete           | `ralph`          | Persistence guarantee                          |

#### Keyword Usage

**Explicit mode control (v3.4.0):**

```bash
"ulw: fix all errors"           # ultrawork (explicit)
"fast: implement feature"       # reads defaultExecutionMode config
```

**Natural language (still works):**

```bash
"don't stop until done"         # ralph
"parallel execution"            # reads defaultExecutionMode
"build me a todo app"           # autopilot
```

### Verification

After upgrading, verify new features:

1. **Check installation**:

   ```bash
   npm list -g oh-my-copilot
   ```

2. **Test ultrapilot**:

   ```bash
   /oh-my-copilot:ultrapilot "create a simple React component"
   ```

3. **Test unified cancel**:

   ```bash
   /oh-my-copilot:cancel
   ```

4. **Check state directory**:
   ```bash
   ls -la .omg/state/  # Should see ultrapilot-state.json after running ultrapilot
   ```

---

## v3.x → v4.0: Major Architecture Overhaul

### Overview

Version 4.0 is a complete architectural redesign focusing on scalability, maintainability, and developer experience.

### What's Coming

⚠️ **This section is under active development as v4.0 is being built.**

#### Planned Changes

1. **Modular Architecture**
   - Plugin system for extensibility
   - Core/extension separation
   - Better dependency management

2. **Enhanced Agent System**
   - Improved agent lifecycle management
   - Better error recovery
   - Performance optimizations

3. **Improved Configuration**
   - Unified config schema
   - Better validation
   - Migration tooling

4. **Breaking Changes**
   - TBD based on development progress
   - Full migration guide will be provided

### Migration Path (Coming Soon)

Detailed migration instructions will be provided when v4.0 reaches release candidate status.

Expected timeline: Q1 2026

### Stay Updated

- Watch the [GitHub repository](https://github.com/RobinNorberg/oh-my-copilot) for announcements
- Check [CHANGELOG.md](../CHANGELOG.md) for detailed release notes
- Join discussions in GitHub Issues

---

## Common Scenarios Across Versions

### Scenario 1: Quick Implementation Task

**2.x Workflow:**

```
/oh-my-copilot:ultrawork "implement the todo list feature"
```

**3.0+ Workflow:**

```
"implement the todo list feature quickly"
    ↓
Copilot: "I'm activating ultrawork for maximum parallelism"
```

**Result:** Same outcome, more natural interaction.

### Scenario 2: Complex Debugging

**2.x Workflow:**

```
/oh-my-copilot:ralph "debug the memory leak"
```

**3.0+ Workflow:**

```
"there's a memory leak in the worker process - don't stop until we fix it"
    ↓
Copilot: "I'm activating ralph-loop to ensure completion"
```

**Result:** Ralph-loop with more context from your natural language.

### Scenario 3: Strategic Planning

**2.x Workflow:**

```
/oh-my-copilot:planner "design the new authentication system"
```

**3.0+ Workflow:**

```
"plan the new authentication system"
    ↓
Copilot: "I'm starting a planning session"
    ↓
Interview begins automatically
```

**Result:** Planning interview triggered by natural language.

### Scenario 4: Stopping Work

**2.x Workflow:**

```
/oh-my-copilot:cancel-ralph
```

**3.0+ Workflow:**

```
"stop"
```

**Result:** Copilot intelligently cancels the active operation.

---

## Configuration Options

### Project-Scoped Configuration (Recommended)

Apply oh-my-copilot to current project only:

```
/oh-my-copilot:omg-default
```

Creates: `./.copilot/copilot-instructions.md`

### Global Configuration

Apply to all Copilot CLI sessions:

```
/oh-my-copilot:omg-default-global
```

Creates: `~/.copilot/copilot-instructions.md`

**Precedence:** Project config overrides global if both exist.

---

## FAQ

**Q: Do I have to use keywords?**
A: No. Keywords are optional shortcuts. Copilot auto-detects intent without them.

**Q: Will my old commands break?**
A: No. All commands continue to work across minor versions (3.0 → 3.1). Major version changes (3.x → 4.0) will provide migration paths.

**Q: What if I like explicit commands?**
A: Keep using them! `/oh-my-copilot:ralph`, `/oh-my-copilot:ultrawork`, and `/oh-my-copilot:plan` work. Note: `/oh-my-copilot:planner` now redirects to `/oh-my-copilot:plan`.

**Q: How do I know what Copilot is doing?**
A: Copilot announces major behaviors: "I'm activating ralph-loop..." or set up `/oh-my-copilot:hud` for real-time status.

**Q: Where's the full command list?**
A: See [README.md](../README.md) for full command reference. All commands still work.

**Q: What's the difference between keywords and natural language?**
A: Keywords are explicit shortcuts. Natural language triggers auto-detection. Both work.

---

## Need Help?

- **Diagnose issues**: Run `/oh-my-copilot:omg-doctor`
- **See all commands**: Run `/oh-my-copilot:omg-help`
- **View real-time status**: Run `/oh-my-copilot:hud setup`
- **Review detailed changelog**: See [CHANGELOG.md](../CHANGELOG.md)
- **Report bugs**: [GitHub Issues](https://github.com/RobinNorberg/oh-my-copilot/issues)

---

## What's Next?

Now that you understand the migration:

1. **For immediate impact**: Start using keywords (`ralph`, `ulw`, `plan`) in your work
2. **For full power**: Read [docs/copilot-instructions.md](copilot-instructions.md) to understand orchestration
3. **For advanced usage**: Check [docs/ARCHITECTURE.md](ARCHITECTURE.md) for deep dives
4. **For team onboarding**: Share this guide with teammates

Welcome to oh-my-copilot!
