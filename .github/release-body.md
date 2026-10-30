# oh-my-copilot v5.18.2

A security and fix release for factory lanes, `copilot_run` jobs and pane
team workers, with Azure DevOps parity fixes and Copilot record/replay
groundwork, on top of v5.18.1.

Install with `npm install -g oh-my-copilot@5.18.2`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Security

- Factory lanes and SDK sessions can no longer write a worktree's `.git`
  through the built-in file tools (including `GIT~1`, NTFS alternate data
  streams and links), which could point git at a config whose
  `core.fsmonitor` ran outside the sandbox.
- `copilot_run` snapshots the common git dir (config, hooks, info,
  commondir, modules, refs, worktree admin files) and fails the job as
  `sandbox-escaped` on any change.
- Job and factory checkout branches can no longer be turned into a symref
  that moves `main`: branches move with `update-ref --no-deref`, and only
  while they are plain commit refs.
- `.claude/`, `.vscode/`, `.mcp.json`, `.husky/` and a relative
  `core.hooksPath` are refused at write time; lane changes there park at
  `protected-paths`.
- Sandboxed lane shells are denied more credential files (`gh`, AWS, npm,
  Docker, kube, gcloud and others) and, on Linux and macOS, agent and
  container sockets.
- Pane team workers refuse credential-named
  `OMC_TEAM_WORKER_ENV_PASSTHROUGH` entries, except the provider's own login.

Known gap, accepted: Copilot's built-in file write and edit tools still run
outside the sandbox, so a race between the write check and the write remains
an arbitrary-file-write window. The git dir snapshot is a detector, not a
boundary.

## Added

- `omg smoke copilot --record/--replay` and `omg smoke cassette
  verify|import`: Copilot record/replay groundwork with a fail-closed
  redaction gate. No cassettes ship yet.
- `omg:` accepted beside `omc:` in skill and agent names the model emits
  (typed slash commands stay `/oh-my-copilot:<skill>`).
- Azure DevOps live acceptance and capture scripts for maintainers.

## Fixed

- `omg factory check` works on real Azure DevOps repositories.
- Factory lanes may not edit Azure Pipelines definitions.
- ci-fix and heal on Azure DevOps get the failed job and the failing tests;
  known-flaky entries apply.
- The Azure CLI MSI layout with only `__main__.pyc` is accepted.
- Lanes keep proxy and CA settings (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`
  and similar).
- A second factory run on the same repository refuses instead of breaking
  the first.
- Skill lists, `/omc-teams` references and setup hints match the shipped
  plugin (`omg team`, `/oh-my-copilot:omc-setup`).

This release was published without the live Copilot smoke (quota exhausted).
Details are in `CHANGELOG.md`.
