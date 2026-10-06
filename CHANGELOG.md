# Changelog

All notable changes to oh-my-copilot will be documented in this file.

## Unreleased

### Fork: Copilot host adaptations

- **Factory chains run past their first link on Copilot:** Copilot CLI has no
  `--session-id`, so a factory chain used to stop silently after one link.
  The spawner now sets `OMC_CHAIN_LINK=<link id>` on each Copilot link, and
  SessionEnd resolves the link as `OMC_CHAIN_LINK`, then the host session id.
  The variable is trusted only when it names a `host: "copilot"` ledger
  that the link's SessionStart bound to the ending session, so neither the
  variable alone nor a nested session inheriting it can inject or end a
  link; the SessionEnd worker never forwards it. A duplicate SessionEnd gets
  the same chain back. Copilot's SessionEnd reason
  `complete` counts as success. Ledgers record `chainLink`, `host`,
  `createdAt` and `parentLink` and are closed once by their link's SessionEnd
  (`closedAt`, `hostSessionId`, `outcome`, `decision`); the watchdog skips
  a closed ledger only when it advanced the chain or left a stop marker, and
  `omg factory status` lists each chain's links. A ledger's
  `maxStageVisits` now carries to later links (above 99 clamps to 99). Under
  a dev plugin root that does not overlap the link's working directory,
  Copilot links get `--plugin-dir` and the SessionEnd worker forwards
  `OMC_PLUGIN_ROOT`. Guardrails, `COPILOT_ALLOW_ALL=false` and the AFK
  profile are unchanged. Verified live with a two-link chain on Copilot CLI
  1.0.91 (2 premium requests).
- **`omg smoke copilot --scenario chain`:** an opt-in tier 2 scenario that
  runs that two-link chain against real `copilot -p` links and asserts the
  link identity, the hand-off, the closeout and the cost from the ledgers
  and both sessions' events. It is not part of `all` or the default set.
