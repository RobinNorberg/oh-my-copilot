---
name: ask
description: Process-first advisor routing for Copilot, Claude, Codex, or Gemini via `omcp ask`, with artifact capture and no raw CLI assembly
---

# Ask

Use OMC's canonical advisor skill to route a prompt through a local CLI (Copilot, Claude, Codex, or Gemini) and persist the result as an ask artifact.

## Usage

```bash
/oh-my-copilot:ask <copilot|claude|codex|gemini> <question or task>
```

Examples:

```bash
/oh-my-copilot:ask copilot "get a fresh perspective on this design decision"
/oh-my-copilot:ask codex "review this patch from a security perspective"
/oh-my-copilot:ask gemini "suggest UX improvements for this flow"
/oh-my-copilot:ask claude "draft an implementation plan for issue #123"
```

## Routing

**Required execution path — always use this command:**

```bash
omcp ask {{ARGUMENTS}}
```

**Do NOT manually construct raw provider CLI commands.** Never run `copilot`, `codex`, `claude`, or `gemini` directly to fulfill this skill. The `omcp ask` wrapper handles correct flag selection, artifact persistence, and provider-version compatibility automatically. Manually assembling provider CLI flags will produce incorrect or outdated invocations.

## Requirements

- The selected local CLI must be installed and authenticated.
- Verify availability with the matching command:

```bash
copilot --version
claude --version
codex --version
gemini --version
```

## Artifacts

`omcp ask` writes artifacts to:

```text
.omcp/artifacts/ask/<provider>-<slug>-<timestamp>.md
```

Task: {{ARGUMENTS}}
