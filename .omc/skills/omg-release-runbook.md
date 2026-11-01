---
name: omg-release-runbook
description: Release oh-my-copilot vX.Y.Z through the release-boundary pipeline — pre-flight contracts, ship sequence, and the failure modes that cost seven tag attempts to discover
triggers:
  - release oh-my-copilot
  - publish to npm
  - tag v5
  - omg release
  - release-boundary
  - "Create GitHub Release failed"
source: extracted
---

# oh-my-copilot Release Runbook

Discovered during the v5.0.0 release (2026-08-31 → 09-01): the tag-triggered
pipeline enforces ~15 contracts, and each unmet one costs a full ~10-minute
run plus a retag cycle. Work through pre-flight completely BEFORE tagging.

## Primary path: `omg release <X.Y.Z>`

The pre-flight, ship sequence and verification below are scripted as eleven
resumable phases. Run the script; use an agent only to triage the phase it
stops at. The manual steps in the rest of this file are the fallback and the
reference for what each phase asserts.

1. Write the prose first; the script checks it but never writes it:
   `CHANGELOG.md` (`# oh-my-copilot vX.Y.Z` H1 and `## [X.Y.Z] - date`),
   `.github/release-body.md` naming X.Y.Z, README / `docs/REFERENCE.md` /
   `docs/MIGRATION.md` as needed. Uncommitted edits to those five files are
   allowed by preflight and land in the release commit.
