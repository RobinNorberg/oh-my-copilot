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

1. Regenerate the Copilot projections: `node scripts/copilot/build-hooks.mjs --write` and `node scripts/copilot/build-agents.mjs --write`. Keep `hooks/hooks.json` and `agents/*.md` upstream-identical; adapt only the generated `copilot/hooks.json` and `copilot/agents/*.md`, which Copilot loads through the root `plugin.json`. A generator error means upstream changed the hook command form or agent frontmatter: extend the generator, never hand-edit the output. `copilot-hooks-manifest.test.ts` and `copilot-agents-manifest.test.ts` fail on drift (`--verify`).
2. Load check instead of installing and opening Copilot by hand: `npm run build`, then `omg smoke copilot --tier 0`. It makes no model call and confirms Copilot loads the plugin, its skills, agents, hooks, and MCP tools. A failed `copilot.plugin_list` with `[]` means a bad `--plugin-dir` or manifest path. Then `omg smoke copilot --tier 2 --sdk-static`, also free: it checks the plugin, skills, agents, and MCP tools as the runtime itself lists them through `@github/copilot-sdk` (install once: `npm i -g @github/copilot-sdk --omit=optional --ignore-scripts`; exit `2` means it is missing).
3. Run full test suite: `npm test`
4. Run type check: `npx tsc --noEmit`
5. Verify no upstream references leaked: `grep -r "oh-my-claudecode" src/ agents/ skills/ | grep -v node_modules`
6. Verify bridge bundles are clean: `grep -c "oh-my-claudecode" bridge/cli.cjs` (must be 0)
7. Live check before the PR: `omg smoke copilot --tier 1`. It runs one real Copilot session with the prompt on stdin and costs one premium request. It reuses your `copilot /login` identity and drops `GH_TOKEN`/`GITHUB_TOKEN` from the session, so do not export a token for it; `--model` is optional because Copilot auto-selects. It proves the hooks fire, run without `[omg-hook]` errors, and write `.omg/` state.
8. Create PR to dev: `gh pr create --base dev`

## Rename Map

Apply these substitutions when porting upstream code:

| Upstream | Fork |
|----------|------|
| `oh-my-claudecode` | `oh-my-copilot` |
| `CLAUDE_CONFIG_DIR` | `COPILOT_HOME` (except Claude-host-specific reads: `src/hooks/permission-handler/index.ts` `CLAUDE_CONFIG_DIR`, `skills/omc-setup/phases/04-welcome.md`) |
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
| Agent files `agents/*.md` | unchanged `agents/*.md` (installer also accepts `.agent.md`) |
| Runtime/state root `.omc/` (OmcPaths + scripts + skill docs) | `.omg/` |

### DO NOT Rename
- `platform.claude.com`, `claudeAiOauth` (Anthropic API refs)
- `CLAUDE_PLUGIN_ROOT` (Claude Code platform env var)
- `.claude/settings.local.json` (Claude Code config path)

## Fork Features to Preserve

When replacing files wholesale, check for these fork-specific additions:
- `formatTeamsAdaptiveCard` + `parseTeamsMention` in notifications
- `RecentTools` in HUD
- `isRunningAsPlugin` dual check (`PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`)
- HUD wrapper template at `scripts/lib/hud-wrapper-template.txt`
- `scripts/run.cjs` fail-closed timeout contract: `hookTimeoutStatus()` returns `124` under `OMC_HOOK_FAIL_CLOSED=1`, used at the generic-child and Worker timeout resolves; keep it when taking upstream `run.cjs` and re-run `npx vitest run src/__tests__/run-cjs-fail-closed-timeout.test.ts`

## Key Gotchas

