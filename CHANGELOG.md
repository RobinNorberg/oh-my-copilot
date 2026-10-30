# Changelog

All notable changes to oh-my-copilot will be documented in this file.

## [Unreleased]

### Added

- **`omg factory check --parent <spec>`** checks a spec's children (the
  GitHub task list `- [ ] #n`, or the Azure DevOps child links) with their
  readiness. The `--json` shape is unchanged (`schemaVersion` 1).
- **Forge items carry their parent**: a GitHub `Part of #n` line, or an Azure
  DevOps parent link (`Hierarchy-Reverse`).
- **`omg factory run --next [--parent <spec>]`** runs the first runnable item
  in `omg factory check` order (priority, then id) among the spec's children
  or the intake source. A run parked at `blocked-by` is resumed once its
  dependencies are satisfied; nothing runnable exits 0 with the bucket counts.

### Changed

- **`omg factory run` parks at `blocked-by` until dependencies are
  satisfied.** An item with `Depends on #n` / `Blocked by #n` lines, or Azure
  DevOps Predecessor links, waits at the intake gate `blocked-by` until each
  dependency is closed, its factory PR merged into the base, or its run
  merged. An item that depends on itself parks with `blocked-by:self`
  (`omg factory check` reports it the same way) instead of waiting forever.
- **A dependency whose factory PR merged counts as satisfied.** `omg factory
  check` no longer reports `depends-on:#n` when issue `#n` is still open but
  a PR from `factory/issue-<n>` was merged into the base, or its factory run
  is `merged`. With `ship.base: dev`, `Closes #n` never closed the issue, so
  dependents stayed blocked until a release. The lookup is one new read:
  `gh pr list --head factory/issue-<n> --base <base> --state merged --json
  number`, and on Azure DevOps a pull request search with
  `searchCriteria.status=completed` and `searchCriteria.targetRefName`
  (allowed by the ADO guard as a GET only).
- **Two-axis factory review.** When the base commit of an `omg factory run` has `docs/standards/`, the review lane reviews on a spec axis (the diff against the plan) and a standards axis (the diff against the matching `docs/standards/` volume, read at the base). Each finding names its `axis`, a `blocker` or `major` on either axis fails the verdict, the PR comment gains an `Axis` column, and the fix lane sees each finding's axis. Without `docs/standards/` the review prompt is byte-identical to before.
### Fixed

- **The listener no longer starts a billed session for a nonexistent
  `diagnose` skill on CI failures.** A failed `check_suite` webhook is now
  an audited `204` discard ("CI failures are healed from workflow_run"); only
  failed push runs of `ci.yml` on the dev branch reach the heal queue (via
  `workflow_run`), and the next `omg factory heal scan` processes them;
  failures on other branches or workflows are no longer acted on by the
  listener (run `omg factory heal scan` manually). `omg factory init
  --no-narrow`, whose full template routed `success:launch` to the same
  missing skill, now refuses (exit 1, nothing written) and points at
  `omg factory run <issue>`. The default narrow table is unchanged. Interim: an existing
  `.omg/factory-routes.json` created with the old full template still routes
  `success:intent` to `launch` and `success:launch` to `diagnose` until the
  follow-up adds `omg factory init --check/--migrate`; re-run `omg factory init
  --force` (narrow) to drop them.
- **`omg ralph from-map` now reads the navigator's ticket types.** `map-frontier` took types only from `wayfinder:<type>` labels, but `ask-navigator` writes them in the issue body (`Type: research`), so every navigator ticket was human-gated. A body `Type: <type>` line is now read (`loft` counts as `prototype`, human-gated) and labels still work; when label and body disagree the more restrictive type wins, and a body type alone grants auto only on a native sub-issue of the map.

# oh-my-copilot v5.18.2

## [5.18.2] - 2026-10-30

Fork **v5.18.2** (from v5.18.1) is a security and fix release for factory
lanes, `copilot_run` jobs and pane team workers, with Azure DevOps parity
fixes and the groundwork for Copilot record/replay smokes. A lane's file
tools can no longer write a worktree's `.git`, the common git dir is
snapshotted and checked after each job, job branches can no longer be turned
into a symref that moves `main`, and pane workers refuse credential-named
passthrough variables. One gap is accepted and remains: Copilot's built-in
file write and edit tools still run outside the sandbox, so a race between
the write check and the write is still an arbitrary-file-write window. The
git dir snapshot detects tampering; it is not a boundary. Like v5.18.1, this
release was published without the live Copilot smoke (the account's Copilot
quota is exhausted). No recorded cassettes ship yet, so the replay path is
covered by unit tests with a fake client only.

### Security

- **SDK sessions can no longer write `.git` through the file tools.** The
  built-in file tools run outside the OS sandbox, and the permission handler
  approved any write under the worktree. A factory lane (or an SDK team
  worker) could rewrite the worktree's `.git` gitfile to name a git dir with
  `core.fsmonitor`, which the next unhardened git run by the runtime or a
  plugin hook executed outside the sandbox. A write to any path with a `.git`
  segment is now refused:
  - as given and after resolving links;
  - case-folded, with trailing dots and spaces stripped;
  - including 8.3 short names (`GIT~1`) and NTFS alternate data streams (any
    `:` past the drive letter).

  The permission handler also refuses a write through a link segment that
  resolves outside the worktree, or that dangles when it decides.
- **A file-tool write swapped into the common git dir is detected and fails
  the job.** The sandboxed shell could replace an approved dir with a
  junction to the common git dir before the unsandboxed file tool wrote,
  planting `core.fsmonitor` in the repository config. `copilot_run` now
  snapshots the common git dir before the session and fails the job as
  `sandbox-escaped` on any change, without moving its branch. The snapshot
  covers:
  - `config`, `config.worktree`, `commondir`, `gitdir`, `HEAD`, `hooks/` and
    `info/`;
  - the `worktrees/<id>` entries with their `config.worktree`, `commondir`,
    `gitdir` and `HEAD` (except the HEADs of jobs running alongside);
  - the submodule git dirs under `modules/`;
  - every branch, the job branches included, which the manager tracks as it
    creates, moves and deletes them.

  A worktree job whose change summary git cannot produce fails, and the
  factory parks such a lane at `protected-paths` instead of committing it.

  **Known gap (accepted).** This is a detector, not a fix. Copilot's built-in
  file write and edit tools still run outside the sandbox, so the window
  between approval and the write remains an arbitrary-file-write primitive: a
  lane that wins the junction race can write anywhere you can, such as a
  shell profile or the startup folder. The runtime's own git may also read a
  planted common config during the session, before the check runs.
- **Job branches can no longer move `main` through a symref.**
  - A `copilot_run` job's branch moves with `update-ref --no-deref`, and only
    while it is still a plain commit id. A lane that rewrote it as
    `ref: refs/heads/main` could otherwise move main to its unreviewed
    commits.
  - The factory prepare checkout used `git worktree add -B`, which writes
    through a symbolic ref, so a checkout branch
    (`omc-team/factory-run/issue-N`) rewritten as `ref: refs/heads/main` moved
    main. The engine now refuses a checkout branch that is not a plain commit
    ref and parks at `lane-tampered`.
  - An ended `copilot_run` job's attached worktree HEAD is no longer accepted
    as the new baseline. The live jobs that ignored the ended job's HEAD adopt
    its value only when it is detached; a `ref:` HEAD keeps the old baseline,
    so their shared git state check reports it.
- **Lane-protected paths gain `.claude/`, `.vscode/`, `.mcp.json` and
  `.husky/`.** A lane change there parks at `protected-paths`, like `.github/`
  and `.copilot/`, and a factory lane's file tools may no longer write them.
  - Every job refuses file-tool writes under a relative `core.hooksPath`, read
    as git resolves it in the job worktree. A job whose `core.hooksPath` git
    cannot read refuses to start.
  - The change summary now also lists ignored files under these paths, so a
    hook the shell plants in husky's self-ignoring `.husky/_/` parks the
    lane.

  These refusals gate the file tools only: the sandboxed shell can still
  write these paths during the session.
- **The lane sandbox denies more credentials and sockets.** When the host
  reports `denied_paths`, these are denied:
  - in the home: `.config/gh`, `.aws`, `.npmrc`, `.docker`, `.kube`,
    `.netrc`, `.cargo/credentials(.toml)`, `.gnupg`, `.pypirc` and
    `.config/gcloud`;
  - on Linux and macOS also `/run/user/<uid>`, the Docker and Podman sockets
    and the `SSH_AUTH_SOCK` directory (only the socket when it sits directly
    in `/tmp` or another sticky world-writable dir; never a dir that holds a
    tool dir).
- **Pane team workers no longer pass credentials through
  `OMC_TEAM_WORKER_ENV_PASSTHROUGH`.** A credential-named variable in the list
  (an AWS secret, `NPM_TOKEN`, `SSH_AUTH_SOCK` and the like) fails the worker
  start with `worker_launch_env_passthrough_credential`, reported by the
  leader before the pane runs anything. Only the provider's own login passes:
  - copilot: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`;
  - claude: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and `AWS_*` /
    `GOOGLE_*` when `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` is
    set.

  In a mixed team, another provider's login is skipped for a worker rather
  than failing its start.

### Added

- **Copilot record/replay groundwork for `omg smoke copilot`.** Tier 2
  scenarios can be recorded once and replayed for free. No cassettes ship
  yet.
  - `omg smoke copilot --record <dir> [--record-overwrite]` and
    `--replay <dir> [--replay-strict]` (each implies tier 2). Replay pins the
    model the cassettes were recorded with, never falls through to live, and
    skips a scenario that has no cassette. Recording is refused under `CI`,
    without `--model`, into `fixtures/cassettes`, or onto an existing
    cassette without `--record-overwrite`. `copilot -p` scenarios are
    refused in both modes. Every check runs before any spend.
  - `omg smoke cassette verify <dir> [--gate-only]` runs the redaction gate
    and a free replay; `omg smoke cassette import <dir> [--to <dir>]
    [--overwrite]` imports verified cassettes. A passing `--record` runs
    verify on its new cassettes at once.
  - The runtime's model requests go through the SDK `requestHandler` seam
    (`@github/copilot-sdk` >= 1.0.16, required in replay). Replay strips
    credentials, sets a dummy `COPILOT_HMAC_KEY`, never calls upstream, and
    answers a miss with 418. WebSocket transport is refused in both modes.
  - The cassette format (v1) fails closed: the writer runs the redaction gate
    over the serialized text and writes nothing when a secret, a
    non-allowlisted header or a deny-set literal remains. A cassette carrying
    a `REDACTION-FAILED` marker, an unknown version or a symlink is refused.
  - The matcher binds each live stream to a recording by prompt digest,
    serves strictly in order, claims streams across processes, and reports
    misses and drift (drift fails only under `--replay-strict`).
- `omg:` is accepted beside `omc:` when oh-my-copilot normalizes a skill or
  agent name the model emits (for example `omg:plan` in a Skill call), in
  delegation enforcement, alias resolution and keyword detection. Copilot CLI
  itself registers plugin skills only as `/oh-my-copilot:<skill>`; a typed
  `/omg:…` or `/omc:…` gets Copilot's "Unknown command".
- Azure DevOps live acceptance and capture scripts for maintainers
  (`scripts/ado-acceptance.mjs`, `scripts/ado-capture.mjs`,
  `scripts/ado-fixture-import.mjs`; see "Live acceptance on Azure DevOps" in
  REFERENCE.md). Not yet run against a real organization.

### Changed

- **Sandboxed `copilot_run` and factory lanes keep proxy and CA settings.**
  `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`,
  `SSL_CERT_FILE` and `SSL_CERT_DIR` stay in the runtime env, so the runtime
  reaches Copilot behind a proxy or a private CA.
  - The `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` bundle files themselves
    (not their dirs) and each `SSL_CERT_DIR` entry are granted read-only.
  - A cert dir that is a root or holds the home is not granted, and a CA path
    that does not resolve is dropped, both with a note, instead of failing
    the sandbox config.
  - A proxy URL with credentials is not stripped; the job records a note,
    because the lane shell inherits it.
- **One factory engine per repository.** A second `omg factory run` (or
  ci-heal run) on a repository where another engine is live refuses with a
  message naming that run, instead of tripping the first run's shared git
  state checks and failing its lanes. A dead engine's lock on this host is
  taken over.
- `omg factory heal` reads CI history through the forge's CI interface
  (`ForgeCi`) instead of calling `gh` directly. No behavior change on GitHub;
  this is the seam for Azure DevOps heal.

### Fixed

- **`omg factory check` works on Azure DevOps.** The command built its az
  guard without the forge repo and the az entry, so every az call on a real
  ADO repository was refused ("no Azure DevOps forge is configured for this
  run"). The az entry is now resolved once; the guard and the adapter both
  get it.
- **Factory lanes may not edit Azure Pipelines definitions.** A write lane
  could change `azure-pipelines.yml` (or `.azure-pipelines/`,
  `.azuredevops/`, `.pipelines/`), the CI that gates its own PR, and turn a
  red build green. These paths are now lane-protected, and on Azure DevOps a
  PR touching them needs the owner. The paths are protected for lanes on
  GitHub repositories too (intended: a repository may run both CIs).
  `omg ship`'s protected paths are unchanged.
- **Failing tests and known-flaky entries apply to Azure DevOps builds.** A
  failed blocking build check now names its failed job (the newest attempt),
  and Azure Pipelines log timestamps are stripped before parsing.
  - The ci-fix lane gets the failing test titles, known-flaky entries apply,
    and heal signatures name the failing tests instead of collapsing every
    failure into the step's `##[error]` line.
  - A build with more than one failed job names none: one job's known-flaky
    log never excuses another's real failure.
  - An `##[error]` in another step of an Azure Pipelines log (split on
    `##[section]Starting:`) still blocks the known-flaky verdict.
  - The known-flaky suggestion on Azure DevOps points at the build to
    re-queue instead of `gh run rerun`.
- **Azure CLI resolution accepts the current MSI layout.** An MSI that ships
  only `azure\cli\__main__.pyc` (no `__main__.py`), as the current installer
  does, is accepted. Before, every live ADO az call refused with "not the MSI
  layout".
- **Skill names and setup hints match the shipped plugin.**
  - The shipped `copilot-instructions.md` skill list and keyword triggers
    match the Tier-0 workflows; retired entries (`ultrawork`, `cccg`,
    `ultraqa`, `sciomc` and similar) are removed. The setup script uses `omg`
    launch wording.
  - Autopilot, cancel and team guidance no longer point at the retired
    `/omc-teams`; autopilot suggests `omg team` or `/oh-my-copilot:team`.
  - Setup hints (session start, HUD diagnostic, README) use
    `/oh-my-copilot:omc-setup`, `/oh-my-copilot:omc-gh-triage` and
    `/oh-my-copilot:omc-ado-sprint`; the plugin update hint uses the
    `copilot plugin` commands.

# oh-my-copilot v5.18.1

## [5.18.1] - 2026-10-29

Fork **v5.18.1** (from v5.18.0) is a security and fix release for headless
`omg team` SDK workers. Workers now start without the leader's credentials,
keep their own Copilot home, and fail fast when their provider has already
exited. Workers are still not sandboxed: the env reset and the extra shell
denies are hygiene against accidental use, not a boundary. Like v5.18.0, this
release was published without the live Copilot smoke (the account's Copilot
quota is exhausted); the token-only CI path for SDK workers, where the
Copilot token now reaches the session over RPC, is covered by unit tests
only so far.


### Fixed

- **Team worker starts fail fast when the provider already exited.** The
  provider-start wait now returns as soon as the attempt has a terminal
  record, a supervisor completion marker, or a started pid that is dead,
  instead of waiting out the full ack timeout (8 s for a pane, 30 s for an
  SDK host). An SDK host that fails, dies or is retired during start is
  reported within about 1.5 s; one that fails after `provider_started` as
  `sdk_host_failed_at_start:<last_error>`.

### Security

- **SDK team workers start credential-free.** This is hygiene against
  accidental use, not a sandbox.
  - The detached host, the worker runtime and its shells no longer inherit the
    leader's tokens and cloud credentials. Gone are `COPILOT_GITHUB_TOKEN`,
    `GH_TOKEN`, AWS keys, Azure, npm, `ANTHROPIC_API_KEY`, ssh-agent, askpass,
    webhook and database URLs, every other secret-named variable, `GIT_CONFIG*`
    and `GCM_*`. This holds also when they come through the worker env.
  - `gh` and `az` see an empty config dir.
  - git runs no credential helper and never prompts. It sends no configured
    extra header, which clears a CI checkout's URL-scoped job token, and it
    uses no ssh-agent.
  - The leader hands the Copilot token to the host on stdin, and the host
    passes it to the session over RPC.
  - A worker with neither a stored Copilot login nor a token now fails to start.
- **Wider secret-name match, for credential-free factory lanes too.** Team
  workers and credential-free factory lanes now also drop these variables:
  - names with `WEBHOOK`, a whole-segment `AUTH`, `_DSN`, `_PWD`;
  - connection strings;
  - database and broker URLs (`DATABASE_URL`, `POSTGRES_URL`, `REDIS_URL`,
    `AMQP_URL`, `CELERY_BROKER_URL`, `MONGODB_URI`);
  - package index URLs (`PIP_INDEX_URL`);
  - bundler's `BUNDLE_<HOST>__<TLD>`;
  - `DOCKER_AUTH_CONFIG`.

  Notification hooks, and tests that need a webhook, DSN or database URL,
  no longer get those values inside a worker or lane.
- **SDK workers keep their own Copilot home.** The leader's `COPILOT_HOME` and
  `COPILOT_MODEL` no longer override the per-worker home and model.
- **More credential reads denied in team workers.** The shell policy also
  refuses these commands:
  - `git credential fill`/`approve`/`reject`;
  - `git config … extraheader`;
  - `gh auth token`, `gh auth git-credential` and `gh auth status --show-token`;
  - `az account get-access-token`.

# oh-my-copilot v5.18.0

## [5.18.0] - 2026-10-29

Fork **v5.18.0** (from v5.17.1) is a minor release with three themes. The
factory now works against more than GitHub: **forges** put GitHub and Azure
DevOps behind one forge interface, `omg factory setup` writes the config,
`omg factory check` reports which issues are ready to run, the factory
engine runs on Azure DevOps, and opt-in progress sync writes the run's stage
back to the issue or work item. Sandboxed factory lanes are harder to abuse:
Windows lanes can start `node` and `git`, lanes write only their private
home and temp directories, and Azure and Git credentials stay out of lanes.
Two flaky tests are fixed, one of them a real crash-resume bug. Be aware of
two limits. The Azure DevOps adapter is tested only against documented
sample responses, not yet against a live organization, and the factory is
still **experimental**. Merge stays a human step: the factory never
completes a PR and its command guard refuses `gh pr merge`.

### Added

