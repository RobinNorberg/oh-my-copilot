# Agent Tiers Reference

Single source of truth for agent selection and model routing. All skill files should reference this file.

## The 18 Agents

| Agent | Default Model | Domain |
|-------|--------------|--------|
| `explore` | haiku | Fast codebase search, file/symbol mapping |
| `analyst` | opus | Requirements clarity, acceptance criteria |
| `planner` | opus | Task sequencing, execution plans |
| `architect` | opus | System design, boundaries, interfaces |
| `debugger` | sonnet | Root-cause analysis, build failures |
| `executor` | sonnet | Code implementation, refactoring |
| `verifier` | sonnet | Completion evidence, claim validation |
| `code-reviewer` | opus | Comprehensive code review |
| `security-reviewer` | sonnet | Vulnerabilities, trust boundaries |
| `test-engineer` | sonnet | Test strategy, coverage, TDD |
| `designer` | sonnet | UI/UX architecture |
| `writer` | haiku | Docs, migration notes |
| `qa-tester` | sonnet | Interactive CLI/service validation |
| `git-master` | sonnet | Commit strategy, history hygiene |
| `document-specialist` | sonnet | External documentation research |
| `scientist` | sonnet | Data analysis, statistics |
| `code-simplifier` | opus | Code clarity and simplification |
| `critic` | opus | Plan/design critical challenge |

## Model Routing

Override the default model by passing `model` when delegating:

```
Agent(subagent_type="oh-my-copilot:executor", model="haiku", prompt="...")
```

| Tier | Model | When to Use |
|------|-------|-------------|
| LOW | haiku | Quick lookups, simple fixes, narrow checks |
| MEDIUM | sonnet | Feature implementation, standard debugging |
| HIGH | opus | Architecture decisions, complex reasoning |

For token savings, prefer lower tiers when the task allows.

## Agent Selection by Task

| Task | Agent | Model |
|------|-------|-------|
| Find files/patterns | explore | haiku |
| Simple code change | executor | haiku |
| Feature implementation | executor | sonnet |
| Complex refactoring | executor | opus |
| Debug simple issue | debugger | haiku |
| Debug complex issue | debugger | sonnet |
| UI component work | designer | sonnet |
| Write docs/comments | writer | haiku |
| Research external APIs | document-specialist | sonnet |
| Strategic planning | planner | opus |
| Review/critique plan | critic | opus |
| Pre-planning analysis | analyst | opus |
| Interactive CLI testing | qa-tester | sonnet |
| Security review | security-reviewer | sonnet |
| Quick security scan | security-reviewer | haiku |
| TDD workflow | test-engineer | sonnet |
| Code review | code-reviewer | opus |
| Data analysis | scientist | sonnet |
| Complex autonomous work | executor | opus |

## MCP Tool Assignments

| Tool | Available To | Notes |
|------|-------------|-------|
| `lsp_diagnostics` | executor, debugger, architect, test-engineer, code-reviewer, qa-tester | Single file errors |
| `lsp_diagnostics_directory` | executor, debugger, architect | Project-wide type checking |
| `lsp_document_symbols` | explore | File symbol outline |
| `lsp_workspace_symbols` | explore | Cross-workspace symbol search |
| `lsp_find_references` | explore (opus only) | Find all usages |
| `ast_grep_search` | explore, architect, code-reviewer | Structural pattern search |
| `ast_grep_replace` | executor (opus only) | Structural transformation |
| `python_repl` | scientist | Data analysis, computation |

### Orchestrator-Direct Tools

These 7 tools are used directly, not assigned to agents:

`lsp_hover`, `lsp_goto_definition`, `lsp_prepare_rename`, `lsp_rename`, `lsp_code_actions`, `lsp_code_action_resolve`, `lsp_servers`
