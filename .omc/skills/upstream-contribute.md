---
name: upstream-contribute
description: Turn a defect found while porting into an upstream oh-my-claudecode issue + PR built from a clean upstream checkout — never from fork code — in the style the maintainer merges
triggers:
  - upstream PR
  - contribute upstream
  - file upstream issue
  - send fix to Yeachan-Heo
  - upstream-contribute
---

# Upstream contribution (fork → Yeachan-Heo/oh-my-claudecode)

Discovered 2026-10-05 while sending five findings upstream (#4226–#4230 → PRs
#4231–#4234, all merged within hours). Robin's rule: upstream fixes are
derived from upstream `dev`, never from oh-my-copilot port code, so the
maintainer's repo stays free of fork names and host abstractions.

## Inputs
- A concrete, reproducible defect with evidence (fork review finding, port
  conflict, failing upstream test). The fork's own fix is a reference for
  *what* to change, never text to paste.
- The clean clone `C:/Code/OMC-upstream` (`origin` = RobinNorberg/oh-my-claudecode
  fork, `upstream` = Yeachan-Heo; `remote.upstream.tagOpt --no-tags`), deps
  installed with `npm ci --ignore-scripts`.

## Steps
1. **Sync and branch.** `git fetch upstream dev`; one worktree per fix:
   `git worktree add C:/Code/OMC-upstream-wt/<slug> -b fix/<slug> upstream/dev`,
   then junction node_modules: `node -e "require('fs').symlinkSync('C:/Code/OMC-upstream/node_modules','node_modules','junction')"`.
2. **Reproduce on upstream first** and capture the exact command + output for
   the issue body (e.g. `npx tsx src/cli/index.ts intake run --headless`).
3. **Implement upstream-flavoured** (`omc`, `.omc/`, upstream identifiers), with
   a focused regression test. One logical commit per defect, title in upstream
   style: `Fix <area>: <what>` (becomes `Fix #N: …` on the PR).
4. **Regenerate upstream's inventory baseline** (`ISSUE_3702_HEAD=$(git rev-parse upstream/dev) npm run generate:inventory -- --write`
   then `generate:inventory:verify`) and commit it with the change — upstream's
   drift gate fails otherwise.
5. **Pollution scan** on the branch diff — must be empty:
   `git diff upstream/dev..HEAD -- . ':!inventory' | grep -E '^\+' | grep -iE 'oh-my-copilot|\bomg\b|\.omg\b|copilot|COPILOT_|psmux|getHostCliType|host-detection|host-signal|RobinNorberg|oh-my-claude-sisyphus'`
   plus a check that every new import exists upstream.
6. **Rebase onto current `upstream/dev` right before posting** (it moves daily),
   regenerate the inventory again, rerun the branch's tests, `push --force-with-lease origin`.
7. **Draft texts** (`issue.md` with `# title` line 1; `pr.md` with `Fix #<ISSUE>: …`
   placeholder) in the style of #4146/#4201: Summary → Reproduction → Environment
   (`upstream dev @ <full sha>`, Node, OS) → Code path with full-sha permalinks →
   Proposed fix → Duplicate search (state the exact `gh issue/pr list --search`
   queries and results). PR body: `## Problem` / `## Solution` / `## Tests`
   with numbers. Show the texts to Robin before anything is created.
8. **Post**: issues first (`gh issue create --repo Yeachan-Heo/oh-my-claudecode --title … --body-file …`),
   then PRs from the fork against `dev` with the numbers substituted
   (`--head RobinNorberg:<branch>`, body starts with `Closes #N`). Drive `gh`
   from Node `spawnSync("gh.exe", args)` with **no shell** — `shell:true`
   mangles titles containing spaces/colons, and lean-ctx blocks shell
   functions.
9. Record the numbers in memory (`omc-upstream-porting`) and expect the port to
   bring the canonical versions back: on the next port, take **theirs** for
   those hunks and re-apply the rename map.

## Success criteria
- Pollution scan empty; branch based on current `upstream/dev`; inventory verify ok.
- Each PR shows `MERGEABLE` against `dev` with exactly the intended files.
- Maintainer merges without requesting changes (he regenerates the inventory
  graph himself after each merge — conflicts there are expected, not a defect).

## Pitfalls
- `gh pr create` prints usage (and creates nothing) when args are shell-joined.
- Upstream tests may hardcode `linux:` identities; verify on Windows, fix test-only.
- The maintainer may fix an issue himself before a PR exists (#4146/#4147/#4230)
  — file the PR together with the issue when the fix is ready.
- Our worktree junctions point at the clone's node_modules; `npm ci` in the
  clone invalidates them for running worktrees.
- **`git worktree remove` follows the node_modules junction and deletes the
  TARGET's contents** (wiped `C:/Code/OMC-upstream/node_modules` once). Before
  removing a worktree, delete only the junction: `node -e "require('fs').rmdirSync('node_modules')"`
  (`rmdirSync` on a junction removes the link, not the target), then
  `git worktree remove`. Same rule for any worktree junctioned to `C:/Code/OMC/node_modules`.