2. `git checkout -b release/vX.Y.Z origin/dev`, then
   `omg release X.Y.Z --dry-run` to see the plan, then run it:

   ```bash
   omg release X.Y.Z --to suite --suite full --baseline <last good report>   # preflight..suite: release commit + full suite, no AI credits
   omg release X.Y.Z --live-smoke    # resumes at smoke (2 prompts, ~1 AI credit): pr, promote, tag (asks), verify
   omg release X.Y.Z --live-smoke --yes    # --yes: required for the tag phase without a terminal (agent lanes, CI)
   ```

   Faster: one run from `suite` through `pr` overlaps the local suite
   (~34 min) with the release PR's CI (~18 min): the PR is pushed right after
   `commit` and merges only once the suite and smoke passed, e.g.
   `omg release X.Y.Z --from suite --suite full --baseline <report> --live-smoke --to pr`.
   A red suite leaves the PR open and unmerged; fix, then `--from suite` (or
   `--from build` after a fix commit). `--to suite` still pushes nothing.

   Before any `--yes`, check `phases.smoke.status` is `ok` in
   `.omg/release/X.Y.Z.json` (`--yes` only logs the skipped-smoke warning).

   **Waiting on CI: drive, do not poll.** From `pr` on, run the rest as one
   detached driver and arm one Monitor; retire cron heartbeats for releases:

   ```bash
   omg release X.Y.Z --drive --detach --yes   # pr..verify to done / fail / blocked; outlives the session
   # then arm ONE Monitor on the command it prints:
   omg progress watch --file .omg/progress/release.log --until settled --stall 30m
   ```

   Why: a CI wait past `--timeout` and a transient GitHub error (5xx,
   GraphQL "Something went wrong") no longer stop the run; the driver resumes
   them itself (up to `--drive-max`, default 6 h), so the Monitor wakes only
   on `done`, `fail` or `blocked`, and every terminal note names the next
   command. Drive never implies `--yes` and never prompts: without `--yes`
   the tag phase stops `blocked` ("needs confirmation"), which is the
   intended human gate when the owner has not pre-approved the tag. The
   merge rule is unchanged. After a session restart, run
   `omg release X.Y.Z --status`: driver alive → re-arm the Monitor; dead →
   `--drive --detach` again (it resumes from the state). `--stop` ends it.

   Phases: preflight, bump, build, gates, commit, suite, smoke, pr, promote,
   tag, verify. The vitest suite (`--suite`) runs in `suite`, AFTER the
   commit: some tests read committed state (npm pack of the committed tree,
   committed docs/CLAUDE.md, inventory drift) and always fail before it. The
   live smoke runs after the suite, so a red suite costs no AI credits.
   `--suite` is recorded for the release: a later run without `--suite` uses
   the recorded level, a lower `--suite` is refused (start over with
   `--from preflight` to change it), and `--suite none` records `suite` as
   skipped with a warning. The level the suite actually ran at is recorded
   too: raising `--suite` after the suite ran lower (e.g. `--suite none`,
   then `--suite full`) blocks `pr` until `--from suite --suite full` runs it.
   `--baseline` is recorded (as an absolute path) and reused by a later run
   that does not pass it. `--suite` with a `--to` before `suite` warns that
   the suite does not run in that invocation. If the suite fails, fix, commit
   and re-run `omg release X.Y.Z --from build --to suite`: every build input
   (src, scripts, templates, package.json, build config) feeds dist/bridge.
   Never a bare `--from build` after a smoke that was never green: it
   continues into smoke and pr, and `pr` refuses a skipped smoke unless
   `--allow-skipped-smoke` is given.
   **Smoke reuse.** A green live smoke is recorded as `lastSmoke` (input
   hash, HEAD sha, time) at the top level of the state, so voiding the smoke
   record keeps it. The input hash is sha256 over HEAD's object ids of
   `dist`, `bridge`, `hooks`, `agents`, `skills`, `commands`, `copilot`,
   `scripts`, `templates`, `.claude-plugin`, `.mcp.json`, `plugin.json`,
   `package.json` and `package-lock.json` (the shipped paths the smoke loads). When a later smoke phase (after
   `--from build` or `--from suite`) sees the same hash, it reuses the green
   smoke without a run and without `--live-smoke`: the note says
   `reused the green Tier 2 smoke of <sha> run at <time>` (with the hash and
   the installed Copilot CLI version) and the details
   carry the full hash. Why: a test-only fix rebuilds byte-identical dist and
   bridge, so it costs no AI credits and needs no `--allow-skipped-smoke`.
   Any change that reaches those paths changes the hash, and the smoke runs
   again (with `--live-smoke`). `--force-smoke` always runs it. A red smoke
   drops `lastSmoke`.
   **Flake triage.** With `--suite full`, each failing title not in the
   baseline (at most 20; more fail at once) is rerun alone
   `--triage-runs` times (default 3) with
   `vitest run <file> --testNamePattern=<title> --reporter=json`, sequentially,
   each with a timeout (`--triage-timeout`, default 5 min; a timeout is a
   failed rerun). A rerun passes only if vitest exits 0 and the report says so. Passing
   every rerun = load-flaky: the suite passes with a warning. Failing every
   rerun (or a file-level collection error) = real: the suite fails. Failing
   only some reruns = mixed: blocked, since it may be a real race. Progress
   heartbeats name each title's class. The triage is recorded as
   `suiteTriage` and reused by a re-run on the same HEAD. Load-flaky and
   mixed titles are written to `.omg/release/X.Y.Z-flaky-candidates.json` in
   the known-flaky entry shape plus `evidence`; the engine never edits or
   commits `.github/known-flaky-tests.json`. `omg release X.Y.Z
   --flaky-candidates` prints them ready to paste, and adding one needs the
   owner's OK (see Known flaky tests). The suite and the live
   smoke fail if they leave files in the working tree (remove them, re-run),
   and skipping past `commit` needs a clean tree, so nothing uncommitted is
   swept into a later release commit or left out of what `pr` pushes. Every
   child runs under the ship scrub (GIT_NO_REPLACE_OBJECTS=1, redirecting
   GIT_*/GH_* dropped); the vitest suite drops only GIT_NO_REPLACE_OBJECTS,
   as in CI. State is `.omg/release/X.Y.Z.json`; a run without `--from`
   resumes at the first phase not yet ok; `--from <phase>` re-runs one and
   voids the records of every later phase, so they run again.
   Progress lines go to `$OMG_PROGRESS_FILE` or `.omg/progress/release.log`.
3. Exit 1 = a phase failed or is blocked; the output names the cause (failed
   checks with failing test titles, orphan dist files, missing stamps).
   Fix it, then re-run the same command. Common stops:
   - `build`: orphan dist outputs → re-run with `--fix-orphans`.
   - `pr` / `promote` blocked with a `gh pr merge … --admin` line:
     `ship.allowAdminMerge` is off (owner-only key), so run the printed merge
     yourself and re-run. CI is judged by the `omg ship` merge rule: every
     check outside `ship.advisoryChecks` SUCCESS/SKIPPED; each failed run is
     rerun once automatically, the second failure stops with the test names.
   - `tag` blocked: no `--yes` and the confirmation was declined or there is
     no terminal to ask on. The confirmation is never skipped on its own: pass
     `--yes` once you have decided to publish.
   - `verify` failed with "is on npm and GitHub Release … is published": the
     release is out; a job of the tag run failed afterwards. Triage the named
     job; do not rerun the run and do not use Release Recovery.
   - `verify` blocked: the tag run or npm propagation is still going; re-run
     `--from verify`.
