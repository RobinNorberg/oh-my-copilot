# oh-my-copilot v5.5.0

This release makes oh-my-copilot a native GitHub Copilot CLI plugin and
brings the fork to parity with upstream oh-my-claudecode v5.5.0 (plus
upstream `dev` through 862c69273). Before this release, every fork hook was a
silent no-op under Copilot CLI on Windows; hooks, agents, team workers and
`omg launch` now follow the Copilot CLI 1.0.88 contract, verified against the
installed binary.

Install with `npm install -g oh-my-copilot@5.5.0`, or from the plugin
marketplace: `copilot plugin marketplace add RobinNorberg/oh-my-copilot` then
`copilot plugin install oh-my-copilot@omc`. Upgrading from 5.1.0? Read the
[v5.1.0 → v5.5.0 guide](docs/MIGRATION.md#v510--v550-fork-upgrade-guide):
one change is breaking.

## Breaking

- **`COPILOT_CONFIG_DIR` is renamed to `COPILOT_HOME`**, the variable Copilot
  CLI itself reads. The old name is no longer honoured; `omg doctor conflicts`
  warns when it is set. The `${COPILOT_CONFIG_DIR}` guards token in
  `omg.jsonc` and the package's JS export keep working as deprecated aliases.

## Highlights

- **Native Copilot plugin surface.** A root `plugin.json` (the manifest
  Copilot reads first) points at generated `copilot/hooks.json` and
  `copilot/agents/`. Hooks run as `exec: node` with an argument list, so no
  shell is involved and Windows paths with spaces work. A `--require` adapter
  translates Claude-shaped hook output to Copilot's contract (top-level
  `additionalContext`, `permissionDecision: deny`, Stop blocks). Upstream's
  `hooks/hooks.json` and `agents/*.md` stay byte-identical for Claude Code.
- **Generated Copilot agents.** Model aliases become `models:` fallback
  lists; read-only agents get a `tools:` allowlist without create/edit;
  agents that review or edit code receive `include-custom-instructions`.
- **`copilot` team workers.** `omg team N:copilot` is first-class and the
  default on a Copilot host. Workers launch with the flags Copilot requires
  for unattended use, plus `permissions.workerDenyTools` /
  `workerDenyUrls` from `omg.jsonc` forwarded as `--deny-tool=` /
  `--deny-url=` (deny beats allow). `omg team` prints what each provider's
  workers were granted. The folder-trust prompt in fresh worktrees is answered
  for the session only. On native Windows, teams run detached in a private
  psmux namespace (`-L <ns>`), so they never appear in a bare `psmux ls`;
  attach with `tmux -L <ns> attach` using the namespace shown by
  `omg team status <team>`.
- **`omg launch` targets the host binary** (Copilot unless running under
  Claude Code), maps `--madmax` to `--yolo`, forwards `COPILOT_HOME` and
  related variables, and keeps tokens off the command line.
- **Ten new skills (61 canonical total):** `harbor`, `agent-doc-discipline`,
  `architecture-survey`, `diagram`, `intent`, `minimal-prose-discipline`,
  `map` (the yard router, which also routes the fork-exclusive skills),
  `pr`, `refit`, and `tdd`.
- **State lock hardening on Windows.** The owner-file fallback no longer
  loses mutual exclusion when an owner exits during a liveness probe
  (upstream #4146 / #4149); the hook-side `.mjs` copies encode the win32
  process identity in temp names (#4147 / #4148); the SQLite path caches
  liveness verdicts and probes outside the write transaction (contended
  give-up 12.8 s → 1.2 s); release retries are bounded.
- **Removed:** the legacy safe-command auto-approver. Copilot's own
  `--allow-tool` / `--deny-tool` rules and assisted approval replace it.

## Requirements

- GitHub Copilot CLI 1.0.88 or later (Claude Code remains supported).
- `node` on PATH: Copilot denies every tool call if a PreToolUse hook cannot
  start.
- `omg team` on native Windows: [psmux](https://github.com/marlocarlo/psmux)
  3.3.7 or later (`winget install psmux`), so `-L <ns>` namespaces are
  honoured.

## Upstream credits

Ported work originates from
[Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
v5.4.0, v5.5.0 and `dev` through 862c69273; see `CHANGELOG.md` for the
per-release breakdown and the fork-specific adaptations.
