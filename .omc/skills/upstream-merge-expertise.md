# Upstream Fork Merge — Large Codebase Delta

## The Insight

When merging a large upstream delta into a deeply-customized fork, **wholesale file replacement fails catastrophically** even with branding sed passes. The fork's customizations are layered: branding (simple sed), env var renames (moderate), structural divergence (config keys, state paths, function signatures), and fork-specific features (additive code not in upstream). Each layer requires a different fix strategy.

The winning approach: **feature-by-feature with commit-per-feature**, triaging each file by customization depth (Level 0-3) before choosing replace vs surgical merge.

## Why This Matters

Naive approaches fail in two ways:
1. **Sequential application** takes forever on large deltas
2. **Blind parallel application** creates race conditions where agents overwrite each other's edits on shared files, and new files that are dependencies of bug fixes get missed

In this session, agents overwrote each other's edits 3 times on `config/models.ts`, `constants/names.ts`, and `model-contract.ts` because multiple work packages touched shared config files.

## Recognition Pattern

- Fork diverged by 1+ minor versions from upstream
- Upstream diff stat shows 100+ files changed
- Mix of bug fixes (modified files) and new features (added files)
- Some new files are **implicit dependencies** of bug fixes (e.g., `standalone-shutdown.ts` imported by modified `standalone-server.ts`)

## The Approach

### Phase 1: Dependency-First Triage (before any code changes)

1. **`git diff --stat`** between tags for scope
2. **`git diff --diff-filter=A --name-only`** to find NEW files
3. **`git diff --diff-filter=M --name-only`** to find MODIFIED files
4. **Cross-reference**: Check which new files are imported by modified files — these are **dependency files** that must be created FIRST
5. **Existence check**: For every modified upstream file, verify it exists in the fork. Missing = we deleted it (skip)

### Phase 2: Work Package Design

Group by **dependency isolation**, not by directory:

- **WP0 (blocking)**: New files that are dependencies of other changes (types, utilities, shared modules)
- **WP1-N (parallel)**: Independent change groups where no two packages modify the same file
- **Shared config files**: Assign to ONE package only, or handle directly after all agents finish

### Phase 3: Parallel Execution with Conflict Prevention