4. The script never deletes `.git/index.lock`, never force-pushes, rebases or
   deletes tags; a local tag that peels elsewhere (an upstream tag) stops the
   `tag` phase for you to remove by hand.

## Where publishing actually happens

- **ci.yml** → "Create GitHub Release" job, triggered by pushing a `v*` tag.
  It runs boundary assertions → build → tests → staged tarball → smoke →
  `npm publish --provenance` → registry verification → GitHub Release.
- **release.yml is recovery-only** (workflow_dispatch; never publishes). The
  trusted-publishing contract test asserts this; don't "fix" it back.
- Auth is **npm Trusted Publishing (OIDC)**: npmjs.com trusted publisher =
  repo `RobinNorberg/oh-my-copilot`, workflow filename `ci.yml`, no
  environment. There is NO NPM_TOKEN — `trusted-publishing-contract.test.ts`
  fails if one appears in ci.yml, and `release-boundary.mjs` verifies the
  SLSA attestation's workflow path is ci.yml, so the publisher config cannot
  be any other file.

## Pre-flight (all of these are hard assertions in the release job)

1. Versions equal in `package.json`, `.claude-plugin/plugin.json`,
   `.claude-plugin/marketplace.json` (plus the plugins[] entry), AND the
   root `plugin.json` (the Copilot manifest, since v5.5.0; name must be
   `oh-my-copilot`). `release-boundary.mjs` asserts the root manifest in the
   archive and at tag time; the CI version-consistency job checks it too.
   `scripts/release.ts` and `scripts/sync-version.sh` bump all of them.
   PITFALL (seen on v5.6.1/v5.6.2/v5.7.0): `bash scripts/sync-version.sh X`
   does NOT bump `package.json`/`package-lock.json` — it assumes `npm version`
   ran first, and `npm version X` breaks on Windows via the `version` script
   (MSYS path). Run `npm version X --no-git-tag-version --ignore-scripts`
   FIRST, then `sync-version.sh X`, then stamp
   `tests/fixtures/prompt-projection/claude-managed-block.golden`. The prompt
   projections take their version from `package.json`, and
   `verify:prompt-projections` reports "bridge not built" until `npm run build`.
1b. `npm run build` runs `build:copilot-hooks` and `build:copilot-agents`;
   `copilot/hooks.json` and `copilot/agents/*.md` are tracked (not ignored)
   generated files — commit them, and `node scripts/copilot/build-*.mjs --verify`
   must pass. Never hand-edit them.
2. `CHANGELOG.md` needs BOTH forms: the Keep-a-Changelog section
   `## [X.Y.Z] - YYYY-MM-DD` AND a top-level heading matching
   `^# .+ vX.Y.Z([:\s]|$)` (e.g. `# oh-my-copilot v5.0.0`) — the boundary
   greps for the H1, multiline, anywhere in the file.
3. `docs/CLAUDE.md` must contain `<!-- OMC:VERSION:X.Y.Z -->`. If you edit
   docs/CLAUDE.md at all: regenerate the projections AND rebuild the bridge
   in the SAME commit — `bridge/claude-md-coordinator.cjs` embeds a digest of
   docs/CLAUDE.md and the runtime closure fails closed on mismatch.
4. `.github/release-body.md` committed, non-empty, describing THIS version —
   it becomes the GitHub Release body verbatim.
5. Full `npm run build`, then commit dist + bridge with `git add -f dist bridge`.
   Both roots are tracked; dist is ALSO gitignored, so a plain `git add`
   silently skips NEW files (a deleted-source orphan or missing new output
   fails `npm-package-bin-surface` / the runtime-closure check). Confirm
   `git ls-files --others dist bridge` prints nothing before committing.
6. Regenerate the inventory baseline LAST — it hashes the whole tracked tree,
   so ANY later commit re-stales it (including a ci.yml edit):
   `node scripts/generate-inventory-graph.mjs --write` → commit →
   `--verify` must say "baseline is current".
7. `npx tsc --noEmit` clean.
8. Bin surface is `oh-my-copilot` / `omg` / `omg-cli` — pinned in
   `release-boundary.mjs` EXPECTED_BINS, its test, package.json, AND
   package-lock.json (regenerate the lock with `npm install
   --package-lock-only` if bins changed; it drifts silently).
