---
name: port-and-release-cycle
description: Orchestrate one "keep porting upstream, then release" cycle for oh-my-copilot end to end — parallel reconciliation + docs lanes, strict bump/build/inventory ordering, baseline-aware suite triage, Tier 2 gates, all-gates PR merges, tag, verification — composing port-upstream and omg-release-runbook
triggers:
  - keep porting upstream then release
  - port and release
  - port cycle
  - release cycle
  - port-and-release-cycle
---

# Port-and-release cycle (orchestration layer)

The two runbooks hold the contracts: `port-upstream.md` (range diff, rename
map, fork-owned logic) and `omg-release-runbook.md` (pre-flight, ship, verify).
This skill is the order and the delegation that made four cycles in two days
(v5.6.1 → v5.8.1) land without a bad tag. Robin's standing rules apply:
delegate implementation to subagents; no force-pushes anywhere; recycle agents
when their report is processed.

## Inputs
- Last ported upstream sha (memory `omc-upstream-porting`), `origin/dev`, a
  clean main tree (`git status --short` empty; stray `.git/index.lock` → remove
  only when no git process holds it).
- Version decision: patch when the range is fixes only; minor when a fork
  feature or new command/tool/peer-dep landed on `dev` since the last tag.

## Steps (what runs in parallel, what must be serial)
1. **Fetch + apply (lead, 1 call):** `git fetch upstream dev` + tags into
   `refs/upstream-tags/*`; `git checkout -B port/upstream-<sha> origin/dev`;
   range-diff with the runbook's exclusions → `git apply -3`; list `UU/AA`
   files; show the `package.json` delta separately (it is excluded from the
   diff and must be ported by hand).
2. **Two lanes at once (both opus executors):**
   - *Reconciliation lane* on the main tree: resolves conflicts per the
     runbook; takes THEIRS for our own fixes returning from upstream
     (re-apply the rename map); keeps fork version stamps; keeps fork-only
     logic; leak sweep; `build-hooks/agents --verify` (run `--write` if
     `hooks/hooks.json` changed); `check-multirepo-paths.mjs`; tsc; touched
     suites vs the baseline; `smoke copilot --tier 2 --sdk-static` (free).
     It stages, never commits/builds/inventories.
   - *Docs lane*: CHANGELOG release section (H1 + `## [X.Y.Z] - date`),
     `.github/release-body.md`, MIGRATION note, README callout, REFERENCE
     counts. It touches only those five files — never the conflicted ones.
3. **Bump (lead, after the reconciliation lane — the manifests are among
   its files):** `npm version X --no-git-tag-version --ignore-scripts` →
   `bash scripts/sync-version.sh X` → sed the stamp in `docs/CLAUDE.md` and
   `tests/fixtures/prompt-projection/claude-managed-block.golden` →
   `npm run generate:prompt-projections` (reads `package.json`).
4. **One gated chain (lead, background, every step `&&`):** port commit →
   tsc → `npm run build` → `verify:prompt-projections` → generators
   `--verify` → path gate → `git add -f dist bridge && git add -A` →
   `generate:inventory` + `--verify` LAST → release commit → `git status
   --short` empty → full `vitest --reporter=verbose` to a log → title diff
   vs the last GOOD baseline → `OMC_LIVE_SMOKE=2 node bridge/cli.cjs smoke
   copilot --tier 2 --json` (2 premium requests) → plain push → `gh pr
   create` → poll until no non-artifact check is pending → **merge only when
   every check except `No Committed Build Artifacts` and `Authorize generated
   artifacts…` is SUCCESS/SKIPPED** → `gh pr merge --admin --merge`.
5. **Ship (lead):** PR `dev → main` (admin merge) → annotated tag on main's
   merge commit, verified with `git rev-parse vX^{}` before push → find the
   tag run by `event=push && headBranch=vX` (not `--branch`) → watch until
   `completed` (two 10-minute windows are normal; the publish job runs the
   full suite first) → `npm view oh-my-copilot@X version dist-tags bin
   dist.attestations` + `gh release view vX` → download the tag run's
   `copilot-smoke-*` artifact and read `reports/{static,scenarios}.json`.
6. **Close out:** memory (`omc-upstream-porting`: what shipped, numbers,
   follow-ups), `ListAgents` empty, report.

## Triage rules for the full suite
- Compare by TITLE against the last good baseline log; the verbose reporter
  sometimes undercounts titles under load (a 362-title log against a
  778-title run) — if the baseline's count looks off, diff against the
  previous one instead of trusting "fixed: 429".
- "Failed Suites" at file level: `npm-package-bin-surface` (npm ENOENT on
  Windows) and `submodule-state-anchor` (10 s hook) are environmental.
- New titles in the load-sensitive cluster (scaling, runtime-v2.*, hud-cache,
  session-end-process-exit, run-cjs budgets, epic-3698 JSON parse) → rerun
  the suspicious ones in isolation with `-t` and accept when they pass.
- POSIX-only upstream tests (`PATH=/usr/bin:/bin`, `sh`/`dash` spawns) fail
  on Windows; Linux CI covers them.
- The Tier 2 gate (26/26) is the signal that decides the release, not the
  Windows failure count.

## Success criteria
- `dev` = PR merged with all non-artifact gates green; `main` = merge of
  `dev`; annotated tag on it; npm `latest` = X with provenance; GitHub
  Release published, `draft=false`, target `main`; CI smoke on the tag
  green (static + scenarios); memory updated; no agents running.

## Pitfalls (each cost a round-trip)
- Chains that don't gate on `git rebase` keep running mid-rebase; prefer
  merge-based updates anyway (no force-push): `git merge origin/dev`,
  regenerate inventory as a new commit, plain push.
- Watch loops that poll only `Test` merge past a red path gate — assert all
  checks.
- `sync-version.sh` does not bump `package.json`/lock; `npm version` first.
- New `dist` files are gitignored: `git add -f dist bridge` or the shipped
  CLI cannot load them; untracked check `git ls-files --others dist bridge`.
- `npm run build` fails inside worktrees (junctioned `node_modules` → esbuild
  `.node` loader); build only in the main tree; never `git worktree remove`
  without deleting the `node_modules` junction first.
- A background `--json` capture with `2>&1` mixes stderr banners into the
  JSON; capture stdout alone.
- `gh run list --branch vX` does not resolve tag pushes.
