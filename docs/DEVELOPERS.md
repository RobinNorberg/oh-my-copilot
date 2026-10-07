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

Its checks: `scn.team.started` (exit 0, transport `sdk`, the host launch time), `completed` (both tasks completed, one per worker), `committed` (each owner committed its task's file in its own worktree), `status` (2 sdk workers alive with host pid and session id, tasks 2/2), `shutdown` (exit 0 without `--force`, no host or runtime pid left, instance reservation released, team state gone), `duration` (start to closeout within 300 s or `--timeout`, whichever is larger), and `premium` (1 to 2 premium requests). Worker runtime logs are copied into the smoke home before shutdown, so `scn.team.adapter_errors` covers them. `team` runs after the SDK scenarios and before `chain`. Set `OMC_TEAM_SDK_LAUNCH_CONCURRENCY=1` in the smoke's environment to measure the serial launch path.

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