9. After the full build, `omg smoke copilot --tier 1` must be green before
   tagging. It loads the build into the real Copilot CLI in a throwaway
   `COPILOT_HOME` and runs one live session with the prompt on stdin, which
   costs one prompt in AI credits. It reuses your `copilot /login` identity and
   drops `GH_TOKEN`/`GITHUB_TOKEN` from the session, so do not export a token
   for it; `--model` is optional (Copilot auto-selects). Hooks run
   fail-closed, so a red `hooks.*` or `hooks.adapter_errors` is a real hook
   failure. CI cannot catch a plugin that Copilot
   refuses to load. Exit `2` means the `copilot` binary was not found, which
   is not a pass.
10. Then `omg smoke copilot --tier 2` (default scenarios `smoke` and
   `guardrail`, one prompt each, about 0.6 AI credits measured) must also be green before
   tagging. It drives the installed Copilot CLI through `@github/copilot-sdk`
   (install once: `npm i -g @github/copilot-sdk --omit=optional
   --ignore-scripts`) and proves the git guardrail hook really denies a
   `git push --force`. Exit `2` here means the SDK or the binary is missing,
   which is not a pass. A red `scn.<name>.adapter_errors` names the hook
   script behind an `[omg-hook]` error or a `[run.cjs]` hook timeout line;
   fix it, do not ship around it.

## Ship sequence

A lane running this sequence emits one progress event per step
(`omg progress emit <step> start|ok|fail|blocked`, see
`agent-progress-events.md`), so the lead's Monitor sees a stuck CI watch as
`status=stalled` instead of silence. For a PR's CI wait use
`omg ship gates <pr> --drive --detach` (events under `agent=ship-<pr>`,
exit 0 green / 1 failed, never 8) plus one Monitor on the progress file it
prints, not a re-run `--watch` loop or a cron heartbeat.

