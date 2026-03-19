<!-- Parent: ../AGENTS.md -->

# docs

User documentation and technical guides for oh-my-copilot.

## Purpose

This directory contains documentation for end-users and developers:

- **End-user guides**: How to use oh-my-copilot features
- **Technical reference**: Architecture, compatibility
- **Design documents**: Feature design specifications

## Structure

| Path | Description |
|------|-------------|
| `index.md` | Documentation home and table of contents |
| `copilot-instructions.md` | End-user orchestration instructions (installed to user projects) |
| `REFERENCE.md` | Full API reference and configuration options |
| `get-started/` | Installation, quick start, configuration |
| `guides/` | Task-oriented guides (team mode, Azure DevOps, skills, etc.) |
| `reference/` | Reference docs (agents, CLI, hooks, state, compatibility, features) |
| `architecture/` | System architecture deep-dives |
| `design/` | Feature design specifications |
| `agent-templates/` | Reusable agent prompt templates |
| `shared/` | Shared content referenced by skills |

## For AI Agents

### Working In This Directory

1. **End-User Focus**: copilot-instructions.md is installed to user projects - write for end-users, not developers
2. **Keep Links Accessible**: Use raw GitHub URLs for links in copilot-instructions.md (agents can't navigate GitHub UI)
3. **Version Consistency**: Update version numbers across all docs when releasing

### When to Update Each File

| Trigger | File to Update |
|---------|---------------|
| Agent count or list changes | `REFERENCE.md` (Agents section) |
| Skill count or list changes | `REFERENCE.md` (Skills section) / `guides/skills-reference.md` |
| Hook count or list changes | `REFERENCE.md` (Hooks System section) / `reference/hooks.md` |
| Magic keywords change | `REFERENCE.md` (Magic Keywords section) |
| Agent tool assignments change | `copilot-instructions.md` (Agent Tool Matrix) |
| Skill composition or architecture changes | `architecture/overview.md` |
| New internal API or feature | `reference/features.md` |
| Tiered agent design updates | `architecture/tiered-agents.md` |
| Platform or version support changes | `reference/compatibility.md` |
| End-user instructions change | `copilot-instructions.md` |
| Major user-facing features | `../README.md` |

### Testing Requirements

- Verify markdown renders correctly
- Check all internal links resolve
- Validate code examples in documentation

### Common Patterns

#### Linking to Raw Content

Use raw GitHub URLs for external accessibility:

[Full Reference](https://raw.githubusercontent.com/RobinNorberg/oh-my-copilot/main/docs/REFERENCE.md)

## Dependencies

### Internal

- References agents from `agents/`
- References skills from `skills/`
- References tools from `src/tools/`

### External

None - pure markdown files.

<!-- MANUAL:
- When documenting `plan`/`ralplan`, include consensus structured deliberation (RALPLAN-DR) and note `--deliberate` high-risk mode behavior.
-->
