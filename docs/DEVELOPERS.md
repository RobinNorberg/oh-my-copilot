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
| `sessionStart` | `SessionStart` | session-start, project-memory-session, wiki-session-start, stale-run-reporter, runs-reconciler, premium-budget | `SessionStart` | mapped; the `init` and `maintenance` matcher groups are [not projected](./HOOKS.md#not-projected) |
| `sessionEnd` | `SessionEnd` | session-end, wiki-session-end | `SessionEnd` | mapped |
| `userPromptSubmitted` | `UserPromptSubmit` | keyword-detector, skill-injector, premium-budget | `UserPromptSubmit` | mapped |
| `preToolUse` | `PreToolUse` | pre-tool-enforcer, git-guardrails (`Bash`) | `PreToolUse` | mapped |
| `permissionRequest` | `PermissionRequest` | permission-handler (`Bash`) | `PermissionRequest` | mapped |
| `postToolUse` | `PostToolUse` | post-tool-verifier, project-memory-posttool, post-tool-rules-injector, post-tool-directory-context-injector | `PostToolUse` | mapped |
| `postToolUseFailure` | `PostToolUseFailure` | post-tool-use-failure | `PostToolUseFailure` | mapped |
| `subagentStart` | `SubagentStart` | subagent-tracker start | `SubagentStart` | mapped |
| `subagentStop` | `SubagentStop` | subagent-tracker stop, verify-deliverables | `SubagentStop` | mapped |
| `preCompact` | `PreCompact` | pre-compact, project-memory-precompact, wiki-pre-compact | `PreCompact` | mapped |
| `agentStop` | `Stop` | context-guard-stop, workflow-drift-guard, persistent-mode, budget-guard, premium-budget, code-simplifier | `Stop` | mapped |
| `notification` | `Notification` (fork-owned `FORK_HOOKS`) | copilot/notification.mjs | none in upstream `hooks/hooks.json` (Claude Code has `Notification`; upstream sends `ask-user-question` from PreToolUse `AskUserQuestion` instead) | mapped: `permission_prompt` and `elicitation_dialog` send the `ask-user-question` notification; other types and team workers are ignored |
| `errorOccurred` | none | none | none | rejected: no OMC consumer. A failed turn already reaches `sessionEnd` with `reason: "error"` and `error`, and SDK workers record `session.error`. The `errorHandling: retry` output would duplicate the runtime's own retries |
| `preMcpToolCall` | none | none | none | rejected: the only output is `metaToUse`, the outgoing MCP request `_meta`, which OMC has no use for. `PreToolUse` already sees and can deny MCP tools |
| `userPromptTransformed` | none | none | none | rejected: the only output is `modifiedTransformedPrompt`. `UserPromptSubmit` already injects OMC context; rewriting the runtime's transformed prompt (`<current_datetime>` and the like) gains nothing |
| `postResult` | not file-configurable | none | none | unmapped, no equivalent; SDK protocol enum only |
| `prePRDescription` | not file-configurable | none | none | unmapped, no equivalent; SDK protocol enum only |

Every upstream event is projected. `FORK_HOOKS` in `build-hooks.mjs` adds Copilot-only events in the upstream command form, so they take the same dispatcher and adapter path; an upstream group for a `FORK_HOOKS` event fails the build. A new upstream event fails `build-hooks.mjs` only when its command form is unknown; check this table whenever upstream adds an event to `hooks/hooks.json`.

**Input and output contracts of the four events.** Inputs as a probe plugin received them from Copilot CLI 1.0.91 in one SDK session on 2026-10-11 (1 premium request). Outputs are from the SDK's `dist/types.d.ts`.

| Event | Input (beyond `sessionId`, `timestamp`, `cwd`) | Output |
|---|---|---|
| `notification` | `message`, `title`, `hook_event_name: "Notification"`, `notification_type`. Observed: `permission_prompt` (title `Permission needed`, message `Run command: <cmd>`; also fires in SDK sessions whose `onPermissionRequest` answers the request), `shell_completed`. The runtime also names `elicitation_dialog`, `agent_completed`, `agent_idle`, `shell_detached_completed`, `new_inbox_message`. A camelCase `notification` and a PascalCase `Notification` registration receive the same payload | none; fired asynchronously |
| `preMcpToolCall` | `toolCallId`, `serverName`, `toolName` (unprefixed, e.g. `state_list_active`), `arguments` | `metaToUse` (object, or `null` to drop `_meta`) |
| `userPromptTransformed` | `prompt`, `transformedPrompt` (the prompt with runtime context such as `<current_datetime>`) | `modifiedTransformedPrompt` |
| `errorOccurred` | `error`, `errorContext` (`model_call`, `tool_execution`, `system`, `user_input`), `recoverable`. Did not fire for a failing shell command in the probe | `errorHandling` (`retry`, `skip`, `abort`), `retryCount`, `userNotification`, `suppressOutput` |

**Cost.** Copilot runs the `Notification` entry asynchronously. The dispatcher and the hook took about 0.7 s per event on Windows; a dispatched notification runs in a detached child. The entry's 5 s `timeoutSec` is also the hook's run.cjs and dispatcher timeout: `resolveHookTimeoutMs()` reads a `scripts/copilot/` hook's timeout from the generated `copilot/hooks.json`, since `hooks/hooks.json` has no entry for it.

**Notification safety.** A permission prompt's message is the whole command line, which can carry credentials.

- **No command arguments.** A `permission_prompt` notification carries only the title (when it is 1 to 40 letters and spaces, else the constant `Permission needed`), the tool category (the message up to its first `:`) and, for a command category, the binary's base name: `Run command: curl -H "Authorization: ..." https://x` is sent as `Permission needed: Run command: curl`. A quoted program path is one word (`"C:\Program Files\Git\bin\git.exe" push` gives `git.exe`). Leading `NAME=value` assignments and a statement that starts with a PowerShell variable (`$env:X = 'v';`) are skipped when picking the binary. The arguments are never sent, because no redaction pattern list covers every way a command line can carry a credential.
- **Redaction.** `elicitation_dialog` (`ask_user`) text, and the permission prompt's title, category and binary, pass through `redactTokens()` (`src/notifications/redact.ts`: PEM private keys, Slack/Telegram/GitHub/AWS/Anthropic/OpenAI-style tokens, Bearer/Bot values, secret-named JSON fields (also with escaped quotes), `Authorization`/`Cookie`/`X-*-Key` headers, secret-named assignments and flags including `--token -value` and `--auth`, `curl -u user:pass`, `mysql -pSecret`, `... login -p secret`, URL credentials including `redis://:pass@host`, Slack and Discord webhook URLs, padded base64 blobs). The question is then capped at 200 characters. Without the redactor the hook sends nothing. The adversarial corpus is in `src/notifications/__tests__/redact.test.ts`.
- **Fail closed on a stale dist.** The hook loads the committed `dist/`, which is rebuilt at release and can predate the source on a dev install. It sends a permission prompt only when the loaded `dist/notifications/index.js` exports `NOTIFICATION_CAPS.nonReplyable` and its `redactTokens` masks the `REDACT_SELF_TEST` inputs (`permissionPromptSupported()`); otherwise the prompt is dropped, with an `OMC_DEBUG_HOOKS` line. `ask_user` notifications are sent either way, but through a redactor that fails the self-test only as the generic `Copilot is asking you a question`, without the question text.
- **Remote replies never answer permission prompts.** A `permission_prompt` notification is sent with `replyable: false`. `notify()` registers no reply mapping for it, so the reply listener ignores replies to it and never types into the pane, where Enter would select the menu's default and approve the command. Before sending it, `notify()` marks the pane non-replyable (`markPaneNonReplyable`, a `reply-blocked-pane-<id>.json` file next to the registry, written without the registry lock) and removes the pane's earlier reply mappings (`removeMessagesByPane`), so a reply to an older replyable message cannot answer the menu either. The reply listener refuses any mapping created (at dispatch start) no later than the pane's marker (`isPaneReplyBlocked`), which covers an `ask_user` notification still in flight that registers its mapping after the removal. The marker is written via temp file and rename; a marker file that exists but does not parse refuses every reply into the pane until the next mark replaces it. Markers are never pruned: one small file per pane id, harmless. The rule for a reply without a mapping (refused while any marker is younger than 24 h) only applies to `processSlackSocketMessage`, which nothing calls yet; the Discord, Telegram and Slack listeners always pass the mapping. When the removal fails (registry lock timeout), the permission notification is not sent. Approval-gate mappings (`omg graph` remote approval, `approvalRef`) are kept, since their replies never touch a pane. A mapping records no tmux/psmux server, only the session name: pane ids (`%N`) can collide across servers, so a mapping under another session name is kept and one with the same session name on another server is removed (the safe side). The message says to answer in the terminal. `elicitation_dialog` (`ask_user`) notifications stay replyable.
- **Cooldown.** Per session, a permission prompt is sent at most once per 30 s, and an identical `ask_user` question once per 30 s (`<state>/sessions/<sessionId>/notification-input-cooldown.json`).
- **No separate switch.** Permission prompts and `ask_user` questions share the `ask-user-question` event. Disabling that event (`events["ask-user-question"].enabled: false`) stops both.

**Evidence.** All paths are inside the CLI package, `%LOCALAPPDATA%\copilot\pkg\win32-x64\1.0.91\` on Windows.

- **File-configurable events.** The native runtime `prebuilds/win32-x64/runtime.node` embeds the settings schema with one `hooks.<event>` entry for each of the 15 events from `sessionStart` to `notification` (byte offsets 84058812 to 84060097). `postResult` and `prePRDescription` have no entry.
- **Protocol enum.** `schemas/api.schema.json:24048` defines `HookType` with all 17 events and says discovery emits the file-configurable subset. The SDK's `dist/generated/rpc.d.ts:1627` has the same 17-member union.
- **PascalCase aliases.** The runtime holds the literal fragments `PermissionReques`, `PostToolUseFailu` and `UserPromptSubmit` together (offset 84618512) and `PreCompact` next to the hook prompt validation strings (offset 85766538). Shorter names compile to immediates and are not greppable. On a real machine with only camelCase `preToolUse`/`postToolUse` personal hooks, the plugin's PascalCase hooks produced `hook.start` events of type `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `agentStop`, `subagentStart` and `subagentStop` in `~/.copilot/session-state/*/events.jsonl`. `preCompact`, `permissionRequest` and `postToolUseFailure` were not observed firing there.

**CLI and SDK differ.** The SDK's `SessionHooks` interface (`dist/types.d.ts:1372`) and its dispatch table (`dist/session.js:1630`) cover only 10 events: `preToolUse`, `preMcpToolCall`, `postToolUse`, `postToolUseFailure`, `userPromptSubmitted`, `userPromptTransformed`, `sessionStart`, `sessionEnd`, `errorOccurred` and `agentStop`. The CLI's file hooks additionally support `subagentStart`, `subagentStop`, `preCompact`, `permissionRequest` and `notification`. An SDK session handles permissions through the separate `onPermissionRequest` handler (`dist/types.d.ts:2112`), not a hook. OMC registers no SDK callback hooks; SDK sessions, such as tier 2 and SDK team workers, run the plugin's file hooks from `copilot/hooks.json`.

## SDK in-process tools

`team.sdk.inProcessTools: true` (env `OMC_TEAM_SDK_INPROCESS_TOOLS=1` or `true` turns it on, `0` or `false` turns it off, any case; any other value is an `invalid_team_sdk_config` error; default off) makes each sdk team host register the plugin MCP tools as SDK session tools (`SessionConfig.tools`) and disable the `t` server for its session (`disabledMcpServers`). The session then starts no `node bridge/mcp-server.cjs` child, and the tools run in the host process.

**Capability.** `@github/copilot-sdk` 1.0.16 exposes `SessionConfig.tools: Tool[]` (`name`, `description`, JSON-schema `parameters`, `handler`, `skipPermission`) and `convertMcpCallToolResult` (`dist/types.d.ts`). The runtime accepts the hyphenated `t-<tool>` names. The host builds the set without the `excludedTools` names, so `t-host_smoke` and `workerDenyTools` entries for single tools (`t(<tool>)`) stay denied. A bare server name (`workerDenyTools: ['t']`, deny every tool of the server) gives an empty set, with the `t` server still disabled. When the loaded SDK has no `convertMcpCallToolResult`, the host logs `in-process tools unavailable` and keeps the MCP server.

**Verification.** The capability check above sees only the SDK module. After `createSession()` the host asks the session, with no model call, whether it offers `t-state_read` (`tools.getCurrentMetadata()`, built first with `tools.initializeAndValidate()` when empty). If the session lists tools but not that one, the host deletes it and creates it again on the `t` MCP server, and `tool_transport` is `mcp`. If the SDK has no metadata RPC, or the RPC fails or lists no tools, the host keeps in-process and records `tool_transport_verified: false` in `sdk-session.json`; `true` means the tool was listed, or the set is empty.

**Process lifetime.** The tools share the host process, so the host takes over what the MCP server process did:

- **Cleanup.** On teardown, before the terminal record, the host runs the server's shutdown cleanup (`cleanupOwnedBridgeSessions()` for the detached Python REPL bridges and `disconnectAll()` for the LSP clients, in parallel), best effort with a 5 s deadline. The bridges get a shorter escalation than the MCP server's default (`bridgeCleanupBudget()`, all bridges in parallel), so SIGKILL is sent inside the deadline; the default 5 s SIGINT grace alone would use it up. On POSIX: SIGINT 1.5 s, SIGTERM 1.5 s, then SIGKILL. On Windows no grace: the SIGINT/SIGTERM stages are `taskkill /T` without `/F`, which does not stop the windowless bridge, and each exit poll costs about 500 ms (PowerShell CIM), so `taskkill /F` goes out after about 1.2 s instead of 4.8 s. The cleanup comes with the injected builder (`SdkInProcessToolSet.cleanup`), so the team bundle still does not load the tool registry.
- **Crashes.** An `unhandledRejection` is logged and recorded in `last_error`, and the host keeps serving: `callTool()` already turns a handler's own failure into an `isError` result, so a stray rejection does not mean the host is broken. An `uncaughtException` leaves the process in an undefined state, so the host stops hard instead of resuming. It kills the runtime, runs the cleanup, writes the terminal record and then a `failed` session (outcome `tool_crash`), so the leader can reclaim the task at once instead of waiting for a dead pid.
- **Signals.** Importing the LSP client manager adds `SIGTERM`/`SIGINT`/`SIGHUP` listeners (`src/tools/lsp/client.ts`), and any listener replaces Node's default exit. The in-process host therefore handles these signals itself, with a hard stop as for a termination request (outcome `terminated`), so a manual `kill` still stops it.
- **Startup.** A crash or signal during startup (`client.start()`, `createSession()`, the tool metadata check: bounded by their 60 s and 30 s RPC timeouts) is recorded at once but acted on at the first doorbell-loop pass, which checks both flags before it sends any prompt. The startup RPCs cannot be cancelled; the hard stop then kills the runtime that startup created.
- **Event loop.** The tools now run on the host's event loop. A synchronous tool call (for example the `execFileSync` `tsc --noEmit` run behind `lsp_diagnostics_directory`, or the synchronous file I/O in the state tools) blocks the doorbell loop, session events and permission answers until it returns. The MCP server had the same blocking, but in its own process. Keep the default MCP transport for workloads with long synchronous tool calls.

**Parity.** `src/team/sdk-inprocess-tools.ts` reuses the server's code and adds no tool logic:

- **Names.** `t-<tool>`, the name Copilot gives the MCP tool.
- **Schemas.** `zodToJsonSchema`, the ListTools `inputSchema`.
- **Results.** `callTool()` from `src/mcp/tool-registry.ts`, the function the standalone server's CallTool handler calls, converted with the SDK's `convertMcpCallToolResult`.
- **Set.** `getEnabledTools()` with the session env's `OMC_DISABLE_TOOLS`, minus `excludedTools`.
- **Environment.** The MCP child runs with the session env. Once the runtime is spawned, the host replaces its own `process.env` with that env (`adoptSessionEnv`). The host already runs in the worker's cwd.
- **Permissions.** The tools set `skipPermission`, matching the host policy, which approves every `t` MCP call.

`src/team/__tests__/sdk-inprocess-tools.test.ts` checks each of these against `buildListToolsResponse()` and `callTool()`. A live SDK turn called `t-state_list_active` in-process and returned the same text as the MCP tool (`tool.execution_complete`, `success: true`).

**Measurement.** These numbers are from Copilot CLI 1.0.91, SDK 1.0.16 and Windows 11, with no model calls. Each run used a fresh runtime and `COPILOT_HOME`. The steps were `client.start()`, `createSession()`, then `tools.initializeAndValidate()` and `getCurrentMetadata()` until `t-state_read` was offered. There were 12 runs per mode, alternating.

| ms (median, p10 to p90) | MCP server | in-process |
|---|---|---|
| `client.start()` | 1954 (1946 to 2008) | 1966 (1947 to 1989) |
| `createSession()` | 560 (549 to 624) | 594 (578 to 648) |
| tools offered after create | 347 (341 to 387) | 292 (278 to 310) |
| total | 2872 (2844 to 2968) | 2843 (2831 to 2897) |

The start latency is unchanged: about 30 ms of 2.9 s, within noise. `createSession()` carries the 55 tool schemas, and the MCP server connects while the session is created. What in-process saves is the MCP child, about 85 MB working set per worker. That is why it stays opt-in: the gain is memory only. The cost is that the tools share the host process. A native crash or memory growth in a tool, such as the LSP clients or the Python REPL bridge, now hits the host instead of a disposable child. A single cold first run measured 840 ms to tools offered for MCP, against 348 ms in-process.

**Rollback.** Leave the key unset, or set `false`, or set `OMC_TEAM_SDK_INPROCESS_TOOLS=0`. Each worker's `sdk-session.json` records `tool_transport` (`mcp` or `in-process`) and, for `in-process`, `tool_transport_verified`.

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
