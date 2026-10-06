# Migration Guide

This guide covers all migration paths for oh-my-copilot. Find your current version below.

---

## Table of Contents

- [Unreleased: Factory Chains on Copilot](#unreleased-factory-chains-on-copilot)
- [Unreleased: Team Instance Ownership](#unreleased-team-instance-ownership)
- [Unreleased: Cancellation Scope](#unreleased-cancellation-scope)
- [v5.6.2 → v5.7.0: Smoke Harness](#v562--v570-smoke-harness)
- [v5.6.1 → v5.6.2: Postinstall Hook](#v561--v562-postinstall-hook)
- [v5.5.0 → v5.6.1: Fork Upgrade Guide](#v550--v561-fork-upgrade-guide)
- [v5.1.0 → v5.5.0: Fork Upgrade Guide](#v510--v550-fork-upgrade-guide)
- [v4.13.102 → v5.0.0: Fork Upgrade Guide](#v413102--v500-fork-upgrade-guide)
- [v4.x → v5.0: Workflow Retirement](#v4x--v50-workflow-retirement)
- [Unreleased: Team MCP Runtime Deprecation (CLI-Only)](#unreleased-team-mcp-runtime-deprecation-cli-only)
- [Unreleased: Native Team Worktree Mode (Opt-In)](#unreleased-native-team-worktree-mode-opt-in)
- [Unreleased: Git-less State Root Recovery](#unreleased-git-less-state-root-recovery)
- [v3.5.3 → v3.5.5: Test Fixes & Cleanup](#v353--v355-test-fixes--cleanup)
- [v3.5.2 → v3.5.3: Skill Consolidation](#v352--v353-skill-consolidation)
- [v2.x → v3.0: Package Rename & Auto-Activation](#v2x--v30-package-rename--auto-activation)
- [v3.0 → v3.1: Notepad Wisdom & Enhanced Features](#v30--v31-notepad-wisdom--enhanced-features)
- [v3.x → v4.0: Major Architecture Overhaul](#v3x--v40-major-architecture-overhaul)

---

## Unreleased: Factory Chains on Copilot

Software-factory chains now run past their first link on Copilot CLI. Before,
a Copilot link got a random session id (Copilot has no `--session-id`), its
SessionEnd found no ledger, and the chain stopped silently after one link.
Nothing to configure:

- The spawner (factory listener or SessionEnd worker) sets
  `OMC_CHAIN_LINK=<link id>` on each Copilot link. SessionEnd resolves the
  link as `OMC_CHAIN_LINK`, then the host session id, and trusts the variable
  only when it names a `host: "copilot"` ledger; a finished link is a no-op.
  Claude links keep `--session-id`.
- Copilot's SessionEnd reason `complete` now counts as success, so route keys
  such as `success:*` match a finished Copilot link.
- Link ledgers record `chainLink`, `host`, `createdAt` and `parentLink`, and
  each link's SessionEnd closes its ledger once (`closedAt`, `hostSessionId`,
  `outcome`, `decision`). A replayed SessionEnd is a no-op. The watchdog
  skips closed ledgers, and `omg factory status` lists each chain's links.
- A ledger's `maxStageVisits` now applies to the whole chain, not just the
  first link.
- Under a dev plugin root (`omg --plugin-dir`), Copilot links get
  `--plugin-dir` too, and the SessionEnd worker forwards `OMC_PLUGIN_ROOT`.
- `omg smoke copilot --tier 2 --scenario chain` runs a real two-link chain
  (about 2 premium requests). It is opt-in and not part of `all`.

Copilot fires `sessionEnd` after every turn, so a link that a Stop hook
continues into a second turn hands off after its first turn; the closed
ledger prevents a second hand-off. Ledgers written by an older version have
no `host` field: a Copilot link
spawned before the upgrade still ends its chain after one link. Guardrails
(serial lock, daily cap), `COPILOT_ALLOW_ALL=false` and the AFK permission
profile are unchanged. See
[Factory chains on Copilot](./REFERENCE.md#factory-chains-on-copilot).

---

## Unreleased: Team Instance Ownership

Team startup reserves an immutable instance ID before creating tasks or workers.
An existing reservation or team state is not overwritten by another start using
the same name. CLI/MCP jobs retain their original instance ID: cleanup of an old
job cannot adopt a newer team's configuration.

Native CLI jobs no longer start through the legacy v1 opt-out path. Unset
`OMC_RUNTIME_V2=0`, `false`, `no`, or `off` before starting a job; disabling v2 is
rejected before native startup effects rather than selecting weaker cleanup.

Cleanup now requires matching instance and worker-launch evidence. A missing or
corrupt receipt is not permission to kill a pane or remove state, even with
`--force`. Older jobs and teams without this evidence are preserved rather than
automatically upgraded or forcibly deleted. Complete their shutdown using the
owning runtime before upgrading; do not fabricate IDs or discard receipts to
bypass a blocked cleanup.

This also applies to API `cleanup` and `orphan-cleanup`: neither is a raw state
deletion escape hatch. The unsafe low-level `teamCleanup` deletion API is removed.
SessionEnd cleanup checks the ending session's ownership via config
`leader_session_id` (not the tmux target projected into `leader.session_id`)
and passes the captured instance ID; stale team-name hints cannot authorize
cleanup of another session's team.

Provider execution and pane liveness are observed separately. An exited provider
can be recovered even when its pane shell remains, but recovery does not treat
that observation as proof that all descendant processes have terminated.

Tmux ownership additionally binds the socket, server PID, and precise process
creation time captured at startup. Reused session names or pane IDs after a
server restart cannot replace that evidence. Missing historical server identity
does not authorize adoption, input, or destruction. Confirmed death of the
original server proves only that its panes are gone, not provider cleanup.
Strict server identity requires the native addon on macOS or boot-bound process
evidence on Linux; unavailable precision preserves resources without a coarse
process-listing fallback.
Native Windows/MSYS tmux control has no verified process-identity mapping and
therefore cannot authorize these effects. Running Node inside WSL uses the Linux
identity path.

The legacy mutation exports `watchdogCliWorkers`, `spawnWorkerForTask`,
`killWorkerPane`, `assignTask`, and `killWorkerPanes` have been removed. Use the instance-bound v2
startup, dispatch, recovery, scaling, and shutdown APIs instead. The former
`done.json` watchdog, five automatic pane-death retries, lowest-index scheduling,
and watchdog timer `stop()` contract are retired, not recreated inside v2.

Final state removal retains instance-bound cleanup records outside the disposable
team directory. After a partial removal failure, retry cleanup for the original
job. Do not manually delete these records, including completed receipts: they
prevent reuse of a retired instance identity. Detached state is removed by the
validated cleanup protocol.

Pending recovery reservations, intents, and owner requests also retain the
original instance ID. Records without that evidence are not automatically
adopted, and retrying an old request cannot attach it to a same-named replacement.

`state_clear(mode="team", ...)` clears orchestration/session state, not native
team runtime directories or name-only native mission records. Shut down native
teams through `omg team shutdown` or the original job's cleanup API first.
Session ownership alone does not prove ownership of a same-name runtime instance.

## Unreleased: Cancellation Scope

`/oh-my-copilot:cancel --force` now targets only the current session; it no longer
means clearing every session. It skips graceful waits, not state locks or ownership checks.
If the current session cannot be identified, cancellation fails closed.

Use `--all` explicitly for all-session cancellation. It follows normal cancellation
within each session; use `--force --all` when forced cancellation across sessions is intended.
Update prompts or automation that previously used `--force` for a workspace-wide reset.
The deprecated `cancel-ralph` alias follows the same contract.

## Unreleased: Git-less State Root Recovery

### TL;DR

Sessions launched outside a Git repository no longer create a separate `.omg/`
directory for every cwd. OMC uses one canonical `~/.omg/` root, or
`$OMC_STATE_DIR/non-git` when centralized state is configured. Protected
locations and descendants of system temp/OS roots are never used as roots.

### Migration and compatibility

- Existing non-git `.omg/` roots remain untouched and are not adopted implicitly.
  Use `state_migrate_non_git` with the owning `session_id` to copy matching JSON
  records into the canonical root without overwriting or deleting sources.
- Existing state under protected locations is never moved or deleted
  automatically, and cannot be used as a migration source.
- `OMC_STATE_DIR` remains the explicit centralized option. In git-less sessions
  it uses one fixed `non-git` child rather than hashing each cwd.
- `workingDirectory` on state tools is honored within the validated context;
  foreign repositories and failed Git probes are rejected visibly.
- Session-scoped state remains owned by its `session_id`. No time-based cleanup
  or cancellation was added.

---

## v5.6.2 → v5.7.0: Smoke Harness

Fork **v5.7.0** adds a headless smoke harness and ports upstream
oh-my-claudecode `dev` 486b85bbb..bcaceb136. There is nothing to migrate: no
config, command or skill is renamed or removed.

- Update with `npm install -g oh-my-copilot@5.7.0` or
  `copilot plugin update oh-my-copilot@omc`.

### Adopting `omg smoke copilot` and `host_smoke`

Build first (`npm run build`); the MCP check spawns
`dist/mcp/standalone-server.js`.

| Tier | Command | Cost |
| --- | --- | --- |
| 0 | `omg smoke copilot --tier 0` | Free, no model call |
| 1 | `omg smoke copilot --tier 1` | 1 premium request |
| 2 static | `omg smoke copilot --sdk-static` | Free, no model call |
| 2 | `omg smoke copilot --tier 2 [--scenario all]` | About 1 premium request per scenario; the default `smoke` + `guardrail` costs about 2 |

`--max-credits` (default and minimum 30) caps a run. The CLI has no opt-in
gate. The MCP tool `host_smoke` has two, set as env vars on the MCP server:

- **`OMC_SMOKE_ALLOW_LIVE=1`** allows `{ "tier": 1 }` and tier 2 with
  scenarios. `{ "tier": 2, "scenarios": [] }` runs the free static checks
  without it.
- **`OMC_SMOKE_ALLOW_ANY_ROOT=1`** allows a `pluginRoot` other than the
  server's own package root.

`OMC_DISABLE_TOOLS=smoke` hides the tool. From vitest, `npm run test:live`
runs tier 0 whenever the `copilot` binary resolves. It runs tier 1 only with
`OMC_LIVE_SMOKE=1` and the tier 2 scenarios only with `OMC_LIVE_SMOKE=2`.
Details are in
[DEVELOPERS.md](DEVELOPERS.md#headless-smoke-against-a-local-build).

### Optional SDK for tier 2

`@github/copilot-sdk` is an optional peer dependency; installing
oh-my-copilot never pulls it in. Install it only if you want tier 2:

```bash
npm i -g @github/copilot-sdk --omit=optional --ignore-scripts
```

`--ignore-scripts` avoids a CMake source build on Windows. If a global
install still adds the SDK's bundled platform runtime (about 128 MB), delete
it; tier 2 always uses the installed `copilot` binary.

### `OMC_HOOK_FAIL_CLOSED=1`

The variable is opt-in and unset by default. Without it, the Copilot hook
adapter turns a hook's non-zero exit into `0` plus one `[omg-hook]` stderr
line, and a hook that times out in `scripts/run.cjs` exits `0`, so hooks fail
open. With `OMC_HOOK_FAIL_CLOSED=1` the adapter keeps the hook's exit code,
and a hook timeout in `scripts/run.cjs` exits `124`. Exit `2` on
PermissionRequest means deny in both modes. The smoke harness sets the
variable for its own sessions.

### Team env passthrough on POSIX (#4236)

`OMC_TEAM_WORKER_ENV_PASSTHROUGH` keeps the same configuration. On POSIX tmux
teams its values are no longer inlined into the worker pane's command line.
They are written to a private `0600` file in a `0700` directory, which the
pane's `/bin/sh` sources and removes before it execs the login shell. Nothing
changes for you, but the values no longer appear in `ps` output or tmux
`pane_start_command`.

---

## v5.6.1 → v5.6.2: Postinstall Hook

Fork **v5.6.2** ports upstream oh-my-claudecode `dev` 4280efb1f..486b85bbb.
There is nothing to migrate: no config, command or skill changes.

- Update with `npm install -g oh-my-copilot@5.6.2` or
  `copilot plugin update oh-my-copilot@omc`.
- `npm install` now runs `scripts/postinstall-contained-fs.mjs`. On macOS it
  builds the contained-fs native addon if it is missing; if Node headers or
  Xcode Command Line Tools are unavailable it prints a warning and you can
  build later with `node scripts/build-contained-fs.mjs` from the package
  root. On Linux and Windows it does nothing. The hook always exits 0, so it
  never fails the install.

---

## v5.5.0 → v5.6.1: Fork Upgrade Guide

This section covers the upgrade from fork **v5.5.0** to fork **v5.6.1**. The
release ports upstream oh-my-claudecode v5.6.0, v5.6.1 and `dev` through
4280efb1f, and it runs the new unattended-run commands on Copilot under a
scoped permission profile. Nothing is renamed or removed, so there are no
breaking changes.

### TL;DR

1. Update the package (`npm install -g oh-my-copilot@5.6.1`) or the plugin
   (`copilot plugin update oh-my-copilot@omc`). No config edits are required.
2. If you export `COPILOT_ALLOW_ALL`, note that unattended children now
   ignore it (see [Behaviour change](#copilot_allow_all-on-unattended-children)).
3. Optional: try `omg factory init`, `omg intake run` and `omg ralph afk`.
   They need the host binary on PATH and `gh` authenticated.

### New commands

| Command | What it does |
|---|---|
| `omg factory init [--no-narrow] [--force] [--cwd <dir>]` | Seeds `.omg/factory-routes.json`, the chain-routing source of truth. Refuses unless `.omg/state/` and `docs/design/` exist, and never overwrites a table without `--force`. |
| `omg factory listen --repo <owner/name,...> [--port 7788] [--host 127.0.0.1] [--cwd <dir>]` | Tracker intake daemon. Requires `OMC_FACTORY_HMAC_SECRET`; binds to 127.0.0.1 unless `--host` says otherwise. |
| `omg factory status [--json]` | Read-only audit of factory chains. |
| `omg intake run [--headless] [--allow-docket-only] [--host-bin <bin>] [--cwd <dir>]` | One headless harbor sweep. Refuses without a verified notification channel unless `--allow-docket-only` is passed. |
| `omg intake schedule --cron <expr> [--off] [--cwd <dir>]` | Installs (or with `--off` removes) the sweep in cron, or in Task Scheduler on Windows (`*/N * * * *` and `M H * * *` only). |
| `omg ralph afk "<task>" [--verify <command>]...` | Launches an isolated headless ralph run. `--verify` is repeatable. |
| `omg ralph verify [--write-baseline] [--session <id>] [--json]` | The only command that records or judges the feedback baseline. |
| `omg ralph from-map --map <repo#number> [--repo <name>] [--execute] [--launch] [--finalize] [--session <id>] [--json]` | Plans, claims and launches a ralph run from a wayfinder map. |

### What these commands need on Copilot

- **The host binary on PATH.** Factory links and ralph AFK runs spawn
  `copilot` (or `claude` under Claude Code). `omg intake run --host-bin <bin>`
  overrides the binary; the value is validated like the team launch contract.
- **`gh` authenticated** for the repository. `omg intake run` refuses when
  `gh repo view` or `gh label list` fails, and AFK sessions talk to the
  tracker through `gh`.
- **The AFK permission profile.** Factory links and `omg ralph afk|from-map`
  launch Copilot with:

  ```text
  --no-ask-user
  --allow-tool=shell(gh issue view)  --allow-tool=shell(gh issue comment)
  --allow-tool=shell(gh issue edit)  --allow-tool=shell(gh pr view)
  --allow-tool=shell(gh pr list)     --allow-tool=shell(gh label list)
  --allow-tool=write  --allow-url=github.com
  --deny-tool=write(.git)  --deny-tool=write(package.json)  --deny-tool=shell(git push)
  ```

  Deny beats allow, so the session cannot edit git plumbing, rewrite
  `package.json` (which would turn an allowed `npm test` into arbitrary
  shell) or push. Ralph AFK runs also get
  `--allow-tool=shell(omg ralph verify)`. Each declared `--verify` command
  becomes one `--allow-tool=shell(<command>)` rule; on Copilot a command that
  is a bare program or an interpreter flag (for example `node -e`) is
  refused, because a prefix rule would admit arbitrary code.
- `omg intake run` launches Copilot with `-p <prompt> --no-ask-user` and no
  allow rules, plus `OMC_GIT_GUARDRAILS=1`.

### `COPILOT_ALLOW_ALL` on unattended children

This is the one behaviour change. `COPILOT_ALLOW_ALL` is no longer forwarded
by the session-end `COPILOT_*` passthrough, and every AFK child (factory
links, `omg ralph afk|from-map`, `omg intake run`) is started with
`COPILOT_ALLOW_ALL=false`. Before, an exported value widened the AFK profile
to unrestricted shell. Interactive sessions and `omg team` workers are not
affected.

### New environment variables

| Variable | Default | Effect |
|---|---|---|
| `OMC_GIT_GUARDRAILS` | unset | `1` blocks `git push`, `git reset --hard`, `git clean -f`, `git branch -D` and `git checkout/restore .` in every session; `0` turns the hook off even during an unattended mode. Unset, it is on only while ralph, autopilot, team or ultragoal is active. |
| `OMC_STALE_RUN_HOURS` | `2` | Age after which the SessionStart watchdog reports an `active: true` unattended run as stale. It reports only; it never resumes or clears state. |
| `OMC_HOST_LOAD_THRESHOLD` | 80% of CPU cores | CPU load above which expensive operations wait. |
| `OMC_FREE_MEMORY_THRESHOLD` | `256` (MB) | Free memory below which expensive operations wait. |
| `OMC_MAX_SIBLING_SESSIONS` | `8` | Live sibling OMC sessions above which expensive operations wait. |
| `OMC_HOST_LOAD_GATE_DISABLED` | unset | Any value disables the host-load gate. The gate also proceeds when metrics are unavailable. |
| `OMC_TEAM_WORKER_ENV_PASSTHROUGH` | unset | Comma-separated variable names forwarded to team workers, for custom provider credentials. Reserved and invalid names are rejected. |
| `OMC_FACTORY_HMAC_SECRET` | unset | Required by `omg factory listen` to verify tracker events. |

### `team.roleRouting.<role>.reasoningEffort`

`roleRouting` entries take a per-role `reasoningEffort`. The fork forwards it
only to providers with a verified CLI flag: claude workers (`--effort`) and
codex workers (`model_reasoning_effort`). **Copilot workers ignore it**,
because Copilot CLI has no verified reasoning-effort flag.

### Windows launch change

On Windows, factory links and ralph AFK runs no longer put the prompt on a
command line. The prompt goes to the host binary on stdin (`copilot` reads a
piped prompt without `-p`, verified on Copilot CLI 1.0.91; `claude` keeps
`-p`), and a `gh --body` becomes `--body-file -`. Native `.exe` binaries are
spawned directly with an argument array; only `.cmd`/`.bat` npm shims go
through `COMSPEC`, with quoting that refuses `%`. Nothing to configure, but
wrappers that inspected the child's argv for the prompt will no longer find
it there.

### Known limitations

- **Copilot factory chains stop after one link** (fixed after v5.7.0, see
  [Factory Chains on Copilot](#unreleased-factory-chains-on-copilot)).
  Copilot CLI has no `--session-id`, so the next link cannot be pinned;
  `omg factory status` and the watchdog report the stalled chain.
- **git-guardrails under Copilot on Windows is not live-verified.** The hook
  is projected and unit-tested, but its PreToolUse payload has not been
  exercised in a live Copilot session on Windows. Plant a violation (for
  example ask for `git push`) before relying on it.

See [CHANGELOG.md](../CHANGELOG.md) for the full port summary.

---

## v5.1.0 → v5.5.0: Fork Upgrade Guide

This section covers the upgrade from fork **v5.1.0** to fork **v5.5.0**. The
release ports upstream oh-my-claudecode v5.4.0 and v5.5.0, and it makes the
fork work as a native GitHub Copilot CLI plugin. Claude Code stays supported.

### TL;DR

1. Rename `COPILOT_CONFIG_DIR` to `COPILOT_HOME` in your shell profile, CI and
   scripts. The old name is no longer read.
2. Update or reinstall the plugin, because the plugin layout changed:
   `copilot plugin update oh-my-copilot@omc`.
3. Make sure `node` is on PATH for the Copilot process. Run
   `omg doctor conflicts` to check both points.
4. Optional: add `permissions.workerDenyTools` / `workerDenyUrls` to
   `.copilot/omg.jsonc` before running `omg team` with copilot workers.

### `COPILOT_CONFIG_DIR` → `COPILOT_HOME`

`COPILOT_HOME` is GitHub Copilot CLI's own config-directory variable. Earlier
fork builds read `COPILOT_CONFIG_DIR`, which Copilot ignores. A user who moved
Copilot with `COPILOT_HOME` therefore got a split: Copilot used one directory
while OMC's hooks, HUD and installer used `~/.copilot`. Now one variable moves
both.

- OMC resolves `${COPILOT_HOME:-~/.copilot}`. There is no fallback to
  `COPILOT_CONFIG_DIR`.
- `omg doctor conflicts` warns when `COPILOT_CONFIG_DIR` is still set.
- The `${COPILOT_CONFIG_DIR}` token in `omg.jsonc` guards keeps working as an
  alias of `${COPILOT_HOME}`. You do not have to edit existing guards.
- The package's JS export `COPILOT_CONFIG_DIR` remains as a deprecated alias.
  New code should use the `COPILOT_HOME` export.

```bash
# before
export COPILOT_CONFIG_DIR="$HOME/.copilot-work"
# after
export COPILOT_HOME="$HOME/.copilot-work"
```

### Plugin layout: update or reinstall

Copilot CLI now loads the fork through a root `plugin.json`, which it reads
before `.claude-plugin/plugin.json`. That manifest points at generated files:

| Copilot loads | Generated from | Regenerate with |
|---|---|---|
| `copilot/hooks.json` | `hooks/hooks.json` | `npm run build:copilot-hooks` |
| `copilot/agents/*.md` | `agents/*.md` | `npm run build:copilot-agents` |

Claude Code keeps reading `.claude-plugin/plugin.json`, `hooks/hooks.json` and
`agents/*.md`, which stay identical to upstream. Never hand-edit the generated
files; `npm run build` regenerates both.

An installed plugin cache from v5.1.0 has no root `plugin.json`, so update it:

```bash
copilot plugin update oh-my-copilot@omc
# or reinstall
copilot plugin uninstall oh-my-copilot@omc
copilot plugin install oh-my-copilot@omc
```

Inside a session, `/plugin install oh-my-copilot@omc` does the same. Then
re-run `/oh-my-copilot:omc-setup`. A standalone install that copied agents
into `~/.copilot/agents/` shadows the plugin's agents by name, so re-run
`omg setup` after upgrading.

What changes under Copilot:

- **Hooks run.** Before v5.5.0 every fork hook was a silent no-op under Copilot
  on Windows. Hooks such as persistent-mode, context-guard and
  pre-tool-enforcer now take effect, including their blocks and denies.
- **SessionStart `init` / `maintenance` hooks are not projected.** Copilot
  ignores SessionStart matchers, so they would run, and prune state, on every
  session. They still run under Claude Code.
- **Read-only agents are enforced.** Copilot ignores `disallowedTools`, so the
  generated read-only agents (architect, critic, verifier and others) get a
  `tools:` allowlist without create/edit/apply_patch. Shell stays allowed, as
  it does under Claude.
- **Agent model aliases** (`opus`, `sonnet`, `haiku`, `fable`) become
  Copilot `models:` fallback lists. Copilot uses the first model your plan can
  access.

### `node` must be on PATH

Copilot CLI ships as a single executable and does not provide `node`. Every
OMC hook runs `node`. When a PreToolUse hook cannot start, Copilot itself
denies the tool call, so a missing `node` blocks every tool. OMC cannot catch
that case. `omg doctor conflicts` checks that `node` resolves on PATH.

### Team workers on a Copilot host

- `copilot` is a first-class worker type (`omg team 3:copilot "..."`) and the
  default worker on a Copilot host. An explicit `N:agent-type`,
  `team.ops.defaultAgentType` or `team.roleRouting.<role>.provider` still wins.
- Copilot workers are unattended panes, so they launch with
  `--allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user`.
- Your deny rules come from `.copilot/omg.jsonc` and are forwarded as
  `--deny-tool=<pattern>` / `--deny-url=<pattern>`. In Copilot CLI, deny beats
  allow, even with `--allow-all-tools`:

  ```jsonc
  {
    "permissions": {
      "workerDenyTools": ["shell(git push)", "shell(rm:*)", "write(.env)"],
      "workerDenyUrls": ["https://*.internal.example"]
    }
  }
  ```

  Entries must be non-empty strings. An entry that starts with `-` or contains
  NUL is rejected. `deniedUrls` in `$COPILOT_HOME/settings.json` also applies,
  because workers inherit `COPILOT_HOME`.
- Only copilot workers enforce the deny list. At startup `omg team` prints one
  stderr line per provider, for example:

  ```text
  [omg team] copilot workers (x3): --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user; deny: shell(git push), https://*.internal.example
  [omg team] codex workers (x1): permissions.workerDenyTools NOT enforced (vendor flags: --dangerously-bypass-approvals-and-sandbox)
  ```

### Windows (psmux)

`omg team` on native Windows runs on [psmux](https://github.com/marlocarlo/psmux); install or upgrade with `winget install psmux` (≥ 3.3.7 required so `-L <ns>` namespaces are honored). Teams always launch detached into a private psmux namespace, so they are invisible to a bare `psmux ls`. Attach with `tmux -L <ns> attach`, where `<ns>` is printed by `omg team status <team>` and recorded in `.omg/state/team/<team>/config.json`. If a startup is left unverified, clean it up with `tmux -L <ns> kill-server`.

### `disableExternalLLM` semantics

`disableExternalLLM` (and `OMC_SECURITY=strict`) now means "only the current
host CLI's workers": claude on a Claude Code host, copilot on a Copilot host.
Before, only claude workers were exempt, so a Copilot user with the setting on
could not start any worker.

### Host detection and `omg launch`

- The host is Copilot when Copilot session markers are present. Otherwise
  `CLAUDE_CODE_ENTRYPOINT` selects Claude Code.
- `omg launch` spawns and probes the host binary (`copilot` or `claude`).
- On Copilot, `--madmax` becomes `--yolo`. A typed
  `--dangerously-skip-permissions`, which Copilot rejects, is also replaced
  by `--yolo`.
- `-p` / `--prompt` print mode adds no allow flags. Pass
  `--allow-all-tools` yourself when a non-interactive run needs it.
- The launcher forwards `COPILOT_HOME`, `COPILOT_MODEL`, `GH_HOST` and
  `COPILOT_GH_HOST` into tmux. Tokens travel only through the private
  transport, never on the command line.
- **macOS:** `--madmax` and `--yolo` require tmux on both hosts. The rule is
  judged from the arguments you typed.

### `agents.<name>.model` is a no-op on Copilot

The `agents.<name>.model` override is applied by rewriting the delegation call
through the PreToolUse `updatedInput` channel. Copilot does not support that
channel, so the adapter drops it. On Copilot, per-agent models come from the
generated `models:` lists or from Copilot's own
`subagents.agents.<name>.model` setting in `$COPILOT_HOME/settings.json`. Use
the agent id as Copilot shows it; plugin agents are namespaced
(`oh-my-copilot:<name>`):

```json
{ "subagents": { "agents": { "oh-my-copilot:executor": { "model": "claude-opus-5" } } } }
```

Under Claude Code the override works as before.

### Removed: the safe-command approver

The v4-era `scripts/safe-command-approver.mjs` hook and the
`src/installer/permissions.ts` allowlist generator are gone. The hook had not
been registered since v5.0.0, and it approved chained commands such as
`cat x; curl … | sh`. Use Copilot CLI's `--allow-tool` / `--deny-tool` rules
or its assisted-approval mode instead.

### New skills

Ten upstream skills are added (61 canonical): `harbor`, `agent-doc-discipline`,
`architecture-survey`, `diagram`, `intent`, `minimal-prose-discipline`, `map`,
`pr`, `refit` and `tdd`. See [CHANGELOG.md](../CHANGELOG.md) for the full
port summary.

---

## v4.13.102 → v5.0.0: Fork Upgrade Guide

This section is specific to **oh-my-copilot** (binaries `oh-my-copilot` and,
from v5.0.0, `omg` — `omcp` in v4), the downstream fork maintained at
[RobinNorberg/oh-my-copilot](https://github.com/RobinNorberg/oh-my-copilot).
It covers the concrete upgrade path from fork **v4.13.102** to fork
**v5.0.0**. The section below it, [v4.x → v5.0: Workflow
Retirement](#v4x--v50-workflow-retirement), documents the same skill/command
retirement in more detail (including declared-only and alias entries); read
this section first for what's fork-specific about the jump.

### TL;DR

v5.0.0 rebases the fork onto the upstream `plan → execute → review → verify`
workflow surface, and — the single most important thing for anyone
upgrading — **moves two directories that OMC and the host CLI both read
from, with no automatic migration.** Eleven skill names and seven command
files are also retired outright (not aliased), three skills are new, one
hook subsystem is gone with no replacement, and two opt-in features are
added. The short command is renamed `omcp` → `omg`. Fork-exclusive skills
(Azure DevOps, GitHub, and four standalone skills) are unaffected.

### Command rename: `omcp` → `omg`

The short user-facing command is now **`omg`**, matching the `.omg/` runtime
root and the `.copilot/omg.jsonc` project config. The bridge entrypoint
`omcp-cli` is likewise now `omg-cli`.

**`omcp` is removed, not aliased.** Anything that invokes it — shell aliases,
scripts, Makefiles, CI steps, editor tasks — has to be updated:

```bash
omcp update      # v4
omg update       # v5
```

The long-form **`oh-my-copilot` command is unchanged**, and it is the only
name present in both v4 and v5. Use it anywhere a command has to work on
both sides of the upgrade — most importantly in scripts that run *before*
the upgrade completes:

```bash
oh-my-copilot update    # works in v4 and v5
```

**Statusline users:** the HUD wrapper file is renamed with the command, from
`omcp-hud.mjs` to `omg-hud.mjs` (and `omcp-hud-cache.sh` to
`omg-hud-cache.sh`). A `statusLine` entry in `settings.json` that still
points at the old filename will silently stop rendering the HUD after the
upgrade, because the old file is no longer installed. Re-run setup to have
it rewritten for you:

```bash
omg hud setup
```

Or fix the path by hand in `~/.copilot/settings.json`, replacing
`hud/omcp-hud.mjs` with `hud/omg-hud.mjs`.

### Directory moves: `.claude/` → `.copilot/`, `.omc/` → `.omg/`

**v5.0.0 does not auto-migrate either directory.** Whatever you leave behind
in the old locations is simply ignored, not read, and not merged — you must
move it yourself before your existing config, skills, and state are picked
up again.

**1. `.claude/` → `.copilot/`.** oh-my-copilot is a GitHub Copilot CLI
plugin, and it now reads the host CLI's own surface from `.copilot/` instead
of `.claude/`: `settings.json`, `settings.local.json`, hooks, commands,
skills, plugins, rules, tasks, and worktrees.

- Project config moves from `.claude/omc.jsonc` to `.copilot/omg.jsonc`.
  Move that file yourself:
  ```bash
  mkdir -p .copilot
  mv .claude/omc.jsonc .copilot/omg.jsonc
  ```
- Context files are the one exception with a built-in fallback: the plugin
  now *prefers* `copilot-instructions.md` and `.copilot/AGENTS.md`, but it
  still falls back to `.claude/CLAUDE.md` / `.claude/AGENTS.md` when running
  under Claude Code. You don't have to move those two immediately, though
  moving them (or adding `copilot-instructions.md`) is recommended going
  forward.
- Everything else under `.claude/` — settings, hooks, commands, skills,
  plugins, rules, tasks, worktrees — is **not** read from `.claude/` anymore
  and must be moved to `.copilot/` to keep working.
- Your user-level OMC config, `.omc-config.json`, now resolves to
  `${COPILOT_CONFIG_DIR:-~/.copilot}/.omc-config.json`. This one you do *not*
  have to move: if `~/.claude/.omc-config.json` is the only copy you have,
  `/oh-my-copilot:omc-setup` adopts it into the new location when setup
  completes, copying rather than moving so nothing is destroyed.
  `/oh-my-copilot:omc-doctor` reports a stranded copy and can adopt it on its
  own, and setting `COPILOT_CONFIG_DIR` overrides the location entirely.
  (v5.5.0 renames that variable to `COPILOT_HOME`; see
  [v5.1.0 → v5.5.0](#v510--v550-fork-upgrade-guide).)

**2. `.omc/` → `.omg/`.** All oh-my-copilot runtime files move: state,
sessions, logs, plans, research, `notepad.md`, `project-memory.json`,
drafts, and autopilot/team state. Move the whole tree:

```bash
mv .omc .omg
```

If you pin `planOutput.directory` explicitly in config, note its **default**
changed from `.omc/plans` to `.omg/plans` — update an explicit pin
accordingly (an unpinned config picks up the new default automatically).

**Unchanged:** the multi-repo workspace marker file is still named
`.omc-workspace` at the workspace root — it does not need renaming.

### Retired skill and command names

If any of these are in your scripts, hooks, `CLAUDE.md`, or muscle memory,
switch to the replacement — the old name no longer resolves:

| Retired name       | Replacement                              |
| ------------------- | ----------------------------------------- |
| `ultrawork`         | `/oh-my-copilot:execute`                 |
| `ultraqa`           | `/oh-my-copilot:verify`                  |
| `deep-dive`         | `/oh-my-copilot:plan` then `execute`, or `/oh-my-copilot:research` for investigation |
| `sciomc`            | `/oh-my-copilot:research`                |
| `cccg` skill (invoked as `/ccg`) | `/oh-my-copilot:execute`   |
| `omc-teams`         | `/oh-my-copilot:team`                    |
| `setup`             | `/oh-my-copilot:omc-setup`               |
| `mcp-setup`         | `/oh-my-copilot:omc-setup`               |
| `omc-reference`     | `/oh-my-copilot:wiki`                    |
| `learner`           | `/oh-my-copilot:skillify` or `/oh-my-copilot:remember` |
| `writer-memory`     | `/oh-my-copilot:remember`                |

Seven command files were removed alongside their skills: `ccg.md`,
`deep-dive.md`, `learner.md`, `mcp-setup.md`, `omc-teams.md`, `sciomc.md`,
`writer-memory.md`.

### New Tier-0 workflow shape

The canonical chain is now `plan → execute → review → verify`. Three skills
are newly adopted: `execute`, `research`, and `review`. `review` installs as
`omc-review` (it would otherwise collide with a native Claude Code command
name). A new `/oh-my-copilot:compact` command is also added — it does not
trigger Claude Code's native `/compact` itself, it prepares OMC context and
hands you the bare `/compact` command to run.

### Known regression: `stagger-launch` is gone

The `ultrawork` / `ultraqa` / `ultrapilot` hook subsystems are removed, and
the `stagger-launch` hook goes with them. `stagger-launch`'s only trigger was
`ultrawork` mode, and it throttled rapid parallel agent launches to avoid a
rate-limit thundering herd. That protection is **not** carried over to the
new `execute`/`team` workflow surface in 5.0.0 — this is a known regression,
not an oversight. If you relied on `ultrawork` specifically for its launch
throttling, there is currently no equivalent in the new workflow surface.

### Upgrading

oh-my-copilot is a GitHub Copilot CLI plugin (binaries `oh-my-copilot` and
`omg`; `omg` was `omcp` before v5.0.0). To upgrade:

```bash
npm i -g oh-my-copilot@5
```

or, via the plugin marketplace:

```bash
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot
/plugin install oh-my-copilot
```

Then run `/oh-my-copilot:omc-setup` (or say "setup omc") to refresh installed
skills and prune retired ones.

**Stale agent files from v4 are now correctly cleaned up.** The 4.x agent
ownership inventory wrongly contained upstream's agent-file hashes instead of
the fork's own, so agent files installed by v4 could fail the installer's
ownership check and be left behind on upgrade instead of being reclaimed.
5.0.0 fixes this by regenerating the inventory from the fork's own release
history, so a v4.13.102 → v5.0.0 upgrade should no longer leave orphaned
agent files behind.

### New opt-in features

Neither of these is enabled by default — turn them on if you want them:

- **Microsoft Teams notifications.** Set `OMC_MICROSOFT_TEAMS_WEBHOOK_URL` to
  a Power Automate Workflows or legacy O365 Connector webhook URL (or add a
  `teams` block to your notification config) to receive OMC notifications in
  Teams.
- **RecentTools HUD element.** Enable `showRecentTools` in your HUD config to
  show a rolling list of recent tool calls with status icons in the
  statusline; tune it with `recentToolsMax` (default 5) and
  `recentToolsShowTarget`.

### Unchanged

Fork-exclusive skills are not affected by the retirement or the upstream
rebase: the five `omc-ado-*` Azure DevOps skills, the five `omc-gh-*` GitHub
skills, plus `critique`, `deep-review`, `discover`, and `ralph-experiment`.

---

## v4.x → v5.0: Workflow Retirement

### TL;DR

17 workflow names were **removed outright**, not kept as aliases. The public
surface is now four canonical workflows — `plan` → `execute` → `review` →
`verify` — plus a small set of independent workflows and utilities.

If you use `/ultrawork`, `/ultraqa`, `/ccg`, `/sciomc`, `/deep-dive`,
`/omc-teams`, `/setup`, `/mcp-setup`, `/learner`, or `/writer-memory`, those
names no longer resolve. Use the replacement in the table below.

### Removed skills and commands

| Removed                | Replacement                              | Notes                                                        |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `ultrawork`            | `/oh-my-copilot:execute` or `/team`   | Use `/team` when you want coordinated parallel workers        |
| `ultrapilot`           | `/oh-my-copilot:team`                 | Declared-only; never shipped as a skill file                  |
| `swarm`                | `/oh-my-copilot:team`                 | Declared-only                                                 |
| `pipeline`             | `/oh-my-copilot:execute`              | Declared-only                                                 |
| `ultraqa`              | `/oh-my-copilot:verify`               |                                                               |
| `merge-readiness`      | `/oh-my-copilot:review`               | Advisory review; release hard checks are unchanged            |
| `deep-dive`            | `/oh-my-copilot:research`             |                                                               |
| `sciomc`               | `/oh-my-copilot:research`             |                                                               |
| `ccg`                  | `/oh-my-copilot:ask` + `/team`        | Run `/ask codex` and `/ask antigravity`, then synthesize      |
| `omc-teams`            | `/oh-my-copilot:team` or `omg team`   |                                                               |
| `setup`                | `/oh-my-copilot:omc-setup`            |                                                               |
| `mcp-setup`            | Claude Code native MCP configuration     | Use `claude mcp add <name> ...` or the path selected by `CLAUDE_MCP_CONFIG_PATH`. |
| `omc-reference`        | `/oh-my-copilot:wiki`                 | Model-routing reference moved into the wiki skill             |
| `learner`              | `/oh-my-copilot:remember`             |                                                               |
| `writer-memory`        | `/oh-my-copilot:remember`             |                                                               |
| `local-build-reminder` | —                                        | Removed; docs and CI cover the rebuild signal                 |
| `understanding-gate`   | `/oh-my-copilot:review`               | Frontmatter alias of the removed merge-readiness              |

Command files removed alongside their skills: `ccg.md`, `deep-dive.md`,
`learner.md`, `mcp-setup.md`, `omc-teams.md`, `sciomc.md`, `writer-memory.md`.

### What is kept

These were **not** retired, despite routing into the canonical workflows:

- **Canonical Tier-0**: `plan`, `execute`, `review`, `verify`
- **Independent Tier-0 planning**: `deep-interview`, `ralplan`
- **Directly invocable workflows**: `autopilot`, `autoresearch`, `ultragoal`, `ralph`
- **Internal lanes**: `team`, `research`
- **Surviving aliases**: `psm` → `project-session-manager`, `release` → maintainer-only `omg release`

### Newly available to everyone

`verify`, `remember`, and `debug` were previously gated behind an internal
entitlement (`USER_TYPE=ant`). They now install for all users — `verify`
completes the canonical chain and `remember` is the target for the retired
`learner`/`writer-memory`.

### Installed names

Two skills install under an `omc-` prefix because their names collide with
Claude Code native commands:

| Skill    | Installed as |
| -------- | ------------ |
| `plan`   | `omc-plan`   |
| `review` | `omc-review` |

### Migration Steps

1. Update any scripts, docs, or prompts that invoke a removed name.
2. Run `omg setup` (or `/oh-my-copilot:omc-setup`). The installer prunes the
   retired skill directories automatically — no manual cleanup needed.
3. If you pinned a removed skill in `.claude/settings.json` or a project
   `CLAUDE.md`, replace it using the table above.

### Why these were removed rather than aliased

The alias retirement policy normally requires ≥2 minor releases, ≥90 days, and
≥95% canonical usage before a name can be removed. A major version is the
sanctioned place for breaking removals, so 5.0.0 applies a major-boundary
carve-out (`isMajorBoundaryRemoval`). The carve-out does **not** waive the
critical-integrations check — an alias with a known critical consumer still
blocks.

---

## Unreleased: Team MCP Runtime Deprecation (CLI-Only)

### TL;DR

`omc_run_team_start/status/wait/cleanup` are now hard-deprecated at runtime. Calls return:

```json
{
  "code": "deprecated_cli_only",
  "message": "Legacy team MCP runtime tools are deprecated. Use the omg team CLI instead."
}
```

Use CLI commands instead:

- `omg team [N:agent-type] "<task>"`
- `omg team status <team-name>`
- `omg team shutdown <team-name> [--force]`
- `omg team api <operation> --input '<json>' --json`

### `omg ask` env alias sunset (Phase-1 compatibility)

`OMC_ASK_*` is now canonical for advisor execution. Phase-1 accepts `OMX_ASK_ADVISOR_SCRIPT` and `OMX_ASK_ORIGINAL_TASK` with deprecation warnings. Planned hard sunset for alias removal: **2026-06-30**.

### How to Migrate

1. Replace MCP runtime tool calls with CLI equivalents.
2. Update skills/prompts from `/omc-teams ...` to `omg team ...` syntax.
3. Legacy Team MCP runtime is now opt-in only (not enabled by default). If you enable it manually, treat responses as deprecation-only compatibility output.

### Example mapping

```bash
# Old (deprecated runtime path)
mcp__team__omc_run_team_start(...)
mcp__team__omc_run_team_status({ job_id: ... })
mcp__team__omc_run_team_wait({ job_id: ... })
mcp__team__omc_run_team_cleanup({ job_id: ... })

# New (CLI-first)
omg team 2:codex "review auth flow"
omg team status review-auth-flow
omg team shutdown review-auth-flow --force
omg team api list-tasks --input '{"team_name":"review-auth-flow"}' --json
```

---

## Unreleased: Native Team Worktree Mode (Opt-In)

### TL;DR

`omg team` runtime-v2 is gaining an opt-in worker worktree mode. Worktree-backed workers run from dedicated git worktrees while task lifecycle, mailbox, status, and manifest files stay under the leader workspace's team-specific coordination root (`<repo>/.omg/state/team/<team-name>`).

### Contract

- Worktree paths use `<repo>/.omg/team/<team-name>/worktrees/<worker-name>`.
- `OMC_TEAM_STATE_ROOT` points workers back to `<repo>/.omg/state/team/<team-name>`.
- Status/config/manifest/identity surfaces should expose `workspace_mode`, `worktree_mode`, `team_state_root`, and worker worktree metadata.
- Dirty worker worktrees are preserved and reported; they are not force-cleaned by shutdown/cleanup.

See [Native Team Worktree Mode](TEAM-WORKTREE-MODE.md) for the full rollout contract and verification checklist.

## v3.5.3 → v3.5.5: Test Fixes & Cleanup

### TL;DR

Maintenance release fixing test suite issues and continuing skill consolidation from v3.5.3.

### What Changed

**Test Fixes:**

- Delegation-enforcer tests marked as skipped (implementation pending)
- Analytics expectations corrected for agent attribution
- All remaining tests now pass cleanly

**Skill Consolidation:**

- Continued cleanup from v3.5.3
- Removed deprecated `cancel-*` skills (use `/cancel` instead)
- Final skill count: 37 core skills

### Migration Steps

1. **No breaking changes** - All functionality preserved
2. **Test suite** now runs cleanly with `npm run test:run`
3. **Deprecated skills** removed (already replaced in v3.5.3)

### For Developers

If you were depending on deprecated `cancel-*` skills, update to use the unified `/cancel` command which auto-detects the active mode.

---

## v3.5.2 → v3.5.3: Skill Consolidation

### TL;DR

8 deprecated skills have been removed. The unified `/cancel` and `/omc-setup` commands replace them.

### Removed Skills

The following skills have been **completely removed** in v3.5.3:

| Removed Skill        | Replacement                            |
| -------------------- | -------------------------------------- |
| `cancel-autopilot`   | `/oh-my-copilot:cancel`             |
| `cancel-ralph`       | `/oh-my-copilot:cancel`             |
| `cancel-ultrawork`   | `/oh-my-copilot:cancel`             |
| `cancel-ultraqa`     | `/oh-my-copilot:cancel`             |
| `omc-default`        | `/oh-my-copilot:omc-setup --local`  |
| `omc-default-global` | `/oh-my-copilot:omc-setup --global` |
| `planner`            | `/oh-my-copilot:plan`               |

### What Changed

**Before v3.5.3:**

```bash
/oh-my-copilot:cancel-ralph      # Cancel ralph specifically
/oh-my-copilot:omc-default       # Configure local project
/oh-my-copilot:planner "task"    # Start planning
```

**After v3.5.3:**

```bash
/oh-my-copilot:cancel            # Auto-detects and cancels any active mode
/oh-my-copilot:omc-setup --local # Configure local project
/oh-my-copilot:plan "task"       # Start planning (includes interview mode)
```

### New Features

**New skill: `/learn-about-omc`**

- Analyzes your OMC usage patterns
- Provides personalized recommendations
- Identifies underutilized features

**Plan skill now supports consensus mode:**

```bash
/oh-my-copilot:plan --consensus "task"  # Iterative planning with Critic review
/oh-my-copilot:ralplan "task"           # Alias for plan --consensus
```

### Migration Steps

1. **No action required** - The unified `/cancel` command already worked in v3.5
2. **Update any scripts** that reference removed commands
3. **Re-run `/omc-setup`** if you want to update your CLAUDE.md configuration

### Skill Count

- v3.5: 42 skills
- v3.5.3: 37 skills (8 removed, 3 added)

---

## v2.x → v3.0: Package Rename & Auto-Activation

### TL;DR

Your old commands still work! But now you don't need them.

**Before 3.0:** Explicitly invoke 25+ commands like `/oh-my-copilot:ralph "task"`, `/oh-my-copilot:ultrawork "task"`

**After 3.0:** Just work naturally - Claude auto-activates the right behaviors. One-time setup: just say "setup omc"

### Project Rebrand

The project was rebranded to better reflect its purpose and improve discoverability.

- **Project/brand name**: `oh-my-copilot` (GitHub repo, plugin name, commands)
- **npm package name**: `oh-my-copilot` (unchanged)

> **Why the difference?** The npm package name `oh-my-copilot` was kept for backward compatibility with existing installations. The project, GitHub repository, plugin, and all commands use `oh-my-copilot`.

#### NPM Install Command (unchanged)

```bash
npm i -g oh-my-copilot@latest
```

### What Changed

#### Before (2.x): Explicit Commands

You had to remember and explicitly invoke specific commands for each mode:

```bash
# 2.x workflow: Multiple commands, lots to remember
/oh-my-copilot:ralph "implement user authentication"       # Persistence mode
/oh-my-copilot:ultrawork "refactor the API layer"          # Maximum parallelism
/oh-my-copilot:planner "plan the new dashboard"            # Planning interview
/oh-my-copilot:deepsearch "find database schema files"     # Deep search
/oh-my-copilot:git-master "commit these changes"           # Git expertise
/oh-my-copilot:deepinit ./src                              # Index codebase
/oh-my-copilot:analyze "why is this test failing?"         # Deep analysis
```

#### After (3.0): Auto-Activation + Keywords

Work naturally. Claude detects intent and activates behaviors automatically:

```bash
# 3.0 workflow: Just talk naturally OR use optional keywords
"don't stop until user auth is done"                # Auto-activates ralph-loop
"fast: refactor the entire API layer"               # Auto-activates ultrawork
"plan: design the new dashboard"                    # Auto-activates planning
"ralph ulw: migrate the database"                   # Combined: persistence + parallelism
"find all database schema files"                    # Auto-activates search mode
"commit these changes properly"                     # Auto-activates git expertise
```

### Agent Naming Standard

Agent naming is now strictly descriptive and role-based (for example: `architect`, `planner`, `analyst`, `critic`, `document-specialist`, `designer`, `writer`, `vision`, `executor`).

Use canonical role names across prompts, commands, docs, and scripts. Avoid introducing alternate myth-style or legacy aliases in new content.

### Directory and Environment Migration

No directory rename is required for the current OMC state paths. Keep existing `.omg/` project state and `~/.omg/` global state directories in place.

Only update genuinely legacy or custom paths that predate the OMC layout:

| Area | Old | New |
| ---- | --- | --- |
| Config file | `~/.claude/omc/mnemosyne.json` | `~/.claude/omc/learner.json` |

Environment variables that already use the `OMC_` prefix do not need renaming. Continue using the existing documented variables such as `OMC_LSP_TOOLS`, `OMC_PARALLEL_EXECUTION`, and `OMC_DEBUG`.

### Command Mapping

All 2.x commands continue to work. Here's what changed:

| 2.x Command                            | 3.0 Equivalent                                     | Works?                 |
| -------------------------------------- | -------------------------------------------------- | ---------------------- |
| `/oh-my-copilot:ralph "task"`       | Say "don't stop until done" OR use `ralph` keyword | ✅ YES (both ways)     |
| `/oh-my-copilot:ultrawork "task"`   | Say "fast" or "parallel" OR use `ulw` keyword      | ✅ YES (both ways)     |
| `/oh-my-copilot:ultrawork-ralph`    | Say "ralph ulw:" prefix                            | ✅ YES (keyword combo) |
| `/oh-my-copilot:planner "task"`     | Say "plan this" OR use `plan` keyword              | ✅ YES (both ways)     |
| `/oh-my-copilot:plan "description"` | Start planning naturally                           | ✅ YES                 |
| `/oh-my-copilot:review [path]`      | Invoke normally                                    | ✅ YES (unchanged)     |
| `/oh-my-copilot:deepsearch "query"` | Say "find" or "search"                             | ✅ YES (auto-detect)   |
| `/oh-my-copilot:analyze "target"`   | Say "analyze" — routes to debugger/architect agent | ✅ YES (keyword route) |
| `/oh-my-copilot:deepinit [path]`    | Invoke normally                                    | ✅ YES (unchanged)     |
| `/oh-my-copilot:git-master`         | Say "git", "commit", "atomic commit"               | ✅ YES (auto-detect)   |
| `/oh-my-copilot:frontend-ui-ux`     | Say "UI", "styling", "component", "design"         | ✅ YES (auto-detect)   |
| `/oh-my-copilot:note "content"`     | Say "remember this" or "save this"                 | ✅ YES (auto-detect)   |
| `/oh-my-copilot:cancel-ralph`       | Say "stop", "cancel", or "abort"                   | ✅ YES (auto-detect)   |
| `/oh-my-copilot:omc-doctor`         | Invoke normally                                    | ✅ YES (unchanged)     |
| All other commands                     | Work exactly as before                             | ✅ YES                 |

### Magic Keywords

Include these anywhere in your message to explicitly activate behaviors. Use keywords when you want explicit control (optional):

| Keyword             | Effect                                   | Example                           |
| ------------------- | ---------------------------------------- | --------------------------------- |
| `ralph`             | Persistence mode - won't stop until done | "ralph: refactor the auth system" |
| `ralplan`           | Iterative planning with consensus        | "ralplan: add OAuth support"      |
| `ulw` / `ultrawork` | Maximum parallel execution               | "ulw: fix all type errors"        |
| `plan`              | Planning interview                       | "plan: new API design"            |

**ralph includes ultrawork:**

```
ralph: migrate the entire database
    ↓
Persistence (won't stop) + Ultrawork (maximum parallelism) built-in
```

**No keywords?** Claude still auto-detects:

```
"don't stop until this works"      # Triggers ralph
"fast, I'm in a hurry"             # Triggers ultrawork
"help me design the dashboard"     # Triggers planning
```

### Natural Cancellation

Say any of these to stop:

- "stop"
- "cancel"
- "abort"
- "nevermind"
- "enough"
- "halt"

Claude intelligently determines what to stop:

```
If in ralph-loop     → Exit persistence loop
If in ultrawork      → Return to normal mode
If in planning       → End planning interview
If multiple active   → Stop the most recent
```

No more `/oh-my-copilot:cancel-ralph` - just say "cancel"!

### Migration Steps

Follow these steps to migrate your existing setup:

#### 1. Uninstall Old Package (if installed via npm)

```bash
npm uninstall -g oh-my-copilot
```

#### 2. Install via Plugin System

```bash
# In Claude Code:
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot
/plugin install oh-my-copilot
```

> **Note**: npm/bun global installs no longer provide the in-session plugin surface by themselves. Use the plugin system for slash commands, hooks, and skills; use the published npm package `oh-my-copilot` when you need the terminal `omg` CLI.

#### 3. Preserve Existing OMC Directories

Do not rename current OMC directories. Existing project state in `.omg/` and global state in `~/.omg/` are already on the current paths.

#### 4. Update Legacy Config Names

If you still have the pre-3.0 learner config filename, rename only that file:

```bash
mv ~/.claude/omc/mnemosyne.json ~/.claude/omc/learner.json
```

#### 5. Review Scripts and Configurations

Search your local scripts and docs for stale references to removed commands or the old config filename. Keep the npm package name as `oh-my-copilot` for npm/bun installs; do not rewrite it to the project/plugin brand name.

#### 6. Run One-Time Setup

In Claude Code, just say "setup omc", "omc setup", or any natural language equivalent.

This:

- Downloads latest CLAUDE.md
- Configures 32 agents
- Enables auto-behavior detection
- Activates continuation enforcement
- Sets up skill composition

### Verification

After migration, verify your setup:

1. **Check CLI installation, if you use the npm CLI surface**:

   ```bash
   npm list -g oh-my-copilot
   ```

2. **Verify directories exist**:

   ```bash
   ls -la .omg/  # In project directory
   ls -la ~/.omg/  # Global directory
   ```

3. **Test a simple command**:
   Run `/oh-my-copilot:omc-help` in Claude Code to ensure the plugin is loaded correctly.

### New Features in 3.0

#### 1. Zero-Learning-Curve Operation

**No commands to memorize.** Work naturally:

```
Before: "OK, I need to use /oh-my-copilot:ultrawork for speed..."
After:  "I'm in a hurry, go fast!"
        ↓
        Claude: "I'm activating ultrawork mode..."
```

#### 2. Delegate Always (Automatic)

Complex work auto-routes to specialist agents:

```
Your request              Claude's action
────────────────────     ────────────────────
"Refactor the database"   → Delegates to architect
"Fix the UI colors"       → Delegates to designer
"Document this API"       → Delegates to writer
"Search for all errors"   → Delegates to explore
"Debug this crash"        → Delegates to architect
```

You don't ask for delegation - it happens automatically.

#### 3. Learned Skills (`/oh-my-copilot:skillify`)

Extract reusable insights from problem-solving. `/oh-my-copilot:learner` remains as a deprecated compatibility alias:

```bash
# After solving a tricky bug:
"Extract this as a skill"
    ↓
Claude learns the pattern and stores it
    ↓
Next time keywords match → Solution auto-injects
```

Storage:

- **Project-level**: `.omg/skills/` (intended to be committed with the repo; uncommitted worktree-local skills disappear when that worktree is removed)
- **User-level**: `~/.claude/skills/omc-learned/` (portable)

#### 4. HUD Statusline (Real-Time Orchestration)

See what Claude is doing in the status bar:

```
[OMC] ralph:3/10 | US-002 | ultrawork skill:planner | ctx:67% | agents:2 | todos:2/5
```

Run `/oh-my-copilot:hud setup` to install. Presets: minimal, focused, full.

#### 5. Three-Tier Memory System

Critical knowledge survives context compaction:

```
<remember priority>API client at src/api/client.ts</remember>
    ↓
Permanently loaded on session start
    ↓
Never lost through compaction
```

Or use `/oh-my-copilot:note` to save discoveries manually:

```bash
/oh-my-copilot:note Project uses PostgreSQL with Prisma ORM
```

#### 6. Structured Task Tracking (PRD Support)

**Ralph Loop now uses Product Requirements Documents:**

```bash
/oh-my-copilot:ralph-init "implement OAuth with multiple providers"
    ↓
Auto-creates PRD with user stories
    ↓
Each story: description + acceptance criteria + pass/fail
    ↓
Ralph loops until ALL stories pass
```

#### 7. Intelligent Continuation

**Tasks complete before Claude stops:**

```
You: "Implement user dashboard"
    ↓
Claude: "I'm activating ralph-loop to ensure completion"
    ↓
Creates todo list, works through each item
    ↓
Only stops when EVERYTHING is verified complete
```

### Backward Compatibility Note

**Note**: v3.0 does not maintain backward compatibility with v2.x naming. You must complete the migration steps above for the new version to work correctly.

---

## v3.0 → v3.1: Notepad Wisdom & Enhanced Features

### Overview

Version 3.1 is a minor release adding powerful new features while maintaining full backward compatibility with v3.0.

### What's New

#### 1. Notepad Wisdom System

Plan-scoped wisdom capture for learnings, decisions, issues, and problems.

**Location:** `.omg/notepads/{plan-name}/`

| File           | Purpose                            |
| -------------- | ---------------------------------- |
| `learnings.md` | Technical discoveries and patterns |
| `decisions.md` | Architectural and design decisions |
| `issues.md`    | Known issues and workarounds       |
| `problems.md`  | Blockers and challenges            |

**API:**

- `initPlanNotepad()` - Initialize notepad for a plan
- `addLearning()` - Record technical discoveries
- `addDecision()` - Record architectural choices
- `addIssue()` - Record known issues
- `addProblem()` - Record blockers
- `getWisdomSummary()` - Get summary of all wisdom
- `readPlanWisdom()` - Read full wisdom for context

#### 2. Delegation Categories

Semantic task categorization that auto-maps to model tier, temperature, and thinking budget.

| Category             | Tier   | Temperature | Thinking | Use For                                         |
| -------------------- | ------ | ----------- | -------- | ----------------------------------------------- |
| `visual-engineering` | HIGH   | 0.7         | high     | UI/UX, frontend, design systems                 |
| `ultrabrain`         | HIGH   | 0.3         | max      | Complex reasoning, architecture, deep debugging |
| `artistry`           | MEDIUM | 0.9         | medium   | Creative solutions, brainstorming               |
| `quick`              | LOW    | 0.1         | low      | Simple lookups, basic operations                |
| `writing`            | MEDIUM | 0.5         | medium   | Documentation, technical writing                |

**Auto-detection:** Categories detect from prompt keywords automatically.

#### 3. Directory Diagnostics Tool

Project-level type checking via `lsp_diagnostics_directory` tool.

**Strategies:**

- `auto` (default) - Auto-selects best strategy, prefers tsc when tsconfig.json exists
- `tsc` - Fast, uses TypeScript compiler
- `lsp` - Fallback, iterates files via Language Server

**Usage:** Check entire project for errors before commits or after refactoring.

#### 4. Session Resume

Background agents can be resumed with full context via `resume-session` tool.

### Migration Steps

Version 3.1 is a drop-in upgrade. No migration required!

```bash
npm update -g oh-my-copilot
```

All existing configurations, plans, and workflows continue working unchanged.

### New Tools Available

Once upgraded, agents automatically gain access to:

- Notepad wisdom APIs (read/write wisdom during execution)
- Delegation categories (automatic categorization)
- Directory diagnostics (project-level type checking)
- Session resume (recover background agent state)

---

## v3.3.x → v3.4.0: Parallel Execution & Advanced Workflows

### Overview

Version 3.4.0 introduces powerful parallel execution modes and advanced workflow orchestration while maintaining full backward compatibility with v3.3.x.

### What's New

#### 1. Pipeline: Sequential Agent Chaining

Chain agents with data passing between stages:

```bash
/oh-my-copilot:pipeline explore:haiku -> architect:opus -> executor:sonnet
```

**Built-in Presets:**

- `review` - explore → architect → critic → executor
- `implement` - planner → executor → tdd-guide
- `debug` - explore → architect → debugger
- `research` - parallel(document-specialist, explore) → architect → writer
- `refactor` - explore → architect-medium → executor-high → qa-tester
- `security` - explore → security-reviewer → executor → security-reviewer-low

#### 4. Unified Cancel Command

Smart cancellation that auto-detects active mode:

```bash
/oh-my-copilot:cancel
# Or just say: "stop", "cancel", "abort"
```

**Auto-detects and cancels:** autopilot, ralph, ultrawork, pipeline (ultraqa is retired; stale pre-5.0.0 `ultraqa-state.json` is still cleared)

**Deprecation Notice:**
Individual cancel commands are deprecated but still work:

- `/oh-my-copilot:cancel-ralph` (deprecated)
- `/oh-my-copilot:cancel-ultraqa` (deprecated)
- `/oh-my-copilot:cancel-ultrawork` (deprecated)
- `/oh-my-copilot:cancel-autopilot` (deprecated)

Use `/oh-my-copilot:cancel` instead.

#### 6. Explore-High Agent

Opus-powered architectural search for complex codebase exploration:

```typescript
Task(
  (subagent_type = "oh-my-copilot:explore-high"),
  (model = "opus"),
  (prompt = "Find all authentication-related code patterns..."),
);
```

**Best for:** Architectural analysis, cross-cutting concerns, complex refactoring planning

#### 7. State Management Standardization

State files now use standardized paths:

**Standard paths:**

- Local: `.omg/state/{name}.json`
- Global: `~/.omg/state/{name}.json`

Legacy locations are auto-migrated on read.

#### 8. Keyword Conflict Resolution

When multiple execution mode keywords are present:

**Conflict Resolution Priority:**
| Priority | Condition | Result |
|----------|-----------|--------|
| 1 (highest) | Single explicit keyword | That mode wins |
| 2 | Generic "fast"/"parallel" only | Read from config (`defaultExecutionMode`) |
| 3 (lowest) | No config file | Default to `ultrawork` |

**Explicit mode keywords:** `ulw`, `ultrawork`
**Generic keywords:** `fast`, `parallel`

Users set their default mode preference via `/oh-my-copilot:omc-setup`.

### Migration Steps

Version 3.4.0 is a drop-in upgrade. No migration required!

```bash
npm update -g oh-my-copilot
```

All existing configurations, plans, and workflows continue working unchanged.

### New Configuration Options

#### Default Execution Mode

Set your preferred execution mode in `${COPILOT_HOME:-~/.copilot}/.omc-config.json`:

```json
{
  "defaultExecutionMode": "ultrawork"
}
```

When you use generic keywords like "fast" or "parallel" without explicit mode keywords, this setting determines which mode activates.

### Breaking Changes

None. All v3.3.x features and commands continue to work in v3.4.0.

### New Tools Available

Once upgraded, you automatically gain access to:

- Ultrapilot (parallel autopilot)
- Swarm coordination
- Pipeline workflows
- Unified cancel command
- Explore-high agent

### Best Practices for v3.4.0

#### When to Use Each Mode

| Scenario                | Recommended Mode | Why                                            |
| ----------------------- | ---------------- | ---------------------------------------------- |
| Multi-component systems | `team N:executor` | Parallel workers handle independent components |
| Many small fixes        | `team N:executor` | Atomic task claiming prevents duplicate work   |
| Sequential dependencies | `pipeline`        | Data passes between stages                     |
| Single complex task     | `autopilot`      | Full autonomous execution                      |
| Must complete           | `ralph`          | Persistence guarantee                          |

#### Keyword Usage

**Explicit mode control (v3.4.0):**

```bash
"ulw: fix all errors"           # ultrawork (explicit)
"fast: implement feature"       # reads defaultExecutionMode config
```

**Natural language (still works):**

```bash
"don't stop until done"         # ralph
"parallel execution"            # reads defaultExecutionMode
"build me a todo app"           # autopilot
```

### Verification

After upgrading, verify new features:

1. **Check CLI installation, if you use the npm CLI surface**:

   ```bash
   npm list -g oh-my-copilot
   ```

2. **Test unified cancel**:

   ```bash
   /oh-my-copilot:cancel
   ```

3. **Check state directory**:
   ```bash
   ls -la .omg/state/
   ```

---

## v3.x → v4.0: Major Architecture Overhaul

### Overview

Version 4.0 is a complete architectural redesign focusing on scalability, maintainability, and developer experience.

### What's Coming

⚠️ **This section is under active development as v4.0 is being built.**

#### Planned Changes

1. **Modular Architecture**
   - Plugin system for extensibility
   - Core/extension separation
   - Better dependency management

2. **Enhanced Agent System**
   - Improved agent lifecycle management
   - Better error recovery
   - Performance optimizations

3. **Improved Configuration**
   - Unified config schema
   - Better validation
   - Migration tooling

4. **Breaking Changes**
   - TBD based on development progress
   - Full migration guide will be provided

### Migration Path (Coming Soon)

Detailed migration instructions will be provided when v4.0 reaches release candidate status.

Expected timeline: Q1 2026

### Stay Updated

- Watch the [GitHub repository](https://github.com/RobinNorberg/oh-my-copilot) for announcements
- Check [CHANGELOG.md](../CHANGELOG.md) for detailed release notes
- Join discussions in GitHub Issues

---

## Common Scenarios Across Versions

### Scenario 1: Quick Implementation Task

**2.x Workflow:**

```
/oh-my-copilot:ultrawork "implement the todo list feature"
```

**3.0+ Workflow:**

```
"implement the todo list feature quickly"
    ↓
Claude: "I'm activating ultrawork for maximum parallelism"
```

**Result:** Same outcome, more natural interaction.

### Scenario 2: Complex Debugging

**2.x Workflow:**

```
/oh-my-copilot:ralph "debug the memory leak"
```

**3.0+ Workflow:**

```
"there's a memory leak in the worker process - don't stop until we fix it"
    ↓
Claude: "I'm activating ralph-loop to ensure completion"
```

**Result:** Ralph-loop with more context from your natural language.

### Scenario 3: Strategic Planning

**2.x Workflow:**

```
/oh-my-copilot:planner "design the new authentication system"
```

**3.0+ Workflow:**

```
"plan the new authentication system"
    ↓
Claude: "I'm starting a planning session"
    ↓
Interview begins automatically
```

**Result:** Planning interview triggered by natural language.

### Scenario 4: Stopping Work

**2.x Workflow:**

```
/oh-my-copilot:cancel-ralph
```

**3.0+ Workflow:**

```
"stop"
```

**Result:** Claude intelligently cancels the active operation.

---

## Configuration Options

### Project-Scoped Configuration (Recommended)

Apply oh-my-copilot to current project only:

```
/oh-my-copilot:omc-default
```

Creates: `./.claude/CLAUDE.md`

### Global Configuration

Apply to all Claude Code sessions:

```
/oh-my-copilot:omc-default-global
```

Creates: `~/.claude/CLAUDE.md`

**Precedence:** Project config overrides global if both exist.

---

## FAQ

**Q: Do I have to use keywords?**
A: No. Keywords are optional shortcuts. Claude auto-detects intent without them.

**Q: Will my old commands break?**
A: No. All commands continue to work across minor versions (3.0 → 3.1). Major version changes (3.x → 4.0) will provide migration paths.

**Q: What if I like explicit commands?**
A: Keep using them! `/oh-my-copilot:ralph`, `/oh-my-copilot:ultrawork`, and `/oh-my-copilot:plan` work. Note: `/oh-my-copilot:planner` now redirects to `/oh-my-copilot:plan`.

**Q: How do I know what Claude is doing?**
A: Claude announces major behaviors: "I'm activating ralph-loop..." or set up `/oh-my-copilot:hud` for real-time status.

**Q: Where's the full command list?**
A: See [README.md](../README.md) for full command reference. All commands still work.

**Q: What's the difference between keywords and natural language?**
A: Keywords are explicit shortcuts. Natural language triggers auto-detection. Both work.

---

## Need Help?

- **Diagnose issues**: Run `/oh-my-copilot:omc-doctor`
- **See all commands**: Run `/oh-my-copilot:omc-help`
- **View real-time status**: Run `/oh-my-copilot:hud setup`
- **Review detailed changelog**: See [CHANGELOG.md](../CHANGELOG.md)
- **Report bugs**: [GitHub Issues](https://github.com/Yeachan-Heo/oh-my-claudecode/issues)

---

## What's Next?

Now that you understand the migration:

1. **For immediate impact**: Start using keywords (`ralph`, `ulw`, `plan`) in your work
2. **For full power**: Read [docs/CLAUDE.md](CLAUDE.md) to understand orchestration
3. **For advanced usage**: Check [docs/ARCHITECTURE.md](ARCHITECTURE.md) for deep dives
4. **For team onboarding**: Share this guide with teammates

Welcome to oh-my-copilot!
