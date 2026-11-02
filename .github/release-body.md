# oh-my-copilot v5.19.4

A CI, release tooling and test reliability release. There are no user-facing
behaviour changes, so the field agent can upgrade safely.

Install with `npm install -g oh-my-copilot@5.19.4`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Release pipeline

- `omg release` pushes the release PR right after the release commit and
  watches its CI while the local suite and smoke run. The PR merges only once
  CI is green and the suite and smoke passed; a red suite leaves it open and
  unmerged. This saves about the release PR's CI time (~18 min) per release.
- On Windows, the release suite no longer picks up WSL's `bash` when started
  from PowerShell; it puts Git for Windows' bash first on PATH, or refuses to
  start without one.

## CI

- CI tests each tree once. A new `Tree evidence` job reuses an earlier green
  run of the same tree (a release PR's dev merge, the main merge of dev, the
  tag) and reports the other jobs as SKIPPED, naming the source run.
- A tag only publishes when its tree already passed: the release job skips
  `npm test` only when the tagged commit is on `main` and its tree has that
  evidence, and runs the suite as before otherwise. Publishing, provenance and
  the GitHub Release are unchanged. Repo variables `CI_TREE_REUSE=false` and
  `CI_RELEASE_REUSE=false` turn reuse off.
- The Linux suite runs in four shards split by measured file cost; the
  required `Test` check merges their reports. On the sharding PR's own CI run,
  `Test` finished 5.2 min after the run started, against 13.9 min for the old
  single job.
- `Generated Artifact Authorization` and `No Committed Build Artifacts` no
  longer email failures on fork PRs (the fork commits `dist/` and `bridge/` by
  design). Neither check is required.

## Tests

- Load-flaky tests no longer depend on host load: clock-sensitive tests freeze
  the clock, overhead checks measure CPU time, fixed sleeps became signals or
  baseline comparisons.
- Slow tests sped up: `inventory-graph-drift` (65.6 s to 31.2 s locally) and
  `copilot-sdk-driver` (25.7 s to 5.3 s).
- The wall-time budget tests run serially after the parallel suite, so a
  loaded host no longer breaks them; budgets and assertions are unchanged.

## Caveats

- A release that reuses its tree relies on CI's `Test` job, which runs on
  Node 20, instead of the release job's Node 24 suite.
- Tree reuse on dev to main PRs only starts once `main` has
  `scripts/ci/tree-reuse.mjs`, that is after this release.
- This release was published without the live Copilot smoke.
