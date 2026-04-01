<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-28 | Updated: 2026-03-02 -->

# skills

37 skill directories for workflow automation and specialized behaviors.

## Purpose

Skills are reusable workflow templates that can be invoked via `/oh-my-copilot:skill-name`. Each skill provides:
- Structured prompts for specific workflows
- Activation triggers (manual or automatic)
- Integration with execution modes

## Key Files

### Execution Mode Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `autopilot/SKILL.md` | autopilot | Full autonomous execution from idea to working code |
| `ultrawork/SKILL.md` | ultrawork | Maximum parallel agent execution |
| `ralph/SKILL.md` | ralph | Persistence until verified complete |
| `team/SKILL.md` | team | N coordinated agents with task claiming |
| `ultraqa/SKILL.md` | ultraqa | QA cycling until goal met |

### Planning Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `plan/SKILL.md` | omc-plan | Strategic planning with interview workflow |
| `ralplan/SKILL.md` | ralplan | Iterative planning (Planner+Architect+Critic) with RALPLAN-DR structured deliberation (`--deliberate` for high-risk) |
| `deep-interview/SKILL.md` | deep-interview | Socratic deep interview with mathematical ambiguity gating (Ouroboros-inspired) |
| `deep-dive/SKILL.md` | deep-dive | 2-stage pipeline: trace (causal investigation) → deep-interview (requirements crystallization) |

### Analysis Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `deep-review/SKILL.md` | deep-review | Multi-pass code review with security, quality, structural analysis, and validation |
| `discover/SKILL.md` | discover | Spawn parallel specialist agents to scan the codebase and produce a prioritized improvement backlog |

### Exploration Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `deepinit/SKILL.md` | deepinit | Generate hierarchical AGENTS.md |
| `sciomc/SKILL.md` | sciomc | Parallel scientist orchestration |
| `external-context/SKILL.md` | external-context | Parallel document-specialist agents for external web searches and documentation lookup |

### Visual Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `visual-verdict/SKILL.md` | visual-verdict | Structured visual QA verdict for screenshot/reference comparisons |

### Orchestration Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `ccg/SKILL.md` | ccg | Quadri-model orchestration — Claude, Codex, Gemini provide independent analysis, Copilot synthesizes |
| `omc-teams/SKILL.md` | omc-teams | CLI-team runtime for claude, codex, or gemini workers in tmux panes |
| `omc-reference/SKILL.md` | omc-reference | OMC agent catalog, tools, team pipeline routing, commit protocol, and skills registry |

### Notification Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `configure-notifications/SKILL.md` | configure-notifications | Configure notification integrations (Telegram, Discord, Slack, Teams) |

### Azure DevOps Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `omc-ado-setup/SKILL.md` | omc-ado-setup | Configure Azure DevOps integration |
| `omc-ado-review/SKILL.md` | omc-ado-review | Review Azure DevOps pull requests |
| `omc-ado-auto-review/SKILL.md` | omc-ado-auto-review | Automated Azure DevOps PR review |
| `omc-ado-sprint/SKILL.md` | omc-ado-sprint | Azure DevOps sprint management |
| `omc-ado-triage/SKILL.md` | omc-ado-triage | Azure DevOps work item triage |

### Utility Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `ai-slop-cleaner/SKILL.md` | ai-slop-cleaner | Regression-safe cleanup workflow for AI-generated code slop |
| `learner/SKILL.md` | learner | Extract reusable skill from session |
| `ask/SKILL.md` | ask | Ask Copilot, Codex, or Gemini via `omc ask` and capture an artifact |
| `cancel/SKILL.md` | cancel | Cancel any active OMC mode |
| `omc-doctor/SKILL.md` | omc-doctor | Diagnose installation issues |
| `setup/SKILL.md` | setup | Unified setup entrypoint for install, diagnostics, and MCP configuration |
| `omc-setup/SKILL.md` | omc-setup | One-time setup wizard |
| `mcp-setup/SKILL.md` | mcp-setup | Configure MCP servers |
| `skill/SKILL.md` | skill | Manage local skills |

### Domain Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `project-session-manager/SKILL.md` | project-session-manager (+ `psm` alias) | Isolated dev environments |
| `writer-memory/SKILL.md` | writer-memory | Agentic memory for writers |
| `release/SKILL.md` | release | Automated release workflow |
| `ralph-experiment/SKILL.md` | ralph-experiment | Hypothesis-driven experiment loop with structured notebook and git checkpoints |

## Permission Model

All plugin MCP tools use a **three-tier auto-approval system** so agents can operate without `/yolo`:

