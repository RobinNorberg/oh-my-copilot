# oh-my-copilot v5.33.0

**Breaking: this release moves to Copilot SDK v2.** oh-my-copilot now drives Copilot through `@microsoft/copilot-sdk` 2.x and needs Copilot CLI 1.0.113 or newer (tested: SDK 2.0.3 with CLI 1.0.116). `@github/copilot-sdk` is no longer used. See "Upgrade: Copilot SDK v2" below.

This release also lets the factory run .NET repositories (`dotnet build` / `dotnet test` gates, .NET lanes on every forge and an opt-in sandboxed NuGet restore), and adds one place that tells you which factory runs need you: `omg factory attention`, with the same list in the HUD, `omg factory poll`, notifications and a rebuilt `omg factory dashboard` that can serve a live local page. See CHANGELOG.md.

Install with `npm install -g oh-my-copilot@5.33.0`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

There is no new factory bench run in this release. The bench baseline is unchanged from v5.31.0.

## Upgrade: Copilot SDK v2

Copilot CLI 1.0.113 moved to SDK protocol 4, which no `@github/copilot-sdk` release speaks, so sdk team workers, `copilot_run`, factory lanes and the tier 2 smoke failed with a protocol mismatch on an updated CLI. From this release they use SDK v2 only.

1. Update Copilot CLI to 1.0.116 or newer (`npm i -g @github/copilot@latest`, or `copilot update` for a WinGet or Homebrew install). 1.0.113 to 1.0.115 speak protocol 4 but are untested; `omg factory check --host` warns for them and fails for anything older.
2. Replace the SDK: `npm uninstall -g @github/copilot-sdk`, then `npm i -g @microsoft/copilot-sdk@2 --ignore-scripts`. A global install also pulls a platform runtime package of about 200 MB that oh-my-copilot never loads: it always drives your installed `copilot`.
3. Run `omg factory check --host`. It names the old package, a CLI that is too old, or an SDK outside `^2.0.3`, each with the fix command.

What changes in behaviour:

- **The sandbox is confirmed after the session is created.** The engine re-sends the policy, requires the runtime to report success, and reads back the effective sandbox state. A session counts as sandboxed only when that state is enabled, has no bypass or opt-out, and is no weaker than the policy sent. Anything else fails closed: a write lane refuses with `sandbox-unavailable:`, a review runs read-only without a shell, and a gate command does not start.
- **A sandbox that is switched off or weakened mid-session stops the lane.** The run parks at `sandbox-escaped` for a human instead of retrying.
- **Only a sandbox-policy error counts as a sandbox failure at session start.** A login, network or model error is an ordinary failure.
- **sdk team workers without a configured model cost more on CLI 1.0.116.** With no `team.sdk.model`, workers run on the runtime's automatic model choice, which measured about 10 AI credits per worker turn in the smoke. Set `team.sdk.model` to a model you choose.
- Recordings made with `omg smoke copilot --record` under SDK v1 and CLI 1.0.112 will probably not replay; record them again.

## Highlights

- **.NET repositories in the factory.** A local gate or prepare check can be plain `["dotnet", "build"]` or `["dotnet", "test"]`, without a wrapper script. The gate's definition covers the solution, project, MSBuild and NuGet files (`*.sln`, `*.*proj`, `*.props`, `*.targets`, `global.json`, `nuget.config`, `packages.lock.json` and more), so a lane that changes one parks at `gate-definition-changed`. Leftover `bin/`, `obj/` and `artifacts/` state is emptied in the sandbox before the gate, and a NuGet restore error is never counted as a code failure: it parks at `gate-install-needed` instead of starting a ci-fix lane.
- **.NET write lanes on GitHub and Azure DevOps.** Implement, fix, CI-fix and conflict-fix lanes get the .NET sandbox settings (relocated `APPDATA`, a read-only grant on your NuGet packages folder, `-m:1` for MSBuild) on every forge, decided from trusted input only: a `dotnet` gate or prepare command, or a solution or C#, F# or VB project file in the base commit.
- **Opt-in sandboxed NuGet restore.** With `factory.run.gateInstall: "sandboxed"`, a gate that needs packages your machine has not cached runs `dotnet restore` once per head in the OS sandbox with only `api.nuget.org` reachable, in an engine-written tree that holds only the head's pinned definition files, into the run's own packages folder (your `~/.nuget/packages` gains nothing). The gate then runs again offline. A repository whose packages are all cached never opens the network. `omg factory run clean <issue>` removes the folder.
- **Root `nuget.config` support.** A sandboxed dotnet `restore`, `build`, `test`, `pack` or `publish` reads exactly one NuGet config: the repository's root `nuget.config`, or a nuget.org-only file when there is none. Before, a committed root `nuget.config` failed every sandboxed dotnet step on Windows with "Failed to read NuGet.Config due to unauthorized access".
- **`omg factory attention` lists what needs you.** One read-only view of every factory run that waits for a human, grouped by the action it needs (Inspect, Broken engine, Decide, Merge, Fix by hand, Limits / retry), oldest first, with the reason, the age at the gate, credits, the PR and the exact commands to run. Commands that can start billed lanes are marked `(billed)`. It exits 4 when something needs you (`--exit-zero` for 0) and 1 when a state cannot be read. `--all-repos` lists every repository with factory runs on this host. A run whose state fails its seal or ledger check shows no text from that state.
- **The next step is sealed in each gate.** At every human gate the engine stores the exact next commands in the sealed run state. `omg factory run status <issue>` prints them under `next:`, and attention prints the same steps. Merge commands are quoted for your shell.
- **Attention where you already look.** A HUD `factory` element (off by default; opt in with `"factory": true` under `elements`), a `/factory-attention` skill, attention lines in `omg factory poll`, and an opt-in `factory-attention` notification (`notifications.events["factory-attention"].enabled`).
- **`omg factory dashboard` rebuilt.** The page opens with what needs you, then Live now, Runs, Tasks, Cost, Throughput and Bench. Each run has a timeline that keeps engine time apart from time parked at a human gate. `--out <file> --watch` rewrites the page when something changed. `--json` is now schemaVersion 2 (`--json --schema 1` prints the old shape for one release).
- **`omg factory dashboard --serve`, a live local page.** It serves the dashboard on `127.0.0.1` only, at a URL with a random token printed once to your terminal (`--port <n>`, `--open`), and updates in place when a run changes. It is read-only: next commands have Copy buttons, and you run them yourself. `--all-repos` adds a Repositories section. Stop it with Ctrl-C.

