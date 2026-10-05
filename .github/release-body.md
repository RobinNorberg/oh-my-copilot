# oh-my-copilot v5.7.0

A minor release that adds a headless smoke harness for the GitHub Copilot CLI,
fixes two hook behaviours, and brings the fork to parity with upstream
oh-my-claudecode `dev` through bcaceb136 (486b85bbb..bcaceb136). Upstream is
still at version 5.6.1. There are **no breaking changes** and nothing to
migrate: the new `@github/copilot-sdk` peer dependency is optional and
`OMC_HOOK_FAIL_CLOSED` is opt-in.

Install with `npm install -g oh-my-copilot@5.7.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

For tier 2 of the smoke harness, also install the optional SDK:

```bash
npm i -g @github/copilot-sdk --omit=optional --ignore-scripts
```

## What's in

### Headless smoke harness: `omg smoke copilot` and `host_smoke`

`omg smoke copilot` loads a plugin root into the real Copilot CLI inside a
throwaway `COPILOT_HOME` and reports one line per check. The same check is
exposed as the MCP tool `host_smoke`; the standalone MCP server now has 56
tools.

| Tier | Command | What it checks | Cost |
| --- | --- | --- | --- |
| 0 | `omg smoke copilot --tier 0` | Manifest and version, generated hooks and agents, `plugin list` / `skill list`, MCP tool count | Free, no model call |
| 1 | `omg smoke copilot --tier 1` | One live session: session events, hooks fired (fail-closed), plugin and MCP load, `.omg/` state writes | 1 premium request |
| 2 static | `omg smoke copilot --sdk-static` | The runtime's plugin, skill, agent and MCP lists via `@github/copilot-sdk`; `host_smoke` hidden from the model | Free, no model call |
| 2 | `omg smoke copilot --tier 2` | Scenarios `smoke` and `guardrail` (default); add `skill` and `delegate` with `--scenario all` | About 1 premium request per scenario, about 2 by default |

`--max-credits` (default and minimum 30) caps a run; at tier 2 a scenario
that passes the cap is aborted and the rest are skipped.

**From Claude Code.** Register the build and ask Claude Code to call
`host_smoke` with `{ "tier": 0 }`:

```bash
claude mcp add omg-dev -- node <path-to-oh-my-copilot>/dist/mcp/standalone-server.js
```

The tool smokes only its own package root unless `OMC_SMOKE_ALLOW_ANY_ROOT=1`
is set on the server. It refuses tier 1 and tier 2 with scenarios unless
`OMC_SMOKE_ALLOW_LIVE=1` is set, because those are billed sessions.
`{ "tier": 2, "scenarios": [] }` runs the free SDK static checks.
`OMC_DISABLE_TOOLS=smoke` hides the tool. `npm run test:live` runs the smoke
from vitest; billed tiers run only with `OMC_LIVE_SMOKE=1` or `2`.

### Fixes

- **Hook timeouts can fail closed.** With `OMC_HOOK_FAIL_CLOSED=1`,
  `scripts/run.cjs` exits `124` when a hook times out instead of `0`.
- **Wiki capture fits the SessionEnd budget.** `wiki-session-end.mjs` loads a
  lean bootstrap instead of the full SessionEnd module graph, so it finishes
  within the 300 ms SessionEnd budget.

### Upstream parity

- **Fork fixes merged upstream (#4231 to #4234).** `intake run --headless`,
  platform-derived dead-owner identity in the team shutdown tests, the
  state-lock owner-reclaim repro script, and BigInt file identity with an
  owner-record recheck before quarantine. They return in upstream's canonical
  form.
- **Team env passthrough off the command line (#4236).**
  `OMC_TEAM_WORKER_ENV_PASSTHROUGH` values, often credentials, are written to
  a private `0600` file that the worker pane sources and removes, instead of
  appearing in argv and tmux `pane_start_command`.

## Behaviour changes

- **Fail-closed hook timeouts apply only with `OMC_HOOK_FAIL_CLOSED=1`.**
  Without the variable a timed-out hook still fails open with exit `0`.
- **Wiki capture now runs reliably under Copilot.** Session wiki entries that
  were previously cut off by the SessionEnd budget are now written.

See [`CHANGELOG.md`](CHANGELOG.md) for details and the
[migration note](docs/MIGRATION.md#v562--v570-smoke-harness).

## Known limitations

- `session-end.mjs` measures about 295 ms against the 300 ms SessionEnd
  budget, so it has little headroom on slow machines.
- In a non-git directory both SessionEnd hooks exceed 300 ms.
- Copilot cannot pin a session id, so a factory chain stops after its first
  link and the watchdog reports it.
- `roleRouting` `reasoningEffort` is ignored for Copilot workers.

## Requirements

- GitHub Copilot CLI 1.0.88 or later (1.0.91 verified for stdin prompts and
  the smoke harness); Claude Code remains supported.
- `node` on PATH, as in v5.6.2.
- Smoke tier 2: `@github/copilot-sdk` installed next to `omg` (SDK 1.0.16
  verified).
- Factory and intake: the host binary on PATH and `gh` authenticated for the
  repository.

## Upstream credits

Ported work originates from
[Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
`dev` 486b85bbb..bcaceb136 (#4231, #4232, #4233, #4234, #4236); see
`CHANGELOG.md` for the breakdown. Thank you to Yeachan Heo for reviewing and
merging this fork's fixes #4231 to #4234 upstream, and for #4236.