- **Tier 1** (read-only): LSP nav, code search, state/memory reads — always auto-approved via `readOnlyHint` annotation
- **Tier 2** (write): State/memory writes, AST replace, LSP rename — auto-approved via `permissions.allow` in `settings.local.json`
- **Tier 3** (destructive): `shared_memory_delete`, `shared_memory_cleanup`, `kill_job` — always prompt user

Safe bash patterns (git, npm, dotnet, gh, az, grep, find, ls) are auto-approved by the `permissionRequest` hook. Shell metacharacters are always rejected.

Deny escalation: 3 consecutive or 20 total denials stops the session. All decisions are audit-logged to `.omc/logs/permissions.log`.

See [permission architecture](../docs/architecture/permissions.md) for details.

## For AI Agents

### Working In This Directory

#### Skill Template Format

```markdown
---
name: skill-name
description: Brief description
triggers:
  - "keyword1"
  - "keyword2"
agent: executor  # Optional: which agent to use
model: sonnet    # Optional: model override
---

# Skill Name

## Purpose
What this skill accomplishes.

## Workflow
1. Step one
2. Step two
3. Step three

## Usage
How to invoke this skill.

## Configuration
Any configurable options.
```

#### Skill Invocation

```bash
# Manual invocation
/oh-my-copilot:skill-name

# With arguments
/oh-my-copilot:skill-name arg1 arg2

# Auto-detected from keywords
"autopilot build me a REST API"  # Triggers autopilot skill
```

#### Creating a New Skill

1. Create `new-skill/SKILL.md` directory and file with YAML frontmatter
2. Define purpose, workflow, and usage
3. Add to skill registry (auto-detected from frontmatter)
4. Optionally add activation triggers
5. Create corresponding `commands/new-skill.md` file (mirror)
6. Update `docs/REFERENCE.md` (Skills section, count)
7. If execution mode skill, also create `src/hooks/new-skill/` hook

### Common Patterns

**Skill chaining:**
```markdown
## Workflow
1. Invoke `explore` agent for context
2. Invoke `architect` for analysis
3. Invoke `executor` for implementation
4. Invoke `qa-tester` for verification
```

**Conditional behavior:**
```markdown
## Workflow
1. Check if tests exist
   - If yes: Run tests first
   - If no: Create test plan
2. Proceed with implementation
```

### Testing Requirements

- Skills are verified via integration tests
- Test skill invocation with `/oh-my-copilot:skill-name`
- Verify trigger keywords activate correct skill
- For git-related skills, follow `templates/rules/git-workflow.md`

## Dependencies

### Internal
- Loaded by skill bridge (`scripts/build-skill-bridge.mjs`)
- References agents from `agents/`
- Uses hooks from `src/hooks/`

### External
None - pure markdown files.

## Skill Categories

| Category | Skills | Trigger Keywords |
|----------|--------|------------------|
| Execution | autopilot, ultrawork, ralph, team, ultraqa, ralph-experiment | "autopilot", "ulw", "ralph" |
| Planning | omc-plan, ralplan, deep-interview, deep-dive | "ralplan", "deep-interview", "ouroboros" |
| Analysis | deep-review, discover | "code review", "security review" |
| Exploration | deepinit, sciomc, external-context | "deepsearch", "deep-analyze" |
| Orchestration | ccg, omc-teams, omc-reference | "ccg", "ask codex", "ask gemini" |
| Visual | visual-verdict | screenshot QA |
| Cleanup | ai-slop-cleaner | "deslop", "anti-slop" |
| Azure DevOps | omc-ado-setup, omc-ado-review, omc-ado-auto-review, omc-ado-sprint, omc-ado-triage | "ado setup", "ado triage" |
| Notifications | configure-notifications | "configure discord", "setup telegram" |
| Utility | learner, ask, cancel, setup, omc-doctor, omc-setup, mcp-setup, skill | "cancelomc", "stopomc" |
| Domain | project-session-manager, writer-memory, release | psm context |

## Auto-Activation

Some skills activate automatically based on context:

| Skill | Auto-Trigger Condition |
|-------|----------------------|
| autopilot | "autopilot", "build me", "I want a" |
| ultrawork | "ulw", "ultrawork" |
| ralph | "ralph", "don't stop until" |
| deep-interview | "deep interview", "interview me", "ouroboros", "don't assume" |
| cancel | "stop", "cancel", "abort" |

<!-- MANUAL:
- Team runtime wait semantics: `omc_run_team_wait.timeout_ms` only limits the wait call and does not stop workers.
- `timeoutSeconds` is removed from `omc_run_team_start`; use explicit `omc_run_team_cleanup` for intentional worker pane termination.
-->