- **Headless Copilot smoke in CI:** a new `smoke` job in
  `.github/workflows/ci.yml` installs the Copilot CLI (`npm i -g
  @github/copilot`) and `@github/copilot-sdk` on ubuntu-latest and runs
  `omg smoke copilot --tier 2 --sdk-static` after every build, with zero
  model calls. Pushed `v*` tags also run the default scenarios (`smoke`,
  `guardrail`, about 2 premium requests). It authenticates with the
  repository secret `COPILOT_GITHUB_TOKEN` and passes with a skip notice when
  the secret is absent, as on fork PRs. Reports and the kept homes are
  uploaded only after a scan for token-shaped strings and the exact token
  passes. Pinned by `tests/lint/copilot-smoke-ci-workflow.test.ts`; setup in
  [docs/DEVELOPERS.md](docs/DEVELOPERS.md#tier-2-in-ci).
- **Smoke on Linux:** the missing-binary message no longer names the WinGet
  directory off Windows; it points at `npm i -g @github/copilot`.
- **Copilot SessionEnd foreground budget is 1500 ms:** `scripts/run.cjs` gave
  `session-end.mjs` and `wiki-session-end.mjs` 300 ms on both hosts, so under
  load Copilot recorded failed SessionEnd hooks (exit 124 with
  `OMC_HOOK_FAIL_CLOSED=1`) and dropped the cleanup. Copilot waits up to 30 s
  for SessionEnd, so the budget is now 1500 ms when `OMC_HOOK_EVENT=SessionEnd`.
  Claude Code keeps 300 ms. `OMC_SESSION_END_BUDGET_MS` overrides both. With 4
  parallel lanes of 8 SessionEnd pairs, 0/64 runs fail (before: 56-63/64).
  `session-end.mjs` also loads the factory chain enqueuer only when a chain
  ledger or `OMC_CHAIN_LINK` exists, which cuts its idle median from 300 ms
  to about 260 ms.
- **Copilot runs generic hooks in a Worker:** under Copilot (`OMC_HOOK_EVENT`
  set), `scripts/run.cjs` runs the 18 audited generic hook scripts in a Worker
  thread instead of the Windows `--generic-child-supervisor` chain of three
  Node processes. Timeout, `OMC_SESSION_OWNER_PID`, extra arguments, stdin,
  exit code and fail-closed 124 are unchanged, and every hook's output matches
  the child path. Each hook is about 90 ms faster on Windows: Stop 1331 to
  893 ms, SessionStart 1919 to 1471 ms (local bench). Claude Code keeps the
  child path. `OMC_COPILOT_HOOK_WORKER=0` turns the routing off.

# oh-my-copilot v5.7.0

## [5.7.0] - 2026-10-05

Fork **v5.7.0** (from v5.6.2) is a minor release: it adds the headless smoke
harness (`omg smoke copilot` and the MCP tool `host_smoke`, tiers 0 to 2),
fixes two hook behaviours, and ports upstream oh-my-claudecode `dev`
486b85bbb..bcaceb136. Upstream is still at version 5.6.1. No breaking
changes: the new peer dependency `@github/copilot-sdk` is optional and
`OMC_HOOK_FAIL_CLOSED` is opt-in. The skill count stays 61. See the
[v5.6.2 → v5.7.0 note](docs/MIGRATION.md#v562--v570-smoke-harness).

### Ported from upstream oh-my-claudecode dev (486b85bbb..bcaceb136)

#4231 to #4234 originated in this fork and were merged upstream; they return
here in upstream's canonical form.

- **`intake run --headless` (#4231):** `intake run` registers `--headless`,
  the flag the entry written by `intake schedule` passes, so scheduled
  sweeps no longer exit with `unknown option '--headless'`. Covered by
  `src/cli/commands/__tests__/intake-headless-flag.test.ts`.
- **Team shutdown tests (#4232):** the dead-owner identity in
  `src/cli/__tests__/team.test.ts` is derived from the host platform, so the
  tests pass on Windows as well as POSIX.
- **State-lock owner-reclaim test (#4233):** adds the missing
  `scripts/dev/repro-state-lock.mjs` and makes
  `tests/integration/state-lock-owner-reclaim.test.ts` assert real lock
  acquisitions.
- **State-lock file identity (#4234):** identity helpers that guard a lock
  artifact or a publication stat with `{ bigint: true }`, so NTFS file ids
  above 2^53 stay distinct (state-lock, mode-state-io and the atomic-write
  twins; the win32 zero-dev tolerance is kept as `0n`).
  `sameStateFileGeneration` compares through `sameFileIdentity`, so a
  generation-bound clear no longer fails closed on win32 dev 0. Before
  quarantining a dead owner, both lock twins re-read the owner record and
  require the same owner as well as the same identity.
- **Team worker env passthrough off the command line (#4236, fixes #4230):**
  `OMC_TEAM_WORKER_ENV_PASSTHROUGH` values are no longer inlined into the
  worker pane's `env -i KEY='value'` command, where they showed in argv and
  tmux `pane_start_command`. Only the fixed baseline stays inline; the
  passthrough values go to a private `0600` file in a `0700` directory that
  the pane's `/bin/sh` sources, removes, and then execs the login shell.

### Fork

- **`omg smoke copilot` and MCP tool `host_smoke`:** a headless smoke check
  that loads a plugin root into the real GitHub Copilot CLI inside a
  throwaway `COPILOT_HOME`. Tier 0 makes no model call: it checks the
  manifest, generated hooks and agents, `plugin list` / `skill list`, and the
  MCP tool count. Tier 1 (`--tier 1`) adds one live session with the prompt
  on stdin, costing one premium request, and asserts the session events,
  hook runs (hooks run fail-closed; `hooks.adapter_errors` fails on any
  `[omg-hook]` error line), plugin and MCP load, and `.omg/` state writes.
  The standalone MCP server now exposes 56 tools; `OMC_DISABLE_TOOLS=smoke`
  hides `host_smoke`. The MCP tool only smokes its own package root unless
  `OMC_SMOKE_ALLOW_ANY_ROOT=1`, and refuses tier 1 unless
  `OMC_SMOKE_ALLOW_LIVE=1`.
  `npm run test:live` runs `tests/live/copilot-smoke.test.ts` (Tier 1 only
  with `OMC_LIVE_SMOKE=1`); the default test run excludes `tests/live/**`.
  See [docs/DEVELOPERS.md](docs/DEVELOPERS.md#headless-smoke-against-a-local-build).
- **Smoke tier 2, SDK-driven scenarios:** `omg smoke copilot --tier 2` drives
  the installed Copilot CLI through `@github/copilot-sdk`, now an optional
  peer dependency that npm does not install
  (`npm i -g @github/copilot-sdk --omit=optional --ignore-scripts`). It adds
  free `sdk.*` checks of the runtime's plugin, skill, agent, and MCP lists
  (`--sdk-static` runs only these) and the scenarios `smoke` and `guardrail`
  by default, plus `skill` and `delegate` (`--scenario <list|all>`), each
  about one premium request, so the default run costs about two.
  `--max-credits` caps the whole run: a scenario that passes it is aborted
  and the rest are skipped. `sdk.tools_excluded` proves the smoke's own
  `host_smoke` tool is hidden from the model. Under vitest a billable run is
  refused unless `OMC_LIVE_SMOKE` names the tier. The report gains `sdk`,
  `cost`, and per-scenario `artifacts.events`. `host_smoke` accepts `tier: 2` and `scenarios`; tier 2
  with scenarios needs `OMC_SMOKE_ALLOW_LIVE=1`, `scenarios: []` does not.
  `npm run test:live` runs the tier 2 static checks when the SDK resolves and
  the default scenarios with `OMC_LIVE_SMOKE=2`.
  See [docs/DEVELOPERS.md](docs/DEVELOPERS.md#tier-2--sdk-scenarios).
- **Hook runner fails closed on timeout when asked:** with
  `OMC_HOOK_FAIL_CLOSED=1`, `scripts/run.cjs` exits `124` when a hook times
  out, instead of `0`. Without the variable it still fails open.
- **Wiki capture fits the SessionEnd budget:** `scripts/wiki-session-end.mjs`
  imports the lean `dist/hooks/session-end/wiki-foreground-bootstrap.js`
  entry instead of the full SessionEnd module graph, which cost about 100 ms
  of the 300 ms SessionEnd budget. Wiki capture now completes reliably under
  Copilot instead of being cut off.

# oh-my-copilot v5.6.2

## [5.6.2] - 2026-10-05

Fork **v5.6.2** (from v5.6.1) ports upstream oh-my-claudecode `dev`
4280efb1f..486b85bbb. Upstream is still at version 5.6.1; the fork bumps its
own patch version. No breaking changes; the skill count stays 61. Nothing to
migrate; see the [v5.6.1 → v5.6.2 note](docs/MIGRATION.md#v561--v562-postinstall-hook).

### Ported from upstream oh-my-claudecode dev (4280efb1f..486b85bbb)

- **contained-fs postinstall (#4217):** `npm install` now runs a
  `postinstall` hook (`scripts/postinstall-contained-fs.mjs`). On macOS it
  builds the contained-fs native addon when no prebuilt
  `native/contained-fs-darwin-<arch>.node` is present; if the build cannot
  run (no Node headers or Xcode Command Line Tools), it prints a one-line
  warning with the manual `node scripts/build-contained-fs.mjs` command and
  exits 0. On Linux and Windows, and in a source checkout (a `.git`
  directory at the package root), it exits 0 without doing anything.
  `scripts/build-contained-fs.mjs` takes a new `--optional` flag that skips
  instead of throwing when the platform is unsupported or no headers are
  found. CI checks that the packed tarball contains the build, postinstall
  and verify scripts, `native/contained-fs.c` and the `postinstall` entry,
  and that the tarball installs cleanly;
  `tests/integration/contained-fs-packaging.test.ts` covers the packaging.
- **Production-safe `team shutdown` (#4218):** shutdown first removes a stale
  team reservation whose owner process is dead (`cleanupStaleReservations`,
  under the lifecycle lock). Shutting down a team with no state prints
  `No team state found for <name>` instead of throwing, and a shutdown error
  prints its message and sets exit code 1 instead of an uncaught failure.
  In the runtime CLI (`src/cli/team.ts`), a team whose config has no valid
  `instance_id` (a partial startup) has its reservation and state directory
  removed (`cleanupAbandonedTeamState`) and exits 1. `startTeamV2` runs the
  stale-reservation cleanup before taking the lifecycle lock, so a dead
  owner's leftover reservation no longer blocks a new team of the same name.
- **git-guardrails latency (#4221):** the destructive-git PreToolUse hook
  runs in a worker thread inside `scripts/run.cjs` instead of a second Node
  process, and `run.cjs` skips it entirely when `OMC_GIT_GUARDRAILS=0`. The
  hook parses the command before the mode lookup, so the state read and git
  calls only happen for a destructive command; there is no substring
  prefilter that could skip a real git command. The Copilot projection
  (`copilot/hooks.json`) invokes the hook through the same `scripts/run.cjs`.

# oh-my-copilot v5.6.1

## [5.6.1] - 2026-10-04

Fork **v5.6.1** (from v5.5.0) ports upstream oh-my-claudecode v5.6.0, v5.6.1
and upstream `dev` through 4280efb1f (862c69273..4280efb1f). It brings the
unattended-run / software-factory surface to Copilot under a scoped AFK
permission profile and hardens host launches on Windows. No breaking changes;
the skill count stays 61. Upgrading? Read the
[v5.5.0 → v5.6.1 guide](docs/MIGRATION.md#v550--v561-fork-upgrade-guide).

### Ported from upstream oh-my-claudecode v5.6.0 / v5.6.1 and dev (862c69273..4280efb1f)

- **Software factory:** a SessionEnd chain enqueuer driven by the project
  route table (`.omg/factory-routes.json`, the single source of truth),
  gate grading, chain guardrails (serial single-session lock and a daily
  cap of 10), check evidence, a diff-first review gate, and a stalled-chain
  watchdog. `omg factory listen` (HMAC-signed tracker intake, bound to
  127.0.0.1), `omg factory init` (seeds the route table and checks
  prerequisites), and `omg factory status` (read-only chain audit).
- **Intake:** `omg intake run` runs the harbor sweep headless;
  `omg intake schedule --cron <expr>` / `--off` registers it with the host
  scheduler (cron, or Task Scheduler on Windows). A run ledger with
  SessionStart reconciliation records unattended-run lifecycles; the
  runs-reconciler test fixtures use relative timestamps so they no longer
  expire.
- **Ralph:** `omg ralph afk` launches an isolated headless ralph run;
  `omg ralph verify` is the only command that computes the feedback
  baseline diff; `omg ralph from-map` plans, claims and launches a run from
  a wayfinder map. Stories are risk-ordered, and the PRD carries a repo
  quality class. The feedback baseline normalizes `node:test` `duration_ms`
  and drops pass/test counters from failure signatures, so a timing-only
  change no longer reads as a new failure (#4215).
- **Unattended-run hardening:** closeouts in ralph, autopilot and team;
  an AFK assumption protocol; an opt-in budget stop; headless harbor and
  refit invocations; a destructive-git guardrail hook
  (`OMC_GIT_GUARDRAILS`); and a stale-run watchdog (`OMC_STALE_RUN_HOURS`).
- **Host-load gate:** expensive operations wait while CPU load, free
  memory or the sibling-session count is over its threshold, and proceed
  if metrics are unavailable (`OMC_HOST_LOAD_*`,
  `OMC_MAX_SIBLING_SESSIONS`).
- **Windows:** the host CLI launches via `COMSPEC` instead of `shell:true`
  (#4154; the fork applies this to both host binaries), zero `lstat` dev is
  tolerated in file identity checks (#4156), and team owner epochs use a
  strict process-start identity (#4211). Session-end deferred chain actions
  survive on Windows, and the omc-setup star endpoint drops its leading
  slash so Git Bash does not rewrite it.
- **Team:** the supervised worker start command stays under 1024 bytes
  (#4191), detached sessions use a dynamic window index (#4193),
  `OMC_TEAM_WORKER_ENV_PASSTHROUGH` forwards custom provider credentials
  (#4194), and `roleRouting` takes a per-role `reasoningEffort` (#4206).
  The fork applies `reasoningEffort` only to providers with a verified CLI
  flag, which excludes Copilot workers.
- **jev:** `:active` mode now acts on the Jev answer in script and TS
  callers, and its configuration and judgment points are documented in
  `docs/HOOKS.md` (#4164, #4208).
- **LSP:** diagnostic URI keys are normalized so Windows drive-letter
  encodings match; malformed escapes are kept verbatim (#4185).
- **Session end:** workers receive `ANTHROPIC_*`, `OMC_HOOK_BRIDGE` and
  model-provider auth alongside the fork's Copilot, Teams, Discord and
  Telegram keys (#4168, #4178), and failed bridge forwards are now reported.
- **State lock:** upstream's owner-file fallback race fix (#4149) and its
  regression test are covered by the fork's stronger variants
  (`scripts/lib/state-lock.mjs`, `src/lib/mode-state-io.ts`). The fork
  keeps capturing identity before the liveness probe and rechecks both the
  owner record and dev/ino before rename. The win32 `ticks:` identity
  encoding in the atomic-write twins is reconciled with upstream's (#4148).

### Fork: Copilot host adaptations and security fixes

- **Unattended runs on Copilot:** factory chain links and
  `omg ralph afk|from-map` launch the Copilot host binary with
  `--no-ask-user` and a scoped AFK permission profile
  (`--allow-tool=shell(gh issue view|comment|edit, gh pr view|list,
  gh label list)`, `--allow-tool=write`, `--allow-url=github.com`, plus
  `--deny-tool=write(.git)`, `--deny-tool=write(package.json)` and
  `--deny-tool=shell(git push)`); single-token `--verify` commands are
  refused on Copilot. `omg intake run` launches Copilot with
  `--no-ask-user` and no allow rules. Copilot cannot pin a session id, so a
  factory chain stops after its first link and the watchdog reports it.
- **Prompt never on a `cmd.exe` command line (security):** on Windows the
  host binary receives the prompt on stdin for both hosts (verified against
  Copilot CLI 1.0.91). Native `.exe` binaries are spawned directly with an
  argv array (`resolveHostBinaryLaunch`, `buildHostBinarySpawn`); only
  `.cmd`/`.bat` shims go through `COMSPEC`, and `quoteForCmd` now keeps
  CRT and cmd quote parity and refuses `%`. Before this, a prompt containing
  `\" --allow-all-tools \"` split the argument vector and `%GH_TOKEN%`
  expanded inside quotes; both were reachable from `package.json` scripts
  (autoresearch setup) and `check_suite.head_branch` (factory listener).
- **`COPILOT_ALLOW_ALL` (security):** excluded from the session-end
  `COPILOT_*` passthrough and forced to `false` on every AFK child, so an
  exported value can no longer widen the AFK profile to unrestricted shell.
- `check_suite.head_branch` is validated before it enters a prompt, and
  `omg intake --host-bin` is validated like the team launch contract.
- `omg intake run` accepts `--headless`, the flag the entry written by
  `omg intake schedule` passes; before this, every scheduled sweep exited with
  `unknown option '--headless'` (also present upstream).
- The copilot worker contract follows #4206's
  `buildLaunchArgs(model, reasoningEffort, extraFlags)` signature, so deny
  flags keep reaching Copilot workers.

# oh-my-copilot v5.5.0

## [5.5.0] - 2026-10-02

Fork **v5.5.0** (from v5.1.0) ports upstream
oh-my-claudecode v5.4.0, v5.5.0 and upstream `dev` through 862c69273
(#4135, #4140), and makes the fork work as a native GitHub Copilot CLI
plugin: hooks, agents, team workers and `omg launch` now follow the Copilot
CLI 1.0.88 contract. Before this release every fork hook was a silent no-op
under Copilot on Windows. Ten new skills (61 canonical total). Upgrading?
Read the [v5.1.0 → v5.5.0 guide](docs/MIGRATION.md#v510--v550-fork-upgrade-guide).

### Ported from upstream oh-my-claudecode dev (v5.5.0..862c69273)

- **Four new skills (57 → 61):** `map` (yard router, which also routes the
  fork-exclusive skills), `pr`, `refit`, and `tdd`. Delivery-loop hardening
  in `launch`.
- **jev** active mode (env-activated), the script-side judgment channel,
  token usage in the shadow log, and `OMC_JEV_QUIET`.
- **budget-guard Stop hook** (`OMC_RUN_BUDGET_TOKENS`) and its enforcement
  log.
- **Team:** honest start-failure reporting, busy-pane vs startup success,
  Windows worker launch environments (#4102, including the PATHEXT
  preference in `src/platform/executable-resolution.ts`), and a final recheck
  window for startup evidence (#4135).
- **Hooks:** unread worker stdin is released, env overrides are validated,
  and the state root resolves without git on PATH.
- **Installer:** user-owned collisions are skipped during bundled skill sync;
  upstream's Windows state-lock bridge path fix (#4140) replaces the fork's
  interim fix.

### Ported from upstream oh-my-claudecode v5.5.0 (v5.4.0..v5.5.0)

- **Four new skills (53 → 57):** `architecture-survey`, `diagram`, `intent`,
  and `minimal-prose-discipline`. Adds the shipyard-audit script (auditing
  `.omg/skills`), the shipyard/launch/drydock discipline rounds, and the
  `cancel` skill rewrite.
- **jev judgment points** (shadow mode) across hooks, plus the `jev-eval`
  script. On win32 the shadow recorder detaches so it survives hook exit.
- **Team:** immutable team instance id lifecycle, scoped cancellation, and
  consistent task claims and monitor snapshots.
- **Hooks:** read-budget preflight, directory-context injector registration,
  and the `${CLAUDE_PLUGIN_ROOT}` brace form in hook commands.
- **State lock:** a file fallback when `better-sqlite3` cannot load. On a
  slow win32 liveness probe the fork retries when the owner artifact vanished
  instead of failing as unverifiable.
- **Launch:** credentials stay off the command line, and the tmux pane is
  exec-replaced.
- **Known Windows gap:** upstream's strict process identity accepts only
  linux/darwin, so team instance recovery fails closed on win32.

### Ported from upstream oh-my-claudecode v5.4.0 (v5.3.0..v5.4.0)

- **Two new skills (51 → 53):** `harbor` (shipyard intake gate) and
  `agent-doc-discipline`.
- **`omg lookout scan`:** a pre-flight danger scan and its parsers.
- **SQLite state-mutation lock** (`scripts/lib/state-lock.mjs`) with
  standalone hook bridge provisioning. It replaces the fork's portable-lockfile
  backend. On win32 the release retries on `SQLITE_BUSY`/`SQLITE_LOCKED`.
- A configurable SessionStart context budget, worktree-paths locale and
  bare-repo probes, team provider preflight and launch-gate hardening, and
  contained-FD graph traversal on Darwin. The Ruby prerequisite is removed.

### Added

- **Copilot plugin manifest.** A root `plugin.json` is the manifest Copilot
  CLI reads; it takes precedence over `.claude-plugin/plugin.json`, which
  Claude Code keeps using. It points `hooks` at the generated
  `copilot/hooks.json` and `agents` at the generated `copilot/agents/`, and
  it carries the MCP server and commands.
- **Generated Copilot hooks** (`npm run build:copilot-hooks`,
  `scripts/copilot/build-hooks.mjs`). `copilot/hooks.json` is derived from
  the upstream-identical `hooks/hooks.json`. Each entry uses `exec: "node"`
  with an `args` array, so no shell runs and a plugin path containing spaces
  stays one argument. `OMC_HOOK_EVENT` names the event. The generator throws
  on a hook command form it does not recognise, so an upstream change breaks
  the build instead of shipping a no-op.
- **Copilot hook output adapter** (`scripts/lib/copilot-hook-adapter.cjs`,
  preloaded with `node --require`). It translates Claude-shaped hook output
  to Copilot's contract: it hoists `additionalContext` to the top level, turns
  PreToolUse blocks into `permissionDecision: "deny"`, maps Stop blocks, and
  converts exit code 2. It fails open on a hook's internal error.
  `OMC_HOOK_FAIL_CLOSED=1` keeps the original exit code, and
  `OMC_HOOK_STRICT=1` makes a hook target that is not a file exit 1. See
  [docs/HOOKS.md](docs/HOOKS.md#copilot-cli-hook-projection).
- **Generated Copilot agents** (`npm run build:copilot-agents`,
  `scripts/copilot/build-agents.mjs`). `copilot/agents/*.md` has the same body
  as `agents/*.md`. Model aliases become Copilot `models:` fallback lists.
  Read-only agents get a `tools:` allowlist without create/edit/apply_patch;
  shell stays allowed, as with Claude's `disallowedTools`. Agents that review
  or edit code get `include-custom-instructions: true`.
- **`copilot` team worker type.** `omg team N:copilot` is accepted by every
  worker validator, and `copilot` is the default worker on a Copilot host.
  Copilot workers launch with `--allow-all-tools --allow-all-paths
  --allow-all-urls --no-ask-user`. Claude-style model ids are mapped to
  Copilot's dotted form (`claude-opus-4-8` → `claude-opus-4.8`).
- **Worker deny rules:** `permissions.workerDenyTools` and
  `permissions.workerDenyUrls` in `omg.jsonc` are forwarded to copilot workers
  as `--deny-tool=` / `--deny-url=`. Deny beats allow. Only copilot workers
  enforce them. `omg team` prints one `[omg team] <provider> workers (xN): ...`
  line per provider to stderr, and for other providers that line says the deny
  list is NOT enforced. Provider advisors print a bypass warning.
- **`omg doctor conflicts`** warns when the legacy `COPILOT_CONFIG_DIR` is set
  and checks that `node` is on PATH.

### Changed

- **Config directory variable:** `COPILOT_CONFIG_DIR` renamed to
  `COPILOT_HOME`, the variable GitHub Copilot CLI actually reads. The old
  name is no longer honoured (no env fallback); `omg doctor conflicts` warns
  when it is set. The `${COPILOT_CONFIG_DIR}` token in `omg.jsonc` guards
  still works as an alias of `${COPILOT_HOME}`, and the package's JS export
  `COPILOT_CONFIG_DIR` remains as a deprecated alias.
- **Host detection:** the host is Copilot when Copilot session markers are
  present; otherwise `CLAUDE_CODE_ENTRYPOINT` selects Claude Code. The team
  default worker, stage routing, scale-up, and the routing-snapshot fallback
  all follow the host.
- **`disableExternalLLM`** now means "only the current host CLI's workers":
  claude on a Claude Code host, copilot on a Copilot host.
- **`omg launch`** spawns and probes the host binary. On Copilot, `--madmax`
  and a typed `--dangerously-skip-permissions` become `--yolo`, and `-p` /
  `--prompt` print mode adds no allow flags. The launcher forwards
  `COPILOT_HOME`, `COPILOT_MODEL`, `GH_HOST`, and `COPILOT_GH_HOST` into tmux;
  tokens travel only through the private transport. The config-dir mirror is
  skipped on Copilot. On macOS, `--madmax` / `--yolo` require tmux on both
  hosts, judged from the raw arguments.
- **`agents.<name>.model`** overrides are applied through the PreToolUse
  `updatedInput` channel, which Copilot does not support, so they are a no-op
  on Copilot. Per-agent models there come from the generated `models:` lists
  or Copilot's own `subagents.agents.<name>.model` setting.
- **SessionStart `init` and `maintenance` hooks** are not projected to
  Copilot. Copilot ignores SessionStart matchers, so they would run (and
  prune state) on every session. Claude Code is unchanged.
- `hooks/hooks.json` and `agents/*.md` stay byte-identical to upstream for
  Claude Code.
- **`node` must be on PATH** under Copilot: a PreToolUse hook that cannot
  start is denied by Copilot itself, which blocks every tool call.

### Removed

- **Fork safe-command auto-approver:** `scripts/safe-command-approver.mjs`
  (the v4-era Copilot `preToolUse` hook that auto-approved "safe" Bash
  commands) and the unused `src/installer/permissions.ts` allowlist generator
  (`generatePermissionAllowList`) are gone. The hook was no longer registered
  in `hooks/hooks.json`, and a review found it approved chained commands
  such as `cat x; curl … | sh`. Use Copilot CLI's native `--allow-tool` /
  `--deny-tool` rules or its assisted-approval mode instead. Upstream's
  `src/hooks/permission-handler/` is unchanged.
- **`--dangerously-skip-permissions` in the copilot worker contract.**
  Copilot rejects the flag, so copilot workers could not launch at all.

### Fixed

- **Every fork hook was a silent no-op under Copilot on Windows.** Copilot
  runs hook commands through PowerShell, which split
  `node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs ...` so that node loaded the
  plugin directory and exited 0. The generated `exec`+`args` hooks remove that
  class of bug and save about 0.5 s of PowerShell startup per hook.
- **State-lock owner-file race** (upstream #4146; fixed upstream by #4149).
  The file-fallback lock captures the artifact identity before the liveness
  probe and re-checks owner and dev/ino immediately before rename, so a live
  replacement lock is never quarantined (8×15 contention: 37/120 → 120/120).
- **State-lock temp names on NTFS** (upstream #4147; fixed upstream by #4148).
  Emergency temp names and reconcile regexes in `scripts/lib/state-lock.mjs`
  use the encoded process identity, because NTFS rejects `:`.
- **SQLite lock probe caching.** Liveness is probed outside
  `BEGIN IMMEDIATE`, and verified owners are cached across retries (give-up
  12.8 s → 1.2 s; 8×15 contention 212 s → 2.5 s). Release has a 5 s
  wall-clock retry budget, accepts an already-absent artifact when the row
  still matches, and can reclaim abandoned own nonces.
- The `copilot` worker was rejected by the team validators and its contract
  could not launch; Copilot model ids used the dashed Claude form.
- **`omg team` startup on native Windows (psmux)** (fork fix over upstream
  #4059): teams run in a private psmux namespace via `-L <ns>` instead of a
  shared socket path, server identity is captured from the session's own
  `new-session` record rather than reconstructed, the `if-shell` guard is
  dropped because psmux cannot run it (every PowerShell condition form is
  mangled or misreported on 3.3.8), and `team-owner-epoch.ts` accepts a
  strict `win32:<ticks>` process identity instead of failing closed on
  win32.

# oh-my-copilot v5.1.0

## [5.1.0] - 2026-09-06

Ports the three upstream oh-my-claudecode releases since the v5.0.0 rebase —
v5.1.0, v5.2.0, and v5.3.0 (upstream dev parity at release time) — into the
fork, adapted throughout to the `omg` CLI, the `.omg/` runtime root, the
`.copilot/` host surface, and the `/oh-my-copilot:` namespace. Five new skills
(51 canonical total): the full Shipyard set — `drydock`, `launch`,
`ask-navigator`, `loft` — plus `minimal-code-discipline`.

### Ported from upstream oh-my-claudecode v5.3.0 (v5.2.0..v5.3.0)

- **Two new shipyard skills (49 → 51):** `ask-navigator` (charts foggy efforts
  into decision-ticket maps, hands off to launch) and `loft` (shape-before-steel
  discipline: throwaway artifacts answer design questions). Launch gained the
  fog gate and map check. Paths adapted to `.omg/wayfinder/` and the
  `/oh-my-copilot:` namespace.
- **Workspace checkpoints:** `omg checkpoint create/list/rollback` shadow
  snapshots for autonomous runs, plus `omg graph run --checkpoint`. The fork
  additionally suppresses CRLF conversion so Windows rollbacks are
  byte-faithful.
- **Remote graph approval gates:** `omg graph run --approval-mode remote` with
  notification dispatch, reply-channel decisions, and
  `omg graph approvals list/decide` (the underlying contained run-dir remains
  Linux-only, as before).
- **Review hardening:** abort-aware gates, denied-only rollback, hardened
  reply/checkpoint paths.
- **Hooks:** stderr preserved after early protocol stdout close (#3963);
  unsupported PostToolUse `suppressOutput` omitted; verifier semantics
  preserved on the Worker path.
- **Perf:** batched Windows cache occupancy identity checks with precise tick
  validation; per-render git path memoization in the HUD.
- Windows test adaptations: case-folded occupancy identities via
  `pathIdentity`, fork rules dir (`.copilot/rules`) in the rules-injector
  guard tests.

### Ported from upstream oh-my-claudecode v5.2.0 (v5.1.0..v5.2.0)

- **Hook runner Windows stdio overhaul:** `run.cjs` protocol writes guarded
  against closed consumers, fail-open before Windows tree reap, single generic
  child reap, EPIPE-safe PassThrough teardown, POSIX process-group reaping, and
  runner-aware SessionEnd foreground ceilings and worker timeouts.
- **LSP hardening:** document open/close lifecycle serialization in the LSP
  client, retired document queue cancellation, and bounded directory
  diagnostics lifecycle in the aggregator.
- **Bounded git calls in worktree-paths** with a memoized `probeGitTopLevel`
  (replacing `getGitTopLevel`/`getWorktreeRoot` call sites), plus the
  symmetric dual-state-root warning on the legacy branch (#3937).
- **HUD:** update and paste-ready upgrade hints (`update-hint` element, adapted
  to `oh-my-copilot` package/plugin names), pid-aware cache lock recovery and
  bounded `.err` reclamation, stale stdin tmp orphan reclamation.
- **Shipyard yard gate (launch C5 sediment pass):** launch now refuses to run
  when the drydock `--check` audit reports actionable findings.
- **session-history-search** bounds retained matches while still counting all.
- **Team:** platform-aware worker launch wrapper for POSIX hosts (#3931).
- Windows adaptations: platform-gated expectations for POSIX-only temp paths,
  `$OMC_TEAM_STATE_ROOT` placeholders, pid-liveness lock tests, and junction
  symlinks in tests; separator-normalized superproject assertions.

### Ported from upstream oh-my-claudecode v5.1.0 (v5.0.2..v5.1.0)

- **Three new skills (46 → 49):** `drydock` and `launch` (the Shipyard
  governed-delivery pair, with the methodology map at `docs/shipyard.md`) and
  `minimal-code-discipline` (opt-in YAGNI-ladder writing-time discipline).
  Skill paths adapted to the fork's `.omg/` runtime root and
  `/oh-my-copilot:` namespace.
- **Cursor default-model hook (#3880):** `externalModels.defaults.cursorModel`
  config plus `OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL` /
  `OMC_CURSOR_DEFAULT_MODEL` env fallbacks.
- **Team model routing hardening (#3899–#3905):** shared
  `resolveDefaultWorkerModel` across launch and scale-up, normalized persisted
  model defaults, preserved routing provenance and configured defaults during
  scale-up. The fork's `copilot` provider shares the claude resolution path.
- **Delegation enforcement rewrite (#3911 + follow-ups):** the pre-tool-use
  template gained a real shell-command parser (heredocs, here-strings, ANSI-C
  quoting, fd duplication, printf/echo semantics, coprocesses) eliminating
  delegation false positives, and bounded cross-platform temp/scratchpad path
  allowances in both the template and the orchestrator hook. The template now
  allows the fork's `.omg/` state root alongside legacy `.omc/`.
- Test expectations for POSIX-only temp-path shapes are platform-gated so the
  suite reflects the implementation's deliberate rejection of cross-platform
  path shapes on Windows.

# oh-my-copilot v5.0.0

## [5.0.0] - 2026-08-31

The fork was at v4.13.102. It has now been rebased onto upstream
`yeachan-heo/oh-my-claudecode` v5.0.2 and is being released as the fork's own
**v5.0.0**, adopting upstream's canonical Tier-0 workflow surface
(`plan` → `execute` → `review` → `verify`) and retiring a set of legacy skill
and command names outright rather than aliasing them.

### Breaking Changes

- **Retired 11 skills, removed outright (not aliased):** `ultrawork`,
  `ultraqa`, `deep-dive`, `sciomc`, the `cccg` skill (invoked as `/ccg`),
  `omc-teams`, `setup`, `mcp-setup`, `omc-reference`, `learner`,
  `writer-memory`. Their behavior now lives in `execute`, `verify`, `review`,
  `research`, `omc-setup`, `wiki`, `remember`, and `team`.
- **Retired 7 commands:** `ccg.md`, `deep-dive.md`, `learner.md`,
  `mcp-setup.md`, `omc-teams.md`, `sciomc.md`, `writer-memory.md`.
- **Canonical Tier-0 workflows are now `plan → execute → review → verify`.**
  Three new skills are adopted from upstream: `execute`, `research`, and
  `review`. `review` installs as `omc-review` to avoid colliding with a native
  command. A new `compact` command is also added.
- **The `ultrawork` / `ultraqa` / `ultrapilot` hook subsystems are removed**,
  along with the `stagger-launch` hook. `stagger-launch`'s only trigger was
  `ultrawork` mode, and its thundering-herd protection for parallel agent
  launches is **not** carried over to the new workflow surface — this is a
  known regression, not an oversight.
- Post-retirement inventory: **46 skills, 20 agents, 21 commands**.
- **Host CLI surface moved `.claude/` → `.copilot/`.** oh-my-copilot is a
  GitHub Copilot CLI plugin, so it now reads the host's settings, hooks,
  commands, skills, plugins, rules, tasks, and worktrees from `.copilot/`
  instead of `.claude/`. Project config moved to `.copilot/omg.jsonc` (was
  `.claude/omc.jsonc`). Context-file discovery now prefers
  `copilot-instructions.md` and `.copilot/AGENTS.md`, while still falling
  back to `.claude/CLAUDE.md` and `.claude/AGENTS.md` so the plugin keeps
  working when run under Claude Code. A small number of genuine Claude Code
  interop paths still read `.claude/` on purpose (credentials, installer
  agent/command ownership, todo-continuation task files).
- **OMC runtime root moved `.omc/` → `.omg/`.** All oh-my-copilot runtime
  files now live under `.omg/`: state, sessions, logs, plans, research,
  notepad, project memory, drafts, autopilot, and team state. **This release
  does not auto-migrate existing `.omc/` content** — if you have runtime
  state under `.omc/`, moving it to `.omg/` is a manual step.
  `WORKSPACE_MARKER` is still `.omc-workspace` (unchanged in this release),
  so multi-repo workspace anchors keep working.
- **Short CLI command renamed `omcp` → `omg`.** The user-facing command now
  matches the `.omg/` runtime root and `.copilot/omg.jsonc` project config, so
  v4's `omcp <command>` becomes `omg <command>` and the bridge entrypoint
  `omcp-cli` becomes `omg-cli`. **`omcp` is removed, not aliased** — scripts,
  aliases, and CI steps that call it must be updated. The long-form
  `oh-my-copilot` command is unchanged and is the only name present in every
  version, so use it where a command has to work across the upgrade boundary.
  Statusline users: the HUD wrapper is now `omg-hud.mjs` (was `omcp-hud.mjs`);
  see the Migration Guide for the `statusLine` fix-up.

### Added

- **Microsoft Teams notifications**, sent as Adaptive Card payloads with
  `@mention` support via `tagList` entries in `"DisplayName:AAD-Object-ID"`
  format. Configure with `OMC_MICROSOFT_TEAMS_WEBHOOK_URL` or a `teams`
  config block. Supports both Power Automate Workflows and legacy O365
  Connector webhook URLs.
- **RecentTools HUD element**: a rolling list of recent tool calls with
  status icons and target summaries. Opt-in via `showRecentTools`; tunable
  with `recentToolsMax` (default 5) and `recentToolsShowTarget`.
- **Team: per-role provider and model routing** via `.copilot/omg.jsonc`,
  with a resolved-routing snapshot. Declare which provider (`claude`,
  `codex`, `gemini`, `grok`, `cursor`, `antigravity`) and model tier backs
  each canonical role (critic, code-reviewer, executor, planner, etc.) in
  `team.roleRouting`. Routing resolves once at team creation, persists in
  `TeamConfig.resolved_routing`, and is reused across spawn/scale-up/restart.
  Env override via `OMC_TEAM_ROLE_OVERRIDES`. New `omg doctor team-routing`
  command probes CLI presence for every provider referenced by
  `team.roleRouting`. See `skills/team/SKILL.md` § Per-Role Provider & Model
  Routing.
- **Deep Interview: Round 0 topology enumeration** (#2919; first shipped in
  the fork's v4.13.7). It confirms and locks top-level components before
  ambiguity scoring, rotates multi-component targeting, and includes confirmed
  components plus deferrals in generated specs. Existing `deep-interview`
  state files without `state.topology` are treated as legacy state: on resume,
  unfinished interviews run the Round 0 topology gate before the next scoring
  pass, and already-finalized specs are left unchanged as
  topology-not-captured legacy artifacts.

### Fixed

- **Agent ownership inventory** (`src/installer/historical-agent-ownership.ts`)
  was regenerated from the fork's own 23 v4 release tags (57 records).
  Previously it held upstream's agent file hashes, so every fork-installed
  agent failed authentication and would never be reclaimed when upgrading
  4.13.102 → 5.0.0. A new generator script,
  `scripts/generate-historical-agent-ownership.mjs` (with `--verify`), plus
  npm scripts `generate:agent-ownership` / `verify:agent-ownership`, keep the
  inventory reproducible going forward.
- **Plugin manifest (`.claude-plugin/plugin.json`) previously listed only 32
  skills** — upstream's set — so all 14 fork-exclusive skills (five
  `omc-ado-*`, five `omc-gh-*`, plus `critique`, `deep-review`, `discover`,
  and `ralph-experiment`) were never registered with the plugin host. The
  manifest now lists all 46.
- **Team: alias-keyed role routing is honored, and `team.ops.defaultAgentType`
  is restricted to runtime-supported CLI providers.** Role keys accepted as
  aliases (e.g. `reviewer`) now resolve correctly against `team.roleRouting`
  during validation and stage routing, instead of being silently rejected or
  ignored.
- **State-file locking works on Windows and macOS.** `flockPath()` probed only
  `/usr/bin/flock` and `/bin/flock`, so off Linux `acquireLockAt()` returned
  `unlocked: true` while the caller was still told the lock was acquired —
  there was no inter-process exclusion at all. A portable lockfile fallback
  now runs wherever `flock` is absent: `O_EXCL` temp plus `linkSync`
  publication, an `O_EXCL` guard marker serializing reclaim and release, and
  stale owners cleared by a PID liveness probe with a 60s age ceiling. The
  result reports `acquired: false` rather than claiming exclusivity it does
  not have, and `flock` stays the fast path where it exists. Applied
  identically to `scripts/lib/atomic-write.mjs`,
  `templates/hooks/lib/atomic-write.mjs`, and `src/lib/mode-state-io.ts`.
  `OMC_TEST_STATE_LOCK_MODE` selects `none` or `portable` for tests.
- **Named autopilot workflows are no longer refused off Linux.**
  `isWorkflowRuntimeSupported()` required `process.platform === 'linux'` plus
  an `flock` binary, and `namedWorkflowRuntimeSupported()` additionally
  required `/proc/self/fd`, so named workflow profiles were rejected outright
  on Windows and macOS while state writes skipped integrity validation. Both
  gates now ask whether a working state-file lock exists rather than which
  platform is running. The `/proc/self/fd` transcript walk is kept verbatim on
  Linux; elsewhere each path component is rejected up front if it is a symlink
  and the opened file is confirmed by device and inode, preserving the
  no-follow contract.
- **Setup and uninstall no longer require bash or jq.** `/omc-setup` drove
  `scripts/setup-claude-md.sh` and `scripts/setup-progress.sh`, the latter
  exiting when `jq` was missing, and `scripts/uninstall.sh` had no non-bash
  equivalent — so a Windows user without Git Bash could never complete setup
  and had no supported uninstall, and resume broke on a stock macOS install.
  `scripts/setup-claude-md.mjs`, `scripts/setup-progress.mjs`, and
  `scripts/uninstall.mjs` are the documented entry points; `uninstall.mjs`
  takes `--dry-run` and `--yes`. The shell scripts remain for back-compat.
- **A fresh plugin cache is runnable on Windows without a rewrite.** The shipped
  `hooks/hooks.json` uses `node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs`, the one
  launcher cmd.exe and POSIX sh resolve the same way, and the install-time
  rewrite now self-heals a manifest left in the `sh`/`find-node.sh` form by an
  install on another OS — which previously failed every hook on Windows with
  `'sh' is not recognized`. POSIX installs still take the `find-node.sh`
  bootstrap unconditionally: it resolves `node` from `PATH` when it is there
  and from the nvm/fnm/volta locations when it is not, so it is correct in both
  cases (issue #892).
- **Skill instructions run on Windows.** Eighteen skills, across 21 markdown
  files, embedded POSIX-only command blocks with no Windows variant — including
  the cancel skill's emergency stop-hook escape (a sha256 shell function, GNU
  `date -u -d`, and a python3 heredoc) and the hud install step, whose
  `mkdir -p` and `cp` meant `omg-hud.mjs` was never installed while
  `statusLine` pointed at it. Those blocks are now `node -e` one-liners. The
  cancel escape reuses `scripts/lib/state-root.mjs`, so it honours
  `OMC_STATE_DIR` and workspace markers exactly as the state tools do.
- **Autoresearch evaluator commands run on Windows.** Evaluator commands are
  user-authored POSIX `sh`; running them through `spawnSync` with `shell:true`
  handed them to `cmd.exe`, so every iteration recorded `error` and no mission
  could pass. `src/platform/posix-shell.ts` discovers a real POSIX shell and
  routes the command through `bash -lc`; when none exists the record carries
  an actionable message instead of an inscrutable `cmd.exe` failure.
- **Workflow integrity checks accept NTFS file ids.** Windows file ids
  routinely exceed `Number.MAX_SAFE_INTEGER`, but the transcript identity was
  built with `Number(stat.ino)` and then validated with
  `Number.isSafeInteger`, so the producer emitted values its own validator
  rejected and named workflow Stop handling answered
  `workflow_descriptor_integrity_failed`. Rounding also let two distinct files
  compare equal. Device and inode now travel as decimal strings, matching what
  `mtimeNs` and `ctimeNs` already did; validation still accepts a legacy safe
  integer, so existing state keeps validating.
- **Windows path matching in team permissions, the bridge daemon, and worktree
  cleanup.** Three defects of the same shape: `isPathAllowed` compared a
  `relative()` result carrying backslashes against `/`-written globs, so
  `allowedPaths` denied everything and — more seriously — `deniedPaths` stopped
  denying anything; `validateConfigPath` built containment by concatenating
  `homeDir + '/'`, which no resolved Windows path matches, so the bridge daemon
  could not start at all; and `assertCleanLeaderWorktree` still filtered
  untracked `.omc` after the runtime root was renamed, so OMC's own metadata
  made the leader look dirty and blocked a second worker. All three now go
  through `path.relative` with segment boundaries preserved.
- **The OMC config directory is unified on `${COPILOT_CONFIG_DIR:-~/.copilot}`.**
  `scripts/lib/config-dir.mjs` and `.cjs` defaulted to `~/.claude` while
  `src/utils/config-dir.ts` and `scripts/lib/config-dir.sh` — which their own
  header names as mirrors — defaulted to `~/.copilot`. The bash lifecycle
  therefore wrote `.omc-config.json` where the Node hooks never looked, so
  settings written by one half of the install were invisible to the other.
  Setup now also adopts a stranded pre-unification `~/.claude/.omc-config.json`
  when the resolved location has none, copying rather than moving; the
  `omc-doctor` skill reports one it finds.
- **Background daemons start under Volta and nvm-windows.** The rate-limit-wait
  daemon and the notification reply-listener spawned themselves as
  `spawn('node', ...)` with a stripped env, so where the `node` on the
  forwarded `PATH` did not exist the spawn failed and the daemon silently never
  started. Both now use `process.execPath`, which needs nothing from `PATH`.
  `resolveDaemonModulePath` also follows the shape of the path it is given
  rather than the host platform.
- **The CLI trust check understands Windows.** Trusted prefixes were POSIX-only
  paths joined onto `$HOME`, `OMC_TRUSTED_CLI_DIRS` was split on `:` (shredding
  `C:\Tools\bin`), and matching was a case-sensitive `startsWith`, so every CLI
  resolution on Windows warned about a non-standard path with no way to silence
  it. Home now comes from `USERPROFILE` on Windows, Windows contributes its own
  trusted roots, the override splits on the platform delimiter, and boundary
  matching uses `path.relative`.
- **Every tmux call goes through argv.** `tmuxShell` built a bare
  `tmux <command>` string, skipping the win32 `.cmd`/`COMSPEC` wrapping
  `resolveTmuxInvocation` exists to apply and forcing callers to POSIX-quote
  format arguments — `cmd.exe` passes single quotes through literally, so
  `-F '#{pane_id}'` came back quote-wrapped and pane matching never fired.
  `isTmuxAvailable` also probes with `shell:false`, so an install path
  containing a space no longer reports tmux as missing. This removes the last
  shell-string assumptions from the tmux surface, which is what a Windows
  tmux-compatible binary such as psmux needs; it was verified with unit tests
  against mocked spawns rather than a live tmux session.

### Changed

- **Fork-exclusive skills preserved through the rebase (14):** the five
  `omc-ado-*` Azure DevOps skills, the five `omc-gh-*` GitHub skills, plus
  `critique`, `deep-review`, `discover`, and `ralph-experiment`.
- **Publishing is unchanged:** a `v*` tag still produces a GitHub Release and
  npm publish via `release.yml`. Upstream moved to OIDC Trusted Publishing;
  this fork deliberately did not adopt that change.
- **Executable resolution is consolidated into `src/platform`.** The Windows
  resolution ritual (`where`/`which`, `.cmd` shim handling, `COMSPEC`
  fallback) had been reimplemented independently in six places, most without a
  timeout — a hook checking for a formatter could hang on an unreachable
  network-drive `PATH` entry. `src/platform/executable-resolution.ts` now
  exposes `resolveExecutable`, `isExecutableAvailable`, and `probeExecutable`,
  and the copies in `src/team/cli-detection.ts`, `src/team/model-contract.ts`,
  `src/mcp/cli-detection.ts`, `src/hooks/plugin-patterns/index.ts`,
  `src/tools/lsp/servers.ts`, and `src/cli/tmux-utils.ts` all delegate to it.
  Importers are unchanged. The `COMSPEC` retry validates its arguments against
  a closed grammar before they reach `cmd.exe`.

### Install

```bash
npm install -g oh-my-copilot@5.0.0
```

---

## [4.11.5] - 2026-04-09

### Fixed (ported from upstream oh-my-claudecode v4.11.4)
- **Keyword detector: narrow false-positive suppression** — Added activation and diagnostic intent detection near keywords. Prompts like "ralph keeps looping" or "what is autopilot mode now?" no longer trigger skill invocations, while explicit requests like "use autopilot to fix bug" still activate correctly (#2411)
- **Installer: portable hook command paths on Windows** — Windows hook commands now use bash-portable `${COPILOT_CONFIG_DIR:-$HOME/.copilot}` expansion instead of CMD-only `%USERPROFILE%` syntax (#2415)
- **HUD: fallback to older built cache versions** — When the latest cached plugin version fails to import, the HUD wrapper now tries progressively older built versions before giving up (#2416)
- **Team: preserve forceInherit by skipping worker model resolution** — When `OMC_ROUTING_FORCE_INHERIT=true`, worker model resolution is skipped to preserve parent model inheritance (#2418)
- **Preemptive compaction: fallback to hook context window usage** — When transcript lacks context_window fields, the hook now falls back to `context_window.used_percentage` or token-based calculation from hook input (#2412)

## [4.11.4] - 2026-04-09

### Fixed (ported from upstream oh-my-claudecode v4.11.3)
- **Node resolution: prefer PATH over ephemeral execPath** — PATH-resolved node is now preferred over `process.execPath` which may point at CI toolcache or Homebrew Cellar version-specific paths that disappear after upgrades (#2396)
- **Hooks: avoid .json false positives in source extension check** — `.json` and `.jsonl` files no longer trigger false "Bash command may modify source files" warnings (#2395)
- **Autoresearch: strip TMUX env for nested session compatibility** — Autoresearch launched from inside a nested tmux session no longer silently creates sessions on the nested server (#2385)
- **Symlink path resolution fixes** — Fixed asymmetric symlink resolution in worktree-paths, autoresearch contracts, learner finder, and team fs-utils (#2372)
- **Installer: detect enabledPlugins field** — `hasEnabledOmcPlugin()` now checks both `enabledPlugins` (modern) and `plugins` (legacy) settings fields (#2371)
- **Ralplan: deactivate stale state after completion** — Prevents ralplan state from rearming after consensus completion or circuit breaker exhaustion (#2370)
- **HUD: version fallback from path** — When package.json is missing, version is extracted from the plugin cache directory path (#2362)

### Changed
- **Build scripts: --watch mode** — All esbuild scripts now support `--watch` flag for development hot-reload
- **Plugin-dir helper** — New shared `resolvePluginDirArg()` utility for CLI plugin directory resolution

## [4.9.0-preview.1] - 2026-03-20

### Added
- **Autoresearch module** (`src/autoresearch/`): Thin-supervisor autoresearch with keep/discard/reset parity, guided interview flow, and Claude session setup
- **Ralphthon module** (`src/ralphthon/`): Autonomous hackathon lifecycle mode with PRD-driven phases, tmux interaction, and idle detection
- **Deep-dive skill**: 2-stage pipeline combining trace (causal investigation) with deep-interview (requirements crystallization) and 3-point injection
- **Deepinit manifest tool** (`src/tools/deepinit-manifest.ts`): Manifest-based incremental deepinit for hierarchical AGENTS.md documentation
- **HUD session summary element**: AI-generated session summary (<20 chars) displayed in HUD, opt-in via `sessionSummary: true`
- **Skill resources guidance**: Bundled skill resources discovery and rendering for better skill context
- **MCP standalone shutdown handler**: Parent-PID polling and signal-based shutdown for orphaned MCP servers
- **CLI commands**: `omcp autoresearch`, `omcp ralphthon`, HUD watch loop extraction
- **Deepsearch magic keyword**: Enhanced codebase search mode with parallel agent orchestration
- **cmux multiplexer support**: Team sessions can now launch from cmux surfaces alongside tmux

### Fixed
- **Security: ReDoS guards** — `safe-regex` validation on user-supplied regex patterns in live-data deny/allow lists
- **Informational keyword filtering** — Questions like "what is ralph?" no longer trigger execution modes (supports EN, KO, JA, ZH)
- **Skill-state collision prevention** — OMC built-in skills no longer collide with project custom skills of the same name (#1581)
- **Session-end fire-and-forget** — Notification and cleanup promises no longer block the SessionEnd hook timeout (#1700)
- **Orchestrator idle allowance** — Orchestrators can go idle while delegated subagents are still running (#1721)
- **Bridge/MCP child process cleanup** — Orphaned bridge and MCP child processes are cleaned up on shutdown (#1724)
- **Bedrock/Vertex model passthrough** — Provider-specific model IDs passed as-is to team workers instead of normalizing to invalid aliases (#1695, #1415)
- **Team split-pane cleanup** — Shutdown now discovers and removes split-pane workers after metadata drift (#1751)
- **LSP singleton protection** — Process-global singleton prevents duplicate LSP client managers across module reloads
- **LSP idle deadline management** — Per-client idle deadlines with configurable timeout via `OMC_LSP_IDLE_TIMEOUT_MS`
- **Kotlin LSP update** — Updated to official JetBrains kotlin-lsp implementation (#1710)
- **Task router fix** — `build-fix` intent now maps to `code-edit` capability instead of `testing`
- **Marketplace clone protection** — Auto-update no longer runs destructive resets on marketplace clones (#1755)
- **Legacy state cleanup consolidation** — Unified ghost-legacy cleanup across multiple candidate paths
- **Project memory preservation** — customNotes and userDirectives preserved when re-detecting project environment (#1689)
- **Print mode tmux bypass** — `--print`/`-p` flag bypasses tmux wrapping so stdout flows to parent process (#1666, #1685)
- **Orphaned tmux session cleanup** — Failed tmux attach now kills the orphaned detached session
- **Keychain credential freshness** — HUD prefers the freshest non-expired Keychain entry when multiple exist (#1684)

### Changed
- Agent tool model parameter denial extended to cover both Task and Agent tools on Bedrock/Vertex (#1415)
- Learner now scans `.agents/skills/` directory alongside `.claude/skills/` for skill discovery
- Bridge manager tracks owned sessions and passes `OMC_PARENT_PID` env var for orphan detection

## [4.8.2-preview.4] - 2026-03-18

### Added
- **Complexity-first phase selection**: Heuristic classifier (`src/hooks/complexity-classifier/`) classifies tasks as SIMPLE/STANDARD/COMPLEX before autopilot/ralplan runs planning. SIMPLE skips planning phases, COMPLEX adds Critic review. AI fallback model configurable via `/omc-setup` (defaults to haiku).
- **Circular fix detection**: Error hash tracking (`src/hooks/circular-fix-detector/`) detects when the same error recurs 3+ times in ultraqa/ralph QA loops. Generates structured escalation report at `.omcp/escalation-report.md` instead of retrying endlessly.
- **Stagger delay for parallel launches**: Advisory stagger hook (`src/hooks/stagger-launch/`) injects 1-second delay guidance between rapid-fire agent launches in ultrawork to prevent thundering herd rate limits. Configurable via `stagger_delay_ms` on UltraworkState.
- **Structured recovery manager**: Orchestration-level failure classification (`src/hooks/recovery/orchestration-recovery.ts`) with mapped recovery actions (retry, retry with backoff, skip, escalate). Per-task attempt tracking with 2-hour rolling window. Integrates with circular fix detector for escalation path.
- **Multi-pass deep review** (`/deep-review`): New skill that runs 3 parallel review passes (Security, Quality, Structural) followed by a validation pass that confirms/dismisses findings. Also accessible via `--deep` flag on code-reviewer agent.
- **Context accumulation between phases**: Hook (`src/hooks/context-accumulator/`) captures key outputs after each autopilot phase or ralph story and injects them into the next phase's agent prompt as `<prior-phase-context>`. Truncated to 12KB per phase, session-scoped.
- **Ideation/discovery skill** (`/discover`): Spawns 6 parallel specialist agents (Security, Quality, Tests, Performance, Documentation, Architecture) to scan a codebase and produce a prioritized improvement backlog at `.omcp/discover/backlog.md`. Supports scoping to subdirectories.
- **Semantic merge resolution**: Extended git-master agent with `<Merge_Conflict_Resolution>` protocol for AI-assisted merge conflict resolution — reads full file context, resolves semantically, verifies with build/tests.

## [4.8.2-preview.3] - 2026-03-18

### Added
- Claude Code CLI as a supported team worker provider (`omcp team N:claude "..."`)
- `ralph-experiment` skill documented in README and copilot-instructions
- Hierarchical docs/ structure (get-started, guides, reference, architecture, migration)
- `docs/index.md` as documentation table of contents

### Changed
- README trimmed to gateway document (~180 lines), detailed content moved to docs/guides/
- All `omg-*` commands renamed to `omc-*` (omc-setup, omc-doctor, omc-plan, etc.)
- All `OMP`/`OMG` abbreviations standardized to `OMC`
- Agent tiers reference updated to reflect actual 18 agents (from 32 pre-consolidation)
- Multi-AI Orchestration section lists all 4 providers (Copilot, Claude, Gemini, Codex)

### Fixed
- `claude` agent type: binary corrected from `copilot` to `claude`
- Broken `https://docs/REFERENCE.md` URLs in README
- Phantom agent entries removed from AGENTS.md (11 non-existent roles)
- Agent counts updated from 28/32 to actual 18 across all docs
- `OMP:VERSION` markers renamed to `OMC:VERSION` in installer

### Removed
- 11 translated README files (English-only going forward)
- 7 stale root markdown files (ANALYSIS.md, IMPLEMENTATION_SUMMARY.md, etc.)
- `docs/partials/` (duplicate of docs/shared/)
- `docs/ko/` Korean translations
- `seminar/` presentation materials
- `benchmark/` SWE-bench (empty results)
- `skills/hud/` (Copilot doesn't support custom HUDs)
- `.github/SPONSOR_TIERS.md` and sponsor badges
- Star history charts

## [4.8.2-preview.1] - 2026-03-17

### Changed
- Initial release as oh-my-copilot
- All URLs updated to `RobinNorberg/oh-my-copilot`
- Preview versions publish to npm under `preview` tag
- `.copilot-plugin/` references corrected to `.claude-plugin/` in CI
