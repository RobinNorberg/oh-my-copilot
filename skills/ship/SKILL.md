---
name: ship
description: Take a task or an open PR to merge-ready — executor lane, independent verifier lane, bounded fix rounds by fresh agents, deterministic prepare/gates/merge via omc ship
argument-hint: "<task description> | --pr <number>"
level: 4
---

# Ship

Carry one change from task (or existing PR) to a merge-ready PR. Agents do
the judgment work; `omc ship` does everything mechanical and refuses the
unsafe steps itself. The ship state lives in `.omg/state/ship/<pr>.json`, so
a run survives restarts: `omc ship status <pr>` tells you where you are.

## Hard rules (every lane, every brief)

Each rule exists because breaking it once cost a round-trip or a wiped tree.

- Never self-approve. The lane that wrote a change never records its verdict;
  `omc ship verdict` refuses a reviewer equal to the implementer.
- Reviewers get the diff and the task, never the author's summary or
  conclusion. An author's "all tests pass" anchors the reviewer.
- Fixes go to a fresh agent, never back to the implementer or the reviewer.
  A fresh context does not defend its earlier choices.
- No `git worktree add` / `git worktree remove`, no `npm ci` in a junctioned
  tree: removing a worktree empties the shared `node_modules` junction target.
- No force push, no rebase, no amend. Update a branch with
  `git merge origin/<base>` and a plain push. `omc ship` refuses force,
  rebase, pull, amend and `reset --hard` before anything spawns.
- The inventory regeneration is the LAST commit. Any later commit re-stales
  `inventory/inventory-graph.json`; `omc ship prepare` orders this for you.
- Merge only through `omc ship merge`. It checks the gates and the verdict;
  a human-typed `gh pr merge` skips both.

## Steps

1. **Implement (executor lane).** Skip with `--pr <n>` when the PR exists.
   Copilot CLI host, headless:
   `omc team 1:copilot:executor --transport sdk "<executor brief>"`.
   In-session: `Task(subagent_type="oh-my-copilot:executor", prompt="<executor brief>")`.
   The lane pushes a branch and opens a draft PR to the base branch.
2. **Start the run:** `omc ship init <pr> --implementer <lane-name>`.
   Record the head sha you hand to the reviewer: `git rev-parse HEAD`.
3. **Review (independent lane).** Give it the reviewer brief below.
   Headless: `omc team 1:copilot:verifier --transport sdk "<reviewer brief>"`
   (the sdk transport rejects the code-reviewer/critic roles; verifier runs).
   In-session: `Task(subagent_type="oh-my-copilot:verifier", ...)` or
   `oh-my-copilot:code-reviewer`. Then record what it said:
   `omc ship verdict <pr> --reviewer <reviewer-lane> --sha <sha> --approve`
   or `--request-changes --notes "<one line>"`.
4. **Fix round (fresh agent)** when changes were requested: a new executor
   with the fix brief below, then back to step 3 with the new head sha. The
   run blocks after `ship.maxFixRounds` (default 2) change requests; stop and
   report to the user instead of starting another round.
5. **Prepare:** `omc ship prepare <pr> --push`. It merges `origin/<base>` in,
   runs `tsc`, eslint on changed files, the tests mapped from the diff and
   the generator `--verify` checks, then regenerates the inventory as the
   last commit and pushes plainly. A conflict outside `inventory/` stops it:
   hand the conflict to a fresh fix agent, then re-review (step 3).
6. **Gates:** `omc ship gates <pr> --watch`. Exit 8 means still pending after
   one watch window (9 minutes, under the 10-minute watcher cap): run the
   same command again. Exit 1 lists the real failures; a failure whose every
   failing test is in `.github/known-flaky-tests.json` is rerun once
   automatically (`gh run rerun <id> --failed`); the same test failing again
   is a real failure.
7. **Merge-readiness:** mark the PR ready (`gh pr ready <pr>`), then
   `omc ship merge <pr>`. It refuses unless the gates are green and the last
   approval covers the head (only ship housekeeping commits may follow the
   reviewed sha). With `ship.allowAdminMerge` unset it prints the exact
   `gh pr merge --admin --merge` command for the owner; merging is the
   owner's call.

## Executor brief (template)

```
Task: <task>
Repo: <path>, branch <branch> off origin/<base>. Read <files> first.
Deliver: the change, tests for it, a plain `git push -u origin <branch>`, a
DRAFT PR to <base>. Report the PR number and head sha.
Never: git worktree add/remove, npm ci, force push, rebase, amend, merging
the PR. Do not edit dist/ or bridge/.
Verify before reporting: npx tsc --noEmit and the tests you touched.
```

## Reviewer brief (template)

```
Review PR #<pr> at commit <sha> against this task: <task>.
Read the change yourself: git diff origin/<base>...<sha> (fetch first).
You were not given the author's summary on purpose; judge the diff.
Check: does it do the task, correctness and edge cases, tests that would fail
without the change, safety rules (no force/rebase paths, no dist/ edits).
Run the targeted tests yourself. Do not edit, commit, or push anything.
Never: git worktree add/remove, npm ci, force push.
Answer with VERDICT: approve | changes-requested, then a numbered list of
blocking findings (file:line, why, expected) and non-blocking notes.
```

## Fix brief (template)

```
PR #<pr>, branch <branch>, head <sha>. A reviewer requested changes:
<numbered blocking findings, verbatim>
Fix exactly these findings; do not refactor beyond them. Add or adjust a test
per finding. Commit as new commits and plain-push (`git push`), never amend.
Never: git worktree add/remove, npm ci, force push, rebase.
Report the new head sha and which finding each commit addresses.
```

## Config (`.copilot/omg.jsonc`)

```jsonc
{
  "ship": {
    "base": "dev",
    "maxFixRounds": 2,
    "allowAdminMerge": false,
    "advisoryChecks": ["No Committed Build Artifacts", "Authorize generated artifacts from base trust root"],
    "knownFlakyFile": ".github/known-flaky-tests.json",
    "autoRerunFlaky": true,
    "pollIntervalSeconds": 30,
    "watchTimeoutMinutes": 9
  }
}
```

## Output

Report the PR number, the final phase from `omc ship status <pr>`, each
verdict (reviewer, sha, approve/changes), the fix rounds used, the gate
result, and either "merged" or the exact merge command left for the owner.
