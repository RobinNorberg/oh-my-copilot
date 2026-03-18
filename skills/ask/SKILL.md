---
name: ask
description: Ask Copilot, Codex, or Gemini via local CLI and capture a reusable artifact
---

# Ask

Use OMC's canonical advisor skill to route a prompt through the local Copilot, Codex, or Gemini CLI and persist the result as an ask artifact.

## Usage

```bash
/oh-my-copilot:ask <claude|copilot|codex|gemini> <question or task>
```

Examples:

```bash
/oh-my-copilot:ask codex "review this patch from a security perspective"
/oh-my-copilot:ask gemini "suggest UX improvements for this flow"
/oh-my-copilot:ask claude "draft an implementation plan for issue #123"
```

## Routing

Preferred path:

```bash
omc ask {{ARGUMENTS}}
```

## Requirements

- The selected local CLI must be installed and authenticated.
- Verify availability with the matching command:

```bash
claude --version
codex --version
gemini --version
```

## Artifacts

`omc ask` writes artifacts to:

```text
.omg/artifacts/ask/<provider>-<slug>-<timestamp>.md
```

Task: {{ARGUMENTS}}