- **Upstream tags collide with fork tags** (both have v5.0.0, v5.1.0, ...). The `upstream`
  remote is configured with `tagOpt=--no-tags` and fetches tags into
  `refs/upstream-tags/*`; always diff `refs/upstream-tags/vX.Y.Z`, never bare `vX.Y.Z`
  (bare tags are the fork's own releases).
- **Range-diff workflow** (preferred over per-commit): `git diff --binary <from> <to> -- .
  ':!dist' ':!bridge' ':!package-lock.json' ':!package.json' ':!CHANGELOG.md' ':!README.md'
  ':!.github/release-body.md' ':!inventory' > r.patch && git apply -3 r.patch`. `git apply` is
  atomic: a file upstream deleted but the fork diverged on aborts everything — `git rm` it and
  exclude it from the patch. Port package.json deltas by hand. Afterwards: `npm run build`
  (it ends with `build:copilot-hooks` and `build:copilot-agents`; re-run both after every
  upstream apply, see Step 4), `git add -f dist bridge copilot`, `npm run generate:inventory`,
  then commit.
- **macOS tmux rule diverges from upstream**: `omg launch` decides "`--madmax`/`--yolo` require
  tmux on macOS" from the RAW args on both hosts (upstream evaluates normalized Claude args).
  Copilot keeps native `--yolo` after normalization, so an upstream rewrite of that check must
  keep the raw-args source in `src/cli/launch.ts`.
- **State lock carries fork fixes stronger than upstream #4149/#4148**: `scripts/lib/state-lock.mjs`
  and `src/lib/mode-state-io.ts` (fork commit d9cc9a808) re-check the owner record and dev/ino
  immediately before rename, retry when the owner artifact vanished during a slow win32 probe,
  cache SQLite liveness probes across retries (probed outside `BEGIN IMMEDIATE`), bound release
  with a 5 s wall-clock budget, and keep the F15 ordering. On the next port keep the fork versions
  of both files, take only unrelated upstream hunks, and re-run
  `npx vitest run src/lib/__tests__/mode-state-lock.test.ts src/__tests__/shared-state-locking.test.ts src/installer/__tests__/standalone-state-lock-bridge.test.ts`.
- **Judge test results against a dev baseline, not zero**: ~725 tests fail on this Windows host
  at dev (symlink EPERM, POSIX modes, tmux, win32 graph guard). Build a baseline worktree of dev,
  run the full suite there, and diff failing test titles (normalize random tmp suffixes).
- **Upstream POSIX-isms that recur**: `x.includes('/templates/hooks/')` on native paths,
  `PACKAGE_ROOT + '/file'` compared to `realpathSync`, `execFileSync('npx', ...)` (use
  `process.execPath` + `node_modules/tsx/dist/cli.mjs`), `--import C:\...` / `import("C:\\...")`
  (use `pathToFileURL`), process identities with `:` used in filenames (NTFS ADS).
- **win32 liveness probes spawn PowerShell (~300ms)**: upstream lock loops that re-probe per retry
  time out on Windows; races invisible on Linux show up here.
- **Known gap (since v5.5.0)**: upstream strict process identity accepts only linux/darwin, so team
  instance recovery fails closed on win32 and ~90 team tests fail on this host. The fork fix below
  (`team-owner-epoch.ts` accepting `win32:<ticks>`) addresses this for win32 specifically.
- **psmux private-server model fork delta** (v5.4.0-v5.5.0 port; design:
  `scratchpad/design-psmux-server.md`, not tracked in this repo): `src/team/psmux-adapter.ts` (new,
  fork-owned, no `tmux-session` imports) plus the four `// Fork (psmux):` branches in
  `src/team/tmux-session.ts` (`buildPrivateTmuxSocketPath`, `runGuardedNativeTmuxCommand`, the
  fresh-detached-server create branch, and `killTeamSession`'s detached branch) and the `-S`→`-L`
  exec-layer translation hook in `src/cli/tmux-utils.ts` (`tmuxExec`/`tmuxExecAsync`/`tmuxSpawn`).
  Teams run detached in a private, randomly-named psmux namespace (`-L <ns>` under
  `~/.psmux/omg-ns/`) instead of a shared socket path, because psmux 3.3.8's `if-shell` cannot run
  any condition with arguments reliably (every PowerShell re-tokenisation mangles it), so the guard
  is replaced by "verify strict identity, then exec argv in the private namespace". On every
  upstream port that touches these files: re-run `npx vitest run
  src/team/__tests__/tmux-session.psmux.test.ts`, and re-run the live-acceptance equivalent,
  `scratchpad/team3.mjs` (made namespace-aware: it polls `config.json`'s
  `tmux_server_identity.socket_path` for the `omg-ns\<ns>` basename, then uses `tmux -L <ns> ls` /
  `list-panes` / `capture-pane` for pane evidence, and asserts the team is invisible in the default
  `psmux ls` and fully torn down after shutdown). That harness lives outside this repo in the
  session scratchpad directory — copy it to `scripts/dev/` later if the owner wants it tracked.
  `team-owner-epoch.ts`'s strict process identity accepting a `win32:<UTC ticks>` token (instead of
  failing closed on win32 like upstream) is also a fork fix owned by this delta; keep it on the
  next port of that file.
- **lean-ctx shell hook** rewrites some piped binaries to an undefined `_lc`; prefix with
  `command` (`command git ...`). Delegated agents must never rewrite repo files through shell
  redirects — two emptied files that way.

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
- **Agent file extension**: both upstream and the fork ship `agents/*.md`; the installer also accepts `.agent.md`
- **State directory**: `.omg/` everywhere (OmcPaths.ROOT, scripts, templates); the pre-tool-use template additionally allows legacy `.omc/`
- **Test mocks**: When upstream adds new exports, grep for `vi.mock.*{module}` and update all mocks
- **Bridge bundles**: Never manually edit — rebuild from source with `npm run build`
- **Count assertions**: New agents/skills require updating hardcoded counts in tests (see `omc-new-agent-skill-checklist` skill)
- **Our own fixes returning from upstream** (2026-10-05, 486b85bbb..bcaceb136): when a range contains
  PRs we authored upstream, the conflict is "same fix, different words" — take THEIRS and re-apply the
  rename map, keeping only genuinely fork-only hunks (state-lock SQLite probe caching, release budget,
  abandoned-nonce recovery). Upstream text is canonical; future ports then apply cleanly.
- **`package.json` is excluded from the range diff** — port `files`/`scripts`/peer-dep deltas by hand
  (`git diff <from>..upstream/dev -- package.json`).
- **Upstream tests may write `.claude/omc.jsonc`** → `.copilot/omg.jsonc`; on Windows the real assertion
  failure is masked by the temp-dir `rmSync` EPERM in `finally`, so check the Linux CI run, not the
  local log, before classifying a loader/config test as "baseline EPERM".
- **Gitignored fixtures**: `*.log` is ignored, so `git add -A` silently skips captured `.log` fixtures;
  CI then fails with ENOENT and mocked replays that read them hang to the 30 s timeout. Un-ignore with
  a scoped negation (`!src/<area>/__tests__/fixtures/*.log`) and `git add -f`.
- **New vitest scripts** in package.json must be classified in
  `tests/lint/subagent-lock-test-contract.test.ts` (`FUNCTIONAL_SCRIPTS` or `LIVE_SCRIPTS`), or CI fails
  with "unclassified Vitest script".
- **Smoke gates** (since v5.7.0): `omg smoke copilot --tier 2 --sdk-static` after the generators (free),
  `--tier 2` default scenarios before the PR (~2 premium requests) — replaces opening Copilot by hand.
- **Orchestration** (since v5.8.1): the end-to-end order, the two parallel lanes and the
  gated chain live in `.omc/skills/port-and-release-cycle.md`; this file stays the
  contract for the range diff, rename map and fork-owned logic.
- **Our own fixes returning (2026-10-06):** when upstream merges a fork-submitted fix in
  the maintainer's own shape (e.g. #4246's lean shipped-module imports), take THEIRS
  outright and delete the fork's earlier variant — do not keep two implementations.
- **Upstream release markers** (`.github/RELEASE_SIGNOFF`) come in with their release
  commits; drop them, nothing in the fork reads them.
- **Config file naming** is inconsistent in the fork (`security-config.ts` and the Stop
  hooks read `.copilot/omc.jsonc`; the naming convention says `omg.jsonc`) — resolve
  before touching either side in a port.