- **Forge interface for the factory.** Forge types, a trusted config
  resolver, plan rules and a shared Azure DevOps base (routes, HTML
  conversion, `az` binary resolution, fixtures) sit under `src/forge/` (#330).
  Chain-side `gh` calls go through a GitHub chain tracker (#331), and the
  GitHub adapter is a byte-for-byte move with the `gh` argv baseline tests
  (#329) and release tests unchanged (#334).
- **Azure DevOps adapter.** It talks to Azure DevOps through `az devops
  invoke` only, behind a guard with an exact route allowlist, guard-owned
  request bodies, an exact-head rule, a PAT redactor and hardened `az`
  resolution (#332).
- **`omg factory setup`.** A wizard picks the forge, intake and progress
  settings and writes them to the project `.copilot/omg.jsonc`; the user
  config holds only `trustedAuthors`. The preview shows the real readiness
  buckets and redacts adapter errors (#333).
- **`omg factory check`.** It sorts issues into runnable, needs-plan and
  blocked, and `--mark` records the result (#335).
- **Factory engine on Azure DevOps.** `omg factory run` uses the Azure DevOps
  repo identity and the exact PR head (allowing for ancestor lag), refuses to
  resume a run whose forge kind or repo changed, hashes the merge body with
  SHA-256 and checks that the base is trusted (#336).
- **Factory progress sync (opt-in).** `omg factory run` can write the run's
  stage to the issue or work item. A stage is one of queued, building,
  reviewing, verifying, ready-to-merge, done, blocked or cancelled (#337).
  - On GitHub the stage is one label from the exclusive `factory:<stage>`
    family.
  - On Azure DevOps it is the mapped board column and/or state, sent as one
    JSON-patch guarded by `test /rev`. A rev conflict is retried once.
  - Sync is off unless the user config or the base-branch
    `.copilot/omg.jsonc` has a `factory.progress` section, which
    `omg factory setup` writes. Existing runs change nothing until you run
    setup, and the config must be committed to the base branch.
  - There is at most one tracker write per stage, recorded as `trackerStage`
    in the sealed run state.
  - A failed write is only a warning and a history note; it never blocks a
    transition. A missing GitHub label points to `omg factory setup`.
  - The factory guard allows `gh issue edit` only with
    `--add-label`/`--remove-label` of `factory:*` labels.
- **Sandbox spawn canary.** The free smoke check now launches real programs
  (`node --version`, `git --version`, and on Windows Git's `sh.exe`) through
  the lane env, policy and tool grants, and passes only when the launch is
  attested as sandboxed (#321, #322, #323).

### Changed

- **Lanes get explicit read-only tool grants.** With `allowDevToolAccess`
  off, Windows lanes could not start `node.exe` or `git`. Lanes now get
  read-only grants for the `node` directory and the Git for Windows root,
  never read-write, and a tool dir that is a filesystem root or contains the
  worktree, git dir, job dir or real home is dropped (#322, #323).
- **Lanes write only their private home and temp.** The sandbox grants
  `<jobHome>/tmp` and `<jobHome>/profile` read-write instead of the whole
  job dir. The runtime cache moves to `<jobHome>/.cache/copilot`, the lane's
  global git config to a read-only `<jobHome>/git/config`, and the node
  compile cache is off (#324).
- **Sandbox smoke checks need positive evidence.** `review_no_write`,
  `write_outside_blocked`, `q1_profile` and `q2_git_dir` pass only on a
  successful shell call or the probe's output line, and the lane model is
  pinned (#321).
- **The Azure DevOps skills use real routes.** The skills and `getPRDiff`
  called `az` commands that do not exist. They now use `az devops invoke`,
  and the diff comes from `refs/pull/{id}/merge` (#326).

### Fixed

- **Windows lanes could launch no process.** Copilot CLI 1.0.105's sandbox
  rejects every launch unless `LOCALAPPDATA` (and `SYSTEMROOT`) are in the
  runtime env. `LOCALAPPDATA` is now allowlisted, `COPILOT_CACHE_HOME` is
  pinned into the job home, and a Windows sandboxed job refuses at start
  with the missing variable named (#321).
- **A crash could leave a graph run that would not resume.** If the
  atomic writer was SIGKILLed while it held a rollback hard link,
  `projection.json` or the fence's `owner.epoch` kept two links, and the run
  was refused as not a private regular file on every later resume. One shared
  cleanup now removes stale `<name>.rollback.<uuid>` links (and, once the
  fence is held, `.<name>.tmp.<uuid>` leftovers) before the read; only
  regular files are removed, and an outside hard link is still refused (#338).
- **Flaky tests.** The team launch-ack and nudge tests were races in the
  tests themselves, not product bugs, and are now deterministic under load
  (#339). The `runtime-cli` pre-deadline tests are deflaked (#338).
- **`release-boundary.mjs` ignored a bad argument on Windows.** Its main
  guard compares real paths, so `node scripts/release-boundary.mjs bogus`
  exits 1 (#323, #324).

### Security

- **Lane credentials are scrubbed.** Azure and Azure DevOps credentials stay
  out of lanes: `AZURE_CONFIG_DIR` points to an empty directory, the Git
  Credential Manager helper is disabled, and a deny rule blocks
  `-c credential.*` (#327).
- **The SDK policy checks every path field.** It refuses `..` segments,
  hard-linked or non-regular write targets, and requests whose path fields
  name different targets, and checks containment on every field (#325, #328).
- **`events.jsonl` cannot be forged from a lane.** The engine opens it once
  with exclusive create and no-follow before the runtime starts and fails
  closed if it already exists. Before this, a Linux or macOS write lane could
  replace it with a link and get host code execution (#324).
- **Hook debug logs do not follow links.** All five `*-debug.log` writers use
  a no-follow append that refuses symlinks, junctions, non-files and
  multiply-linked files (#323, #324).
- **Lane TEMP is private** to the job (#322).

### Known limitations

- The Azure DevOps adapter has run only against documented sample responses.
  Route names, the build-log form, the field that carries the PR head and the
  policy keys are unverified against a live organization.
- Git hooks cannot run in Windows lanes: Git's `sh.exe` exits with
  `STATUS_DLL_INIT_FAILED` inside the sandbox on CLI 1.0.105. The canary
  reports it without failing.
- Three runtime-owned directories stay lane-writable (tmp, profile, and the
  session `files` directory), and the runtime follows links in them.
- Team SDK workers still get the full `process.env`, and Git Credential
  Manager exposure in Linux and macOS sandboxes is unprobed.
- `factory listen`, `factory heal` and the factory-run smoke are GitHub-only;
  on Azure DevOps they refuse. `omg factory board` and GitHub Projects v2
  intake and progress are not part of this release.

# oh-my-copilot v5.17.1

## [5.17.1] - 2026-10-28

Fork **v5.17.1** (from v5.16.0) is the first published release of the 5.17
line. v5.17.0 was tagged but never published: its tag run failed the release
boundary while building the staged archive, so nothing reached npm or GitHub
Releases. Everything listed under 5.17.0 below ships in
5.17.1, together with the fix that follows. Upgrade from v5.16.0 directly;
there is no v5.17.0 package to install.

### Fixed

- **The package archive passes the release boundary again.**
  `src/factory/heal/evidence.ts` compiled to `dist/factory/heal/evidence.js`,
  a name the release boundary rejects as an operational artifact, so the
  v5.17.0 staged archive failed. The module is now `heal-evidence`, and the
  boundary rule is unchanged. A new test,
  `src/__tests__/release-archive-paths.test.ts`, runs the same rule over
  every packaged tracked file and the dist output of every tracked source, so
  a forbidden name now fails the normal suite instead of the tag run (#318).

# oh-my-copilot v5.17.0

## [5.17.0] - 2026-10-28

Fork **v5.17.0** (from v5.16.0) is a minor release with four themes. Release
and ship gates now drive themselves to a terminal state, and `omg port drive`
automates an upstream port up to a draft PR. The factory engine, still
**experimental**, now runs `omg factory run <issue>` from the independent
review through ship's prepare step and the CI gates to
`awaiting-human: merge`. Factory lanes run in the Copilot OS sandbox, and the
engine commits for write lanes with hardened git. Self-healing CI classifies
red `dev` runs, diagnoses one in a read-only debugger lane, and turns an
approved diagnosis into a `ci-heal` run. Merge stays a human step everywhere:
there is no auto-merge, and the engine's command guard refuses `gh pr merge`.
See the [migration note](docs/MIGRATION.md#unreleased-omg-factory-run).

### Added

- **`--drive` and `--detach` for `omg release` and `omg ship gates`.** A drive
  runs until done, a real failure or a human decision. A CI wait past
  `--timeout` or a transient GitHub error (5xx, GraphQL "Something went
  wrong") is resumed after one minute, up to `--drive-max` (default 6 h).
  `--detach` runs the driver as a detached process behind a single-driver
  lock; `--status` and `--stop` inspect and end it. Every phase and wait
  writes progress events. Drive never implies `--yes`, so the tag phase still
  needs your confirmation, and the merge rule is unchanged.
- **Smoke reuse in `omg release`.** A green Tier 2 smoke is reused when the
  hash of the shipped inputs (dist, bridge, hooks, agents, skills, commands,
  copilot, scripts, templates, manifests and lock file) is unchanged, so a
  test-only rebuild needs no `--allow-skipped-smoke`. `--force-smoke` always
  runs it, and a red smoke clears the record.
- **Flake triage in the release suite.** Each new failing test reruns alone
  three times. Three passes is load-flaky (ok with a warning), three failures
  is real (fail), and a mix blocks. Candidates are written to
  `.omg/release/<v>-flaky-candidates.json` for the owner; nothing writes
  `.github/known-flaky-tests.json`.
- **`omg port drive`.** It applies an upstream head, drops junk, classifies the
  package delta, writes a conflict brief, optionally runs a paid reconcile
  lane (`--reconcile-lane --max-credits N`), runs the gates, commits with the
  inventory last, pushes `port/upstream-<sha>` and opens a **draft** PR. A
  non-version package delta, conflicts without a lane or in release, ship,
  installer or permission paths, leak hits and leftover conflict markers stop
  at a human gate (exit 3). The reconcile lane is tamper-checked, and every
  host git and gh call goes through a hardened allowlist.
- **`omg factory heal` (experimental).** `heal scan` classifies new red
  `ci.yml` runs on `dev` by failure signature: infra, known-flaky, history,
  environment change or regression. It makes no LLM call and no GitHub write.
  `heal run <sig8>` builds a capped, redacted evidence bundle and diagnoses it
  in a read-only debugger lane, then parks at `heal-approve`. `heal approve`
  starts a `ci-heal` run from the sealed diagnosis on `factory/heal-<sig8>`,
  which goes through review, prepare and gates to the human merge gate.
  `heal status`, `heal cancel` and `heal close` complete the set. A
  `workflow_run` webhook (HMAC-verified) can enqueue a scan. Daily run, lane
  and credit caps are reserved before each lane starts, and known-flaky
  additions are only ever printed as proposals.

- **Prepare, gates and the human merge gate for `omg factory run`.** After an
  approve verdict the engine marks the PR ready and runs ship's prepare in an
  engine-owned checkout, then pushes the housekeeping commits itself. A gates
  driver loops ship's `watchGates` in-process and accepts a read only for the
  head the engine pushed. Green gates go to ship's merge rule, which comments
  the exact merge command on the PR. Rerun the engine after you merge, and it
  finishes as `merged`.
- **`conflict-fix` and `ci-fix` lanes.** A base merge that conflicts outside
  `inventory/` gets up to 2 conflict-fix rounds. A real check failure gets one
  ci-fix round with the failing check names and test titles. Both go back
  through publish and a new review.
- **`omg factory run clean <issue>`** removes the lane worktrees and the
  prepare checkout of a merged or cancelled run. It keeps anything dirty or
  holding commits that no verified ref holds, and never deletes the PR branch.
- **`factory.run.gatesTimeoutMinutes`** (default 90) bounds the gates phase.
- **Tier 2 smoke scenarios `factory-run` and `factory-run-fix`** (opt-in,
  never in `all`): the engine in-process with real implement and review lanes
  against a sandbox repository, a bare `origin` and a scripted `gh`, up to the
  merge gate. They are estimated at about 2 and 4 AI credits.
- **Sandbox smoke.** A new SDK static check, `sdk.sandbox`, makes no model
  call. It reports whether the host supports the Copilot OS sandbox, applies
  `copilot_run`'s review policy and reads its enforcement. The opt-in
  `sandbox-lane` scenario, never in `all` and estimated at about 3 AI credits,
  runs a review, a write and a canary lane in the sandbox. It checks that the
  review lane cannot write, and that the write lane cannot write outside its
  grant or reach the network. It checks that the engine commits the write
  lane's change, and it answers open questions Q1, Q2 and Q5 of the design
  with one result line each. The Linux CI smoke job installs `bubblewrap`,
  `slirp4netns` and `uidmap`, so the probe there reports `supported`.
- **A sandboxed lanes reference**: modes, lane rights, config keys,
  `detect-only`, the git 2.41 floor, host git hardening, open questions and
  residual risks.
- **The full `omg factory run` reference**: phases, state and resume rules,
  every human gate, config, the security model and the cost model.

### Changed

- **Release and ship gates check the head.** In `pr`, gates wait until the
  PR head equals the pushed HEAD; in `promote`, until it contains the dev
  merge. Only runs for the current head count, and the head is re-checked on
  every verdict. This fixes a false stop on a stale run.
- **`eslint src` (0 errors) is a release gate**, and the path gate scans
  tracked and untracked-but-not-ignored files instead of the whole tree.
- **`gh pr merge` is retried** up to twice on GitHub 5xx or GraphQL "Something
  went wrong" errors. Policy and conflict errors fail at once.
- **The `merge` park replaces the `prepare` park.** It exits 0, as the
  `prepare` park did. Other `awaiting-human` stops still exit 4. A run parked
  at `prepare` by v5.15.0 goes on when you rerun it.
- **Prepare runs under the tamper checks.** Prepare's checks run the PR's own
  code, so the engine snapshots the shared git state around them like a lane.
  A crash between prepare's push and its record repeats nothing.
- **Behaviour change: write lanes refuse to run without an OS sandbox.** An
  `omg factory run` write lane (implement, fix, conflict-fix, ci-fix) whose
  Copilot sandbox is not confirmed parks at `awaiting-human:
  sandbox-unavailable` instead of running unsandboxed. Set
  `factory.run.sandbox.writeUnsandboxed: "detect-only"` in your user
  `omg.jsonc` to run it anyway. The engine then warns, records
  `sandbox.mode: "detect-only"` on the lane, and says so in the PR body. A
  repository config cannot set it. A review lane without a confirmed sandbox
  runs with no shell. The same settings apply to `copilot_run` jobs as
  `copilotRun.sandbox`, and a repository config can only tighten them. See
  [Sandboxed lanes](docs/REFERENCE.md#sandboxed-lanes).
- **The engine commits for write lanes.** A write lane's sandbox keeps the git
  directory read-only, so the lane leaves its changes uncommitted. After the
  lane ends and passes the tamper check, the engine commits them with hardened
  git: no hooks, no filters, and a fixed `omg factory` identity, with the
  lane's final message as the commit message. It refuses an empty change, a
  merge-rule path, a nested repository (`sandbox-escaped`), or a lane that
  committed itself. A conflict-fix lane starts from the engine's merge of the
  base with the conflict markers in place, and the engine commits the
  resolution as the merge of both. Each lane's sandbox state is recorded in
  the run state. A detect-only lane after the PR exists gets a PR comment.
- **Write lanes may not change agent instructions, hooks, skills or CI.** The
  engine also refuses a lane change to `.github/`, `.copilot/`, `.omg/skills/`,
  `.omc/skills/`, `AGENTS.md` or `CLAUDE.md` (`protected-paths`). `omg ship`
  keeps its own list.

### Security

- **The engine commits nothing a lane linked in from outside its worktree.**
  Git for Windows follows a directory junction in `git add -A`, and the
  engine's git runs with your read rights, so a lane could have had the
  engine commit and push files such as `~/.ssh`. The engine now refuses a
  directory link (any link on Windows), a new symlink, or a staged path whose
  real folder is outside the worktree. The lane parks at `sandbox-escaped`
  with the path named, and the index is reset. The lane's commit message
  loses skip-CI markers, its own trailers (`Co-authored-by`, `Signed-off-by`,
  `skip-checks`) and invisible format characters.
- Lanes run in the Copilot OS sandbox, which confines their shell commands
  and local MCP servers. Built-in file tools, plugin hooks and team workers
  are not OS-sandboxed, and some sandbox behaviour is still unverified (open
  questions Q1, Q2 and Q5, which `--scenario sandbox-lane` answers). So the
  tamper checks, the engine's own state record and hardened engine git stay,
  and a human merge always comes last. The team merge paths still run
  unhardened git in worker worktrees: do not use them with sandboxed lanes.
- **CI logs are untrusted input to `omg factory heal`.** Reads are capped,
  logs are only regex-matched, and the evidence bundle redacts token shapes,
  AWS keys, Bearer values, URL userinfo and PEM blocks, and fences every file
  with a per-run delimiter. The debugger lane's environment drops GitHub
  tokens, secret-named variables, ssh-agent and credential helpers. The heal
  subject (including its `source`) is sealed out of the repository, and the
  record hash is documented as an integrity hash, not a tamper proof.

Upgrade notes are in
[MIGRATION.md](docs/MIGRATION.md#unreleased-omg-factory-run).

# oh-my-copilot v5.16.0

## [5.16.0] - 2026-10-27

Fork **v5.16.0** (from v5.15.0) is a minor release: a HUD overhaul for Copilot
CLI. The HUD now detects whether Claude Code or Copilot CLI is calling it, from
the shape of the statusline payload. Claude Code output is unchanged apart from
the label. Under Copilot the HUD stops showing Claude-only data, prints the
right update command for your install channel, and reads real Copilot data:
session time, context, AI credits, and agent, skill and tool counts.

### Added

- **New HUD elements for Copilot CLI.** `copilotMode` shows `mode:plan`,
  `mode:autopilot` or `mode:yolo` (combined as `mode:plan+yolo`), from
  `session.mode_changed` events and the payload's `allow_all_enabled`. `team`
  shows a live `omg team` run, and `ultragoal` shows open plan progress. All
  three are on under Copilot and off under Claude Code unless set to `true`.
  `team` and `ultragoal` show repo-wide state, not per session.
- **Real Copilot data.** Session duration and context % come from the
  statusline payload. Without a `softLimit`, `creditBudget` shows the session's
  AI credits as `cr:0.4`, with two decimals below 0.1 credit and hidden at
  exactly zero. Agent, skill and tool-call counts are read from the session's
  `events.jsonl` (the last 4 MB, so counts undercount in very long sessions).
  The effort level, when shown, comes from the latest session start, resume or
  model-change event.

### Changed

- **Host detection.** The HUD tells the hosts apart by payload fields: Copilot
  sends `ai_used`, `allow_all_enabled`, `remote.connected` and
  `cost.total_premium_requests`; Claude Code sends `output_style`,
  `exceeds_200k_tokens`, `rate_limits` and a `.claude/projects` transcript.
  When neither decides, the environment is checked, then Claude. Claude Code
  output is byte-identical except for the label and the `omc` to `omg` wording
  in the update hint.
- **One label.** The label reads `[oh-my-copilot#version]` on both hosts.
  `omgLabel` is the layout element and `omcLabel` is still accepted; listing
  both renders the label once.
- **Copilot hides what its footer already shows.** Under Copilot, `model`,
  `effort`, `cwd` and `gitBranch` default to off. Set one to `true` under
  `omcHud.elements` in `~/.copilot/settings.json` to keep it.
- **Claude-only elements are off under Copilot.** `rateLimits`,
  `enterpriseMode`, `showEnterpriseCost`, `apiKeySource`, `thinking`, `todos`
  and `sessionSummary` are forced off even when configured, because they have
  no data source there. The Claude Code version check, label and hint no longer
  appear, and the SessionStart hook skips the `@anthropic-ai/claude-code`
  fetch and the Anthropic usage work.
- **Update hints name the right command for your channel.** A Copilot plugin
  install (`~/.copilot/installed-plugins/`) reads its latest version from
  `marketplace.json` on `main` and gets:

  ```
  copilot plugin marketplace update omc && copilot plugin update oh-my-copilot@omc
  ```

  An npm install gets `npm i -g oh-my-copilot@latest`. `omg update --check`
  follows the same rule. Whether `plugin update` refreshes the marketplace on
  its own is unverified, so the hint keeps the explicit refresh.
- **The update check is cached for 6 hours** (was 24), refreshed early when the
  installed version or channel changes. The HUD uses a cached hint only when it
  came from the HUD's own channel and installed version.
- **Per-element isolation.** Each HUD element renders inside its own guard, so
  an element that throws is dropped and the rest of the line still prints. The
  HUD no longer goes blank.
- The tmux rate-limit detector matches both `[oh-my-copilot#...]` and the old
  `[OMC#...]` label.

### Fixed

- **`omg update --check` queried the wrong repository.** It looked at
  `Yeachan-Heo/oh-my-copilot` and now queries `RobinNorberg`.
- **The Claude Code update hint no longer appears under Copilot.** The HUD had
  compared Copilot's own CLI version with the newest Claude Code release, so
  the hint always fired, and plugin installs always got the npm command.
- **A Copilot plugin install gets the plugin command**, not `npm i -g`, and the
  wording says `omg` instead of `omc`.

Upgrade notes are in
[MIGRATION.md](docs/MIGRATION.md#unreleased-hud-host-detection-and-copilot-defaults).

# oh-my-copilot v5.15.0

## [5.15.0] - 2026-10-27

Fork **v5.15.0** (from v5.14.0) is a minor release. It adds the first part of
the factory engine, **experimental**: `omg factory run <issue>` drives one
GitHub issue through plan, implement lane, draft PR, an independent review lane
and fix rounds, then parks at `prepare` behind a human gate. The prepare step,
the gates driver and the merge gate arrive in later releases. The run starts
only when you start it by hand, and merging is always a human step: there is no
auto-merge anywhere. The release also closes a hole in the team worker push
rule that was already exploitable.

### Added

- **`omg factory run <issue> [--dry-run] [--json]`** (experimental). The engine
  reads the issue and its plan, runs an implement lane in its own worktree,
  pushes `factory/<issue>` and opens a draft PR, then runs a fresh review lane
  on the exact head sha. A changes-requested verdict starts a fix round on a
  fresh lane, up to `maxFixRounds`. The run then stops at
  `awaiting-human: prepare`. `omg factory run status <issue>` shows the
  persisted state and `omg factory run cancel <issue>` stops the engine and its
  lane while keeping the PR, branch and worktrees. Rerun the same command to
  resume after any `awaiting-human` stop. The issue needs an
  `Acceptance criteria` heading or an `omg-plan: <repo path>` line; the line is
  honoured only from an OWNER, MEMBER or COLLABORATOR author, otherwise the run
  stops at `awaiting-human: needs-plan`.
- **A mandatory AI-credit cap per lane.** `factory.run.laneMaxCredits`
  (default 30, which is also Copilot CLI's minimum) caps every lane, and the
  engine refuses to start a run without it. The optional
  `factory.run.maxRunCredits` stops the run at `awaiting-human: budget`,
  checked at step boundaries. Both keys come from the user config; the project
  config can only lower them. Lane credits go to the ledger for reporting only.
- **Per-run time and retry limits.** Lane and run wall time, retries per phase
  (a lost lane is respawned once), `maxFixRounds` and a single ci-fix round.
  The plugin still enforces no budget (see v5.14.0); these are limits on one
  unattended run.
- **`copilot_run` additions**, all backwards compatible for MCP callers:
  - `startRef` creates the job worktree at a validated commit instead of
    `HEAD`. A ref that starts with `-`, holds whitespace or control characters,
    is longer than 256 characters or does not resolve to a commit is refused
    before anything is created; only the resolved sha reaches
    `git worktree add`.
  - `profile: "review"` denies the write tool and every git command that
    changes the tree, its refs or its config, including aliases, `-c` and
    `--config-env`, and quoted or full-path git binaries. The default profile
    is `write`.
  - `allowLive` is an in-process opt-in that the MCP handler cannot pass.
    Factory lanes use it instead of `OMG_COPILOT_RUN_ALLOW`, which sessions
    never inherit.
  - Lanes set `OMC_SKIP_HOOKS=persistent-mode,workflow-drift-guard,code-simplifier`
    so no Stop block spends an extra billed turn. The `code-simplifier` hook now
    honours `OMC_SKIP_HOOKS`.
- **Lane interface** (`LaneBackend`: start, poll, wait, cancel), with
  `CopilotLaneBackend` on top of the `copilot_run` manager. Ledger records are
  keyed `factory-lane:<laneId>` and count AI credits.

### Security

The engine assumes any lane may be prompt-injected, because lanes run Copilot
with a shell and read untrusted issue and PR text. The running engine is the
only trusted party.

- **Engine-held state record.** The engine keeps the exact bytes of every state
  file it writes in memory and in a sidecar under `~/.omg/factory-ledger/`
  (or `$OMC_STATE_DIR/factory-ledger/`). Any other change stops the run at
  `awaiting-human: state-tampered`, and the engine restores its copy. A ship
  approve counts only when the engine recorded it from its own review lane
  (job id, head sha and verdict hash).
- **Tamper checks around every lane**, write or review, on the common git dir:
  refs, config, `hooks/`, `info/`, `worktrees/`, `modules/`, alternates, the
  global git config and its includes, both HEADs, the lane's changes and
  untracked deletions, and a bounded set of ignored files. Any change stops the
  run at `review-tampered`, `lane-tampered` or `state-tampered`, drops the
  verdict and pushes nothing.
- **Hardened engine git.** The engine's own git runs with an empty
  `core.hooksPath` and `core.fsmonitor=false`, and the change summary
  neutralises filter drivers.
- **Confirmed lane end.** Comparisons run only after a confirmed terminal
  state. A lost lane's Copilot child must be dead (pid plus start-time
  identity) or killed, otherwise the run stops at `lane-unconfirmed`. Unknown
  usage counts as the full lane cap.
- **Narrow pushes and verdicts.** The engine pushes only
  `<sha40>:refs/heads/factory/<issue>` to origin, never a name taken from issue
  text. Draft PRs are created without a shell. A verdict is exactly one
  trailing JSON block from the review lane's final message on the exact head
  sha; quoted or fake blocks are rejected, an approve with blocker or major
  findings becomes changes-requested, and the implementer can never approve.
- **Lanes are not sandboxed.** A lane whose shell reaches your home directory
  can still rewrite the engine's record there. The checks narrow that and a
  human gate always precedes the merge. Running lanes under Copilot CLI's
  `--sandbox` is a planned follow-up.

### Fixed

- **Team worker push rule.** The `git push` denial in `omg team` sdk workers
  could be bypassed through git aliases, quote-split spellings, quoted
  full-path git binaries, `send-pack`, `http-push` and `subtree push`. All are
  now refused. This was exploitable on v5.14.0 and earlier.
- **Git 2.56 wording.** Git 2.56 reworded the error for a `.git` file that
  points at a non-repository (`fatal: gitfile does not point to a valid
  repository`). The stderr classifiers knew only the old text and failed
  closed as `probe_failed`, which showed up as the "flaky"
  `state-tools-nongit-ownership` test in CI. All four matchers now accept both
  wordings. This fix is also in 5.14.0's build, but 5.14.0's notes did not
  mention it.

### Known limits

- A regex denylist cannot catch `git $p`, `$(...)` or direct writes to
  `.git/config`; the engine's tamper checks cover those after each lane.
- Git include targets are read without an lstat or size cap, so
  `include.path=/dev/zero` can hang the after-lane snapshot. It fails closed.
- Global `git/ignore`, `attributes`, `core.excludesFile` and
  `core.attributesFile` targets are not hashed.
- The Windows process-tree kill can miss orphaned grandchildren.

# oh-my-copilot v5.14.0

## [5.14.0] - 2026-10-27

Fork **v5.14.0** (from v5.13.1) is a minor release with a **breaking
change**. GitHub Copilot has billed in AI Credits since 2026-06-01
(1 credit = $0.01, charged per token), so the budget now counts AI credits,
and the plugin no longer enforces a budget. `omg team` does not clamp or
refuse fan-out, and the old enforcement settings are deprecated no-ops. Cap
spend with Copilot's own per-session limit (`copilot --max-ai-credits`) and
Copilot admin budgets instead (see the
[migration note](docs/MIGRATION.md#unreleased-budget-unit-is-ai-credits)).

### Breaking

- **Budget enforcement is retired.** `omg team` no longer clamps or refuses a
  launch on budget, `copilot_run_start` no longer refuses a job, the `budget`
  hook never blocks, and `omg budget status` always exits 0. `budget.mode`
  `"enforce"`, `budget.hardLimit`, `budget.perTeamLimit` and
  `"unit": "premiumRequests"` still load, but as deprecated no-ops that warn
  once per surface (SessionStart summary, `omg budget`,
  `omg doctor conflicts`). `--budget-override` is an accepted no-op that
  warns each time it is used. `budget.softLimit` stays as an advisory
  threshold, and the per-worker `maxCreditsPerWorker` session cap stays.
  **Set instead:** Copilot's per-session cap, `copilot --max-ai-credits` or
  SDK `sessionLimits.maxAiCredits` (a soft cap, minimum 30 credits since
  Copilot CLI 1.0.67), and Copilot admin USD budgets at the user,
  cost-center or org level.

### Changed

- **The budget counts AI Credits.** The ledger, `omg budget`, the
  SessionStart summary, the soft-limit notice, the HUD (`creditBudget`,
  `cr:`; `premiumBudget` is still accepted), the smoke checks
  (`scn.team.credits`, `scn.chain.credits`), MCP tool text, release messages,
  docs, runbooks and CI labels all show AI credits. Premium requests remain
  a read-compatible legacy field, so old ledgers load unchanged, and annual
  Pro/Pro+ plans still bill them. A `softLimit` written for premium requests
  now counts AI credits.
- **SDK nano-AIU conversion.** One labelled constant converts the SDK's
  `totalNanoAiu` to credits. Billing, not the SDK, defines the real rate.
- **The default tier-2 smoke costs about 0.6 AI credits**, measured from the
  recorded fixtures.

# oh-my-copilot v5.13.1

## [5.13.1] - 2026-10-26

Fork **v5.13.1** (from v5.13.0) is a patch release. It ports upstream
oh-my-claudecode `dev` faedfd200..ed9eb4fa8 (upstream v5.7.7 to v5.7.17), so
the fork is now at upstream dev ed9eb4fa8. The port is bug fixes only: no new
features and no breaking changes. Most fixes make environment-variable
timeouts stricter or more predictable, harden the team workers on Windows, and
tighten the keyword detector.

### Fixed

- **Environment timeouts are read as whole numbers, not truncated.** Values
  such as `1e3`, `1_000` or `12abc` used to be cut at the first unreadable
  character (`1e3` became 1) and could silently disable a check or start a
  1 ms poll loop. They are now parsed in full, and an unreadable value falls
  back to the default. Affects the host-load gate thresholds
  (`OMC_FREE_MEMORY_THRESHOLD` and the CPU limit; a negative value still
  disables that one check; upstream #4510), the LSP timeouts (upstream
  #4543), the team shell-ready, worker-ready, launch-ack and start-submit
  timeouts (upstream #4545, #4547, #4546, #4558), the team-dispatch
  cooldown (upstream #4557), `OMC_NOTIFY_TMUX_TAIL_LINES` (upstream #4556),
  `OMC_PERSISTENT_MODE_TIMEOUT_MS` (upstream commit 2c3669767) and
  `OMC_PRE_TOOL_ADVISORY_COOLDOWN_MS` (upstream #4600).
- **Notification reply settings must be positive.** A zero or negative
  `OMC_REPLY_RATE_LIMIT` no longer drops every reply, and a zero or negative
  `OMC_REPLY_POLL_INTERVAL_MS` no longer polls Discord or Slack in a tight
  loop; the whole value must be a plain positive integer (upstream #4497).
- **`OMC_DEBUG` has one meaning.** `1` or `true` (any case) turns debug on,
  a comma-separated list enables named scopes, and unset, empty, `0` and
  `false` are off. The delegation enforcer, the learner and
  todo-continuation previously disagreed on the accepted values (upstream
  #4508).
- **A leading UTF-8 BOM is accepted** in JSONC config files (upstream #4494)
  and in the hand-edited `prd.json` and OpenClaw config (upstream #4499).
- **`omg team` on Windows.** The native Windows worker supervisor is repaired
  (upstream #4479). Startup trust prompts are guarded (upstream #4502), pane
  input is refused on every kind of trust prompt (upstream #4528), and
  Claude's trust dialog is still detected when its question wraps over
  several lines (upstream #4611).
- **Team recovery and messages.** Workers whose provider exited inside a
  surviving pane now count as dead, so all-dead recovery is reached
  (upstream #4618). Rebase-conflict messages and the `rebase_conflict` event
  list modify/delete and add conflicts, not only both-modified ones
  (upstream #4608). The pane-ready timeout hint names
  `OMC_TEAM_READY_TIMEOUT_MS` (upstream #4568).
- **tmux sessions with spaces in the name** keep their pane IDs in
  rate-limit-wait (upstream #4544).
- **Keyword detector.** An explicit leading mode keyword in a reference
  prompt keeps working (upstream #4551). Executable commands after a
  `mode:` prefix are no longer treated as informational, and colon-prefixed
  help questions in Korean, Japanese and Thai no longer activate a mode
  (upstream #4553). A bare `ralph:` line followed by a help request, and
  help requests that merely mention a command word, stay informational
  (upstream #4564).
- **Think mode** matches multilingual think keywords as whole words only
  (upstream #4493).
- **Stop hook Jev resolver.** The shadow-mode resolver is detached from
  short-lived hook groups (upstream #4575), and the active parent timeout
  matches the resolver's (upstream #4515).
- **Ralph fails closed on an invalid PRD.** A `prd.json` that cannot be read
  or validated now stops verification instead of passing it (upstream
  commit e47304859, refs upstream #4526).
- **Teleport and providers parse URLs more tolerantly.** PR and issue URLs
  with a trailing slash or sub-page (upstream #4542), PR patch and diff URLs
  (upstream #4604), and remote URLs ending in a slash (upstream #4549).
- **Version ranking.** A prerelease now ranks below its own release
  (upstream #4511).
- **HUD** shows token counts that round up to 1000k in millions (upstream
  #4601).
- **Subagent file summary** keeps the first path of `git status` intact, so
  an unstaged deletion listed first is no longer reported as modified
  (upstream #4607).
- **MCP registry TOML output** escapes unpaired surrogates (upstream #4512).

### Removed

- **Unwired team dispatch hook** (`src/hooks/team-dispatch-hook.ts`, its
  tests and stale `dist` outputs): it had no caller, registration or package
  export (upstream #4581).

### Changed

- The upstream docs list the Node.js hooks for macOS and Linux (upstream
  #4619). Upstream test-only and CI-only changes in this range (deterministic
  SessionStart timing and workflow-stop tests) are ported with no user-facing
  effect (upstream #4514, #4561).

# oh-my-copilot v5.13.0

## [5.13.0] - 2026-10-26

Fork **v5.13.0** (from v5.12.2) is a minor release. It makes OMC's
keep-going modes work on GitHub Copilot CLI: Stop continuations now chain,
ultragoal gets a native goal record, per-agent models reach Copilot, and the
hook adapter is brought up to Copilot CLI 1.0.103. It also adds
`omg hooks doctor` and reworks the `omg release` suite phase. There are no
breaking changes, but **on Copilot a prompt can now cost up to 3 extra
premium requests** from OMC continuations (see Changed and the
[migration note](docs/MIGRATION.md#v5122--v5130-chained-stop-continuation-on-copilot)).

### Added

- **Chained Stop continuation on Copilot** (#279): an OMC Stop block
  continues the session up to 3 times per genuine user prompt, bounded first
  by the mode's own cap. `OMC_COPILOT_STOP_CHAIN_MAX` (1 to 7) overrides it;
  1 restores the old single continuation. Ralph is not extended inside a
  chain, `code-simplifier` honours the cap, and `persistent-mode` does not
  block when the payload says Copilot's native autopilot is on.
- **OMG goal record for ultragoal on Copilot** (#279): `omg ultragoal
  goal-start` and `goal-evidence` write `.omg/ultragoal/omg-goal.json` (or a
  per-plan record with `--plan-id`), which stands in for Claude Code's
  `/goal`. Stop keeps going until every criterion has evidence. The session's
  `plan_id` is recorded in its ultragoal state, a complete record is archived
  as `omg-goal.<timestamp>.json` instead of deleted, and a session-scoped
  cancel removes only that session's plan record.
- **Per-agent models on Copilot** (#281): `omg setup` copies explicit
  `agents.<name>.model` overrides from the user config into
  `subagents.agents["oh-my-copilot:<name>"].model` in
  `$COPILOT_HOME/settings.json` (merge, `.bak` backup, atomic write).
  Tier aliases resolve through the Copilot 5.5 tier table in
  `src/config/copilot-models.json`; unknown ids are skipped with a warning.
  The settings key is not yet verified on a live Copilot; check with
  `/subagents`. Read-only agents also gain `read_bash`, `read_powershell`,
  `list_agents` and `read_agent`.
- **`omg hooks doctor`** (#280): checks `node` on PATH, `copilot/hooks.json`
  against its generator, hook script paths, a sandboxed dry dispatch of every
  entry with recorded Copilot payloads, and the Copilot CLI version.
- **Opt-in live CLI smoke scenarios** (#280): `omg smoke copilot --tier 2
  --scenario continuation,prompt-context,events` runs headless `copilot`
  sessions (about 4 premium requests). The `ultragoal` scenario is still
  marked pending. The default scenario set is unchanged.
- **Copilot payload normalization** (#283): the hook dispatcher adds the
  Claude field names to every Copilot payload (camelCase PermissionRequest
  and SubagentStart, `skill` to `Skill`, plugin MCP names to `mcp__t__x`,
  Copilot argument names to Claude ones), without removing Copilot's keys.

### Changed

- **`context-guard-stop` never blocks on Copilot** (#283): Copilot's token
  sample is stale and the model cannot run `/compact`, so the guard sends its
  advice once per session as a message instead of spending premium requests.
  Context share is read from `events.jsonl` against a per-model limit table.
- **`systemMessage` on Copilot** (#283): it is folded into
  `additionalContext` or the Stop block reason, and a non-blocking Stop's
  message is handed to the next prompt. User notices such as the update
  check therefore reach the model.
- **PermissionRequest on Copilot** (#283): an `allow` or `deny` is emitted at
  the top level and as `hookSpecificOutput.decision`, deny wins when several
  hooks answer, and `ask` emits nothing so Copilot's own flow runs. The
  manifest matcher also lists `bash` and `powershell`.
- **SessionEnd on Copilot** (#279): Copilot fires SessionEnd after every
  turn, so the cleanup job is held until `events.jsonl` records
  `session.shutdown`. The factory-chain link is decided at that real end.
- **Mode keywords** (#279): OMC continuation text and subagent kickoff
  prompts never arm a mode on Copilot, and a question that only mentions a
  mode keyword no longer arms it.
- **`omg release` suite phase** (#282): the vitest suite now runs in its own
  `suite` phase after `commit`. The `--suite` level and `--baseline` are
  recorded per release, `pr` refuses a skipped live smoke unless
  `--allow-skipped-smoke` is given, skipping past `commit` needs a clean
  tree, and re-running a phase voids later phase records. Usage errors exit
  2. See [REFERENCE.md](docs/REFERENCE.md#omg-release).

### Fixed

- **Skill tool on Copilot** (#279): the lowercase `skill` tool name is
  recognized, so the cancel and ultragoal bootstrap and skill-state hooks
  fire.
- **Nested repo under a git-less session root** (#282): a project repo below
  a git-less workspace folder is no longer rejected as foreign. The state
  root is memoized per call, so per-session scans no longer take minutes on
  Windows.
- **Copilot subagents** (#279, #283): the ultragoal guard resolves a child's
  parent session, parallel agents of one type close oldest first, a child's
  Stop skips the context guard and the message handoff, and pending handoff
  files older than 24 hours are pruned at SessionEnd.
- **`omg release` messages** (#282): `verify` names the failed CI jobs when
  npm and the GitHub Release are already published, and `tag` without a
  terminal says to pass `--yes`.

# oh-my-copilot v5.12.2

## [5.12.2] - 2026-10-23

Fork **v5.12.2** (from v5.12.1) is a patch release. It hardens native
Windows provider launch, fixes several cross-platform races, and brings the
Windows test suite to a clean run. It also adds `omg release` and
`omg progress` for maintainers.

### Security

- **Windows: hardened native .cmd/.bat provider launch (argument quoting and
  supervisor launch path); upgrading is recommended for Windows users with
  npm-installed providers** (#274).

### Added

- **`omg release <X.Y.Z>`** (#258): the maintainer release as ten resumable,
  gated phases (preflight, bump, build, gates, smoke, commit, pr, promote,
  tag, verify), with state in `.omg/release/<X.Y.Z>.json`.
- **`omg progress emit|watch|status`** (#255): append-only agent progress
  events, with stall detection for the lead.
- **`omg smoke copilot --tier 2 --scenario filetools`** (#259): an opt-in
  live check that PreToolUse/PostToolUse hooks fire on Copilot's file tools
  and that directory-context injection reaches the model.

### Fixed

- **Races (#268-#276).** SessionEnd lease renewal, job updates and release
  re-read the manifest under the lock, so revision drift from action children
  no longer reads as a lost lease; a worker releasing a still-reserved action
  undoes its claim, so the job can complete. A state-lock `SQLITE_BUSY` during
  open is retried instead of falling back to an unlocked read (concurrent
  duplicate Stop). The Windows supervisor's stdin EPIPE in the worker launch
  bootstrap is handled (#270). `getProjectIdentifier` caches its git probes
  per process, validated by git metadata and environment signatures (#268).
- **Injectors and `apply_patch`** (#259): the rules and directory-context
  injectors read the file paths from `apply_patch` patch text, so they inject
  for GPT-family models too.
- **Windows product fixes:** atomic writes and team `writeAtomic` retry
  EPERM/EACCES/EBUSY renames, and atomic-write rollback no longer fails
  silently; `omg ask claude` passes the prompt over stdin; autoresearch
  tolerates `core.autocrlf`; worktree-root and plugin-cache path handling,
  graph runtime gates, the python REPL fallback and LSP devcontainer URIs.

### Tests

- **Windows test suite.** The Windows vitest baseline (810 failures in 146
  files) is worked down to zero across lanes #256-#276: shared platform helpers
  (`src/__tests__/helpers/platform.ts`, `scaleTiming`), POSIX-only gates,
  load-tolerant timing, and root-cause fixes for four full-suite flakes.

# oh-my-copilot v5.12.1

## [5.12.1] - 2026-10-21

Fork **v5.12.1** (from v5.12.0) is a patch release. v5.12.0 was tagged but
never published to npm: its release job failed on the SessionStart parity
test. v5.12.1 is therefore the first npm release containing everything listed
under [5.12.0] below, including the removal of the `merge_readiness_*` MCP
tools ([migration note](docs/MIGRATION.md#v5110--v5120-merge-readiness-mcp-tools-removed)).

### Fixed

- **Deterministic `update-check.json` key order** (#253). The SessionStart
  hook (`scripts/session-start.mjs` and `templates/hooks/session-start.mjs`)
  writes the update-check cache with sorted keys, so concurrent registry
  fetches no longer produce files that differ only in key order.
- **Hermetic SessionStart parity test.** The parity test sets
  `OMC_UPDATE_REGISTRY_BASE` to a closed local port, so update checks never
  reach the live npm registry; the key-order test now also covers the
  template writer.

# oh-my-copilot v5.12.0

## [5.12.0] - 2026-10-21

Fork **v5.12.0** (from v5.11.0) is a minor release. It ports upstream
oh-my-claudecode `dev` through faedfd200 in two steps: 7cb577e94..51bec397e
(183 commits, upstream v5.7.0 to v5.7.3) and 51bec397e..faedfd200 (97 commits,
upstream v5.7.4 to v5.7.6). It also binds the generated-artifact authorization
check to the fork. **Breaking for MCP callers:** the five retired
`merge_readiness_*` MCP tools are removed, so the configured MCP server now
exposes 56 tools (see Removed and the
[migration note](docs/MIGRATION.md#v5110--v5120-merge-readiness-mcp-tools-removed)).

### Added

- **`omg ask muse`**: a Muse advisor provider (upstream v5.7.2). Grok role
  prompts now go through a private prompt file.
- **`claudeMdEnabled: false`** in `~/.copilot/.omc-config.json` opts out of
  global CLAUDE.md management: install, update, setup, session-start drift and
  doctor leave your own `~/.copilot/CLAUDE.md` untouched (upstream #4383). See
  [REFERENCE.md](docs/REFERENCE.md).
- **`OMC_JEV_PLAN_MODE`** keeps Jev from deciding in plan mode (upstream
  #4395).
- **State-lock deadline API (upstream #4322).** `scripts/lib/state-lock.mjs`
  bounds lock work by the hook budget, with shared deadlines across acquire and
  release, and adds `acquire/withStateFileLockAtPathSync`,
  `getStateFileLockFailureKind` and support for legacy version-0 owners.

### Removed

- **The retired `merge_readiness_*` MCP tools and their runtime**
  (`merge_readiness_start`, `merge_readiness_set_content`,
  `merge_readiness_record_answer`, `merge_readiness_report`,
  `merge_readiness_cancel`; `src/hooks/merge-readiness/`, upstream #4422). The
  `merge-readiness` skill was already retired in 5.0.0; review stays advisory
  and the release hard checks are unchanged. CI now asserts the bridge omits
  them. A client that still calls one gets an unknown-tool error.
- Retired tiered agent names (`executor-low`, `architect-low` and others) are
  gone from docs, prompts and the CLI help; pass a `model` instead (upstream
  #4345). `src/verification/tier-selector.ts` is deleted.

### Changed: upstream port 7cb577e94..faedfd200

- **File-context injectors run only for file tools (upstream #4373).** The
  rules and directory-context injectors moved to the PostToolUse group
  `Read|Write|Edit|MultiEdit`, copied as-is into `copilot/hooks.json`. Copilot
  CLI matches Claude-format hooks against the Claude tool names (`view`→`Read`,
  `create`→`Write`, `edit`→`Edit`); [HOOKS.md](docs/HOOKS.md) documents the
  mapping.
- **Frontmatter parsing** in skills, commands, rules, agents, wiki,
  autoresearch and learner accepts a UTF-8 BOM, CRLF line endings, YAML block
  scalars and quoted flow values (upstream #4392–#4411, #4451, #4452). The
  rules injector supports `{a,b}` brace alternation and trailing comments
  (#4403, #4407).
- **Literal globs.** State-manager list/cleanup, learner triggers and
  factcheck strict globs match literally (#4390, #4416, #4418).
- **Integer CLI options.** `wait`, `session`, team, ralphthon,
  featured-contributors, autoresearch and `factory listen --port` reject
  non-integer values (#4409, #4420, #4439, #4441, #4442).
- **pre-tool-enforcer** matches the cancel and ultragoal bootstrap commands
  as a single `omg`/`omc`/`oh-my-copilot` CLI command, not as a substring.
- SessionStart purges legacy tool-failure state and atomic temp files, defers
  cleanup when the state is locked, and publishes plugin occupancy.
  PostToolUseFailure state no longer stores tool input or error text (#4284).
- Ralph started through the Skill tool gets PRD-mode state (#4363); plan
  consensus runs Architect and Critic reviews in parallel when both are Claude
  agents (#4355).
- omc-doctor's legacy-hook cleanup checks provenance, events, plugin manifests
  and managed policies and verifies fingerprints before removing anything.

### Fixed: upstream port 7cb577e94..faedfd200

- HUD: the npm fallback is restricted to global prefixes, cached load failures
  are reported, the stdin cache is scoped per session (#4398), local API
  records are excluded from the payload estimate (#4437), plugin mode no
  longer imports Zod from the plugin cache (#4454), and quota identity is
  scoped to the stored OAuth account.
- Team: cmux worker startup is stable (#4413), startup ACK and shutdown
  instructions agree (#4404), shutdown acknowledgements are validated before
  they are consumed, and stale Cursor verdicts are quarantined (#4380).
- Plugin cache repair links stale roots only to a real directory (#4375); the
  installer logs "CLAUDE.md already up to date" (#4377); Jev request
  directories are removed after use; empty `OMC_SKIP_HOOKS` entries are
  ignored (#4417); `OMC_DAILY_CHAIN_LIMIT` no longer floors to zero (#4440);
  slash-command parsing keeps the plugin namespace (#4450); blank config-dir
  overrides fall back to the default; agent model JSONC allows trailing
  commas.

### Fixed (fork)

- **Generated-artifact authorization is bound to the fork (#246).** The
  verifier's owner is `RobinNorberg` and the base-owned manifest names
  `RobinNorberg/oh-my-copilot`, so source-only PRs to `dev` pass the
  "Authorize generated artifacts from base trust root" check. Release PRs that
  commit `dist/`/`bridge/` still fail it by design.
- **Fork repository links** point at `RobinNorberg/oh-my-copilot` instead of
  the non-existent `Yeachan-Heo/oh-my-copilot` (omc-doctor, omc-setup, psm,
  CONTRIBUTING, SECURITY); the drift leak scan now flags the wrong slug.
- omc-setup phase 1 names `${COPILOT_HOME:-~/.copilot}` and "all Copilot CLI
  sessions" in the global report.
- The committed `dist/` drops outputs whose source is gone
  (`dist/hooks/merge-readiness/` and three test outputs deleted in v5.5.0).

### Fork deviations: upstream port 7cb577e94..faedfd200

- **Dropped (now upstream):** `lsp_diagnostics_directory` running tsc on
  Windows (#4336, ours) and the split-pane env-file discard (#4333, which
  supersedes our #4335).
- **Kept:** MSYS2/Cygwin tmux keeps the POSIX identity guard; the state-lock
  win32 fixes (cached own process identity, abandoned-nonce recovery, the
  verified liveness cache, the BUSY release retry capped by the operation
  deadline) on top of upstream's deadline API and `testHooks`; the
  `WINDOWS_BASELINE_ENV_KEYS` worker env; generated-artifact authorization
  keep-ours; fork version stamps.
- **New:** `post-tool-use-failure.mjs` uses a 1.4 s process-probe budget on
  win32 instead of 0.9 s (the PowerShell probe takes 0.8–1.1 s); the total
  1.8 s deadline is unchanged.
- `node-hook-fingerprints.json` is kept as upstream ships it; renamed fork
  templates do not match, so omc-doctor leaves them for manual review.

# oh-my-copilot v5.11.0

## [5.11.0] - 2026-10-14

Fork **v5.11.0** (from v5.10.0) is a minor release: the standalone MCP server
gains five `copilot_run_*` tools that delegate a task to a headless Copilot
session in its own git worktree (opt-in with `OMG_COPILOT_RUN_ALLOW=1`). There
is no upstream port in this release; upstream `dev` stays ported through
7cb577e94.

### Added

- **`copilot_run_*` MCP tools: delegate a task to Copilot.** The standalone
  MCP server (`t`, `dist/mcp/standalone-server.js`) gains
  `copilot_run_start`, `copilot_run_status`, `copilot_run_wait`,
  `copilot_run_cancel` and `copilot_run_cleanup`: Claude Code (or any MCP
  client) starts a headless `@github/copilot-sdk` session on a prompt as a
  background job and gets back the final assistant text, the session id, the
  premium requests and AI credits spent, and the worktree path, branch and
  `git diff --stat` to review. Starting needs `OMG_COPILOT_RUN_ALLOW=1` in
  the server env and passes the budget governor (the spend is recorded as
  `copilot-run:<jobId>`). By default Copilot works in a new git worktree and
  branch, not in the caller's tree; the write tool is confined to it and
  refused on the `omg ship` merge-rule paths (the shell policy is a denylist,
  not a sandbox); a timeout (15 min default), a credit cap, cancel and the
  server's shutdown abort the session; at most 2 jobs run at once; cleanup
  never removes a worktree with uncommitted or unmerged work (ignored files
  go with it; links in it are unlinked first, so a junctioned `node_modules`
  target survives — this guard also covers `omg team` worker worktrees).
  `OMC_DISABLE_TOOLS=copilot-run` hides the tools; sdk team workers and the
  jobs' own sessions do not get them, and the Copilot sessions omg starts
  never inherit the opt-in. See
  [REFERENCE.md](docs/REFERENCE.md#mcp-tools-copilot_run_-delegate-a-task-to-copilot).

### Fixed

- **`omg team` worker worktree removal no longer empties a junction target.**
  `removeWorkerWorktree` unlinks untracked symlinks and junctions (only the
  link) before `git worktree remove`, which on Windows recursed through a
  junctioned `node_modules` and emptied its target. A link that cannot be
  unlinked refuses the removal (`worktree_link_unremovable`), and a registered
  worktree with initialized submodules is refused before any link is touched.

# oh-my-copilot v5.10.0

## [5.10.0] - 2026-10-11

Fork **v5.10.0** (from v5.9.0) is a minor release: a premium-request budget
governor (`omg budget`, warn-only by default), the `omg ship` gate engine and
`ship` skill, opt-in in-process SDK tools for sdk team workers, a Copilot
`notification` hook for permission prompts and `ask_user`, the `session-flow`
skill, and upstream oh-my-claudecode `dev` ported through 7cb577e94
(a720eabd0..7cb577e94, 224 commits). Permission auto-approval is narrower: on
Copilot, `npm run build`, test commands, git read commands and heredoc
`git commit`/`git tag` are no longer auto-approved (see Changed).

### Added

- **Premium-request budget governor.** A ledger at
  `.omg/state/budget-ledger.json` records Copilot usage per session and per
  team, each record labelled measured or estimated. Copilot CLI sessions are
  read from their `events.jsonl` (`session.shutdown` /
  `session.usage_checkpoint` totals, else an estimate of one premium request
  per prompt until the session ends); sdk team workers are recorded live by
  their host. New `budget` keys in `.copilot/omg.jsonc`: `mode`
  (`warn` default, `enforce` opt-in), `unit` (`premiumRequests` or
  `credits`), `softLimit`, `hardLimit`, `perTeamLimit`. A fail-open
  `premium-budget.mjs` hook prints a SessionStart summary and a one-time
  notice when a limit is crossed; the HUD gains a `premiumBudget` element;
  in enforce mode `omg team` clamps or refuses a fan-out whose projected cost
  exceeds the limits (`--budget-override` starts it anyway); `omg budget`
  (`status`, `reset`, `--json`) shows and resets the ledger; `omg doctor
  conflicts` warns about invalid values. `OMC_BUDGET_GOVERNOR=0` turns it
  all off. See [REFERENCE.md](docs/REFERENCE.md#omg-budget-ai-credits-budget).
- **New `session-flow` skill (upstream #4319)**: an evidence-backed map of the
  current session; its Tasks are excluded from the continuation hook. The
  plugin now ships 63 skills.

#### `omg ship` and the `ship` skill

- **`/oh-my-copilot:ship`** takes a task or an open PR to merge-ready: an
  executor lane, an independent verifier lane (the implementer's own verdict
  is refused), fix rounds by a fresh agent up to `ship.maxFixRounds`
  (default 2), then the mechanical steps below. The skill ships the executor,
  reviewer and fix brief templates (reviewers get the diff, not the author's
  conclusion) and runs the lanes through `omg team --transport sdk` or the
  in-session Task tool.
- **`omg ship gates <pr> [--watch]`** applies the merge rule to
  `gh pr checks --json`: green only when every check outside
  `ship.advisoryChecks` (default `No Committed Build Artifacts`,
  `Authorize generated artifacts from base trust root` and the two Socket
  Security app checks) is SUCCESS or
  SKIPPED, every `ship.requiredChecks` name has been reported (a missing one,
  such as `Build` before its `needs:` jobs start, is pending), and every
  workflow run for the head sha is completed; unknown states fail closed. A
  failed job whose every failing vitest test matches a title-scoped entry in
  `.github/known-flaky-tests.json`, with no unhandled errors, failed suites
  or failing non-test step in its log, is classified flaky and rerun once per
  run (`gh run rerun <id> --failed`; the budget is recorded before the
  rerun). One watch window lasts 9 minutes (under the 10-minute background
  watcher cap); exit 8 means still pending, so run the command again.
- **`omg ship prepare <pr>`** refuses unless HEAD is the run's PR branch and
  contains the reviewed sha, then merges GitHub's base sha in (`--no-ff`, never
  rebases), resolves an inventory-only sibling conflict with `--theirs`, runs
  `tsc`, eslint on changed files, the tests mapped from the diff and the
  generator `--verify` checks, regenerates the inventory as the last commit,
  and with `--push` pushes plainly to the run's branch. Option-shaped or
  invalid base / branch names and a non-hex `verdict --sha` are refused.
- **`omg ship merge <pr>`** refuses unless the gates are green, the state
  passes its integrity check, and the latest independent approval covers the
  head (only commits `prepare` made may follow the reviewed sha). It prints
  `gh pr merge --admin --merge --match-head-commit <sha>` unless the owner set
  `ship.allowAdminMerge`; there is no CLI flag for the admin merge.
- **`omg ship init <pr> --force`** keeps the replaced run in `previousRuns`;
  replacing a blocked or merged run needs the owner-only `OMG_SHIP_HUMAN=1`.
  Reviewer identity is advisory and the state file is not tamper-proof: a
  sha256 `integrity` field written on every engine update catches hand edits
  (later updates and `merge` refuse a mismatch) but is not a signature.
- Every engine command passes an allowlist guard: only the exact git / gh /
  node shapes the engine builds may spawn, so force pushes, deleting
  refspecs, rebase, pull, amend, `reset`, global `-c` / `--config-env`
  options, option-shaped operands, `git worktree`, `gh api`, `gh -R`,
  `--auto` / `--delete-branch` merges, `.cmd` shims and `npm ci` are refused.
  Run state lives in `.omg/state/ship/<pr>.json` under the state file lock
  and is shape-checked on read (including `history` and `previousRuns`
  entries).
- **Safety settings come from trusted sources only.** `ship.allowAdminMerge`,
  `advisoryChecks`, `requiredChecks` and `knownFlakyFile` are read from the
  user config at its default location, then `.copilot/omg.jsonc` as
  committed on the PR's base branch, then the defaults. The same keys in the
  working-tree project file (a lane can drop one in untracked) or the PR head
  are ignored with a warning, and the known-flaky list is read from the base
  branch. `omg ship merge` refuses a PR whose changed files touch
  `.copilot/omg.jsonc`, `.github/known-flaky-tests.json` or
  `.github/workflows/` unless the owner sets `OMG_SHIP_HUMAN=1`.
- **The base branch is checked against GitHub.** `init`, `gates` and `merge`
  take the base and its sha (`baseRefOid`) from `gh pr view`, fetch the
  base, require `refs/remotes/origin/<base>` to equal that sha, and read
  `<sha>:.copilot/omg.jsonc` with `GIT_NO_REPLACE_OBJECTS=1`, so a lane's
  `git replace` or a moved or shadowed ref cannot change the trusted config.
  When the check (or the fetch) fails, `gates` warns and uses the defaults
  and `merge` refuses. `init --base` must match the PR's base on GitHub, and
  `gates` uses GitHub's base rather than the recorded one.
- **`prepare` merges GitHub's base sha, never a ref name.** It checks that
  `git remote get-url origin` (`insteadOf` applied) is the PR's repository
  (`gh pr view --json url`), fetches the base, requires
  `refs/remotes/origin/<base>` to equal `baseRefOid`, and runs
  `git merge --no-ff --no-edit <baseRefOid>`; the guard no longer allows a
  merge by ref name, so a lane's tag named `origin/dev` or a repointed
  `remote.origin.url` cannot get its content merged and recorded as
  housekeeping. The trusted config loader runs the same remote check.
- **`merge` re-checks housekeeping merges.** The commits after the reviewed
  sha (`git rev-list --first-parent --parents`) must form a chain from the
  head back to the reviewed sha of commits `prepare` recorded, and each
  recorded merge must have two parents, the second GitHub's current
  `baseRefOid` or its ancestor; anything else needs a new verdict.
- **`merge` checks housekeeping content, not just parents.** A recorded
  one-parent commit may change only `inventory/` against its parent; a
  recorded merge may differ only under `inventory/` from the tree
  `git merge-tree --write-tree` rebuilds from its parents, and is refused
  while any `merge.<name>.driver` is configured. A custom merge driver, a
  hook that stages a file, or a file another lane stages during the checks
  can no longer ride into a commit `merge` accepts without re-review.
  `prepare` also hardens the commits it makes: merges and commits run with
  `--no-verify` (hooks never shape engine commits), the inventory commit
  names `-- inventory`, and it refuses to start with staged changes in the
  index.
- Known limits, documented: a lane with write access to `.git/objects` can
  forge loose objects; environment and `PATH` overrides are advisory; `gh`
  resolves the repository from the checkout's remotes too.
- **`ship.trustedBases`** (user config only; default `dev`, `main`,
  `master`): any other base is never read and never admin-merged; `merge`
  prints the command instead.
- **User-config safety keys ignore `APPDATA` / `XDG_CONFIG_HOME`.** They come
  from the default location under the account's home as the OS reports it;
  a file chosen through those variables keeps its other keys, and its safety
  keys are ignored with a warning.
- **The merge's changed-file list is computed locally**
  (`git diff --name-only --no-renames -z <base sha>...<head sha>`): a rename
  out of `.github/workflows/` names the old path too, non-ASCII paths are
  read unquoted, and the 300-file cap of `gh pr diff` no longer blocks a
  merge.
- Engine commands run with a scrubbed environment: the `GIT_*` variables
  that redirect git (`GIT_CONFIG_*`, `GIT_DIR`, `GIT_EXEC_PATH`,
  `GIT_SSH_COMMAND`, ...) and `GH_REPO` / `GH_HOST` are dropped, `GH_TOKEN`
  passes through. The push guard compares protected branch names
  case-insensitively. A legacy-named `.copilot/omc.jsonc` (never read from
  the base) gets one warning instead of one per key. `OMG_SHIP_HUMAN` and
  the lane names stay advisory against a lane that controls its own
  environment.
- `gates` resolves the PR head first, reads checks and workflow runs for that
  sha, and is pending when the head moved during the read; a workflow run
  that completed red without reporting any check (startup failure) is
  failed; a head with no checks and no workflow runs reports
  `no-workflows-triggered` (bot PRs pushed with `GITHUB_TOKEN` trigger no
  workflows). The Socket Security app checks are advisory by default, and a
  test compares `.github/workflows/*.yml` PR jobs with the default
  required + advisory lists.
- `init --force` keeps the implementer and fix-round budget of a run that has
  verdicts (resetting needs `OMG_SHIP_HUMAN=1`). The guard no longer allows
  any npm command and refuses pushes to `main`, `master`, `dev` and the
  run's base.

#### Copilot `notification` hook

- **"Input needed" notifications on Copilot.** The generated
  `copilot/hooks.json` maps Copilot's `notification` event (fork-owned
  `FORK_HOOKS` in `scripts/copilot/build-hooks.mjs`, no upstream counterpart)
  to `scripts/copilot/notification.mjs`. A `permission_prompt` or
  `elicitation_dialog` (which includes the `ask_user` tool) sends OMC's
  `ask-user-question` notification to the configured Discord, Telegram or
  Slack targets. Upstream sends it from PreToolUse for `AskUserQuestion`, which
  Copilot never calls, so on Copilot it never fired. Team workers are skipped.
  A permission prompt is sent as its title, tool category and command binary
  only (`Permission needed: Run command: curl`), never the command arguments.
  `ask_user` text is redacted (`redactTokens`, now also covering secret
  assignments and flags, secret JSON fields, credential headers, `curl -u`,
  `mysql -p`, `login -p`, URL credentials, webhook URLs, PEM keys, OpenAI-style
  keys and padded base64) and capped at 200 characters. Permission-prompt
  notifications are not replyable, and sending one marks the pane
  non-replyable and drops its earlier reply mappings (approval-gate mappings
  stay): remote replies never answer a permission prompt, also for an
  `ask_user` mapping registered while the prompt was sent. When the mappings
  cannot be dropped (registry lock timeout) the prompt is not sent. A title
  that is not plain letters and spaces is sent as `Permission needed`. On a
  stale `dist/` that lacks these guarantees (`NOTIFICATION_CAPS`, redaction
  self-test) the hook sends no permission prompt, and `ask_user` only as
  `Copilot is asking you a question`. A
  permission prompt is sent at most once per 30 s per session, an identical
  `ask_user` question once per 30 s. The hook's run.cjs timeout is now its
  generated 5 s instead of the 60 s default.
  The other three unmapped events (`errorOccurred`, `preMcpToolCall`,
  `userPromptTransformed`) stay unmapped; the reasons are in
  [DEVELOPERS.md](docs/DEVELOPERS.md#copilot-cli-hook-events).

#### In-process plugin tools for sdk team workers (opt-in)

- **`team.sdk.inProcessTools`** (default `false`; env
  `OMC_TEAM_SDK_INPROCESS_TOOLS=1`/`0`) registers the plugin MCP tools in the
  sdk host as SDK session tools and disables the `t` stdio MCP server for that
  worker. Names (`t-<tool>`), schemas and results match the MCP server. An SDK
  without `convertMcpCallToolResult` keeps the MCP server.
  `sdk-session.json` records `tool_transport`. Measured on Copilot CLI 1.0.91
  with SDK 1.0.16, 12 runs per mode: session start median 2843 ms in-process
  vs 2872 ms MCP. The start time is unchanged; each worker saves one node
  process of about 85 MB working set. Off by default; see
  [DEVELOPERS.md](docs/DEVELOPERS.md#sdk-in-process-tools).
- **In-process host lifetime.** After `createSession()` the host checks the
  session's tool metadata for `t-state_read`; a session that does not offer it
  is recreated on the MCP server, and one the SDK cannot check is recorded as
  `tool_transport_verified: false`. `workerDenyTools: ['t']` offers no
  in-process tool. Teardown runs the MCP server's shutdown cleanup (Python REPL
  bridges, LSP clients) with a 5 s deadline; on Windows the bridges go straight
  to `taskkill /F`, since `/T` alone does not stop them. An unhandled rejection is
  recorded and the host keeps serving; an uncaught exception stops the host
  hard with a `failed` session (outcome `tool_crash`); `SIGTERM`/`SIGINT`/
  `SIGHUP` stop it hard. `OMC_TEAM_SDK_INPROCESS_TOOLS` also accepts
  `true`/`false` (any case) and rejects other values as a config error.

### Changed: upstream port a720eabd0..7cb577e94

Upstream oh-my-claudecode `dev` is ported through 7cb577e94 (224 commits,
42 merges). See [MIGRATION.md](docs/MIGRATION.md) for the three upstream
migration notes (glossary rename, shipyard tracker artifacts and audit
contract v2, SSRF guard for IPv6 literals).

- **Shipyard is lean (upstream #4274).** Drydock seeds two faces on day one
  (`CLAUDE.md` + `GLOSSARY.md`); every other surface appears on first use,
  and `scripts/shipyard-audit.mjs` (contract v2) checks only adopted
  surfaces. Navigator maps, launch specs and tickets are tracker-only; the
  glossary file is `GLOSSARY.md` (a legacy `CONTEXT.md` glossary is still
  read, and both at once is a `duplicate-authority` finding).
- **Permission auto-approval is narrower (upstream #4283, #4280).** The
  PermissionRequest hook auto-approves only `git status`, `gh issue|pr
  view|list|status`, `ls` and the repo-scoped inspection commands; build (`npm run build`),
  lint, targeted-test and heredoc `git commit`/`git tag` commands go through
  the normal permission flow. On Copilot this means `git diff`, `git log`,
  `git branch`, `git show`, `git fetch`, `tsc`, `eslint`, `prettier`,
  `cargo`, `pnpm` and `yarn` are no longer auto-approved. The Copilot
  camelCase input shape is unchanged.
- **AFK user settings are opt-in (upstream #4282).** `OMC_AFK_INCLUDE_USER_SETTINGS=1`
  widens a Claude Code factory link or `omg ralph afk` to
  `--setting-sources user,project,local`; chain ledgers carry the choice.
  Copilot links have no setting-sources flag and are unaffected.

### Fork deviations: upstream port a720eabd0..7cb577e94

Three upstream defects are fixed in the fork only; each site carries a
`// fork deviation:` comment so later ports merge them deliberately.

- **Split panes discard the private pane env file again.**
  `splitTeamWorkerPaneWithEvidence` goes back through `runPaneCreationCommand`,
  so a split the server guard did not run, or one that throws, removes the
  `OMC_TEAM_WORKER_ENV_PASSTHROUGH` file (which may hold credentials) on POSIX
  tmux. Upstream left it on disk.
- **MSYS2/Cygwin tmux keeps the POSIX identity guard.** The PowerShell
  `if-shell` guard under MSYS is chosen only when the `tmux` binary is psmux,
  not whenever `TMUX` is unset. Upstream's PowerShell guard is a `/bin/sh`
  syntax error under MSYS tmux, so the team could not start.
- **`lsp_diagnostics_directory` runs tsc on Windows.** The tsc strategy runs
  the project's `node_modules/typescript` with the current Node. Otherwise it
  uses `tsc` from PATH, through cmd.exe on win32 because there it is the
  `tsc.cmd` shim. A missing compiler reports `tsc not found` as a failed check,
  never as clean. Upstream's bare `execFileSync('tsc')` always failed with
  ENOENT on Windows.

### Fixed: upstream port a720eabd0..7cb577e94

- MCP registry sync parses multiline TOML strings and literal strings,
  extended Unicode escapes and quoted keys, infers omitted registry
  transports, and ignores Codex-only type drift (upstream #4297, #4294).
- Native Windows tmux gets a PowerShell identity-guard condition (upstream
  #4269); the fork's psmux private-namespace path, which never runs the
  `if-shell` guard, is unchanged.
- Stale plugin-cache purge validates hook payloads, redirect targets, UNC and
  symlink-cycle traversal before relinking (upstream #4298); cache occupancy
  fails closed on unreadable records (#4299).
- Notifications: JSON webhook templates escape values (#4295), inherited
  template properties are ignored (#4300), custom integration shapes are
  validated (#4301), carriage returns are normalized before reply injection
  (#4308), Telegram proxy exclusions honor ports (#4311), tmux session names
  keep whitespace (#4312), and the reply registry is rewritten atomically
  (#4314).
- HUD: custom rate-provider stderr is drained (#4302) and its cache is keyed
  by command and periods (#4304), completed background-task history is capped
  (#4303), directory hyperlinks are encoded (#4305), and ANSI truncation uses
  visible text (#4306, #4287).
- Team: Cursor worker lifecycle and centralized state resolution (#4272),
  usage records count Unicode characters (#4310) and skip invalid records
  (#4315).
- Also: JSONC comment token boundaries (#4285), payloads without a JSON
  representation are rejected (#4286), complete IPv6 local ranges in the SSRF
  guard (#4288), custom-note delimiter collisions (#4289), literal git tag
  arguments (#4290), exact Azure DevOps host matching (#4291), transcript
  context usage within a complete frame (#4292), incomplete version-manager
  Node installs skipped (#4293), Git remote cache keyed by resolved cwd
  (#4296), directory diagnostics fail on compiler invocation errors (#4309),
  session-search terminal output escapes controls (#4307), LSP file URIs use
  native paths (#4313), and keyword detection skips attributed paste blocks
  (#4318).

# oh-my-copilot v5.9.0

## [5.9.0] - 2026-10-10

Fork **v5.9.0** (from v5.8.1) is a minor release: `omg team` starts headless
SDK workers by default under the Copilot CLI host, Copilot hooks run through a
per-event dispatcher, the project config is `.copilot/omg.jsonc` everywhere, a
daily upstream drift bot proposes ports, and upstream oh-my-claudecode `dev` is
ported through a720eabd0 (ef9a44f0e..a720eabd0, 6 commits). Under Claude Code
the team transport stays `pane`. To keep panes under Copilot CLI, see the
[v5.8.1 → v5.9.0 note](docs/MIGRATION.md#v581--v590-sdk-team-transport-by-default).

### Changed: SDK team transport is the default under Copilot CLI

- **`omg team` defaults to `--transport auto`.** Under the Copilot CLI host
  (the existing host detection) that starts headless sdk workers; under Claude
  Code it stays `pane`. `auto` falls back to panes, with a note on stderr, for
  `--auto-merge`, non-copilot workers, an explicitly assigned
  reviewer-contract role, or a missing `@github/copilot-sdk`. `--transport`
  accepts `sdk`, `pane`, `auto` and the aliases `tmux`/`psmux`; `team.transport`
  in the project config overrides the default. See the
  [migration note](docs/MIGRATION.md#v581--v590-sdk-team-transport-by-default).
- **Parallel sdk worker launch.** Hosts start concurrently
  (`team.sdk.launchConcurrency`, default 4; env
  `OMC_TEAM_SDK_LAUNCH_CONCURRENCY`). In a live 2-worker run the host launch
  took 75.3 s serial and 24.0 to 51.8 s parallel. Each launch still waits for its
  own worker's claim, so a model turn dominates and varies.
- **`omg team status --json`** adds `transport` and, per sdk worker,
  `host_pid`, `runtime_pid`, `session_id`, `attempt_id`, `updated_at`,
  `task_state`, `current_task_id` and `premium_requests_final`. A session file
  from an earlier launch attempt is ignored. The human `sdk_worker=` line adds
  the host pid and session id.
- **`one_team_per_leader_session` sees sdk teams.** It probed only
  `tmux has-session`, so an sdk team never counted. A team is now live while any
  of its sdk hosts is.

### Changed: per-event Copilot hook dispatcher

- **Copilot hooks run through a per-event dispatcher.** `copilot/hooks.json`
  now has one entry per `(event, matcher)` group of `hooks/hooks.json`
  instead of one per hook. Each entry runs `scripts/copilot/dispatch.cjs`,
  which reads stdin once, runs the group's hooks in order with the same
  `run.cjs` routing and per-hook timeouts, and merges the adapted outputs:
  context joined in hook order, any PreToolUse deny wins, a Stop block from
  any hook survives (reasons joined in hook order, and it beats another
  hook's `continue: false`), a throwing hook fails alone, a timed-out hook
  contributes no stdout, PermissionRequest exit 2 is kept, and under
  `OMC_HOOK_FAIL_CLOSED=1` a timeout (124) beats every other exit code.
  Locally on Windows, Stop drops from 1358 to 1011 ms and SessionStart from
  2403 to 2036 ms. `OMC_COPILOT_HOOK_DISPATCH=0` runs one process per hook
  again without regenerating. Claude Code and `hooks/hooks.json` are
  unchanged. See [HOOKS.md](docs/HOOKS.md#per-event-dispatcher).

### Added

- **Upstream drift bot.** A daily workflow, `.github/workflows/upstream-drift.yml`, checks upstream oh-my-claudecode `dev` against the last ported sha. That sha is recorded in the new `.github/upstream-port.json`. When upstream has moved, the bot applies the range with `scripts/port/upstream-drift.mjs`, using the runbook's exclusions and the mechanical rename map. A clean apply opens a draft port PR to `dev`. Conflicts open an issue that lists them. Each upstream head gets one item, older ones are closed, and nothing is force-pushed. The optional `UPSTREAM_DRIFT_TOKEN` secret lets CI run on bot PRs. See docs/DEVELOPERS.md, "Upstream drift bot".

- **`omg smoke copilot --tier 2 --scenario team`** (opt-in, never in `all`):
  a real 2-worker `omg team` on the default transport, from start to a clean
  shutdown, in about 2 premium requests. Checks `scn.team.started`,
  `completed`, `committed`, `status`, `shutdown`, `duration` and `premium`.

### Fixed

- **Team shutdown preserved every worktree a copilot worker ran in.** The
  worker's SessionEnd hook keeps job records under the worktree's own `.omg/`,
  which the clean check counted as dirty. `omg team shutdown` then exited 1 and
  kept the instance reservation and the team state. Untracked
  OMC runtime state no longer counts, and it is removed with the worktree. A
  half-finished forced removal on Windows, where an action runner still holds the
  directory, retries for up to 15 s and then leaves only that runtime state behind
  with a warning. Any other untracked or modified file still preserves the
  worktree.
- **Upstream port `ef9a44f0e..a720eabd0` (6 commits).** `omg ask antigravity`
  now runs on Windows (the advisor spawns `agy`
  without a shell so the prompt reaches it as one argv value), and antigravity team workers are no longer refused on Windows (upstream #4258).
  Session cwds in a repo subdirectory on Windows resolve to the right worktree
  (#4254). cmux teams verify pane ownership through the tmux-compat layer and
  match surfaces by ref or UUID, and `--force` shutdown no longer stalls on
  workers without a verifiable pane (#4261). Plugin cache cleanup keeps
  symlinked versions and ignores orphaned `*.tmp~*` directories (#4263).
- **Project config is `.copilot/omg.jsonc` everywhere.** The security config
  reader, the Stop hook (`persistent-mode.mjs`), the keyword detector's
  `keywordDetector.disabled` opt-out, per-agent model overrides in the
  PreToolUse hook, and `autopilot --workflow` profiles each read a different
  file before (`.copilot/omc.jsonc` or the upstream `.claude/omc.jsonc`). All
  of them now read `.copilot/omg.jsonc` first. `.copilot/omc.jsonc` is read
  as a fallback when the canonical file is absent, and hooks that read
  `.claude/omc.jsonc` before still fall back to it. Docs, skills and error
  messages name the canonical file only.
- **`omg doctor conflicts` reports a legacy-named project config.** It prints
  the exact rename command for `.copilot/omc.jsonc` or `.claude/omc.jsonc`,
  or says the file is ignored when `.copilot/omg.jsonc` also exists. It never
  renames the file and does not count it as a conflict.

### Documentation

- **Copilot CLI hook event audit.** `docs/DEVELOPERS.md` lists every hook
  event Copilot CLI 1.0.91 supports, with evidence from its own package, and
  how each maps to the generated `copilot/hooks.json`. All 11 upstream hook
  events are already projected. The Copilot-only events (`notification`,
  `errorOccurred`, `preMcpToolCall`, `userPromptTransformed`, and the
  protocol-only `postResult` and `prePRDescription`) have no upstream hook to
  map.
  The SDK's callback hooks cover only 10 of the CLI's 15 file hook events.

# oh-my-copilot v5.8.1

## [5.8.1] - 2026-10-06

Fork **v5.8.1** is a patch release: it ports upstream oh-my-claudecode `dev`
bcaceb136..ef9a44f0e, moving parity from upstream 5.6.2 (upstream's own
version did not change in this range). There are no breaking changes and
nothing to migrate. The fork stays ahead of upstream at v5.8.1 vs upstream's
5.6.2.

### Ported from upstream oh-my-claudecode dev (bcaceb136..ef9a44f0e)

- **HUD cache wrapper gets a minimum refresh age and a POSIX-sh fast path
  (#4237).** `scripts/lib/hud-cache-wrapper.sh` skips the lock-and-refresh
  step after printing a cached statusline when the cache is younger than
  `OMC_HUD_MIN_REFRESH_SECONDS` (default 15; `0` restores render-every-call).
  A new fast path at the top of the wrapper reads stdin with the shell's
  `read` builtin, pulls the session id out of compact JSON by parameter
  expansion, and rejects ids with unsafe characters, so a fresh, non-empty
  cache can be printed and the script can exit before the normal
  mkdir/sweep/stdin-save path runs at all. Non-compact JSON, a missing id, or
  an unsafe id falls through to the stock path unchanged.
- **HUD renders todos from `TaskCreate`/`TaskUpdate`, tracked by task id
  (#4242/#4243).** The HUD transcript reader now follows the `TaskCreate` and
  `TaskUpdate` tools, not only `TodoWrite`: `TaskCreate` adds a pending todo
  (held until its tool result supplies the task id), and `TaskUpdate`
  addresses that todo by id to change its status or subject or delete it.
  `TodoWrite` keeps replacing the full list; `TaskCreate`/`TaskUpdate` apply
  on top of it. A follow-up fix corrected the first cut, which matched
  `TaskUpdate` by subject instead of id, so a bare `{taskId, status}` update
  (the issue's own repro) was a no-op.
- **HUD shows the Claude Code effort level (#4249).** A new `effort` HUD
  element reads the effort level from statusline stdin and renders
  `effort:<level>`, colored cool to warm by intensity (dim low, cyan medium,
  yellow high, magenta xhigh, bold magenta max) and never red, since the HUD
  reserves red for critical state.
- **Autopilot state no longer arms from a sanitized pasted-echo prompt
  (#4250/#4251).** `keyword-detector.mjs` detecting a mode keyword (ralph,
  autopilot, ultragoal, ralplan) inside pasted system-echo content used to
  arm that mode's state even though the prompt sanitizes entirely to the
  pasted-echo sentinel. The detector now skips arming any of those states
  for a prompt that sanitizes to the sentinel, and the sentinel string is
  shared with `persistent-mode.mjs`/`.cjs` and the TypeScript enforcement
  path (`src/hooks/autopilot/enforcement.ts`) as defense in depth, so an
  orphaned state is recognized and cleared wherever it is checked.
- **Detached `new-session -F` format kept unescaped (#4252/#4253).** An
  earlier change updated the detached tmux `new-session -F` format string but
  left both call sites allowlisting the old string, so the new format got
  tmux's `#`-escaping and was printed literally, and
  `parseTmuxCreationRecord()` failed every detached team start outside tmux.
  The format is now defined once and reused for both the `-F` argument and
  the allowlists.
- **Ralph's `hardMaxIterations` is enforced in the Stop hook scripts
  (#4256/#4257).** The hard iteration cap was previously hardened only in the
  TypeScript enforcement path; the Stop hook scripts that actually run it
  (`scripts/persistent-mode.mjs`, and now `templates/hooks/persistent-mode.mjs`,
  which previously had no hard max at all) now mirror
  `src/lib/security-config.ts`: the cap is checked before continuing or
  extending an iteration (not only once `max_iterations` was reached), strict
  mode clamps it to at most 200 instead of letting config raise or disable
  it, and the config is read from the XDG/APPDATA directory with the same
  JSONC parsing `keyword-detector.mjs` uses, instead of a hardcoded
  `~/.config` path and a comment regex that broke on URLs.
- Upstream's own release during this range: **v5.6.2**, folded into the
  ported range above.

### Fork

- The fork's own `wiki-session-end` SessionEnd-budget fix (merged upstream as
  #4246) now returns in its canonical upstream form: the hook script imports
  only the lean dist modules upstream already ships
  (`worktree-paths`, `wiki/session-hooks`, `session-end/cleanup-manifest`,
  and, after sealing, `session-end/worker`), replacing this fork's earlier
  variant of the same fix.
- The fork's own team-shutdown reservation fix (merged upstream as #4247) is
  already in the fork since v5.8.0 (#218); it is now also upstream in
  canonical form, so no fork change was needed here.

# oh-my-copilot v5.8.0

## [5.8.0] - 2026-10-06

Fork **v5.8.0** (from v5.7.0) is a minor release: it adds an experimental
headless SDK transport for `omg team`, lets factory chains run past their
first link on Copilot, cuts Copilot hook latency, and runs the headless
Copilot smoke in CI. There is no upstream port in this release; parity stays
at upstream oh-my-claudecode `dev` bcaceb136. No breaking changes, and the
defaults are unchanged: the team transport stays `pane`, the SessionEnd budget
under Claude Code stays 300 ms, and the CI smoke job skips without its
secret. The skill count stays 61. See the
[v5.7.0 → v5.8.0 note](docs/MIGRATION.md#v570--v580-sdk-team-transport).

### Experimental: headless SDK team transport

- **`omg team --transport sdk` (#219):** `omg team 2:copilot --transport sdk
  "<task>"`, or `team.transport: "sdk"`, runs each copilot worker as a
  detached `omg team sdk-host` process that owns one `@github/copilot-sdk`
  session, with no pane and no tmux or psmux. Workers report through the
  unchanged `omg team api`, and `omg team status` shows each worker's
  provider state, turns, credits and premium requests. The transport needs
  `copilot` on PATH and `@github/copilot-sdk` installed
  (`npm i -g @github/copilot-sdk --omit=optional --ignore-scripts`); without
  the SDK each worker fails with that install hint. The default stays `pane`.
- **Permission model:** no allow-all. The host answers every permission
  request: writes only inside the worker's worktree and the team state root,
  reads also in the plugin root, MCP calls only to the plugin server. The
  shell policy is a denylist, not a sandbox: it rejects team control other
  than `team api`, `omg smoke`, `tmux`/`psmux`, `git push` (also as a
  subcommand and through quoting) and the `shell(<prefix>)` entries of
  `workerDenyTools`. Sub-agent tools (`task`, `run_dynamic_workflow`,
  `dynamic_workflows_manage`, `write_agent`, `read_agent`, `list_agents`,
  `search_code_subagent`) and the plugin's `host_smoke` are removed from the
  session. Each worker gets its own `COPILOT_HOME`. The start banner states
  this policy instead of the pane allow-all lines.
- **Credit cap:** `team.sdk.maxCreditsPerWorker` (default 10, a positive
  number; env `OMC_TEAM_SDK_MAX_CREDITS`). At the cap the host aborts the
  turn and takes no more prompts; `omg team status` shows the worker as
  `capped` with a reassign recommendation.
- **Rejected at start under sdk:** `--auto-merge`, non-copilot workers,
  scaling, and an explicitly assigned reviewer role with a verdict contract
  (`critic`, `code-reviewer`, `security-reviewer`, `test-engineer`, via a
  task's `role` or `team.roleRouting`). A contract role only inferred from
  the task text is dropped and the worker runs as a plain executor. Dead
  workers are not recovered.
- **Shutdown** stops all sdk hosts in parallel and kills only processes whose
  identity matches the recorded host. The sdk host stays off the MCP tool
  registry, so the team bundle carries no native modules.
- **Measured:** two live runs on Copilot CLI 1.0.91 with SDK 1.0.16, two
  workers with one task each: 1 premium request per worker, about 3.5 s from
  host spawn to an idle SDK session, `omg team` returned after 72.8 s and
  73.9 s because workers launch one after another, and `omg team shutdown`
  took 8.8 s.

### Factory chains on Copilot

- **Factory chains run past their first link on Copilot (#220):** Copilot CLI has no
  `--session-id`, so a factory chain used to stop silently after one link.
  The spawner now sets `OMC_CHAIN_LINK=<link id>` on each Copilot link, and
  SessionEnd resolves the link as `OMC_CHAIN_LINK`, then the host session id.
  The variable is trusted only when it names a `host: "copilot"` ledger
  that the link's SessionStart bound to the ending session, so neither the
  variable alone nor a nested session inheriting it can inject or end a
  link; the SessionEnd worker never forwards it. A duplicate SessionEnd gets
  the same chain back. Copilot's SessionEnd reason
  `complete` counts as success. Ledgers record `chainLink`, `host`,
  `createdAt` and `parentLink` and are closed once by their link's SessionEnd
  (`closedAt`, `hostSessionId`, `outcome`, `decision`); the watchdog skips
  a closed ledger only when it advanced the chain or left a stop marker, and
  `omg factory status` lists each chain's links. A ledger's
  `maxStageVisits` now carries to later links (above 99 clamps to 99). Under
  a dev plugin root that does not overlap the link's working directory,
  Copilot links get `--plugin-dir` and the SessionEnd worker forwards
  `OMC_PLUGIN_ROOT`. Guardrails, `COPILOT_ALLOW_ALL=false` and the AFK
  profile are unchanged. Verified live with a two-link chain on Copilot CLI
  1.0.91 (2 premium requests).
- **`omg smoke copilot --scenario chain`:** an opt-in tier 2 scenario that
  runs that two-link chain against real `copilot -p` links and asserts the
  link identity, the hand-off, the closeout and the cost from the ledgers
  and both sessions' events. It is not part of `all` or the default set.

### Copilot hook latency

- **Copilot SessionEnd foreground budget is 1500 ms (#224):** `scripts/run.cjs` gave
  `session-end.mjs` and `wiki-session-end.mjs` 300 ms on both hosts, so under
  load Copilot recorded failed SessionEnd hooks (exit 124 with
  `OMC_HOOK_FAIL_CLOSED=1`) and dropped the cleanup. Copilot waits up to 30 s
  for SessionEnd, so the budget is now 1500 ms when `OMC_HOOK_EVENT=SessionEnd`.
  1500 ms is a chosen value (about 5x the idle foreground cost), not one
  derived from a load model. Claude Code keeps 300 ms.
  `OMC_SESSION_END_BUDGET_MS` overrides both. With 4
  parallel lanes of 8 SessionEnd pairs, 0/64 runs fail (before: 56-63/64).
  `session-end.mjs` also loads the factory chain enqueuer only when a chain
  ledger or `OMC_CHAIN_LINK` exists, which cuts its idle median from 300 ms
  to about 260 ms.
- **Copilot runs generic hooks in a Worker (#224):** under Copilot (`OMC_HOOK_EVENT`
  set), `scripts/run.cjs` runs the 18 audited generic hook scripts in a Worker
  thread instead of the Windows `--generic-child-supervisor` chain of three
  Node processes (two on Linux/macOS, which have no supervisor hop). Timeout,
  `OMC_SESSION_OWNER_PID`, extra arguments, stdin, exit code and fail-closed
  124 are unchanged, and on an idle project, every hook's stdout/stderr and
  written files match the child path. A
  Worker-routed hook is about 90 ms faster on Windows and about 50 ms faster
  on Linux/macOS. A Worker cannot preempt a hook blocked in a synchronous
  call, so entries whose own manifest timeout is 3 s or tighter
  (`post-tool-directory-context-injector.mjs`, `post-tool-use-failure.mjs`,
  `subagent-tracker.mjs start`, `wiki-pre-compact.mjs`,
  `workflow-drift-guard.mjs`) stay on the supervised child path instead,
  where `taskkill /T` can still reap a blocked sync `git` call; several of
  the audited scripts make such calls with their own ~2 s timeouts. Local
  bench, sum of medians: Stop 1331 to 976 ms, SessionStart 1919 to 1482 ms,
  PreCompact 994 to 805 ms; PostToolUse and PostToolUseFailure keep their
  child-path cost (789 ms, 188 ms) because their only audited entries have a
  3 s budget. Claude Code keeps the child path.
  `OMC_COPILOT_HOOK_WORKER=0` turns the routing off.

### CI: Copilot smoke job

- **Headless Copilot smoke in CI (#222):** a new `smoke` job in
  `.github/workflows/ci.yml` installs the Copilot CLI (`npm i -g
  @github/copilot`) and `@github/copilot-sdk` on ubuntu-latest and runs
  `omg smoke copilot --tier 2 --sdk-static` after every build, with zero
  model calls. Pushed `v*` tags also run the default scenarios (`smoke`,
  `guardrail`, about 2 premium requests). It authenticates with the
  repository secret `COPILOT_GITHUB_TOKEN` and passes with a skip notice when
  the secret is absent, as on fork PRs. Reports and the kept homes are
  uploaded only after a scan for token-shaped strings and the exact token
  passes. Pinned by `tests/lint/copilot-smoke-ci-workflow.test.ts`; setup in
  [docs/DEVELOPERS.md](docs/DEVELOPERS.md#tier-2-in-ci).
- **Smoke on Linux:** the missing-binary message no longer names the WinGet
  directory off Windows; it points at `npm i -g @github/copilot`.

### Fixes

- **`omg team shutdown` from a fresh shell (#218):** shutdown no longer
  reclaims the active instance reservation just because its owner, the
  `team start` CLI, has exited. Before, every shutdown from a new shell
  failed with `team_instance_reservation_missing`. Only a pending, never
  activated reservation with a dead owner is stale. This affected pane teams
  as well.
- **`--json` honoured (#221):** `doctor conflicts`, `wait status`,
  `wait detect`, `teleport list` and `teleport remove` read `--json` through
  `optsWithGlobals()`, so the parent command's flag no longer swallows it.
  `team status` no longer treats a literal `--json` as the team name,
  resolves the running team when exactly one exists and no name is given,
  and with `--json` prints one JSON document with an `ok` field, including
  the sdk worker fields.
- **`omg smoke copilot --json` stdout stays pure (#217):** the Windows
  no-tmux banner is skipped whenever `--json` is in argv, so even a caller
  that merges stdout and stderr gets only the JSON report.
- **Chain scenario path gate (#223):** `--scenario chain` builds its sandbox
  state paths through `getOmcRoot`, so it passes the multirepo path gate and
  honours a relocated state root.

# oh-my-copilot v5.7.0

## [5.7.0] - 2026-10-05

Fork **v5.7.0** (from v5.6.2) is a minor release: it adds the headless smoke
harness (`omg smoke copilot` and the MCP tool `host_smoke`, tiers 0 to 2),
fixes two hook behaviours, and ports upstream oh-my-claudecode `dev`
486b85bbb..bcaceb136. Upstream is still at version 5.6.1. No breaking
changes: the new peer dependency `@github/copilot-sdk` is optional and
`OMC_HOOK_FAIL_CLOSED` is opt-in. The skill count stays 61. See the
[v5.6.2 → v5.7.0 note](docs/MIGRATION.md#v562--v570-smoke-harness).

### Ported from upstream oh-my-claudecode dev (486b85bbb..bcaceb136)

#4231 to #4234 originated in this fork and were merged upstream; they return
here in upstream's canonical form.

- **`intake run --headless` (#4231):** `intake run` registers `--headless`,
  the flag the entry written by `intake schedule` passes, so scheduled
  sweeps no longer exit with `unknown option '--headless'`. Covered by
  `src/cli/commands/__tests__/intake-headless-flag.test.ts`.
- **Team shutdown tests (#4232):** the dead-owner identity in
  `src/cli/__tests__/team.test.ts` is derived from the host platform, so the
  tests pass on Windows as well as POSIX.
- **State-lock owner-reclaim test (#4233):** adds the missing
  `scripts/dev/repro-state-lock.mjs` and makes
  `tests/integration/state-lock-owner-reclaim.test.ts` assert real lock
  acquisitions.
- **State-lock file identity (#4234):** identity helpers that guard a lock
  artifact or a publication stat with `{ bigint: true }`, so NTFS file ids
  above 2^53 stay distinct (state-lock, mode-state-io and the atomic-write
  twins; the win32 zero-dev tolerance is kept as `0n`).
  `sameStateFileGeneration` compares through `sameFileIdentity`, so a
  generation-bound clear no longer fails closed on win32 dev 0. Before
  quarantining a dead owner, both lock twins re-read the owner record and
  require the same owner as well as the same identity.
- **Team worker env passthrough off the command line (#4236, fixes #4230):**
  `OMC_TEAM_WORKER_ENV_PASSTHROUGH` values are no longer inlined into the
  worker pane's `env -i KEY='value'` command, where they showed in argv and
  tmux `pane_start_command`. Only the fixed baseline stays inline; the
  passthrough values go to a private `0600` file in a `0700` directory that
  the pane's `/bin/sh` sources, removes, and then execs the login shell.

### Fork

- **`omg smoke copilot` and MCP tool `host_smoke`:** a headless smoke check
  that loads a plugin root into the real GitHub Copilot CLI inside a
  throwaway `COPILOT_HOME`. Tier 0 makes no model call: it checks the
  manifest, generated hooks and agents, `plugin list` / `skill list`, and the
  MCP tool count. Tier 1 (`--tier 1`) adds one live session with the prompt
  on stdin, costing one premium request, and asserts the session events,
  hook runs (hooks run fail-closed; `hooks.adapter_errors` fails on any
  `[omg-hook]` error line), plugin and MCP load, and `.omg/` state writes.
  The standalone MCP server now exposes 56 tools; `OMC_DISABLE_TOOLS=smoke`
  hides `host_smoke`. The MCP tool only smokes its own package root unless
  `OMC_SMOKE_ALLOW_ANY_ROOT=1`, and refuses tier 1 unless
  `OMC_SMOKE_ALLOW_LIVE=1`.
  `npm run test:live` runs `tests/live/copilot-smoke.test.ts` (Tier 1 only
  with `OMC_LIVE_SMOKE=1`); the default test run excludes `tests/live/**`.
  See [docs/DEVELOPERS.md](docs/DEVELOPERS.md#headless-smoke-against-a-local-build).
- **Smoke tier 2, SDK-driven scenarios:** `omg smoke copilot --tier 2` drives
  the installed Copilot CLI through `@github/copilot-sdk`, now an optional
  peer dependency that npm does not install
  (`npm i -g @github/copilot-sdk --omit=optional --ignore-scripts`). It adds
  free `sdk.*` checks of the runtime's plugin, skill, agent, and MCP lists
  (`--sdk-static` runs only these) and the scenarios `smoke` and `guardrail`
  by default, plus `skill` and `delegate` (`--scenario <list|all>`), each
  about one premium request, so the default run costs about two.
  `--max-credits` caps the whole run: a scenario that passes it is aborted
  and the rest are skipped. `sdk.tools_excluded` proves the smoke's own
  `host_smoke` tool is hidden from the model. Under vitest a billable run is
  refused unless `OMC_LIVE_SMOKE` names the tier. The report gains `sdk`,
  `cost`, and per-scenario `artifacts.events`. `host_smoke` accepts `tier: 2` and `scenarios`; tier 2
  with scenarios needs `OMC_SMOKE_ALLOW_LIVE=1`, `scenarios: []` does not.
  `npm run test:live` runs the tier 2 static checks when the SDK resolves and
  the default scenarios with `OMC_LIVE_SMOKE=2`.
  See [docs/DEVELOPERS.md](docs/DEVELOPERS.md#tier-2--sdk-scenarios).
- **Hook runner fails closed on timeout when asked:** with
  `OMC_HOOK_FAIL_CLOSED=1`, `scripts/run.cjs` exits `124` when a hook times
  out, instead of `0`. Without the variable it still fails open.
- **Wiki capture fits the SessionEnd budget:** `scripts/wiki-session-end.mjs`
  imports the lean `dist/hooks/session-end/wiki-foreground-bootstrap.js`
  entry instead of the full SessionEnd module graph, which cost about 100 ms
  of the 300 ms SessionEnd budget. Wiki capture now completes reliably under
  Copilot instead of being cut off.

# oh-my-copilot v5.6.2

## [5.6.2] - 2026-10-05

Fork **v5.6.2** (from v5.6.1) ports upstream oh-my-claudecode `dev`
4280efb1f..486b85bbb. Upstream is still at version 5.6.1; the fork bumps its
own patch version. No breaking changes; the skill count stays 61. Nothing to
migrate; see the [v5.6.1 → v5.6.2 note](docs/MIGRATION.md#v561--v562-postinstall-hook).

### Ported from upstream oh-my-claudecode dev (4280efb1f..486b85bbb)

- **contained-fs postinstall (#4217):** `npm install` now runs a
  `postinstall` hook (`scripts/postinstall-contained-fs.mjs`). On macOS it
  builds the contained-fs native addon when no prebuilt
  `native/contained-fs-darwin-<arch>.node` is present; if the build cannot
  run (no Node headers or Xcode Command Line Tools), it prints a one-line
  warning with the manual `node scripts/build-contained-fs.mjs` command and
  exits 0. On Linux and Windows, and in a source checkout (a `.git`
  directory at the package root), it exits 0 without doing anything.
  `scripts/build-contained-fs.mjs` takes a new `--optional` flag that skips
  instead of throwing when the platform is unsupported or no headers are
  found. CI checks that the packed tarball contains the build, postinstall
  and verify scripts, `native/contained-fs.c` and the `postinstall` entry,
  and that the tarball installs cleanly;
  `tests/integration/contained-fs-packaging.test.ts` covers the packaging.
- **Production-safe `team shutdown` (#4218):** shutdown first removes a stale
  team reservation whose owner process is dead (`cleanupStaleReservations`,
  under the lifecycle lock). Shutting down a team with no state prints
  `No team state found for <name>` instead of throwing, and a shutdown error
  prints its message and sets exit code 1 instead of an uncaught failure.
  In the runtime CLI (`src/cli/team.ts`), a team whose config has no valid
  `instance_id` (a partial startup) has its reservation and state directory
  removed (`cleanupAbandonedTeamState`) and exits 1. `startTeamV2` runs the
  stale-reservation cleanup before taking the lifecycle lock, so a dead
  owner's leftover reservation no longer blocks a new team of the same name.
- **git-guardrails latency (#4221):** the destructive-git PreToolUse hook
  runs in a worker thread inside `scripts/run.cjs` instead of a second Node
  process, and `run.cjs` skips it entirely when `OMC_GIT_GUARDRAILS=0`. The
  hook parses the command before the mode lookup, so the state read and git
  calls only happen for a destructive command; there is no substring
  prefilter that could skip a real git command. The Copilot projection
  (`copilot/hooks.json`) invokes the hook through the same `scripts/run.cjs`.

# oh-my-copilot v5.6.1

## [5.6.1] - 2026-10-04

Fork **v5.6.1** (from v5.5.0) ports upstream oh-my-claudecode v5.6.0, v5.6.1
and upstream `dev` through 4280efb1f (862c69273..4280efb1f). It brings the
unattended-run / software-factory surface to Copilot under a scoped AFK
permission profile and hardens host launches on Windows. No breaking changes;
the skill count stays 61. Upgrading? Read the
[v5.5.0 → v5.6.1 guide](docs/MIGRATION.md#v550--v561-fork-upgrade-guide).

### Ported from upstream oh-my-claudecode v5.6.0 / v5.6.1 and dev (862c69273..4280efb1f)

- **Software factory:** a SessionEnd chain enqueuer driven by the project
  route table (`.omg/factory-routes.json`, the single source of truth),
  gate grading, chain guardrails (serial single-session lock and a daily
  cap of 10), check evidence, a diff-first review gate, and a stalled-chain
  watchdog. `omg factory listen` (HMAC-signed tracker intake, bound to
  127.0.0.1), `omg factory init` (seeds the route table and checks
  prerequisites), and `omg factory status` (read-only chain audit).
- **Intake:** `omg intake run` runs the harbor sweep headless;
  `omg intake schedule --cron <expr>` / `--off` registers it with the host
  scheduler (cron, or Task Scheduler on Windows). A run ledger with
  SessionStart reconciliation records unattended-run lifecycles; the
  runs-reconciler test fixtures use relative timestamps so they no longer
  expire.
- **Ralph:** `omg ralph afk` launches an isolated headless ralph run;
  `omg ralph verify` is the only command that computes the feedback
  baseline diff; `omg ralph from-map` plans, claims and launches a run from
  a wayfinder map. Stories are risk-ordered, and the PRD carries a repo
  quality class. The feedback baseline normalizes `node:test` `duration_ms`
  and drops pass/test counters from failure signatures, so a timing-only
  change no longer reads as a new failure (#4215).
- **Unattended-run hardening:** closeouts in ralph, autopilot and team;
  an AFK assumption protocol; an opt-in budget stop; headless harbor and
  refit invocations; a destructive-git guardrail hook
  (`OMC_GIT_GUARDRAILS`); and a stale-run watchdog (`OMC_STALE_RUN_HOURS`).
- **Host-load gate:** expensive operations wait while CPU load, free
  memory or the sibling-session count is over its threshold, and proceed
  if metrics are unavailable (`OMC_HOST_LOAD_*`,
  `OMC_MAX_SIBLING_SESSIONS`).
- **Windows:** the host CLI launches via `COMSPEC` instead of `shell:true`
  (#4154; the fork applies this to both host binaries), zero `lstat` dev is
  tolerated in file identity checks (#4156), and team owner epochs use a
  strict process-start identity (#4211). Session-end deferred chain actions
  survive on Windows, and the omc-setup star endpoint drops its leading
  slash so Git Bash does not rewrite it.
- **Team:** the supervised worker start command stays under 1024 bytes
  (#4191), detached sessions use a dynamic window index (#4193),
  `OMC_TEAM_WORKER_ENV_PASSTHROUGH` forwards custom provider credentials
  (#4194), and `roleRouting` takes a per-role `reasoningEffort` (#4206).
  The fork applies `reasoningEffort` only to providers with a verified CLI
  flag, which excludes Copilot workers.
- **jev:** `:active` mode now acts on the Jev answer in script and TS
  callers, and its configuration and judgment points are documented in
  `docs/HOOKS.md` (#4164, #4208).
- **LSP:** diagnostic URI keys are normalized so Windows drive-letter
  encodings match; malformed escapes are kept verbatim (#4185).
- **Session end:** workers receive `ANTHROPIC_*`, `OMC_HOOK_BRIDGE` and
  model-provider auth alongside the fork's Copilot, Teams, Discord and
  Telegram keys (#4168, #4178), and failed bridge forwards are now reported.
- **State lock:** upstream's owner-file fallback race fix (#4149) and its
  regression test are covered by the fork's stronger variants
  (`scripts/lib/state-lock.mjs`, `src/lib/mode-state-io.ts`). The fork
  keeps capturing identity before the liveness probe and rechecks both the
  owner record and dev/ino before rename. The win32 `ticks:` identity
  encoding in the atomic-write twins is reconciled with upstream's (#4148).

### Fork: Copilot host adaptations and security fixes

- **Unattended runs on Copilot:** factory chain links and
  `omg ralph afk|from-map` launch the Copilot host binary with
  `--no-ask-user` and a scoped AFK permission profile
  (`--allow-tool=shell(gh issue view|comment|edit, gh pr view|list,
  gh label list)`, `--allow-tool=write`, `--allow-url=github.com`, plus
  `--deny-tool=write(.git)`, `--deny-tool=write(package.json)` and
  `--deny-tool=shell(git push)`); single-token `--verify` commands are
  refused on Copilot. `omg intake run` launches Copilot with
  `--no-ask-user` and no allow rules. Copilot cannot pin a session id, so a
  factory chain stops after its first link and the watchdog reports it.
- **Prompt never on a `cmd.exe` command line (security):** on Windows the
  host binary receives the prompt on stdin for both hosts (verified against
  Copilot CLI 1.0.91). Native `.exe` binaries are spawned directly with an
  argv array (`resolveHostBinaryLaunch`, `buildHostBinarySpawn`); only
  `.cmd`/`.bat` shims go through `COMSPEC`, and `quoteForCmd` now keeps
  CRT and cmd quote parity and refuses `%`. Before this, a prompt containing
  `\" --allow-all-tools \"` split the argument vector and `%GH_TOKEN%`
  expanded inside quotes; both were reachable from `package.json` scripts
  (autoresearch setup) and `check_suite.head_branch` (factory listener).
- **`COPILOT_ALLOW_ALL` (security):** excluded from the session-end
  `COPILOT_*` passthrough and forced to `false` on every AFK child, so an
  exported value can no longer widen the AFK profile to unrestricted shell.
- `check_suite.head_branch` is validated before it enters a prompt, and
  `omg intake --host-bin` is validated like the team launch contract.
- `omg intake run` accepts `--headless`, the flag the entry written by
  `omg intake schedule` passes; before this, every scheduled sweep exited with
  `unknown option '--headless'` (also present upstream).
- The copilot worker contract follows #4206's
  `buildLaunchArgs(model, reasoningEffort, extraFlags)` signature, so deny
  flags keep reaching Copilot workers.

# oh-my-copilot v5.5.0

## [5.5.0] - 2026-10-02

Fork **v5.5.0** (from v5.1.0) ports upstream
oh-my-claudecode v5.4.0, v5.5.0 and upstream `dev` through 862c69273
(#4135, #4140), and makes the fork work as a native GitHub Copilot CLI
plugin: hooks, agents, team workers and `omg launch` now follow the Copilot
CLI 1.0.88 contract. Before this release every fork hook was a silent no-op
under Copilot on Windows. Ten new skills (61 canonical total). Upgrading?
Read the [v5.1.0 → v5.5.0 guide](docs/MIGRATION.md#v510--v550-fork-upgrade-guide).

### Ported from upstream oh-my-claudecode dev (v5.5.0..862c69273)

- **Four new skills (57 → 61):** `map` (yard router, which also routes the
  fork-exclusive skills), `pr`, `refit`, and `tdd`. Delivery-loop hardening
  in `launch`.
- **jev** active mode (env-activated), the script-side judgment channel,
  token usage in the shadow log, and `OMC_JEV_QUIET`.
- **budget-guard Stop hook** (`OMC_RUN_BUDGET_TOKENS`) and its enforcement
  log.
- **Team:** honest start-failure reporting, busy-pane vs startup success,
  Windows worker launch environments (#4102, including the PATHEXT
  preference in `src/platform/executable-resolution.ts`), and a final recheck
  window for startup evidence (#4135).
- **Hooks:** unread worker stdin is released, env overrides are validated,
  and the state root resolves without git on PATH.
- **Installer:** user-owned collisions are skipped during bundled skill sync;
  upstream's Windows state-lock bridge path fix (#4140) replaces the fork's
  interim fix.

### Ported from upstream oh-my-claudecode v5.5.0 (v5.4.0..v5.5.0)

- **Four new skills (53 → 57):** `architecture-survey`, `diagram`, `intent`,
  and `minimal-prose-discipline`. Adds the shipyard-audit script (auditing
  `.omg/skills`), the shipyard/launch/drydock discipline rounds, and the
  `cancel` skill rewrite.
- **jev judgment points** (shadow mode) across hooks, plus the `jev-eval`
  script. On win32 the shadow recorder detaches so it survives hook exit.
- **Team:** immutable team instance id lifecycle, scoped cancellation, and
  consistent task claims and monitor snapshots.
- **Hooks:** read-budget preflight, directory-context injector registration,
  and the `${CLAUDE_PLUGIN_ROOT}` brace form in hook commands.
- **State lock:** a file fallback when `better-sqlite3` cannot load. On a
  slow win32 liveness probe the fork retries when the owner artifact vanished
  instead of failing as unverifiable.
- **Launch:** credentials stay off the command line, and the tmux pane is
  exec-replaced.
- **Known Windows gap:** upstream's strict process identity accepts only
  linux/darwin, so team instance recovery fails closed on win32.

### Ported from upstream oh-my-claudecode v5.4.0 (v5.3.0..v5.4.0)

- **Two new skills (51 → 53):** `harbor` (shipyard intake gate) and
  `agent-doc-discipline`.
- **`omg lookout scan`:** a pre-flight danger scan and its parsers.
- **SQLite state-mutation lock** (`scripts/lib/state-lock.mjs`) with
  standalone hook bridge provisioning. It replaces the fork's portable-lockfile
  backend. On win32 the release retries on `SQLITE_BUSY`/`SQLITE_LOCKED`.
- A configurable SessionStart context budget, worktree-paths locale and
  bare-repo probes, team provider preflight and launch-gate hardening, and
  contained-FD graph traversal on Darwin. The Ruby prerequisite is removed.

### Added

- **Copilot plugin manifest.** A root `plugin.json` is the manifest Copilot
  CLI reads; it takes precedence over `.claude-plugin/plugin.json`, which
  Claude Code keeps using. It points `hooks` at the generated
  `copilot/hooks.json` and `agents` at the generated `copilot/agents/`, and
  it carries the MCP server and commands.
- **Generated Copilot hooks** (`npm run build:copilot-hooks`,
  `scripts/copilot/build-hooks.mjs`). `copilot/hooks.json` is derived from
  the upstream-identical `hooks/hooks.json`. Each entry uses `exec: "node"`
  with an `args` array, so no shell runs and a plugin path containing spaces
  stays one argument. `OMC_HOOK_EVENT` names the event. The generator throws
  on a hook command form it does not recognise, so an upstream change breaks
  the build instead of shipping a no-op.
- **Copilot hook output adapter** (`scripts/lib/copilot-hook-adapter.cjs`,
  preloaded with `node --require`). It translates Claude-shaped hook output
  to Copilot's contract: it hoists `additionalContext` to the top level, turns
  PreToolUse blocks into `permissionDecision: "deny"`, maps Stop blocks, and
  converts exit code 2. It fails open on a hook's internal error.
  `OMC_HOOK_FAIL_CLOSED=1` keeps the original exit code, and
  `OMC_HOOK_STRICT=1` makes a hook target that is not a file exit 1. See
  [docs/HOOKS.md](docs/HOOKS.md#copilot-cli-hook-projection).
- **Generated Copilot agents** (`npm run build:copilot-agents`,
  `scripts/copilot/build-agents.mjs`). `copilot/agents/*.md` has the same body
  as `agents/*.md`. Model aliases become Copilot `models:` fallback lists.
  Read-only agents get a `tools:` allowlist without create/edit/apply_patch;
  shell stays allowed, as with Claude's `disallowedTools`. Agents that review
  or edit code get `include-custom-instructions: true`.
- **`copilot` team worker type.** `omg team N:copilot` is accepted by every
  worker validator, and `copilot` is the default worker on a Copilot host.
  Copilot workers launch with `--allow-all-tools --allow-all-paths
  --allow-all-urls --no-ask-user`. Claude-style model ids are mapped to
  Copilot's dotted form (`claude-opus-4-8` → `claude-opus-4.8`).
- **Worker deny rules:** `permissions.workerDenyTools` and
  `permissions.workerDenyUrls` in `omg.jsonc` are forwarded to copilot workers
  as `--deny-tool=` / `--deny-url=`. Deny beats allow. Only copilot workers
  enforce them. `omg team` prints one `[omg team] <provider> workers (xN): ...`
  line per provider to stderr, and for other providers that line says the deny
  list is NOT enforced. Provider advisors print a bypass warning.
- **`omg doctor conflicts`** warns when the legacy `COPILOT_CONFIG_DIR` is set
  and checks that `node` is on PATH.

### Changed

- **Config directory variable:** `COPILOT_CONFIG_DIR` renamed to
  `COPILOT_HOME`, the variable GitHub Copilot CLI actually reads. The old
  name is no longer honoured (no env fallback); `omg doctor conflicts` warns
  when it is set. The `${COPILOT_CONFIG_DIR}` token in `omg.jsonc` guards
  still works as an alias of `${COPILOT_HOME}`, and the package's JS export
  `COPILOT_CONFIG_DIR` remains as a deprecated alias.
- **Host detection:** the host is Copilot when Copilot session markers are
  present; otherwise `CLAUDE_CODE_ENTRYPOINT` selects Claude Code. The team
  default worker, stage routing, scale-up, and the routing-snapshot fallback
  all follow the host.
- **`disableExternalLLM`** now means "only the current host CLI's workers":
  claude on a Claude Code host, copilot on a Copilot host.
- **`omg launch`** spawns and probes the host binary. On Copilot, `--madmax`
  and a typed `--dangerously-skip-permissions` become `--yolo`, and `-p` /
  `--prompt` print mode adds no allow flags. The launcher forwards
  `COPILOT_HOME`, `COPILOT_MODEL`, `GH_HOST`, and `COPILOT_GH_HOST` into tmux;
  tokens travel only through the private transport. The config-dir mirror is
  skipped on Copilot. On macOS, `--madmax` / `--yolo` require tmux on both
  hosts, judged from the raw arguments.
- **`agents.<name>.model`** overrides are applied through the PreToolUse
  `updatedInput` channel, which Copilot does not support, so they are a no-op
  on Copilot. Per-agent models there come from the generated `models:` lists
  or Copilot's own `subagents.agents.<name>.model` setting.
- **SessionStart `init` and `maintenance` hooks** are not projected to
  Copilot. Copilot ignores SessionStart matchers, so they would run (and
  prune state) on every session. Claude Code is unchanged.
- `hooks/hooks.json` and `agents/*.md` stay byte-identical to upstream for
  Claude Code.
- **`node` must be on PATH** under Copilot: a PreToolUse hook that cannot
  start is denied by Copilot itself, which blocks every tool call.

### Removed

- **Fork safe-command auto-approver:** `scripts/safe-command-approver.mjs`
  (the v4-era Copilot `preToolUse` hook that auto-approved "safe" Bash
  commands) and the unused `src/installer/permissions.ts` allowlist generator
  (`generatePermissionAllowList`) are gone. The hook was no longer registered
  in `hooks/hooks.json`, and a review found it approved chained commands
  such as `cat x; curl … | sh`. Use Copilot CLI's native `--allow-tool` /
  `--deny-tool` rules or its assisted-approval mode instead. Upstream's
  `src/hooks/permission-handler/` is unchanged.
- **`--dangerously-skip-permissions` in the copilot worker contract.**
  Copilot rejects the flag, so copilot workers could not launch at all.

### Fixed

- **Every fork hook was a silent no-op under Copilot on Windows.** Copilot
  runs hook commands through PowerShell, which split
  `node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs ...` so that node loaded the
  plugin directory and exited 0. The generated `exec`+`args` hooks remove that
  class of bug and save about 0.5 s of PowerShell startup per hook.
- **State-lock owner-file race** (upstream #4146; fixed upstream by #4149).
  The file-fallback lock captures the artifact identity before the liveness
  probe and re-checks owner and dev/ino immediately before rename, so a live
  replacement lock is never quarantined (8×15 contention: 37/120 → 120/120).
- **State-lock temp names on NTFS** (upstream #4147; fixed upstream by #4148).
  Emergency temp names and reconcile regexes in `scripts/lib/state-lock.mjs`
  use the encoded process identity, because NTFS rejects `:`.
- **SQLite lock probe caching.** Liveness is probed outside
  `BEGIN IMMEDIATE`, and verified owners are cached across retries (give-up
  12.8 s → 1.2 s; 8×15 contention 212 s → 2.5 s). Release has a 5 s
  wall-clock retry budget, accepts an already-absent artifact when the row
  still matches, and can reclaim abandoned own nonces.
- The `copilot` worker was rejected by the team validators and its contract
  could not launch; Copilot model ids used the dashed Claude form.
- **`omg team` startup on native Windows (psmux)** (fork fix over upstream
  #4059): teams run in a private psmux namespace via `-L <ns>` instead of a
  shared socket path, server identity is captured from the session's own
  `new-session` record rather than reconstructed, the `if-shell` guard is
  dropped because psmux cannot run it (every PowerShell condition form is
  mangled or misreported on 3.3.8), and `team-owner-epoch.ts` accepts a
  strict `win32:<ticks>` process identity instead of failing closed on
  win32.

# oh-my-copilot v5.1.0

## [5.1.0] - 2026-09-06

Ports the three upstream oh-my-claudecode releases since the v5.0.0 rebase —
v5.1.0, v5.2.0, and v5.3.0 (upstream dev parity at release time) — into the
fork, adapted throughout to the `omg` CLI, the `.omg/` runtime root, the
`.copilot/` host surface, and the `/oh-my-copilot:` namespace. Five new skills
(51 canonical total): the full Shipyard set — `drydock`, `launch`,
`ask-navigator`, `loft` — plus `minimal-code-discipline`.

### Ported from upstream oh-my-claudecode v5.3.0 (v5.2.0..v5.3.0)

- **Two new shipyard skills (49 → 51):** `ask-navigator` (charts foggy efforts
  into decision-ticket maps, hands off to launch) and `loft` (shape-before-steel
  discipline: throwaway artifacts answer design questions). Launch gained the
  fog gate and map check. Paths adapted to `.omg/wayfinder/` and the
  `/oh-my-copilot:` namespace.
- **Workspace checkpoints:** `omg checkpoint create/list/rollback` shadow
  snapshots for autonomous runs, plus `omg graph run --checkpoint`. The fork
  additionally suppresses CRLF conversion so Windows rollbacks are
  byte-faithful.
- **Remote graph approval gates:** `omg graph run --approval-mode remote` with
  notification dispatch, reply-channel decisions, and
  `omg graph approvals list/decide` (the underlying contained run-dir remains
  Linux-only, as before).
- **Review hardening:** abort-aware gates, denied-only rollback, hardened
  reply/checkpoint paths.
- **Hooks:** stderr preserved after early protocol stdout close (#3963);
  unsupported PostToolUse `suppressOutput` omitted; verifier semantics
  preserved on the Worker path.
- **Perf:** batched Windows cache occupancy identity checks with precise tick
  validation; per-render git path memoization in the HUD.
- Windows test adaptations: case-folded occupancy identities via
  `pathIdentity`, fork rules dir (`.copilot/rules`) in the rules-injector
  guard tests.

### Ported from upstream oh-my-claudecode v5.2.0 (v5.1.0..v5.2.0)

- **Hook runner Windows stdio overhaul:** `run.cjs` protocol writes guarded
  against closed consumers, fail-open before Windows tree reap, single generic
  child reap, EPIPE-safe PassThrough teardown, POSIX process-group reaping, and
  runner-aware SessionEnd foreground ceilings and worker timeouts.
- **LSP hardening:** document open/close lifecycle serialization in the LSP
  client, retired document queue cancellation, and bounded directory
  diagnostics lifecycle in the aggregator.
- **Bounded git calls in worktree-paths** with a memoized `probeGitTopLevel`
  (replacing `getGitTopLevel`/`getWorktreeRoot` call sites), plus the
  symmetric dual-state-root warning on the legacy branch (#3937).
- **HUD:** update and paste-ready upgrade hints (`update-hint` element, adapted
  to `oh-my-copilot` package/plugin names), pid-aware cache lock recovery and
  bounded `.err` reclamation, stale stdin tmp orphan reclamation.
- **Shipyard yard gate (launch C5 sediment pass):** launch now refuses to run
  when the drydock `--check` audit reports actionable findings.
- **session-history-search** bounds retained matches while still counting all.
- **Team:** platform-aware worker launch wrapper for POSIX hosts (#3931).
- Windows adaptations: platform-gated expectations for POSIX-only temp paths,
  `$OMC_TEAM_STATE_ROOT` placeholders, pid-liveness lock tests, and junction
  symlinks in tests; separator-normalized superproject assertions.

### Ported from upstream oh-my-claudecode v5.1.0 (v5.0.2..v5.1.0)

- **Three new skills (46 → 49):** `drydock` and `launch` (the Shipyard
  governed-delivery pair, with the methodology map at `docs/shipyard.md`) and
  `minimal-code-discipline` (opt-in YAGNI-ladder writing-time discipline).
  Skill paths adapted to the fork's `.omg/` runtime root and
  `/oh-my-copilot:` namespace.
- **Cursor default-model hook (#3880):** `externalModels.defaults.cursorModel`
  config plus `OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL` /
  `OMC_CURSOR_DEFAULT_MODEL` env fallbacks.
- **Team model routing hardening (#3899–#3905):** shared
  `resolveDefaultWorkerModel` across launch and scale-up, normalized persisted
  model defaults, preserved routing provenance and configured defaults during
  scale-up. The fork's `copilot` provider shares the claude resolution path.
- **Delegation enforcement rewrite (#3911 + follow-ups):** the pre-tool-use
  template gained a real shell-command parser (heredocs, here-strings, ANSI-C
  quoting, fd duplication, printf/echo semantics, coprocesses) eliminating
  delegation false positives, and bounded cross-platform temp/scratchpad path
  allowances in both the template and the orchestrator hook. The template now
  allows the fork's `.omg/` state root alongside legacy `.omc/`.
- Test expectations for POSIX-only temp-path shapes are platform-gated so the
  suite reflects the implementation's deliberate rejection of cross-platform
  path shapes on Windows.

# oh-my-copilot v5.0.0

## [5.0.0] - 2026-08-31

The fork was at v4.13.102. It has now been rebased onto upstream
`yeachan-heo/oh-my-claudecode` v5.0.2 and is being released as the fork's own
**v5.0.0**, adopting upstream's canonical Tier-0 workflow surface
(`plan` → `execute` → `review` → `verify`) and retiring a set of legacy skill
and command names outright rather than aliasing them.

### Breaking Changes

- **Retired 11 skills, removed outright (not aliased):** `ultrawork`,
  `ultraqa`, `deep-dive`, `sciomc`, the `cccg` skill (invoked as `/ccg`),
  `omc-teams`, `setup`, `mcp-setup`, `omc-reference`, `learner`,
  `writer-memory`. Their behavior now lives in `execute`, `verify`, `review`,
  `research`, `omc-setup`, `wiki`, `remember`, and `team`.
- **Retired 7 commands:** `ccg.md`, `deep-dive.md`, `learner.md`,
  `mcp-setup.md`, `omc-teams.md`, `sciomc.md`, `writer-memory.md`.
- **Canonical Tier-0 workflows are now `plan → execute → review → verify`.**
  Three new skills are adopted from upstream: `execute`, `research`, and
  `review`. `review` installs as `omc-review` to avoid colliding with a native
  command. A new `compact` command is also added.
- **The `ultrawork` / `ultraqa` / `ultrapilot` hook subsystems are removed**,
  along with the `stagger-launch` hook. `stagger-launch`'s only trigger was
  `ultrawork` mode, and its thundering-herd protection for parallel agent
  launches is **not** carried over to the new workflow surface — this is a
  known regression, not an oversight.
- Post-retirement inventory: **46 skills, 20 agents, 21 commands**.
- **Host CLI surface moved `.claude/` → `.copilot/`.** oh-my-copilot is a
  GitHub Copilot CLI plugin, so it now reads the host's settings, hooks,
  commands, skills, plugins, rules, tasks, and worktrees from `.copilot/`
  instead of `.claude/`. Project config moved to `.copilot/omg.jsonc` (was
  `.claude/omc.jsonc`). Context-file discovery now prefers
  `copilot-instructions.md` and `.copilot/AGENTS.md`, while still falling
  back to `.claude/CLAUDE.md` and `.claude/AGENTS.md` so the plugin keeps
  working when run under Claude Code. A small number of genuine Claude Code
  interop paths still read `.claude/` on purpose (credentials, installer
  agent/command ownership, todo-continuation task files).
- **OMC runtime root moved `.omc/` → `.omg/`.** All oh-my-copilot runtime
  files now live under `.omg/`: state, sessions, logs, plans, research,
  notepad, project memory, drafts, autopilot, and team state. **This release
  does not auto-migrate existing `.omc/` content** — if you have runtime
  state under `.omc/`, moving it to `.omg/` is a manual step.
  `WORKSPACE_MARKER` is still `.omc-workspace` (unchanged in this release),
  so multi-repo workspace anchors keep working.
- **Short CLI command renamed `omcp` → `omg`.** The user-facing command now
  matches the `.omg/` runtime root and `.copilot/omg.jsonc` project config, so
  v4's `omcp <command>` becomes `omg <command>` and the bridge entrypoint
  `omcp-cli` becomes `omg-cli`. **`omcp` is removed, not aliased** — scripts,
  aliases, and CI steps that call it must be updated. The long-form
  `oh-my-copilot` command is unchanged and is the only name present in every
  version, so use it where a command has to work across the upgrade boundary.
  Statusline users: the HUD wrapper is now `omg-hud.mjs` (was `omcp-hud.mjs`);
  see the Migration Guide for the `statusLine` fix-up.

### Added

- **Microsoft Teams notifications**, sent as Adaptive Card payloads with
  `@mention` support via `tagList` entries in `"DisplayName:AAD-Object-ID"`
  format. Configure with `OMC_MICROSOFT_TEAMS_WEBHOOK_URL` or a `teams`
  config block. Supports both Power Automate Workflows and legacy O365
  Connector webhook URLs.
- **RecentTools HUD element**: a rolling list of recent tool calls with
  status icons and target summaries. Opt-in via `showRecentTools`; tunable
  with `recentToolsMax` (default 5) and `recentToolsShowTarget`.
- **Team: per-role provider and model routing** via `.copilot/omg.jsonc`,
  with a resolved-routing snapshot. Declare which provider (`claude`,
  `codex`, `gemini`, `grok`, `cursor`, `antigravity`) and model tier backs
  each canonical role (critic, code-reviewer, executor, planner, etc.) in
  `team.roleRouting`. Routing resolves once at team creation, persists in
  `TeamConfig.resolved_routing`, and is reused across spawn/scale-up/restart.
  Env override via `OMC_TEAM_ROLE_OVERRIDES`. New `omg doctor team-routing`
  command probes CLI presence for every provider referenced by
  `team.roleRouting`. See `skills/team/SKILL.md` § Per-Role Provider & Model
  Routing.
- **Deep Interview: Round 0 topology enumeration** (#2919; first shipped in
  the fork's v4.13.7). It confirms and locks top-level components before
  ambiguity scoring, rotates multi-component targeting, and includes confirmed
  components plus deferrals in generated specs. Existing `deep-interview`
  state files without `state.topology` are treated as legacy state: on resume,
  unfinished interviews run the Round 0 topology gate before the next scoring
  pass, and already-finalized specs are left unchanged as
  topology-not-captured legacy artifacts.

### Fixed

- **Agent ownership inventory** (`src/installer/historical-agent-ownership.ts`)
  was regenerated from the fork's own 23 v4 release tags (57 records).
  Previously it held upstream's agent file hashes, so every fork-installed
  agent failed authentication and would never be reclaimed when upgrading
  4.13.102 → 5.0.0. A new generator script,
  `scripts/generate-historical-agent-ownership.mjs` (with `--verify`), plus
  npm scripts `generate:agent-ownership` / `verify:agent-ownership`, keep the
  inventory reproducible going forward.
- **Plugin manifest (`.claude-plugin/plugin.json`) previously listed only 32
  skills** — upstream's set — so all 14 fork-exclusive skills (five
  `omc-ado-*`, five `omc-gh-*`, plus `critique`, `deep-review`, `discover`,
  and `ralph-experiment`) were never registered with the plugin host. The
  manifest now lists all 46.
- **Team: alias-keyed role routing is honored, and `team.ops.defaultAgentType`
  is restricted to runtime-supported CLI providers.** Role keys accepted as
  aliases (e.g. `reviewer`) now resolve correctly against `team.roleRouting`
  during validation and stage routing, instead of being silently rejected or
  ignored.
- **State-file locking works on Windows and macOS.** `flockPath()` probed only
  `/usr/bin/flock` and `/bin/flock`, so off Linux `acquireLockAt()` returned
  `unlocked: true` while the caller was still told the lock was acquired —
  there was no inter-process exclusion at all. A portable lockfile fallback
  now runs wherever `flock` is absent: `O_EXCL` temp plus `linkSync`
  publication, an `O_EXCL` guard marker serializing reclaim and release, and
  stale owners cleared by a PID liveness probe with a 60s age ceiling. The
  result reports `acquired: false` rather than claiming exclusivity it does
  not have, and `flock` stays the fast path where it exists. Applied
  identically to `scripts/lib/atomic-write.mjs`,
  `templates/hooks/lib/atomic-write.mjs`, and `src/lib/mode-state-io.ts`.
  `OMC_TEST_STATE_LOCK_MODE` selects `none` or `portable` for tests.
- **Named autopilot workflows are no longer refused off Linux.**
  `isWorkflowRuntimeSupported()` required `process.platform === 'linux'` plus
  an `flock` binary, and `namedWorkflowRuntimeSupported()` additionally
  required `/proc/self/fd`, so named workflow profiles were rejected outright
  on Windows and macOS while state writes skipped integrity validation. Both
  gates now ask whether a working state-file lock exists rather than which
  platform is running. The `/proc/self/fd` transcript walk is kept verbatim on
  Linux; elsewhere each path component is rejected up front if it is a symlink
  and the opened file is confirmed by device and inode, preserving the
  no-follow contract.
- **Setup and uninstall no longer require bash or jq.** `/omc-setup` drove
  `scripts/setup-claude-md.sh` and `scripts/setup-progress.sh`, the latter
  exiting when `jq` was missing, and `scripts/uninstall.sh` had no non-bash
  equivalent — so a Windows user without Git Bash could never complete setup
  and had no supported uninstall, and resume broke on a stock macOS install.
  `scripts/setup-claude-md.mjs`, `scripts/setup-progress.mjs`, and
  `scripts/uninstall.mjs` are the documented entry points; `uninstall.mjs`
  takes `--dry-run` and `--yes`. The shell scripts remain for back-compat.
- **A fresh plugin cache is runnable on Windows without a rewrite.** The shipped
  `hooks/hooks.json` uses `node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs`, the one
  launcher cmd.exe and POSIX sh resolve the same way, and the install-time
  rewrite now self-heals a manifest left in the `sh`/`find-node.sh` form by an
  install on another OS — which previously failed every hook on Windows with
  `'sh' is not recognized`. POSIX installs still take the `find-node.sh`
  bootstrap unconditionally: it resolves `node` from `PATH` when it is there
  and from the nvm/fnm/volta locations when it is not, so it is correct in both
  cases (issue #892).
- **Skill instructions run on Windows.** Eighteen skills, across 21 markdown
  files, embedded POSIX-only command blocks with no Windows variant — including
  the cancel skill's emergency stop-hook escape (a sha256 shell function, GNU
  `date -u -d`, and a python3 heredoc) and the hud install step, whose
  `mkdir -p` and `cp` meant `omg-hud.mjs` was never installed while
  `statusLine` pointed at it. Those blocks are now `node -e` one-liners. The
  cancel escape reuses `scripts/lib/state-root.mjs`, so it honours
  `OMC_STATE_DIR` and workspace markers exactly as the state tools do.
- **Autoresearch evaluator commands run on Windows.** Evaluator commands are
  user-authored POSIX `sh`; running them through `spawnSync` with `shell:true`
  handed them to `cmd.exe`, so every iteration recorded `error` and no mission
  could pass. `src/platform/posix-shell.ts` discovers a real POSIX shell and
  routes the command through `bash -lc`; when none exists the record carries
  an actionable message instead of an inscrutable `cmd.exe` failure.
- **Workflow integrity checks accept NTFS file ids.** Windows file ids
  routinely exceed `Number.MAX_SAFE_INTEGER`, but the transcript identity was
  built with `Number(stat.ino)` and then validated with
  `Number.isSafeInteger`, so the producer emitted values its own validator
  rejected and named workflow Stop handling answered
  `workflow_descriptor_integrity_failed`. Rounding also let two distinct files
  compare equal. Device and inode now travel as decimal strings, matching what
  `mtimeNs` and `ctimeNs` already did; validation still accepts a legacy safe
  integer, so existing state keeps validating.
- **Windows path matching in team permissions, the bridge daemon, and worktree
  cleanup.** Three defects of the same shape: `isPathAllowed` compared a
  `relative()` result carrying backslashes against `/`-written globs, so
  `allowedPaths` denied everything and — more seriously — `deniedPaths` stopped
  denying anything; `validateConfigPath` built containment by concatenating
  `homeDir + '/'`, which no resolved Windows path matches, so the bridge daemon
  could not start at all; and `assertCleanLeaderWorktree` still filtered
  untracked `.omc` after the runtime root was renamed, so OMC's own metadata
  made the leader look dirty and blocked a second worker. All three now go
  through `path.relative` with segment boundaries preserved.
- **The OMC config directory is unified on `${COPILOT_CONFIG_DIR:-~/.copilot}`.**
  `scripts/lib/config-dir.mjs` and `.cjs` defaulted to `~/.claude` while
  `src/utils/config-dir.ts` and `scripts/lib/config-dir.sh` — which their own
  header names as mirrors — defaulted to `~/.copilot`. The bash lifecycle
  therefore wrote `.omc-config.json` where the Node hooks never looked, so
  settings written by one half of the install were invisible to the other.
  Setup now also adopts a stranded pre-unification `~/.claude/.omc-config.json`
  when the resolved location has none, copying rather than moving; the
  `omc-doctor` skill reports one it finds.
- **Background daemons start under Volta and nvm-windows.** The rate-limit-wait
  daemon and the notification reply-listener spawned themselves as
  `spawn('node', ...)` with a stripped env, so where the `node` on the
  forwarded `PATH` did not exist the spawn failed and the daemon silently never
  started. Both now use `process.execPath`, which needs nothing from `PATH`.
  `resolveDaemonModulePath` also follows the shape of the path it is given
  rather than the host platform.
- **The CLI trust check understands Windows.** Trusted prefixes were POSIX-only
  paths joined onto `$HOME`, `OMC_TRUSTED_CLI_DIRS` was split on `:` (shredding
  `C:\Tools\bin`), and matching was a case-sensitive `startsWith`, so every CLI
  resolution on Windows warned about a non-standard path with no way to silence
  it. Home now comes from `USERPROFILE` on Windows, Windows contributes its own
  trusted roots, the override splits on the platform delimiter, and boundary
  matching uses `path.relative`.
- **Every tmux call goes through argv.** `tmuxShell` built a bare
  `tmux <command>` string, skipping the win32 `.cmd`/`COMSPEC` wrapping
  `resolveTmuxInvocation` exists to apply and forcing callers to POSIX-quote
  format arguments — `cmd.exe` passes single quotes through literally, so
  `-F '#{pane_id}'` came back quote-wrapped and pane matching never fired.
  `isTmuxAvailable` also probes with `shell:false`, so an install path
  containing a space no longer reports tmux as missing. This removes the last
  shell-string assumptions from the tmux surface, which is what a Windows
  tmux-compatible binary such as psmux needs; it was verified with unit tests
  against mocked spawns rather than a live tmux session.

### Changed

- **Fork-exclusive skills preserved through the rebase (14):** the five
  `omc-ado-*` Azure DevOps skills, the five `omc-gh-*` GitHub skills, plus
  `critique`, `deep-review`, `discover`, and `ralph-experiment`.
- **Publishing is unchanged:** a `v*` tag still produces a GitHub Release and
  npm publish via `release.yml`. Upstream moved to OIDC Trusted Publishing;
  this fork deliberately did not adopt that change.
- **Executable resolution is consolidated into `src/platform`.** The Windows
  resolution ritual (`where`/`which`, `.cmd` shim handling, `COMSPEC`
  fallback) had been reimplemented independently in six places, most without a
  timeout — a hook checking for a formatter could hang on an unreachable
  network-drive `PATH` entry. `src/platform/executable-resolution.ts` now
  exposes `resolveExecutable`, `isExecutableAvailable`, and `probeExecutable`,
  and the copies in `src/team/cli-detection.ts`, `src/team/model-contract.ts`,
  `src/mcp/cli-detection.ts`, `src/hooks/plugin-patterns/index.ts`,
  `src/tools/lsp/servers.ts`, and `src/cli/tmux-utils.ts` all delegate to it.
  Importers are unchanged. The `COMSPEC` retry validates its arguments against
  a closed grammar before they reach `cmd.exe`.

### Install

```bash
npm install -g oh-my-copilot@5.0.0
```

---

## [4.11.5] - 2026-04-09

### Fixed (ported from upstream oh-my-claudecode v4.11.4)
- **Keyword detector: narrow false-positive suppression** — Added activation and diagnostic intent detection near keywords. Prompts like "ralph keeps looping" or "what is autopilot mode now?" no longer trigger skill invocations, while explicit requests like "use autopilot to fix bug" still activate correctly (#2411)
- **Installer: portable hook command paths on Windows** — Windows hook commands now use bash-portable `${COPILOT_CONFIG_DIR:-$HOME/.copilot}` expansion instead of CMD-only `%USERPROFILE%` syntax (#2415)
- **HUD: fallback to older built cache versions** — When the latest cached plugin version fails to import, the HUD wrapper now tries progressively older built versions before giving up (#2416)
- **Team: preserve forceInherit by skipping worker model resolution** — When `OMC_ROUTING_FORCE_INHERIT=true`, worker model resolution is skipped to preserve parent model inheritance (#2418)
- **Preemptive compaction: fallback to hook context window usage** — When transcript lacks context_window fields, the hook now falls back to `context_window.used_percentage` or token-based calculation from hook input (#2412)

## [4.11.4] - 2026-04-09

### Fixed (ported from upstream oh-my-claudecode v4.11.3)
- **Node resolution: prefer PATH over ephemeral execPath** — PATH-resolved node is now preferred over `process.execPath` which may point at CI toolcache or Homebrew Cellar version-specific paths that disappear after upgrades (#2396)
- **Hooks: avoid .json false positives in source extension check** — `.json` and `.jsonl` files no longer trigger false "Bash command may modify source files" warnings (#2395)
- **Autoresearch: strip TMUX env for nested session compatibility** — Autoresearch launched from inside a nested tmux session no longer silently creates sessions on the nested server (#2385)
- **Symlink path resolution fixes** — Fixed asymmetric symlink resolution in worktree-paths, autoresearch contracts, learner finder, and team fs-utils (#2372)
- **Installer: detect enabledPlugins field** — `hasEnabledOmcPlugin()` now checks both `enabledPlugins` (modern) and `plugins` (legacy) settings fields (#2371)
- **Ralplan: deactivate stale state after completion** — Prevents ralplan state from rearming after consensus completion or circuit breaker exhaustion (#2370)
- **HUD: version fallback from path** — When package.json is missing, version is extracted from the plugin cache directory path (#2362)

### Changed
- **Build scripts: --watch mode** — All esbuild scripts now support `--watch` flag for development hot-reload
- **Plugin-dir helper** — New shared `resolvePluginDirArg()` utility for CLI plugin directory resolution

## [4.9.0-preview.1] - 2026-03-20

### Added
- **Autoresearch module** (`src/autoresearch/`): Thin-supervisor autoresearch with keep/discard/reset parity, guided interview flow, and Claude session setup
- **Ralphthon module** (`src/ralphthon/`): Autonomous hackathon lifecycle mode with PRD-driven phases, tmux interaction, and idle detection
- **Deep-dive skill**: 2-stage pipeline combining trace (causal investigation) with deep-interview (requirements crystallization) and 3-point injection
- **Deepinit manifest tool** (`src/tools/deepinit-manifest.ts`): Manifest-based incremental deepinit for hierarchical AGENTS.md documentation
- **HUD session summary element**: AI-generated session summary (<20 chars) displayed in HUD, opt-in via `sessionSummary: true`
- **Skill resources guidance**: Bundled skill resources discovery and rendering for better skill context
- **MCP standalone shutdown handler**: Parent-PID polling and signal-based shutdown for orphaned MCP servers
- **CLI commands**: `omcp autoresearch`, `omcp ralphthon`, HUD watch loop extraction
- **Deepsearch magic keyword**: Enhanced codebase search mode with parallel agent orchestration
- **cmux multiplexer support**: Team sessions can now launch from cmux surfaces alongside tmux

### Fixed
- **Security: ReDoS guards** — `safe-regex` validation on user-supplied regex patterns in live-data deny/allow lists
- **Informational keyword filtering** — Questions like "what is ralph?" no longer trigger execution modes (supports EN, KO, JA, ZH)
- **Skill-state collision prevention** — OMC built-in skills no longer collide with project custom skills of the same name (#1581)
- **Session-end fire-and-forget** — Notification and cleanup promises no longer block the SessionEnd hook timeout (#1700)
- **Orchestrator idle allowance** — Orchestrators can go idle while delegated subagents are still running (#1721)
- **Bridge/MCP child process cleanup** — Orphaned bridge and MCP child processes are cleaned up on shutdown (#1724)
- **Bedrock/Vertex model passthrough** — Provider-specific model IDs passed as-is to team workers instead of normalizing to invalid aliases (#1695, #1415)
- **Team split-pane cleanup** — Shutdown now discovers and removes split-pane workers after metadata drift (#1751)
- **LSP singleton protection** — Process-global singleton prevents duplicate LSP client managers across module reloads
- **LSP idle deadline management** — Per-client idle deadlines with configurable timeout via `OMC_LSP_IDLE_TIMEOUT_MS`
- **Kotlin LSP update** — Updated to official JetBrains kotlin-lsp implementation (#1710)
- **Task router fix** — `build-fix` intent now maps to `code-edit` capability instead of `testing`
- **Marketplace clone protection** — Auto-update no longer runs destructive resets on marketplace clones (#1755)
- **Legacy state cleanup consolidation** — Unified ghost-legacy cleanup across multiple candidate paths
- **Project memory preservation** — customNotes and userDirectives preserved when re-detecting project environment (#1689)
- **Print mode tmux bypass** — `--print`/`-p` flag bypasses tmux wrapping so stdout flows to parent process (#1666, #1685)
- **Orphaned tmux session cleanup** — Failed tmux attach now kills the orphaned detached session
- **Keychain credential freshness** — HUD prefers the freshest non-expired Keychain entry when multiple exist (#1684)

### Changed
- Agent tool model parameter denial extended to cover both Task and Agent tools on Bedrock/Vertex (#1415)
- Learner now scans `.agents/skills/` directory alongside `.claude/skills/` for skill discovery
- Bridge manager tracks owned sessions and passes `OMC_PARENT_PID` env var for orphan detection

## [4.8.2-preview.4] - 2026-03-18

### Added
- **Complexity-first phase selection**: Heuristic classifier (`src/hooks/complexity-classifier/`) classifies tasks as SIMPLE/STANDARD/COMPLEX before autopilot/ralplan runs planning. SIMPLE skips planning phases, COMPLEX adds Critic review. AI fallback model configurable via `/omc-setup` (defaults to haiku).
- **Circular fix detection**: Error hash tracking (`src/hooks/circular-fix-detector/`) detects when the same error recurs 3+ times in ultraqa/ralph QA loops. Generates structured escalation report at `.omcp/escalation-report.md` instead of retrying endlessly.
- **Stagger delay for parallel launches**: Advisory stagger hook (`src/hooks/stagger-launch/`) injects 1-second delay guidance between rapid-fire agent launches in ultrawork to prevent thundering herd rate limits. Configurable via `stagger_delay_ms` on UltraworkState.
- **Structured recovery manager**: Orchestration-level failure classification (`src/hooks/recovery/orchestration-recovery.ts`) with mapped recovery actions (retry, retry with backoff, skip, escalate). Per-task attempt tracking with 2-hour rolling window. Integrates with circular fix detector for escalation path.
- **Multi-pass deep review** (`/deep-review`): New skill that runs 3 parallel review passes (Security, Quality, Structural) followed by a validation pass that confirms/dismisses findings. Also accessible via `--deep` flag on code-reviewer agent.
- **Context accumulation between phases**: Hook (`src/hooks/context-accumulator/`) captures key outputs after each autopilot phase or ralph story and injects them into the next phase's agent prompt as `<prior-phase-context>`. Truncated to 12KB per phase, session-scoped.
- **Ideation/discovery skill** (`/discover`): Spawns 6 parallel specialist agents (Security, Quality, Tests, Performance, Documentation, Architecture) to scan a codebase and produce a prioritized improvement backlog at `.omcp/discover/backlog.md`. Supports scoping to subdirectories.
- **Semantic merge resolution**: Extended git-master agent with `<Merge_Conflict_Resolution>` protocol for AI-assisted merge conflict resolution — reads full file context, resolves semantically, verifies with build/tests.

## [4.8.2-preview.3] - 2026-03-18

### Added
- Claude Code CLI as a supported team worker provider (`omcp team N:claude "..."`)
- `ralph-experiment` skill documented in README and copilot-instructions
- Hierarchical docs/ structure (get-started, guides, reference, architecture, migration)
- `docs/index.md` as documentation table of contents

### Changed
- README trimmed to gateway document (~180 lines), detailed content moved to docs/guides/
- All `omg-*` commands renamed to `omc-*` (omc-setup, omc-doctor, omc-plan, etc.)
- All `OMP`/`OMG` abbreviations standardized to `OMC`
- Agent tiers reference updated to reflect actual 18 agents (from 32 pre-consolidation)
- Multi-AI Orchestration section lists all 4 providers (Copilot, Claude, Gemini, Codex)

### Fixed
- `claude` agent type: binary corrected from `copilot` to `claude`
- Broken `https://docs/REFERENCE.md` URLs in README
- Phantom agent entries removed from AGENTS.md (11 non-existent roles)
- Agent counts updated from 28/32 to actual 18 across all docs
- `OMP:VERSION` markers renamed to `OMC:VERSION` in installer

### Removed
- 11 translated README files (English-only going forward)
- 7 stale root markdown files (ANALYSIS.md, IMPLEMENTATION_SUMMARY.md, etc.)
- `docs/partials/` (duplicate of docs/shared/)
- `docs/ko/` Korean translations
- `seminar/` presentation materials
- `benchmark/` SWE-bench (empty results)
- `skills/hud/` (Copilot doesn't support custom HUDs)
- `.github/SPONSOR_TIERS.md` and sponsor badges
- Star history charts

## [4.8.2-preview.1] - 2026-03-17

### Changed
- Initial release as oh-my-copilot
- All URLs updated to `RobinNorberg/oh-my-copilot`
- Preview versions publish to npm under `preview` tag
- `.copilot-plugin/` references corrected to `.claude-plugin/` in CI
