# oh-my-copilot v5.8.0

A minor release that adds an experimental headless SDK transport for
`omg team`, lets factory chains run past their first link on Copilot, cuts
Copilot hook latency, and runs the headless Copilot smoke in CI. There are
**no breaking changes** and nothing to migrate: the team transport stays
`pane`, the SessionEnd budget under Claude Code stays 300 ms, and the CI smoke
job skips without its secret. There is no upstream port in this release;
parity stays at upstream oh-my-claudecode `dev` bcaceb136.

Install with `npm install -g oh-my-copilot@5.8.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## What's in

| Change | Measured |
| --- | --- |
| Headless SDK team transport (experimental) | 1 premium request per worker for one task; about 3.5 s from host spawn to an idle SDK session |
| Factory chains on Copilot | A live two-link chain on Copilot CLI 1.0.91 ran end to end for 2 premium requests |
| Copilot hook latency | SessionEnd under 4 parallel lanes: 0 of 64 runs failed, down from 56 to 63; Stop hooks 1331 ms to 976 ms |
| Copilot smoke in CI | 0 premium requests on PRs and branch pushes; about 2 per pushed tag |

### Headless SDK team transport (experimental)

`omg team --transport sdk` runs each copilot worker as a detached
`omg team sdk-host` process that owns one `@github/copilot-sdk` session. There
is no pane and no tmux or psmux. Workers report through the unchanged
`omg team api`, and `omg team status` shows each worker's state, turns,
credits and premium requests.

```bash
npm i -g @github/copilot-sdk --omit=optional --ignore-scripts
omg team 2:copilot --transport sdk "fix the failing tests"
```

- **Requirements.** `copilot` on PATH and `@github/copilot-sdk` installed
  globally. Without the SDK each worker fails with the install hint.
- **Cost.** In the live runs each worker spent 1 premium request on its task.
  `team.sdk.maxCreditsPerWorker` (default 10) caps each worker; at the cap the
  host aborts the turn and the worker shows as `capped`.
- **Permissions.** No allow-all. The host answers every permission request:
  writes only in the worker's worktree and the team state root, MCP only to
  the plugin server. The shell policy is a denylist, not a sandbox. Sub-agent
  tools and `host_smoke` are removed from the session.
- **Experimental.** `pane` stays the default. Set `team.transport: "sdk"` in
  `.copilot/omg.jsonc` only to opt in for every team.

### Factory chains on Copilot

Copilot CLI has no `--session-id`, so a factory chain used to stop silently
after its first link. The spawner now sets `OMC_CHAIN_LINK=<link id>` on each
Copilot link, and the link's own SessionStart binds it to its host session,
so a nested session that inherits the variable cannot end its parent's link.
Ledgers record each link's host, parent and closeout, and `omg factory status`
lists every chain's links. `omg smoke copilot --tier 2 --scenario chain` runs
a real two-link chain as an opt-in check.

### Copilot hook latency

- **SessionEnd budget 1500 ms under Copilot.** Copilot fires SessionEnd after
  every turn and waits up to 30 s, so the 300 ms budget dropped the cleanup
  under ordinary load. 1500 ms is a chosen value, about 5x the idle foreground
  cost, not a measured limit. Claude Code keeps 300 ms.
- **Generic hooks run in a Worker under Copilot.** Under Copilot,
  `scripts/run.cjs` runs 18 audited hooks in a Worker thread instead of a chain
  of Node processes. A Worker-routed hook is about 90 ms faster on Windows.
  Hooks whose own timeout is 3 s or less stay on the supervised child path,
  because a Worker cannot interrupt a blocked synchronous call.

| Event (local bench, sum of medians) | Before | After |
| --- | --- | --- |
| SessionStart | 1919 ms | 1482 ms |
| Stop | 1331 ms | 976 ms |
| PreCompact | 994 ms | 805 ms |

### Copilot smoke in CI

A new `smoke` job runs `omg smoke copilot --tier 2 --sdk-static` on
ubuntu-latest after every build, with no model call. Pushed `v*` tags also
run the default scenarios, about 2 premium requests. The job needs the
repository secret `COPILOT_GITHUB_TOKEN`, a fine-grained token of a Copilot
user with the "Copilot Requests" permission. Without it the job passes with
the notice `Copilot smoke skipped`, as on fork PRs. Setup is in
[`docs/DEVELOPERS.md`](docs/DEVELOPERS.md#tier-2-in-ci).

### Fixes

- **`omg team shutdown` works from a fresh shell.** It no longer reclaims the
  active instance reservation once the `team start` CLI has exited, which
  failed every such shutdown with `team_instance_reservation_missing`.
- **`--json` is honoured** by `doctor conflicts`, `wait status`,
  `wait detect`, `teleport list`, `teleport remove` and `team status`.
  `team status --json` prints one JSON document.
- **`omg smoke copilot --json` keeps stdout pure** even when stdout and stderr
  are merged.
- **The chain smoke scenario builds its state paths through the state root**,
  so it honours a relocated `.omg/`.

## Behaviour changes

None by default. These environment variables tune the new behaviour:

| Variable | Effect |
| --- | --- |
| `OMC_SESSION_END_BUDGET_MS` | Overrides the SessionEnd foreground budget on both hosts, 1 to 60000 ms. |
| `OMC_COPILOT_HOOK_WORKER=0` | Turns off Worker routing of generic hooks under Copilot. |
| `OMC_TEAM_SDK_MAX_CREDITS` | Overrides `team.sdk.maxCreditsPerWorker` for the sdk transport. |
| `OMC_SMOKE_ALLOW_LIVE=1` | Lets the `host_smoke` MCP tool run billed tiers, as in v5.7.0. |
| `OMC_LIVE_SMOKE` | Lets `npm run test:live` run billed smoke tiers, as in v5.7.0. |

See [`CHANGELOG.md`](CHANGELOG.md) for details and the
[migration note](docs/MIGRATION.md#v570--v580-sdk-team-transport).

## Known limitations

- **SDK transport startup is serial.** Each worker launch waits for the
  previous worker's claim, so a two-worker start took about 73 s.
- **SDK teams bypass the one-team-per-leader guard.** The guard probes tmux
  sessions, so it does not see an sdk team.
- **SDK teams have no HUD or leader notifications.** Worker messages to the
  leader land only in the mailbox.
- **SDK transport rejects explicit reviewer-contract roles** (`critic`,
  `code-reviewer`, `security-reviewer`, `test-engineer`), `--auto-merge`,
  non-copilot workers and scaling.
- **Copilot fires `sessionEnd` after every turn.** A factory link that a Stop
  hook continues into a second turn hands off after its first turn.
- **The hook gain is smaller on Linux and macOS.** They have no supervisor
  hop, so a Worker-routed hook saves about 50 ms instead of about 90 ms.
- **`omg wait detect --json` is not pure JSON.** It prints a scanning line
  before the JSON, and without tmux it exits early with plain text.

## Requirements

- GitHub Copilot CLI 1.0.88 or later (1.0.91 verified for the SDK transport,
  factory chains and the smoke harness); Claude Code remains supported.
- `node` on PATH, as in v5.7.0.
- SDK transport and smoke tier 2: `@github/copilot-sdk` installed next to
  `omg` (SDK 1.0.16 verified).
- Factory and intake: the host binary on PATH and `gh` authenticated for the
  repository.

## Upstream parity

The fork stays at upstream oh-my-claudecode `dev` through bcaceb136. This
fork's fixes #4231 to #4234 are merged upstream and already carried in their
canonical form since v5.7.0.

## Thanks

Thank you to Yeachan Heo for
[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), and for
reviewing and merging this fork's fixes upstream.