1. Push the working branch → PR → `dev` → `gh pr merge --admin` (rulesets
   require PRs; direct pushes to dev/main are rejected). **Merge only when
   every check except the two artifact gates is SUCCESS/SKIPPED** — poll with
   `gh pr checks N --json name,state` and assert, don't watch `Test` alone
   (the AST-grep path gate was merged past twice on 2026-10-06). **Never
   force-push** (Robin's rule): if `dev` moved, `git merge origin/dev`,
   regenerate the inventory as a new commit, plain push.
   The `No Committed Build Artifacts` and `generated-artifact-authorization`
   checks go RED by design on dist/bridge deltas — they are advisory
   owner-confirmation gates (the authorization trust root still points at
   upstream); the owner merging through them IS the confirmation.
2. PR `dev` → `main` → admin merge.
3. Tag must be ANNOTATED on main's merge commit:
   `git tag -a vX.Y.Z -m "vX.Y.Z" <main-sha>` then push the tag.
   PITFALL: upstream's identically-named tags keep re-appearing locally via a
   background fetcher — after any `git tag -d`, verify
   `git rev-parse vX.Y.Z^{}` points at YOUR commit before pushing, and
   confirm with `git ls-remote --tags origin vX.Y.Z` after.
4. Watch the run: `gh run list --workflow=ci.yml`, then `gh run watch <id>`.
   Background watchers cap at 10 minutes; the release job alone takes ~9.
   The tag run also starts the `Copilot smoke (tier 2)` job in parallel: SDK
   static checks plus the default scenarios (smoke, guardrail; ~0.6 AI
   credits billed to the `COPILOT_GITHUB_TOKEN` owner). The release job does
   NOT wait for it, so check its result before announcing; its report is the
   `copilot-smoke-<run id>-<attempt>` artifact (`reports/scenarios.json`).

## Known flaky tests (rerun once before diagnosing)

`session-end-process-exit` (producer grace), `tests/perf/subagent-lock.bench.ts` (45ms latency
guardrail on shared runners), `runtime-v2.dispatch` ("requeues the selected
task through an exact read…", 30 s timeout — hit on the v5.6.1 tag run),
`subagent-tracker` ("persists durably under the already-held lock", 310 ms
latency bound — hit on PR #209), `tests/integration/workflow-profile-lock-recovery`
("serializes concurrent reclaimers without removing a live replacement" — hit on
PR #231's Linux run 2026-10-07, passed on rerun), `src/__tests__/copilot-hook-dispatch.test.ts`
("stdout parity with the per-hook path (real hooks) > SessionStart", real SessionStart
hooks against a 60 s spawn timeout on shared runners). One `gh run rerun <id> --failed` clears them;
only investigate if the SAME test fails twice. A rerun keeps the tag and
workflow path, so the provenance attestation is unaffected. The machine-read
list is `.github/known-flaky-tests.json` (`omg ship gates`); keep both in sync.
The former `runtime-done-recovery` entry (briefly-malformed `done.json`
window) is retired: the header of
`src/team/__tests__/runtime-done-recovery.test.ts` says the done.json polling
protocol is intentionally retired, and no test in that file has the window.

Local release suite (`omg release --suite full`): a new failing title that
passes every isolated rerun is load-flaky and does not block; one that fails
some isolated reruns blocks. Load-flaky titles become candidates in
`.omg/release/X.Y.Z-flaky-candidates.json` (`--flaky-candidates` prints
them). Never add one to `.github/known-flaky-tests.json` without the owner's
OK: that file is part of the merge rule, so the engine and agent lanes do not
edit or commit it. Load-flaky titles seen in a release suite:
"session-start-script-context > treats malformed failure-state lock metadata
as terminal" (a timing ceiling) and "worker-launch-ack > reloads the accepted
current recovery launch with its durable context".

## Verification (a green run is necessary, not sufficient — check the outputs)

- `npm view oh-my-copilot@X.Y.Z version dist-tags bin` → latest points at
  X.Y.Z, bins are oh-my-copilot/omg/omg-cli.
- `npm view oh-my-copilot@X.Y.Z dist.attestations` → SLSA provenance present.
- `gh release view vX.Y.Z` → published, not draft, targets main.
- The tag run's `Copilot smoke (tier 2)` job is green and did not skip (a
  skip shows the notice `Copilot smoke skipped`).

## Failure → cause map from v5.0.0 (fastest diagnosis path)

| Error text | Cause |
| --- | --- |
| `CHANGELOG.md does not start with a X.Y.Z release heading` | Missing the `# name vX.Y.Z` H1 (the `## [X.Y.Z]` section is NOT enough) |
| `archive package.json.bin does not match the required CLI surface` | package.json bins ≠ EXPECTED_BINS in release-boundary.mjs |
| `env: '…/.bin/<name>': No such file or directory` in smoke | ci.yml smoke step drives a bin name the package doesn't ship |
| `npm error 404 … PUT` | token auth rejected (expired/revoked token era; now OIDC) |
| `npm error code EOTP` | token subject to 2FA — use trusted publishing, not tokens |
| `omg smoke copilot` fails `copilot.plugin_list`: plugin list returns `[]` | Bad `--plugin-dir` or manifest path; Copilot only warns on a bad dir. The manifest must be at `plugin.json`, `.github/plugin/plugin.json`, or `.claude-plugin/plugin.json` under the root |
| `Copilot smoke skipped` notice; smoke job green in seconds | Secret `COPILOT_GITHUB_TOKEN` missing or not passed (fork PR, Dependabot). Add it under repo Settings > Secrets and variables > Actions: a fine-grained PAT with the "Copilot Requests" permission from a Copilot-entitled user (docs/DEVELOPERS.md "Tier 2 in CI"). Then re-run the job |
| smoke `sdk.agents` / `sdk.runtime` fail with auth or "not available" errors in CI | Token expired, lacks "Copilot Requests", or its owner lost Copilot access. Regenerate it and update the secret |
| `token-shaped string in the smoke artifacts` | The leak scan hit: the CLI or a hook wrote a token into the smoke home. Artifacts were deleted, nothing uploaded. Find the writer from the listed file names before re-running; rotate the token if it appeared in a log |
| inventory-graph `sourceSha256 must match` | a commit landed after the last baseline regeneration |
| `coordinator source digest mismatch` | docs/CLAUDE.md edited without rebuilding bridge in the same commit |
| `reachable generated runtime module is missing` | new/deleted source without a full dist rebuild force-added |
| `... was PUBLISHED to the registry; it did not become visible after 30 attempts` | Publish SUCCEEDED but the verify loop timed out on slow registry propagation (hit on v5.1.0 at 12 attempts; the window is ~28 min since the upstream #4083 port). Check `npm view oh-my-copilot@X.Y.Z version dist-tags dist.attestations` — if live with provenance, do NOT rerun the job (republish over an existing version fails). Only the GitHub Release step was skipped: run the `Release Recovery` workflow (`release.yml`, workflow_dispatch with `tag` and `sha` inputs — generic since the v5.5.0 port; no longer pinned to an old tag), or `gh release create vX.Y.Z --title vX.Y.Z --notes-file .github/release-body.md`. |