## Changed / Upgrade notes

- **`omg factory dashboard` is read-only by default.** It no longer reads the forge or records human merges before it builds the page. Pass `--forge` to get both back. `omg factory board` and `omg factory run status` still record human merges.
- **Sandboxed sessions and commands get a cleaned `PATH`.** Empty and relative entries and `node_modules/.bin` directories are dropped from the `PATH` a factory lane, gate or sandboxed command inherits. `npm` and `npx` still find a project's binaries themselves; a gate that calls a package binary by its bare name must go through `npx` or an npm script.
- **The NuGet restore source rule.** The engine never appends a package source to the ones NuGet would use. When your root `nuget.config` defines no package source at all, the command reads an engine-written copy of it with nuget.org as its one source, and any `RestoreSources` your repository sets replaces it, as plain NuGet would. A root config that defines sources is used exactly as it is. A root config with a path-valued setting gets no copy: if a restore then needs nuget.org, the run parks and asks you to add nuget.org to the root `nuget.config` explicitly. Before the network opens, the restore step checks that MSBuild sees the same restore sources in its tree as in the gate checkout, and parks with both lists when they differ. It also parks when a feed restriction depends on your environment (an environment variable, the registry, an import chosen by your environment), because the sandbox scrubs the environment; declare the feed in the repository's `nuget.config` or give the name an unconditional value in a pinned `.props` file. A repository with submodules gets no copy, and its restore step parks.
- **`omg factory poll` keeps its stale-gate reminder record in the host factory ledger** (`$OMC_STATE_DIR/factory-ledger`, else `~/.omg/factory-ledger`), out of reach of lanes. The old `.omg/state/factory/reminders.json` is ignored, so a run already reminded may be reminded once more after the upgrade.
- **`omg factory heal approve` refuses a closed heal run** with exit 3. An open heal run parked at `heal-approve` is approved as before.
- **`omg factory board` and `omg factory poll` show no text from an unverified run state**: only its key, `not verified` and `omg factory run status <issue>`.
- `omg factory board` (and `dashboard --forge`) checks human merges on the local forge again.

## Caveats

- **Test evidence:** published with CI on the release commit, not the maintainer's local full test suite. The SDK v2 change was smoke-tested live on Windows against Copilot CLI 1.0.116 before the release commit (the standard scenarios, sandboxed review, write and canary lanes, a two-worker sdk team and a factory run to the merge gate); the release commit itself got no separate local live smoke.
- **SDK v2 is verified live on Windows only.** The check that compares the runtime's effective sandbox policy with the one sent was validated against the Windows runtime. On Linux or macOS, or on a machine with an organisation-managed sandbox policy or a sandbox proxy, a runtime that reports extra entries would make lanes refuse with `sandbox-unavailable:` (fail closed). Please report it if you see that.
- **.NET support is verified on Windows with .NET SDK 10 only.** None of it is verified on Linux or macOS.
- **Private NuGet feeds are not supported yet.** A restore that needs a private or local feed, or gets a feed's 401/403, parks. NuGet network for lanes and `packages.config` projects are not supported either.
- **Microsoft.Testing.Platform:** on Windows, a run whose `dotnet test` local gate uses Microsoft.Testing.Platform in the OS sandbox parks at `gates` at run start, because the test app cannot connect back to `dotnet test` there.
- **On Windows the sandboxed restore step can also reach loopback and the local network**, not only `api.nuget.org`: the Windows sandbox runs nothing without them. The `gate-definition-changed` park says so when `gateInstall` is `"sandboxed"`. If your policy forbids nuget.org, keep `gateInstall: "park"` (the default) and restore the branch's packages yourself.
- The environment check of the restore step does not catch environment reads by MSBuild tasks and tools at execution time, or configs the engine cannot see.
- `OMC_PLANNER_WRITE_GUARD=1` protects nothing under the Copilot host yet: Copilot's PreToolUse payload carries no agent identity, and an `apply_patch` call names no file path.
- **Redaction:** with the default rules, a `NAME="value"` secret that contains a backslash-escaped quote keeps the text after that quote unmasked: `API_TOKEN="abc\"sensitive-suffix"` is logged as `API_TOKEN=****sensitive-suffix"`. `OMC_REDACT_KEY_SHAPES=1` masks the whole value. A fix is planned.
