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
   costs one premium request. It reuses your `copilot /login` identity and
   drops `GH_TOKEN`/`GITHUB_TOKEN` from the session, so do not export a token
   for it; `--model` is optional (Copilot auto-selects). Hooks run
   fail-closed, so a red `hooks.*` or `hooks.adapter_errors` is a real hook
   failure. CI cannot catch a plugin that Copilot
   refuses to load. Exit `2` means the `copilot` binary was not found, which
   is not a pass.

## Ship sequence

1. Push the working branch → PR → `dev` → `gh pr merge --admin` (rulesets
   require PRs; direct pushes to dev/main are rejected).
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

## Known flaky tests (rerun once before diagnosing)

`session-end-process-exit` (producer grace), `runtime-done-recovery`
(briefly-malformed window), `tests/perf/subagent-lock.bench.ts` (45ms latency
guardrail on shared runners). One `gh run rerun <id> --failed` clears them;
only investigate if the SAME test fails twice.

## Verification (a green run is necessary, not sufficient — check the outputs)

- `npm view oh-my-copilot@X.Y.Z version dist-tags bin` → latest points at
  X.Y.Z, bins are oh-my-copilot/omg/omg-cli.
- `npm view oh-my-copilot@X.Y.Z dist.attestations` → SLSA provenance present.
- `gh release view vX.Y.Z` → published, not draft, targets main.

## Failure → cause map from v5.0.0 (fastest diagnosis path)

| Error text | Cause |
| --- | --- |
| `CHANGELOG.md does not start with a X.Y.Z release heading` | Missing the `# name vX.Y.Z` H1 (the `## [X.Y.Z]` section is NOT enough) |
| `archive package.json.bin does not match the required CLI surface` | package.json bins ≠ EXPECTED_BINS in release-boundary.mjs |
| `env: '…/.bin/<name>': No such file or directory` in smoke | ci.yml smoke step drives a bin name the package doesn't ship |
| `npm error 404 … PUT` | token auth rejected (expired/revoked token era; now OIDC) |
| `npm error code EOTP` | token subject to 2FA — use trusted publishing, not tokens |
| `omg smoke copilot` fails `copilot.plugin_list`: plugin list returns `[]` | Bad `--plugin-dir` or manifest path; Copilot only warns on a bad dir. The manifest must be at `plugin.json`, `.github/plugin/plugin.json`, or `.claude-plugin/plugin.json` under the root |
| inventory-graph `sourceSha256 must match` | a commit landed after the last baseline regeneration |
| `coordinator source digest mismatch` | docs/CLAUDE.md edited without rebuilding bridge in the same commit |
| `reachable generated runtime module is missing` | new/deleted source without a full dist rebuild force-added |
| `... was PUBLISHED to the registry; it did not become visible after 30 attempts` | Publish SUCCEEDED but the verify loop timed out on slow registry propagation (hit on v5.1.0 at 12 attempts; the window is ~28 min since the upstream #4083 port). Check `npm view oh-my-copilot@X.Y.Z version dist-tags dist.attestations` — if live with provenance, do NOT rerun the job (republish over an existing version fails). Only the GitHub Release step was skipped: run the `Release Recovery` workflow (`release.yml`, workflow_dispatch with `tag` and `sha` inputs — generic since the v5.5.0 port; no longer pinned to an old tag), or `gh release create vX.Y.Z --title vX.Y.Z --notes-file .github/release-body.md`. |
