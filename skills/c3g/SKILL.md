---
name: c3g
description: Quadri-model orchestration — Claude, Codex, and Gemini provide independent analysis, Copilot synthesizes
---

# C3G - Copilot-Claude-Codex-Gemini Orchestration

C3G (3 C's + G) fans out to three external models (Claude, Codex, Gemini) for independent analysis, then Copilot synthesizes all perspectives into one unified answer.

Four models participate:
1. **Claude** — independent analysis via `omc ask claude`
2. **Codex** — independent analysis via `omc ask codex`
3. **Gemini** — independent analysis via `omc ask gemini`
4. **Copilot** — orchestrator, reads all three responses and produces the synthesis

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
- `omc ask` command available
- If any CLI is unavailable, continue with whichever providers are available and note the limitation

## How It Works

```text
1. Copilot decomposes the request into three advisor prompts:
   - Claude prompt (deep reasoning, logic, edge cases)
   - Codex prompt (architecture, correctness, backend, risks)
   - Gemini prompt (UX/design, alternatives, docs, usability)

2. Copilot runs all three via CLI in parallel:
   - `omc ask claude "<claude prompt>"`
   - `omc ask codex "<codex prompt>"`
   - `omc ask gemini "<gemini prompt>"`

3. Artifacts are written under `.omg/artifacts/ask/`

4. Copilot reads all three outputs and synthesizes into one final response
```

## Execution Protocol

When invoked, Copilot MUST follow this workflow:

### 1. Decompose Request
Split the user request into:

- **Claude prompt:** deep reasoning, logic correctness, edge cases, security analysis
- **Codex prompt:** architecture, backend patterns, test strategy, performance risks
- **Gemini prompt:** UX/content clarity, alternatives, design consistency, docs polish
- **Synthesis plan:** how to reconcile conflicts across three perspectives

### 2. Invoke advisors via CLI

> **Note:** Skill nesting (invoking a skill from within an active skill) is not supported. Always use the direct CLI path via Bash tool.

Run all three advisors in parallel:

```bash
omc ask claude "<claude prompt>"
omc ask codex "<codex prompt>"
omc ask gemini "<gemini prompt>"
```

### 3. Collect artifacts

Read latest ask artifacts from:

```text
.omg/artifacts/ask/claude-*.md
.omg/artifacts/ask/codex-*.md
.omg/artifacts/ask/gemini-*.md
```

### 4. Synthesize

Return one unified answer with:

- **Consensus:** recommendations all three models agree on
- **Conflicts:** where models disagree (explicitly called out with each model's position)
- **Unique insights:** valuable points raised by only one model
- **Chosen direction:** final recommendation + rationale
- **Action checklist:** concrete next steps

## Fallbacks

If one or two providers are unavailable:

- Continue with available providers + Copilot synthesis
- Clearly note missing perspectives and associated risk

If all three unavailable:

- Fall back to Copilot-only answer and state C3G external advisors were unavailable

## Invocation

```bash
/oh-my-copilot:c3g <task description>
```

Example:

```bash
/oh-my-copilot:c3g Review this PR for security, architecture, and UX concerns
```
