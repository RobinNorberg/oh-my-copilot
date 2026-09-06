---
name: port-upstream
description: Port commits from upstream oh-my-claudecode dev branch into oh-my-copilot one-by-one
triggers:
  - "port upstream"
  - "port from upstream"
  - "sync upstream"
  - "upstream port"
  - "cherry-pick upstream"
---

# Port Upstream

Port commits from the upstream `yeachan-heo/oh-my-claudecode` dev branch into a local `oh-my-copilot` port branch, one commit at a time with full adaptation.

## Directories

- **Upstream repo**: `C:\Code\oh-my-claudecode` (read-only reference; `upstream` remote also configured in the fork)
- **Our fork**: `C:\Code\OMC` (working directory for all edits)

## Workflow

### Step 1: Setup

1. Fetch latest upstream dev (in the upstream repo directory):
   ```bash
   git -C /c/Code/Temp/oh-my-claudecode fetch origin && git -C /c/Code/Temp/oh-my-claudecode checkout dev && git -C /c/Code/Temp/oh-my-claudecode pull
   ```

2. Fetch our latest dev:
   ```bash
   cd /c/Code/OMC && git fetch origin dev:dev
   ```

3. Identify what needs porting — list upstream commits since last port:
   ```bash
   git -C /c/Code/Temp/oh-my-claudecode log --oneline dev --since="<last-port-date>"
   ```
   Or compare tags:
   ```bash
   git -C /c/Code/Temp/oh-my-claudecode log --oneline <last-ported-upstream-tag>..dev
   ```

4. Create port branch from our dev:
   ```bash
   cd /c/Code/OMC && git checkout -b port/upstream-<date-or-version> dev
   ```

### Step 2: Analyze Each Commit

For each upstream commit (oldest first):

1. **Read the commit** (in upstream repo): `git -C /c/Code/Temp/oh-my-claudecode show <hash> --stat` then `git -C /c/Code/Temp/oh-my-claudecode show <hash>` for the full diff
2. **Filter by policy** — SKIP commits that are:
   - Non-English i18n / CJK / Korean translations
   - Claude Code CLI-specific features (not applicable to Copilot CLI)
   - Upstream-only docs or CI changes
3. **Classify files** by customization depth:
   - **Level 0** (no fork refs): Apply directly + branding sed
   - **Level 1** (few fork refs): Apply + full rename map
   - **Level 2** (many fork refs): Surgical merge of upstream diff hunks
   - **Level 3** (deeply customized): Manual merge understanding both versions

### Step 3: Apply Each Commit

For each non-skipped commit:

1. **Read the upstream diff** carefully
2. **Apply the changes** to our fork's files, adapting as needed
3. **Run the rename map** on any new/replaced content (see Rename Map below)
4. **Check for new files** that are dependencies of modified files
5. **Build**: `npm run build`
6. **Test**: `npx vitest run` (at minimum, run affected test files)
7. **Commit** with message: `port: <original-commit-summary> (upstream <short-hash>)`

### Step 4: Finalize

1. Run full test suite: `npm test`
2. Run type check: `npx tsc --noEmit`
3. Verify no upstream references leaked: `grep -r "oh-my-claudecode" src/ agents/ skills/ | grep -v node_modules`
4. Verify bridge bundles are clean: `grep -c "oh-my-claudecode" bridge/cli.cjs` (must be 0)
5. Create PR to dev: `gh pr create --base dev`

## Rename Map

Apply these substitutions when porting upstream code:

| Upstream | Fork |
|----------|------|
| `oh-my-claudecode` | `oh-my-copilot` |
| `CLAUDE_CONFIG_DIR` | `COPILOT_CONFIG_DIR` |
| `CLAUDE_FAMILY_DEFAULTS` | `COPILOT_FAMILY_DEFAULTS` |
| `isNonClaudeProvider` | `isNonCopilotProvider` |
| `skipClaudeCheck` | `skipCopilotCheck` |
| `isClaudeInstalled` | `isCopilotInstalled` |
| `isClaudeAvailable` | `isCopilotAvailable` |
| `hasClaudeCode` | `hasCopilotCode` |
| `getClaudeConfigDir` | `getCopilotConfigDir` |
| `getClaude*Permission*` | `getCopilot*Permission*` |
| `claude-native` | `copilot-native` |
| `tmux-claude` | `tmux-copilot` |
| `omc-hud` | `omg-hud` |
| `OMC_CLI_BINARY` | `'omg'` |
| `omc` CLI invocations in docs/messages | `omg` |
| `.claude/omc.jsonc` (project config) | `.copilot/omg.jsonc` |
| Host dir `.claude/` (Copilot host surface) | `.copilot/` (keep `.claude` fallbacks where dev already has them) |
| Agent files `.md` | `.agent.md` |
| Runtime/state root `.omc/` (OmcPaths + scripts + skill docs) | `.omg/` |

### DO NOT Rename
- `platform.claude.com`, `claudeAiOauth` (Anthropic API refs)
- `CLAUDE_PLUGIN_ROOT` (Claude Code platform env var)
- `.claude/settings.local.json` (Claude Code config path)

## Fork Features to Preserve

When replacing files wholesale, check for these fork-specific additions:
- `formatTeamsAdaptiveCard` + `parseTeamsMention` in notifications
- `RecentTools` in HUD
- `LifecycleProfile` in team types
- `isRunningAsPlugin` dual check (`PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`)
- HUD wrapper template at `scripts/lib/hud-wrapper-template.txt`

## Key Gotchas

- **Always base port branches on `dev`** (latest code), never feature branches
- **Windows-hostile upstream tests**: upstream writes temp-path and team-dispatch
  expectations for POSIX hosts (`/tmp/...` allowances, `$OMC_TEAM_STATE_ROOT`
  placeholders). The implementations deliberately branch on `win32`; adapt the
  ported test EXPECTATIONS platform-aware, don't change the implementation.
- **chdir/rmSync EPERM**: upstream tests that `process.chdir(tempDir)` then
  `rmSync(tempDir)` in `finally` fail on Windows (cannot delete the cwd);
  restore cwd before rmSync when porting such tests.
- **Pre-existing local Windows failures** (not port regressions, baseline on dev
  as of 2026-09-06): 15 in config/loader.test.ts (chdir/rmSync EPERM), 3 in
  session-end-process-exit (timing ceilings), 3 in runtime-v2.dispatch
  ($OMC_TEAM_STATE_ROOT placeholder vs win32 absolute paths), plus tmux/POSIX
  permission suites under src/team.
- **Agent file extension**: Upstream uses `.md`, we use `.agent.md`
- **State directory**: `.omg/` everywhere (OmcPaths.ROOT, scripts, templates); the pre-tool-use template additionally allows legacy `.omc/`
- **Test mocks**: When upstream adds new exports, grep for `vi.mock.*{module}` and update all mocks
- **Bridge bundles**: Never manually edit — rebuild from source with `npm run build`
- **Count assertions**: New agents/skills require updating hardcoded counts in tests (see `omc-new-agent-skill-checklist` skill)