- Each agent gets `bypassPermissions` mode (learned: agents blocked on Edit permissions waste 80% of their time)
- Each agent gets **Windows-native paths** for temp files (learned: `/tmp/` in Git Bash maps to `C:\Users\...\AppData\Local\Temp\` which agents using Read tool can't resolve)
- **Never** let two agents touch the same file — if unavoidable, one does the work and the other skips it

### Phase 4: Fix-Forward After Convergence

After all agents complete:
1. Run `tsc --noEmit` — fix type errors from missing imports, incomplete edits
2. Run test suite — fix mock mismatches from new exports (e.g., `vi.mock` doesn't include newly added functions)
3. Re-run both until green

### Key Gotcha: Test Mocks

When upstream adds a new exported function to a module (e.g., `resolveClaudeWorkerModel` in `model-contract.ts`), every test file that mocks that module with `vi.mock(() => ({...}))` will **fail** because vitest enforces mock completeness. Grep for `vi.mock.*{module-name}` and add the new function to each mock.

## Small Patch Ports (single minor version)

For small upstream releases (< 10 PRs, < 200 files), the dependency-graph triage is overkill. Use this streamlined workflow:

### Critical: Fresh main before starting

**Always** `git fetch origin main:main` before starting any port work. A stale local `main` can silently re-introduce code that was removed by recently-merged PRs (e.g., PR #16 removed Anthropic SDKs but a stale main still had them — the port branch re-added them via merge).

**Always** base port branches on `main`, never `dev` or feature branches. Dev can be behind main — basing on stale code causes merge conflicts and duplicated work when the PR lands.

```bash
git fetch origin main:main
git checkout -b port/upstream-vX.Y.Z main
```

### Streamlined Steps

1. **Analyze**: `git log vOLD..vNEW --oneline` + `git diff vOLD..vNEW --stat` in the upstream repo
2. **Read actual diffs**: `git diff vOLD..vNEW -- <file>` for each changed file — commit messages alone are insufficient
3. **Filter by policy**: Skip non-English i18n files, upstream-specific docs, Claude Code-specific CLI features
4. **Adapt references**: Replace `oh-my-claudecode` → `oh-my-copilot`, `yeachan-heo` → check allowed locations only (LICENSE, README.md)
5. **Apply edits directly**: For < 30 files, apply edits sequentially — no need for parallel agents
6. **Verify**: `tsc --noEmit` + build scripts + full test suite
7. **Version bump**: 4 files (package.json, plugin.json, marketplace.json, copilot-instructions.md OMC:VERSION marker)

### Adaptation Checklist

When porting each change, check:
- [ ] File exists in our repo (we may have deleted it)
- [ ] No `oh-my-claudecode` or `yeachan-heo` references introduced (except LICENSE + README.md)
- [ ] Plugin name references use `oh-my-copilot` not `oh-my-claudecode`
- [ ] State directory references use `.omcp` (template hooks) or `.omc` (TypeScript source) as appropriate
- [ ] Environment variable names match our fork (e.g., `PLUGIN_ROOT` vs `OMC_PLUGIN_ROOT`)

## Deep Fork Adaptation (v4.11.6 Learnings)

### File Customization Triage

For each upstream file, check `grep -c "copilot\|Copilot\|COPILOT\|omcp"`:
- **Level 0** (0-2 refs): Wholesale replace + branding sed
- **Level 1** (3-10 refs): Replace + full rename map (all 15 mappings)
- **Level 2** (10-50 refs): Surgical — apply upstream diff hunks to fork's file
- **Level 3** (50+ refs): Deep merge — understand both versions, merge manually

### Bridge/Dist Rebuild Shortcut (v4.11.7 Learning)

**Never manually edit L3 compiled files** (bridge/cli.cjs, bridge/mcp-server.cjs, etc.).
These are esbuild bundles — if the source files are ported correctly, just rebuild:

```bash
npm run build:cli          # → bridge/cli.cjs + bridge/team.js
node scripts/build-skill-bridge.mjs  # → dist/hooks/skill-bridge.cjs
node scripts/build-mcp-server.mjs    # → bridge/mcp-server.cjs
node scripts/build-bridge-entry.mjs  # → bridge/team-bridge.cjs
npm run build:runtime-cli  # → bridge/runtime-cli.cjs
npx tsc --skipLibCheck     # → dist/ (use --skipLibCheck to bypass missing optional deps)
```

Post-build verification: `grep -c "oh-my-claudecode" bridge/cli.cjs` must return 0.
This saved 3-4 hours on the v4.11.7 port vs manually editing 3,627 diff lines.

### Agent File Extension Divergence

Upstream agents use `.md` extension (`agents/critic.md`).
OMC agents use `.agent.md` extension (`agents/critic.agent.md`).

When porting agent frontmatter changes (e.g., model aliases), apply to `.agent.md` files.
When tests create agent fixture files in temp dirs, use `.md` (matching plugin convention).

### Complete Rename Map (oh-my-copilot fork)

```
oh-my-claudecode → oh-my-copilot
CLAUDE_CONFIG_DIR → COPILOT_CONFIG_DIR
CLAUDE_FAMILY_DEFAULTS → COPILOT_FAMILY_DEFAULTS
isNonClaudeProvider → isNonCopilotProvider
skipClaudeCheck → skipCopilotCheck
isClaudeInstalled → isCopilotInstalled
isClaudeAvailable → isCopilotAvailable
hasClaudeCode → hasCopilotCode
getClaudeConfigDir → getCopilotConfigDir
getClaude*Permission* → getCopilot*Permission*
claude-native → copilot-native, tmux-claude → tmux-copilot
omc-hud → omcp-hud, OMC_CLI_BINARY = 'omcp'
cache slug: 'omg' (not 'omc'), config key: 'omg'
markers: OMG:START/OMG:END (OMC:VERSION unchanged)
PLUGIN_ROOT || CLAUDE_PLUGIN_ROOT (not just CLAUDE_PLUGIN_ROOT)
WORKER_BLOCKED_TEAM_CLI_PATTERN: \bom(?:cp?|x)\s+team\b
usage cache: .usage-cache-{provider}.json
New env vars: OMC_TEAM_ROLE_OVERRIDES → OMCP_TEAM_ROLE_OVERRIDES
Log prefix: [OMC] → [OMCP] (in new validation/error messages)
```

### .omcp Path Gotcha (CRITICAL)

Runtime scripts use THREE quoting styles — all must be handled:
```bash
sed "s/'\.omc', 'state'/'\.omcp', 'state'/g"   # single-quote join args
sed 's/"\.omc", "state"/".omcp", "state"/g'     # double-quote join args
sed 's|\.omc/state|.omcp/state|g'               # string literals
```
Also: `scripts/lib/state-root.{cjs,mjs}` inline fallback must return `.omcp`.

### DO NOT Rename (Anthropic API refs)

`platform.claude.com`, `claudeAiOauth`, `CLAUDE_PLUGIN_ROOT`, `.claude/settings.local.json`

### Fork Features to Preserve When Replacing Files

- `formatTeamsAdaptiveCard` + `parseTeamsMention` in `notifications/formatter.ts`
- `RecentTools` in `hud/types.ts`, `hud/render.ts`, `hud/elements/recent-tools.ts`
- `LifecycleProfile` in `team/types.ts`
- `isRunningAsPlugin` checking both `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`
- HUD wrapper template at `scripts/lib/hud-wrapper-template.txt`

## Example

```javascript
// state-root.cjs fallback — WRONG (upstream sed):
return join(directory, '.omc');
// CORRECT (fork):
return join(directory, '.omcp');
```
Caused stop-hook to write to `.omcp/state/` but read from `.omc/state/`, making `shouldBlock` always false.
