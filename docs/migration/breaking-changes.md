# Breaking Changes

## Migrating from oh-my-claudecode

oh-my-copilot is a fork of [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode). If you're migrating from the upstream project, note these differences:

### Naming

| oh-my-claudecode | oh-my-copilot |
|------------------|---------------|
| `.omc/` state directory | `.omg/` state directory |
| `OMC` abbreviation | `OMC` abbreviation (same) |
| `omc-setup`, `omc-doctor` commands | Same command names |
| `oh-my-claudecode:` skill prefix | `oh-my-copilot:` skill prefix |

### State Directory

oh-my-copilot uses `.omg/` for its state directory (instead of `.omc/`) to avoid collision if both plugins are installed side-by-side.

### Multi-AI Orchestration

oh-my-copilot supports all 4 CLI providers as team workers:

```bash
omc team N:claude "..."    # Claude Code CLI
omc team N:copilot "..."   # Copilot CLI
omc team N:codex "..."     # OpenAI Codex CLI
omc team N:gemini "..."    # Google Gemini CLI
```

---

> For upstream breaking changes prior to the fork, see the [original migration guide](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/main/docs/MIGRATION.md).
