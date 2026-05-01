---
name: cccg
description: Quadri-model orchestration — Copilot, Claude, Codex, and Gemini each provide independent analysis, then Copilot synthesizes
level: 5
---

# CCCG - Copilot-Claude-Codex-Gemini Orchestration

CCCG (3 C's + G) runs four independent analyses in parallel, then synthesizes all perspectives into one unified answer.

Four models participate as independent reviewers:
1. **Copilot** — independent analysis via a delegated agent (runs in parallel with external models)
2. **Claude** — independent analysis via `omcp ask claude`
3. **Codex** — independent analysis via `omcp ask codex`
4. **Gemini** — independent analysis via `omcp ask gemini`

After all four complete, Copilot synthesizes the combined findings.

Use this when you want parallel external perspectives without launching tmux team workers.

## When to Use

- Cross-validation where multiple models may catch different issues
- Code review from multiple perspectives (security, architecture, UX)
- Architecture decisions where diverse opinions reduce blind spots
- Fast advisor-style parallel input without team runtime orchestration

## Requirements

- **Claude Code**: `npm install -g @anthropic-ai/claude-code`
- **Codex CLI**: `npm install -g @openai/codex`
- **Gemini CLI**: `npm install -g @google/gemini-cli`
- `omcp ask` command available
- If any CLI is unavailable, continue with whichever providers are available and note the limitation

## How It Works

```text
1. Copilot decomposes the request into four analysis prompts:
   - Copilot prompt (domain knowledge, codebase context, project conventions)
   - Claude prompt (deep reasoning, logic, edge cases)
   - Codex prompt (architecture, correctness, backend, risks)
   - Gemini prompt (UX/design, alternatives, docs, usability)

2. Copilot runs all four in parallel:
   - Delegates a Copilot review agent (subagent with the analysis prompt)
   - `omcp ask claude "<claude prompt>"`
   - `omcp ask codex "<codex prompt>"`
   - `omcp ask gemini "<gemini prompt>"`

3. External artifacts are written under `.omcp/artifacts/ask/`

4. Copilot reads all four outputs and synthesizes into one final response
```

## Execution Protocol

When invoked, Copilot MUST follow this workflow:

### 1. Decompose Request
Split the user request into four analysis prompts:

- **Copilot prompt:** domain knowledge, codebase context, project conventions, integration risks — Copilot has direct repo access and can read code, git history, and project config
- **Claude prompt:** deep reasoning, logic correctness, edge cases, security analysis
- **Codex prompt:** architecture, backend patterns, test strategy, performance risks
- **Gemini prompt:** UX/content clarity, alternatives, design consistency, docs polish
- **Synthesis plan:** how to reconcile conflicts across four perspectives

### 2. Run all four analyses in parallel

> **Note:** Skill nesting (invoking a skill from within an active skill) is not supported. Always use the direct CLI path via Bash tool for external models.

Launch all four simultaneously:

- **Copilot:** Delegate an Agent (e.g. `subagent_type="oh-my-copilot:code-reviewer"`) with the Copilot prompt. This agent has full repo access and can read files, run commands, and check git state.
- **Claude, Codex, Gemini:** Run via CLI in parallel using file-based prompts to avoid command-line length limits (Windows has an ~8KB limit):

```bash
omcp ask claude "<claude prompt>"
omcp ask codex "<codex prompt>"
omcp ask gemini "<gemini prompt>"
```

> **Important — Windows command-line limit (~8KB):** Do NOT embed large content (diffs, file contents) directly in the prompt string. Instead:
> - Keep prompts concise — describe the task and tell the model to examine specific files/paths
> - External CLIs (Claude, Codex, Gemini) run in the repo working directory and can read files themselves
> - If context is needed, write it to a temp file and reference the path in the prompt: `"Review the diff in /tmp/cccg-diff.txt for security issues"`

### 3. Collect results

- **Copilot result:** returned directly from the delegated agent
- **External artifacts:** read from `.omcp/artifacts/ask/`:

```text
.omcp/artifacts/ask/claude-*.md
.omcp/artifacts/ask/codex-*.md
.omcp/artifacts/ask/gemini-*.md
```

### 4. Synthesize

Return one unified answer with:

- **Consensus:** recommendations all four models agree on
- **Conflicts:** where models disagree (explicitly called out with each model's position)
- **Unique insights:** valuable points raised by only one model
- **Copilot advantage:** findings that required direct repo access (git history, file reads, config checks)
- **Chosen direction:** final recommendation + rationale
- **Action checklist:** concrete next steps

## Fallbacks

Copilot's own review always runs (it has no external dependency). For external providers:

If one or two are unavailable:

- Continue with available providers + Copilot's own review + synthesis
- Clearly note missing perspectives and associated risk

If all three external providers are unavailable:

- Copilot's own review still runs — synthesize from that single perspective
- State that CCCG external advisors were unavailable

## Invocation

```bash
/oh-my-copilot:cccg <task description>
```

Example:

```bash
/oh-my-copilot:cccg Review this PR for security, architecture, and UX concerns
```
