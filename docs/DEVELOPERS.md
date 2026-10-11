# Developers

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full developer guide.

## Headless smoke against a local build

`omg smoke copilot` loads a plugin root into the real GitHub Copilot CLI inside a throwaway `COPILOT_HOME` and reports one line per check. It replaces the manual "install the plugin and open Copilot" step. Build first: the MCP check spawns `dist/mcp/standalone-server.js`.

```bash
npm run build
omg smoke copilot --tier 0        # free: no model call
omg smoke copilot --tier 1        # costs one premium request
```

### The two tiers

- **Tier 0 is a free load check.** It verifies the manifest and version, the generated hooks and agents, `plugin list` and `skill list` as Copilot sees them, and the MCP server's tool count. Run it after every generator change.
- **Tier 1 adds one live session with the prompt on stdin.** It asserts the session exits cleanly, the session events log parses, our hooks fired, the plugin and MCP server loaded, and the hooks wrote state under `.omg/` in a temp project. Each run is one premium request capped by `--max-credits` (default 30, which is Copilot's minimum).

**Model.** `--model` is optional. Without it Copilot auto-selects a model; 1.0.91 picked `mai-code-1.1-flash`. Explicit ids may be rejected as unavailable for your account, and the `session.exit` detail then says to omit `--model`.

**Auth.** Tier 1 copies only the login identity from your real Copilot config, so a normal `copilot /login` is enough. Do not export a token for it. `GH_TOKEN` and `GITHUB_TOKEN` take precedence over a stored login, and a `gh` token is not entitled to Copilot models, so the smoke drops both from the session when it found a login. `COPILOT_GITHUB_TOKEN` is always passed through. Without a stored login, as in CI, all three pass through and one of them must hold a Copilot-entitled token.

**Hooks fail closed.** The session runs with `OMC_HOOK_FAIL_CLOSED=1`, so a crashing hook shows up as a failed `hooks.*` check instead of being swallowed by the hook adapter. The `hooks.adapter_errors` check also fails on any `[omg-hook]` error line in the debug log, session stderr, events, or stdout. With `OMC_HOOK_FAIL_CLOSED=1` a hook timeout in `scripts/run.cjs` also exits `124` instead of failing open.

**Sandbox.** The session denies `t(host_smoke)` so the model cannot recurse into the smoke, and passes `--disable-builtin-mcps`. The default prompt also denies `shell` and `write`; `--delegate` keeps them because the hand-off is a tool call. The env drops `OMC_*`, Claude Code host markers, `NODE_OPTIONS`, `COPILOT_MODEL`, `COPILOT_OFFLINE`, and `COPILOT_PROVIDER_*` before spawning Copilot.

Use `--keep-home` to keep the temp homes and project for debugging, and `--json` for the full report. The report's `artifacts.listHome` is the tier 0 home and `artifacts.copilotHome` is the tier 1 session home. `--json` always prints a report; a bad option yields `ok: false` with one `cli.error` check. Exit code `2` means the `copilot` binary was not found and nothing else failed. The binary resolves from PATH first, then `COPILOT_CLI_PATH`, then the WinGet install location on Windows. Set `COPILOT_CLI_PATH` when it is not on PATH; a `copilot` on PATH still wins.

### From vitest

`npm run test:live` runs `tests/live/copilot-smoke.test.ts`. Tier 0 runs whenever the binary resolves and skips otherwise. Tier 1 runs only with `OMC_LIVE_SMOKE=1`, so it never spends a request by accident. The free tier 2 static checks run whenever the binary and `@github/copilot-sdk` resolve. The tier 2 default scenarios run only with `OMC_LIVE_SMOKE=2`. The default `npm test` run and CI exclude `tests/live/**`.

### From Claude Code (MCP tool `host_smoke`)

The standalone MCP server exposes the same check as `host_smoke`. Register the local build once:

```bash
claude mcp add omg-dev -- node C:/Code/OMC/dist/mcp/standalone-server.js
```

Then ask Claude Code to call `host_smoke` with `{ "tier": 0 }`. It returns the report JSON and sets `isError` when any check fails. Rebuild after source changes, because the server runs from `dist/`.

The tool is also reachable from inside Copilot through the plugin's own MCP server, so it is fenced. Two env vars on the MCP server lift the fences:

- **`OMC_SMOKE_ALLOW_LIVE=1`** allows `{ "tier": 1 }` and tier 2 with scenarios. Without it the tool refuses both, because they are billed sessions. `{ "tier": 2, "scenarios": [] }` runs the free SDK static checks and needs no opt-in.
- **`OMC_SMOKE_ALLOW_ANY_ROOT=1`** allows a `pluginRoot` other than the package root the server runs from. Paths are compared after resolving symlinks.

```bash
claude mcp add omg-dev -e OMC_SMOKE_ALLOW_LIVE=1 -- node C:/Code/OMC/dist/mcp/standalone-server.js
```

The `omg smoke copilot` CLI has no such gate.

### Tier 2 — SDK scenarios

Tier 2 drives Copilot through `@github/copilot-sdk` instead of `copilot -p`. The SDK sees the full event stream and the runtime's own plugin, skill, agent, and MCP lists, so it can assert behaviour that tier 1 cannot: a guardrail deny, a skill invocation, a delegation.

```bash
npm i -g @github/copilot-sdk --omit=optional --ignore-scripts
omg smoke copilot --sdk-static                # free: SDK static checks, no model call
omg smoke copilot --tier 2                    # smoke + guardrail, about 2 premium requests (1 per scenario)
omg smoke copilot --tier 2 --scenario all     # adds skill + delegate
omg smoke copilot --tier 2 --scenario chain   # opt-in: real two-link factory chain, about 2 premium requests
omg smoke copilot --tier 2 --scenario team    # opt-in: real 2-worker sdk team, about 2 premium requests
```

**Install.** The SDK is an optional peer dependency, so `npm i -g oh-my-copilot` never installs it. Install it next to `omg` with the command above. `--ignore-scripts` is required on Windows with `--omit=optional`, because koffi's install script otherwise falls back to a source build that needs CMake. Without the SDK every `sdk.*` check fails with that install hint and the run exits `2`.

**Bundled runtime.** A global install can still pull the SDK's platform runtime, about 128 MB, despite `--omit=optional`. It lands nested at `<npm root -g>/@github/copilot-sdk/node_modules/@github/copilot-sdk-<platform>`. Delete that folder if it appears; tier 2 never uses it. The lean alternative is a project-local install in the plugin root, which the spike measured at 11 MB:

```bash
npm i --no-save --omit=optional --ignore-scripts @github/copilot-sdk
```

**Installed-exe policy.** Tier 2 always connects the SDK to the installed `copilot` binary, resolved exactly as for tier 0 and 1. It never uses the SDK's bundled runtime, because the installed CLI is what users run and plugin loading differs between the two. `sdk.runtime` checks that the runtime reports the tier 0 binary version and protocol 3 or later.

**Scenarios.** `smoke` and `guardrail` are the default; `--scenario` takes a comma-separated list or `all`. Each scenario runs in its own session in a temp git repo with an isolated `COPILOT_HOME`, a per-scenario timeout, and its full event stream kept as `artifacts.events.<name>`. `scn.<name>.cost` reports premium requests and credits. `chain` is the exception: it is opt-in (never in `all`), uses no SDK session, and spawns two real `copilot -p` factory links that hand off through `OMC_CHAIN_LINK` and the SessionEnd worker (see [REFERENCE.md](./REFERENCE.md#factory-chains-on-copilot)). Its links run without `--max-ai-credits`, so `--max-credits` does not bound them, and a link-2 process still running after the timeout is not killed.

**The `team` scenario.** Also opt-in and outside `all`. It runs the plugin's own `bridge/cli.cjs` as child processes, so it proves the default transport end to end:

1. `omg team 2:copilot --json "<two numbered tasks>"` in the sandbox repo with no `--transport`, `COPILOT_CLI=1` and detached worker worktrees. Each sdk host is capped at half of the run's remaining credits.
2. `omg team status --json` is polled until both tasks settle. Then `omg team api list-tasks` and each worker worktree's commits are read.
3. `omg team shutdown`, while each worker's `sdk-session.json` is polled for the final `session.shutdown` totals.

Its checks: `scn.team.started` (exit 0, transport `sdk`, the host launch time), `completed` (both tasks completed, one per worker), `committed` (each owner committed its task's file in its own worktree), `status` (2 sdk workers alive with host pid and session id, tasks 2/2), `shutdown` (exit 0 without `--force`, no host or runtime pid left, instance reservation released, team state gone), `retained` (each worker's committed HEAD survives the shutdown, merged into the leader HEAD or kept in a worktree that `omg team status --json` lists under `preserved_worktrees`), `duration` (start to closeout within 300 s or `--timeout`, whichever is larger), and `premium` (1 to 2 premium requests). Worker runtime logs are copied into the smoke home before shutdown, so `scn.team.adapter_errors` covers them. `team` runs after the SDK scenarios and before `chain`. Set `OMC_TEAM_SDK_LAUNCH_CONCURRENCY=1` in the smoke's environment to measure the serial launch path.

**Credit cap.** `--max-credits` (default and minimum 30) caps the whole tier 2 run. The runtime gets `--max-ai-credits` with the same value; the headless runtime accepts and validates the flag (CLI 1.0.91), but whether it enforces it on SDK sessions is unverified. The smoke therefore enforces the cap itself: it sums `assistant.usage` credits per scenario, aborts the scenario that passes what is left (`scn.<name>.exit` and `.cost` fail), and reports the remaining scenarios as `skipped: credit cap reached`.

**No billing from unit tests.** Under vitest (`VITEST` or `NODE_ENV=test`) `runCopilotSmoke` refuses any run that would call a model, with one `cli.guard` check and no spawn, unless `OMC_LIVE_SMOKE=1` (tier 1) or `OMC_LIVE_SMOKE=2` (tier 2 scenarios) is set or the test injects the seam that would bill (`deps.spawn` at tier 1, `deps.loadSdk` at tier 2). `--sdk-static` is never refused.

**Runtime teardown.** After `client.stop()` the smoke checks whether the runtime pid is still alive and kills its process tree. A scenario that does not go idle even after `abort()` marks the runtime wedged: the remaining scenarios are skipped and the tree is killed before `stop()`, so hook and MCP children are not orphaned. On POSIX the SDK does not start the runtime as a process-group leader, so the kill reaches the runtime itself but not always its children.

**Quirks verified on SDK 1.0.16 with Copilot CLI 1.0.91.**

- **`sessionStart` is lazy.** It fires after the first `userPromptSubmitted`, not at session creation.
- **`sessionEnd` fires after every turn.** In SDK and headless mode OMC's SessionEnd hooks therefore run per turn, also on abort.
- **Skill name differs from its path.** `skill.invoked` reports the frontmatter name, such as `omc-plan`, not `oh-my-copilot:plan`. Assert on `path` ending in `skills/plan/SKILL.md` and on `pluginName`.
- **MCP tool names are `<server>-<tool>`.** Excluding `t-host_smoke` works; `t:host_smoke` and `t(host_smoke)` match nothing in `excludedTools`. The smoke takes the server name from the first `.mcp.json` key, and `sdk.tools_excluded` proves the exclusion against `session.rpc.tools.getCurrentMetadata` without a model call.
- **Env is per client, not per session.** Hook processes inherit the runtime's env, so a scenario that needs a different env, such as `OMC_GIT_GUARDRAILS=1`, needs its own client.
- **Hook stderr is only in the debug log.** It appears in `COPILOT_HOME/logs/*.log` as `[hook stderr]` lines and only at log level `debug`. `scn.<name>.adapter_errors` reads that log for `[omg-hook]` lines from the adapter and `[run.cjs]` lines from the hook runner, such as a hook timeout. Lines are attributed to a scenario by their timestamp, so a late SessionEnd line lands in the scenario that caused it.
- **Windows npm shim.** The SDK spawns the runtime without a shell, so a `copilot.cmd` or `.ps1` shim is resolved to the `.js` or `.exe` it launches. If that fails, every `sdk.*` and `scn.*` check fails with a hint to pass `--copilot-bin`.

### Tier 2 in CI

The `smoke` job in `.github/workflows/ci.yml` runs the smoke on `ubuntu-latest` against the real Copilot CLI, so every PR and tag is checked on Linux and not only on a maintainer's machine.

- **Every run after `Build`** (PRs, pushes to `main` and `dev`, manual runs): `omg smoke copilot --tier 2 --sdk-static`. Zero model calls, zero premium requests.
- **Pushed `v*` tags** additionally run `omg smoke copilot --tier 2`, the default scenarios `smoke` and `guardrail`. That costs about 2 premium requests per tag, capped by the default `--max-credits 30`.
- **The release job does not wait for it.** On a tag both jobs run in parallel; check the smoke result before announcing a release. The job is not a required check yet.

**Install.** The job runs `npm i -g @github/copilot`, the CLI's documented npm install. Its `copilot` bin is a node loader that runs the native binary from the `@github/copilot-linux-x64` optional dependency. The SDK is installed with `npm i -g @github/copilot-sdk --omit=optional --ignore-scripts`, so its bundled runtime is never downloaded; the installed-exe policy above applies unchanged. The job builds first, because a PR branch need not carry rebuilt bundles.

**Secret.** Add a repository secret named `COPILOT_GITHUB_TOKEN` under Settings, Secrets and variables, Actions. Its value is a fine-grained personal access token of a user with an active Copilot subscription, with the account permission "Copilot Requests" (see "Authenticate with a Personal Access Token" in the `@github/copilot` README). Create it at <https://github.com/settings/personal-access-tokens/new>. It needs no repository permissions. Premium requests are billed to that user.

**Static checks need the token too.** A fresh `COPILOT_HOME` has no login, and without auth the runtime skips loading custom agents, so `sdk.agents` would fail. The whole job is therefore gated on the secret.

**No secret, no failure.** The first step reads the secret into a step env and sets an output; every later step is conditioned on it. Without the secret the job passes with the notice `Copilot smoke skipped`. GitHub never passes secrets to PRs from forks or to Dependabot runs, so those always skip.

**Isolation.** The job points the outer `COPILOT_HOME` at an empty dir and `TMPDIR` at a dir under the runner temp. With no stored login, the smoke passes `COPILOT_GITHUB_TOKEN` through to every copilot child, as described under Auth above. The token only ever appears as step env, never on a command line or in a printed string. Hooks of the branch under test run with the token in their env, as any same-repo PR workflow with secrets does.

**Artifacts.** Each run with the secret uploads `copilot-smoke-<run id>-<attempt>`: `reports/static.json`, `reports/scenarios.json` on tags, their stderr, and the `--keep-home` homes with debug logs and event streams. Before the upload a step scans every file, binaries included, for token shapes (`gho_`, `ghu_`, `ghp_`, `ghs_`, `ghr_`, `github_pat_`) and for the exact secret value. A hit deletes the directory, fails the job, and skips the upload. `tests/lint/copilot-smoke-ci-workflow.test.ts` pins this layout.

### Copilot CLI facts the smoke relies on

These were verified against Copilot CLI 1.0.91.

- **Free load checks.** `copilot --plugin-dir <root> plugin list --json` and `copilot --plugin-dir <root> skill list --json` make no model call and reflect `--plugin-dir`.
- **A bad `--plugin-dir` only warns.** The command still succeeds and `plugin list` returns `[]`, so assert on the exact entry, never on the exit code.
- **Manifest locations.** Copilot accepts the plugin manifest at `plugin.json`, `.github/plugin/plugin.json`, or `.claude-plugin/plugin.json` under the root.
- **`plugin install` takes no local path.** Use `--plugin-dir` to load a working tree.
- **An isolated `COPILOT_HOME` needs a token.** A fresh home has no stored login, so pass a token through the environment for any model call.
- **Trusted folders are camelCase.** Write `trustedFolders` in `$COPILOT_HOME/config.json` so `-p` runs in the temp project without a trust prompt.
- **No `installed_plugins.json`.** Installed plugins live under `~/.copilot/installed-plugins/`.

## Copilot CLI hook events

`copilot/hooks.json` keeps the upstream PascalCase event names. Copilot CLI accepts PascalCase names alongside its own camelCase names (changelog 1.0.6) and sends PascalCase hooks Claude-style snake_case payloads (changelog 1.0.21). The table below was audited against Copilot CLI 1.0.91 and `@github/copilot-sdk` 1.0.16.

| Copilot event | Name in `copilot/hooks.json` | Fork hook scripts | Upstream Claude hook | Status |
|---|---|---|---|---|
| `sessionStart` | `SessionStart` | session-start, project-memory-session, wiki-session-start, stale-run-reporter, runs-reconciler | `SessionStart` | mapped; the `init` and `maintenance` matcher groups are [not projected](./HOOKS.md#not-projected) |
| `sessionEnd` | `SessionEnd` | session-end, wiki-session-end | `SessionEnd` | mapped |
| `userPromptSubmitted` | `UserPromptSubmit` | keyword-detector, skill-injector | `UserPromptSubmit` | mapped |
| `preToolUse` | `PreToolUse` | pre-tool-enforcer, git-guardrails (`Bash`) | `PreToolUse` | mapped |
| `permissionRequest` | `PermissionRequest` | permission-handler (`Bash`) | `PermissionRequest` | mapped |
| `postToolUse` | `PostToolUse` | post-tool-verifier, project-memory-posttool, post-tool-rules-injector, post-tool-directory-context-injector | `PostToolUse` | mapped |
| `postToolUseFailure` | `PostToolUseFailure` | post-tool-use-failure | `PostToolUseFailure` | mapped |
| `subagentStart` | `SubagentStart` | subagent-tracker start | `SubagentStart` | mapped |
| `subagentStop` | `SubagentStop` | subagent-tracker stop, verify-deliverables | `SubagentStop` | mapped |
| `preCompact` | `PreCompact` | pre-compact, project-memory-precompact, wiki-pre-compact | `PreCompact` | mapped |
| `agentStop` | `Stop` | context-guard-stop, workflow-drift-guard, persistent-mode, budget-guard, code-simplifier | `Stop` | mapped |
| `notification` | none | none | none in upstream `hooks/hooks.json` (Claude Code has `Notification`, upstream registers no hook for it) | unmapped, no upstream hook |
| `errorOccurred` | none | none | none | unmapped, no equivalent |
| `preMcpToolCall` | none | none | none (`PreToolUse` already sees MCP tools) | unmapped, no equivalent |
| `userPromptTransformed` | none | none | none | unmapped, no equivalent |
| `postResult` | not file-configurable | none | none | unmapped, no equivalent; SDK protocol enum only |
| `prePRDescription` | not file-configurable | none | none | unmapped, no equivalent; SDK protocol enum only |

Every upstream event is projected, so the generator has nothing to add. A new upstream event fails `build-hooks.mjs` only when its command form is unknown; check this table whenever upstream adds an event to `hooks/hooks.json`.

**Evidence.** All paths are inside the CLI package, `%LOCALAPPDATA%\copilot\pkg\win32-x64\1.0.91\` on Windows.

- **File-configurable events.** The native runtime `prebuilds/win32-x64/runtime.node` embeds the settings schema with one `hooks.<event>` entry for each of the 15 events from `sessionStart` to `notification` (byte offsets 84058812 to 84060097). `postResult` and `prePRDescription` have no entry.
- **Protocol enum.** `schemas/api.schema.json:24048` defines `HookType` with all 17 events and says discovery emits the file-configurable subset. The SDK's `dist/generated/rpc.d.ts:1627` has the same 17-member union.
- **PascalCase aliases.** The runtime holds the literal fragments `PermissionReques`, `PostToolUseFailu` and `UserPromptSubmit` together (offset 84618512) and `PreCompact` next to the hook prompt validation strings (offset 85766538). Shorter names compile to immediates and are not greppable. On a real machine with only camelCase `preToolUse`/`postToolUse` personal hooks, the plugin's PascalCase hooks produced `hook.start` events of type `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `agentStop`, `subagentStart` and `subagentStop` in `~/.copilot/session-state/*/events.jsonl`. `preCompact`, `permissionRequest` and `postToolUseFailure` were not observed firing there.

**CLI and SDK differ.** The SDK's `SessionHooks` interface (`dist/types.d.ts:1372`) and its dispatch table (`dist/session.js:1630`) cover only 10 events: `preToolUse`, `preMcpToolCall`, `postToolUse`, `postToolUseFailure`, `userPromptSubmitted`, `userPromptTransformed`, `sessionStart`, `sessionEnd`, `errorOccurred` and `agentStop`. The CLI's file hooks additionally support `subagentStart`, `subagentStop`, `preCompact`, `permissionRequest` and `notification`. An SDK session handles permissions through the separate `onPermissionRequest` handler (`dist/types.d.ts:2112`), not a hook. OMC registers no SDK callback hooks; SDK sessions, such as tier 2 and SDK team workers, run the plugin's file hooks from `copilot/hooks.json`.

## Copilot hooks: per-event dispatcher

Copilot starts one `node` process per entry of `copilot/hooks.json`. The generator (`scripts/copilot/build-hooks.mjs`) therefore emits one entry per `(event, matcher)` group of `hooks/hooks.json`, and that entry runs `scripts/copilot/dispatch.cjs`:

```text
node --require <root>/scripts/lib/copilot-hook-adapter.cjs <root>/scripts/copilot/dispatch.cjs \
     <Event> <script> [args]... [-- <script> [args]...]...
```

The dispatcher reads stdin once and runs the group's hooks in order through `runResolvedHook()` in `scripts/run.cjs`. That is the same routing as a direct `run.cjs <script>` call, with the same manifest timeout per hook: a Worker for the audited hooks, and the supervised child for entries with a budget of 3 s or less. It applies the adapter's `transform()` to each hook's own stdout and exit code, then merges:

- **Context.** `additionalContext` and `systemMessage` are joined with `\n` in hook order, at top level and inside `hookSpecificOutput`.
- **PreToolUse.** Any `deny` wins, with the first deny reason.
- **Stop and SubagentStop.** A `decision: "block"` from any hook survives, and every hook still runs. Several blocks join their reasons with `\n\n` in hook order. A block beats another hook's `continue: false`, which is dropped with its `stopReason` and an `[omg-hook]` stderr line. The adapter's `continue: false` + block rule applies only inside one hook's own output.
- **Failures.** A hook whose run throws or rejects is that hook's failure, with an `[omg-hook]` line and exit `1` under fail-closed, and the other hooks keep their output. A timed-out hook contributes no stdout on either runner path.
- **Everything else.** Without a block, `continue: false` wins with its `stopReason`. `suppressOutput: true` survives only when every output sets it. Any other key keeps the first hook's value. Non-JSON stdout next to JSON output is dropped with an `[omg-hook]` stderr line. A group with one non-empty output passes it through byte for byte.
- **Exit code.** Under `OMC_HOOK_FAIL_CLOSED=1` it is `124` if any hook timed out, else the highest per-hook code. Otherwise `transform()` has already mapped every failure to `0` with one `[omg-hook]` line per hook, except PermissionRequest exit `2`, which is kept.

`hooks/hooks.json` is untouched, and Claude Code never runs the dispatcher.

**Kill switch.** `OMC_COPILOT_HOOK_DISPATCH=0` makes the dispatcher run each hook as its own `node --require <adapter> run.cjs <script>` process, one after another, which is the pre-dispatcher path, and merge their outputs with the same rules. Each process gets its manifest timeout plus 2 s, capped at what is left of the group's summed timeouts (the entry's `timeoutSec`); past that, `reapTree()` from `run.cjs` kills its process tree. Set it in the environment Copilot runs in to compare both paths live without regenerating `copilot/hooks.json`. `OMC_DEBUG_HOOKS=1` prints one `[omg-hook] <Event> dispatch: <script> <ms>ms exit <code>` stderr line per hook.

**Tests.** `src/__tests__/copilot-hook-dispatch.test.ts` pins the argv round trip, the merge rules per event, the exit-code precedence, per-hook isolation, timed-out stdout discard, the kill switch and its outer-timer cap, and parity with the per-hook path for the real Stop and SessionStart hooks: the same stdout, and the same state files with the same contents once timestamps and pids are scrubbed. Latency numbers are in [HOOKS.md](./HOOKS.md#per-event-dispatcher).

## Copilot hooks: warm daemon (opt-in)

`scripts/copilot/hook-daemon.cjs` is an opt-in, long-lived Node process that runs a dispatcher group instead of the hook entry's own process. It is **off by default**. `OMC_COPILOT_HOOK_DAEMON=1` in the environment Copilot runs in turns it on, and `0` or unset keeps it off. `OMC_COPILOT_HOOK_DISPATCH=0` also turns it off. No regeneration of `copilot/hooks.json` is needed.

**What it saves, and what it does not.** The Copilot hook entry still starts `node` for every event; the generated command is unchanged. The daemon saves only what the entry's own process would spend after start-up: loading `run.cjs`, the first Worker in the process, and a cold JIT. Most hook time is the hooks' own work, and most of that is two `git rev-parse` spawns per hook (`resolveToWorktreeRoot`). A daemon cannot share that work without caching results across hooks, which would change what they see, so it does not. See the numbers below before turning it on.

**Request path.** `dispatch.cjs` reads stdin, then calls `runViaDaemon()`:

1. **Eligibility.** Every hook of the group must be in `DAEMON_SAFE_HOOKS` (see [Daemon safety](#daemon-safety)) and be `<CLAUDE_PLUGIN_ROOT>/scripts/<name>` of this plugin after resolving symlinks. Otherwise the group runs cold without touching the daemon.
2. **Key.** One daemon per key: plugin root, package version, size and mtime of the main-thread modules (`dispatch.cjs`, `run.cjs`, the adapter, `hook-daemon.cjs`), node binary and version, the entry's parent pid (the host), and the cwd. An in-place edit or a version bump gets a new daemon.
3. **Files.** `<COPILOT_HOME or ~/.copilot>/.omg/state/hook-daemon/<key>.json|.lock|.sock`. The directory is created `0700`; on POSIX a directory another user owns or others can enter is refused. The metadata file (`0600`, written by rename) holds the pid, version, code fingerprint, endpoint and a 32-byte random token.
4. **Transport.** A Windows named pipe `\\.\pipe\omg-hookd-<key>-<random>`, or the unix socket `<key>.sock` in that directory (`0600`). A socket path over 100 bytes keeps the daemon off. Each request is one connection with three newline-delimited JSON lines: the request (token, version, code fingerprint, event, hooks, base64 payload, env, cwd, parent pid), an accept with the group budget, and the result.
5. **No daemon.** The client starts one detached (`stdio: 'ignore'`, `windowsHide`, cwd = the state directory) and runs this group cold. It never waits for the daemon. A live lock or a start in the last 10 s suppresses another start.

The client returns `null`, and the dispatcher runs the group in its own process, on every problem: no or stale metadata, a refused connection, a wrong token, a version or code mismatch, `busy`, a protocol error, a dropped connection, a connect timeout (300 ms), an accept timeout (1 s), or no result within the group budget plus 3 s. The cold path is the same code that runs without the daemon, so the verdict cannot change. One consequence: when the connection drops while the daemon is running hooks, the hooks that already ran there run again cold.

**Inside the daemon.** For each request it sets `process.env` (in place, so Windows keeps its case-insensitive env) to the entry's env, `chdir`s to the entry's cwd, sets `process.ppid` to the entry's parent, and captures its own `process.stdout`/`process.stderr` writes, such as the `run.cjs` timeout diagnostics. Then it calls the same `dispatch()` as the cold path, so every hook keeps its Worker or supervised-child routing, its manifest timeout, `OMC_SESSION_OWNER_PID`, its extra arguments, every merge rule and the exit code. Hook code never runs on the daemon's main thread: each hook gets a fresh Worker or child process, exactly as cold. The result is the stdout the cold dispatcher would print, the stderr it would print in the same order, and its exit code; the client writes them once, as the dispatcher does. Requests run one at a time; a concurrent one is refused as `busy` and runs cold with its own env.

**Lifecycle.**

- **Idle.** It exits after `OMC_COPILOT_HOOK_DAEMON_IDLE_MS` without a request (default 600000, 10 min; 500 to 86400000).
- **Host gone.** It polls the host pid every 2 s and exits when it is gone. Copilot fires `SessionEnd` after every turn, so the session's end is the host's exit.
- **Retire after an abnormal request.** It exits right after replying when a hook timed out, threw, or exited other than `0` or `2`, or the entry hung up early. A killed hook may leave an open fd or a half-written file; the daemon's pid then dies as soon as the cold dispatcher's would have. It also exits after 1000 requests.
- **One per key.** `<key>.lock` is created with `O_EXCL` (pid and nonce) and touched every 15 s. A second daemon for a live lock exits at once. A lock whose owner pid is dead, or that nobody touched for 60 s (pid reuse), is moved aside and reclaimed; a reclaim that lost a race puts the lock back and exits.
- **Cleanup.** On exit it removes its metadata, lock and socket when they are still its own. After a hard kill they stay; the next entry's connect fails, it runs cold, and the next daemon reclaims the lock.
- **No orphans and no host pipes.** The daemon starts `detached`, so on Windows it is outside the entry's kill-on-close job, with stdio ignored. Node does not let a child inherit its stdio handles, so the daemon never holds the entry's stdout or stderr, and Copilot sees the entry close as soon as it exits. Hook children are reaped by `run.cjs` exactly as on the cold path.

**Security.** Only the user can read the token, and on POSIX only the user can reach the socket. A request without the token is refused. Named pipes on Windows are enumerable by other users, but the default pipe DACL does not let them write, and the pipe name is random per daemon. The env sent to the daemon is the env the entry already has.

### Daemon safety

A hook may run in the daemon only when it behaves the same in a process that outlives the event. Each hook's whole module closure (static imports, literal dynamic imports, `dist/` modules) was checked for:

- **pid-liveness locks.** A lock whose staleness test is "the owner pid is dead": `scripts/lib/state-lock.mjs`, `scripts/lib/atomic-write.mjs`, `dist/lib/file-lock.js`, the `dist/notifications` session registry, and the pid lock files in `skill-injector.mjs` and `post-tool-use-failure.mjs`. In a daemon the owner pid stays alive, so a lock a killed hook left behind would block the next hooks instead of being reclaimed.
- **`process.ppid`.** A Worker's `process.ppid` is the daemon's parent, not the host.
- **process lifetime.** `isMainThread` gating, exit or signal handlers in the host process, async non-detached children (they die with the process that started them on Windows), stdio inheritance.

`dist/lib/worktree-paths.js` `getProcessSessionId()` uses `process.pid` only in an id that is fresh per Worker, so it does not count. `DAEMON_SAFE_HOOKS` in `hook-daemon.cjs` holds the `yes` rows; `src/__tests__/copilot-hook-daemon.test.ts` fails when this table and the list differ, or when a Copilot hook is missing here.

| Script | Daemon-safe | Why |
|---|---|---|
| `budget-guard.mjs` | yes | stdin, state root, enforcement log; no lock. |
| `code-simplifier.mjs` | yes | Sync git probes; the Jev shadow child is detached on Windows. |
| `context-guard-stop.mjs` | yes | Sync git probes, transcript read. |
| `git-guardrails.mjs` | yes | stdin, state root. |
| `keyword-detector.mjs` | no | `state-lock.mjs` and `atomic-write.mjs` locks. |
| `permission-handler.mjs` | yes | `dist/hooks/permission-handler`; no lock. |
| `persistent-mode.mjs` | no | `state-lock.mjs` and `atomic-write.mjs` locks, session registry. |
| `post-tool-directory-context-injector.mjs` | yes | `dist/hooks/directory-readme-injector`; no lock. |
| `post-tool-rules-injector.mjs` | yes | `dist/hooks/rules-injector`; no lock. |
| `post-tool-use-failure.mjs` | no | pid lock file, `state-lock.mjs`. |
| `post-tool-verifier.mjs` | no | Imports the package index (`dist/index.js`), about 470 modules including `state-lock.mjs`, `file-lock.js` and the job-state database. |
| `pre-compact.mjs` | no | `dist/lib/file-lock.js`, mode-state database. |
| `pre-tool-enforcer.mjs` | yes | Except a payload naming the `AskUserQuestion` tool: that branch imports `dist/notifications` and its session registry lock, so the client sends it cold. |
| `project-memory-posttool.mjs` | no | `dist/lib/file-lock.js`. |
| `project-memory-precompact.mjs` | no | `dist/lib/file-lock.js`. |
| `project-memory-session.mjs` | no | `dist/lib/file-lock.js`. |
| `runs-reconciler.mjs` | yes | stdin, state root. |
| `session-end.mjs` | no | `isMainThread` gating, the SessionEnd worker and its children, `file-lock.js`. |
| `session-start.mjs` | no | Cache-occupancy records keyed by `process.pid`, a `process.ppid` fallback, background children. |
| `skill-injector.mjs` | no | pid lock file, `state-lock.mjs`. |
| `stale-run-reporter.mjs` | yes | Reads run records; never signals a process. |
| `subagent-tracker.mjs` | no | `dist/lib/file-lock.js`. |
| `verify-deliverables.mjs` | yes | stdin, state root. |
| `wiki-pre-compact.mjs` | no | `dist/lib/file-lock.js`. |
| `wiki-session-end.mjs` | no | As `session-end.mjs`. |
| `wiki-session-start.mjs` | no | `dist/lib/file-lock.js`. |
| `workflow-drift-guard.mjs` | yes | stdin only. |

A group runs in the daemon only when every hook in it is `yes`. With today's `copilot/hooks.json` that is both PreToolUse entries and PermissionRequest; Stop, SessionStart, PostToolUse, PreCompact, SubagentStart, SubagentStop, UserPromptSubmit and SessionEnd each contain at least one `no` hook and stay cold. Before you add a script to the list, repeat the audit for its whole closure, and add a payload guard when only one branch is unsafe.

**Tests.** `src/__tests__/copilot-hook-daemon.test.ts` runs the same group and payload cold and through a running daemon in a self-contained probe plugin, and requires the same exit code, stdout, stderr, hook order, cwd and owner pid, with the Worker hooks shown to run in the daemon. It covers the Stop merge rules, non-JSON stdout, fail-open and fail-closed exit codes, a timed-out supervised child (124) and a timed-out Worker, PreToolUse deny, PermissionRequest exit 2 and extra hook arguments. It breaks the daemon in each way listed above and requires the cold verdict. It pins the idle exit, the host-gone exit, retire after an abnormal request, one daemon per key, stale-lock reclaim, and that the entry closes as soon as it exits. It also runs every daemon-eligible group of the real `copilot/hooks.json` cold and warm in fresh projects and requires the same output and state files.

## Upstream drift bot

`.github/workflows/upstream-drift.yml` notices new upstream oh-my-claudecode `dev` commits and does the mechanical first step of a port. Conflict resolution, the `package.json` delta, generators, build, inventory, tests, and release stay with a human or agent (`.omc/skills/port-and-release-cycle.md`).

**Schedule.** It runs daily at 05:23 UTC and on demand from the Actions tab (`workflow_dispatch`). GitHub runs `schedule` only from the default branch, `main`. The daily run therefore starts once the workflow reaches `main` with the next release. Until then, dispatch it on `dev` by hand.

**What it does.** When upstream `dev` is past the recorded sha, the bot branches `port/bot-<short sha>` from `dev` and runs `scripts/port/upstream-drift.mjs --apply`. Then one of two things happens:

- **Clean apply.** The bot commits `port: upstream <from>..<to> (bot)` and opens a draft PR to `dev` labelled `upstream-port`. The PR body lists the commits, files, the `package.json` delta, and the leak scan.
- **Conflicts.** The bot opens an issue `Upstream drift: N commits since <from>, conflicts in M files` with the conflict list and the commit list, labelled `upstream-port`.

**One item per upstream head.** The upstream head sha is a hidden marker in each body. A rerun for the same head updates the open issue, or turns it into a PR when the range now applies cleanly. An open or merged PR for that head means the bot does nothing. So does a PR or issue for that head that a maintainer closed; reopen it to bring it back. When a newer head arrives, the bot opens a new branch and item, then closes the older one with a comment starting `upstream-drift: superseded by`. That comment is how a later run tells a bot close from a maintainer's. A bot PR that has more than the bot's single commit stays open, because someone is working on it. Once `dev` has caught up with upstream, every open bot item is closed. The bot never force-pushes. If its branch already exists without a PR, it opens the PR from that branch without pushing, and the PR body names the commit on that branch and whether it matches this run's apply.

**`keep` label.** Add the `keep` label to a bot PR or issue to pin it. The bot never closes an item with that label, even when a newer upstream head supersedes it or `dev` has caught up.

**Marker file.** `.github/upstream-port.json` is the tracked record of the last ported upstream commit:

```json
{ "upstream_sha": "<full sha>", "upstream_branch": "dev", "ported_at": "YYYY-MM-DD", "fork_version": "X.Y.Z" }
```

The script reads it from `HEAD` as the default base. Every port commit updates it, whether the bot or a human made the port. The bot writes `fork_version: "unreleased"`, and the release bump sets the version that ships the port.

**Token.** Pushes and PRs made with `GITHUB_TOKEN` do not trigger other workflows, so CI does not run on a bot PR. Add the optional repository secret `UPSTREAM_DRIFT_TOKEN` to fix that. It must be a fine-grained personal access token on this repository with read/write access to Contents, Pull requests, and Issues. Without it the bot uses `GITHUB_TOKEN`, prints a warning, and adds a note to the PR body. Closing and reopening the PR then starts CI. The `GITHUB_TOKEN` path also needs the setting "Allow GitHub Actions to create and approve pull requests" under Settings, Actions, General. The permissions block asks only for `contents`, `pull-requests`, and `issues` write. `tests/lint/upstream-drift-workflow.test.ts` pins the workflow shape.

**What the script applies.** It follows the range diff in `.omc/skills/port-upstream.md`:

- **Excluded paths.** `dist`, `bridge`, `inventory`, `package.json`, `package-lock.json`, `CHANGELOG.md`, `README.md`, `.github/release-body.md`, and `.github/generated-artifact-authorizations.json` are never applied.
- **Dropped and skipped paths.** `.github/RELEASE_SIGNOFF` is dropped. Upstream `.github/workflows/` and `.github/actions/` changes are listed in the report but never applied, because upstream CI is not ported and a `GITHUB_TOKEN` push cannot change workflow files.
- **Fork-diverged files.** A file deleted upstream that the fork changed is kept and reported as `UD`. An upstream change to a file the fork removed is reported as `DU`. An upstream new file that differs from the fork's copy gets conflict markers and is reported as `AA`.
- **Rename map.** The mechanical part of the map runs only on lines the port introduced, so text the fork keeps on purpose stays. Examples are upstream issue links and the legacy corpus. DO-NOT-RENAME tokens and the per-file `CLAUDE_CONFIG_DIR` exceptions are honoured. Some paths are applied verbatim and never renamed: `.omc/`, `receipts/`, the content-addressed legacy corpus `src/installer/legacy-claude-md-corpus.ts`, and its fixture `src/installer/__tests__/fixtures/legacy-guides.json`. Symlinks, gitlinks, binary files, and non-UTF-8 files are applied byte-exact and skipped by the rename pass. The `omc` CLI prose, the `.claude/` host directory, and `OMC_CLI_BINARY` need judgement, so the script leaves them to the reviewer.
- **Leak scan.** It lists new `oh-my-claudecode` lines in `src/`, `agents/`, `skills/`, and `hooks/`. Upstream issue links are not leaks.

**By hand.** Run it in a clean clone or worktree. `--apply` refuses a tree with tracked changes, stages its result, leaves conflicts unmerged, and never commits.

```bash
git fetch --no-tags upstream dev
node scripts/port/upstream-drift.mjs --check            # exit 0 up to date, 1 new commits
node scripts/port/upstream-drift.mjs --apply            # exit 0 clean, 1 conflicts
node scripts/port/upstream-drift.mjs --report           # JSON: commits, files, conflicts, leaks, package.json delta
node scripts/port/upstream-drift.mjs --report --markdown
```

`--base <sha>` and `--head <ref>` override the marker's sha and `upstream/dev`. Exit code `2` means a usage or git error. `tests/port/upstream-drift.test.ts` covers the script against a fake upstream and fork pair.
