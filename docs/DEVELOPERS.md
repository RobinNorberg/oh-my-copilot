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
```

**Install.** The SDK is an optional peer dependency, so `npm i -g oh-my-copilot` never installs it. Install it next to `omg` with the command above. `--ignore-scripts` is required on Windows with `--omit=optional`, because koffi's install script otherwise falls back to a source build that needs CMake. Without the SDK every `sdk.*` check fails with that install hint and the run exits `2`.

**Bundled runtime.** A global install can still pull the SDK's platform runtime, about 128 MB, despite `--omit=optional`. It lands nested at `<npm root -g>/@github/copilot-sdk/node_modules/@github/copilot-sdk-<platform>`. Delete that folder if it appears; tier 2 never uses it. The lean alternative is a project-local install in the plugin root, which the spike measured at 11 MB:

```bash
npm i --no-save --omit=optional --ignore-scripts @github/copilot-sdk
```

**Installed-exe policy.** Tier 2 always connects the SDK to the installed `copilot` binary, resolved exactly as for tier 0 and 1. It never uses the SDK's bundled runtime, because the installed CLI is what users run and plugin loading differs between the two. `sdk.runtime` checks that the runtime reports the tier 0 binary version and protocol 3 or later.

**Scenarios.** `smoke` and `guardrail` are the default; `--scenario` takes a comma-separated list or `all`. Each scenario runs in its own session in a temp git repo with an isolated `COPILOT_HOME`, a per-scenario timeout, and its full event stream kept as `artifacts.events.<name>`. `scn.<name>.cost` reports premium requests and credits. `chain` is the exception: it is opt-in (never in `all`), uses no SDK session, and spawns two real `copilot -p` factory links that hand off through `OMC_CHAIN_LINK` and the SessionEnd worker (see [REFERENCE.md](./REFERENCE.md#factory-chains-on-copilot)). Its links run without `--max-ai-credits`, so `--max-credits` does not bound them, and a link-2 process still running after the timeout is not killed.

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
