# oh-my-copilot Branching Strategy

## The Insight
Squash merges on GitHub destroy shared history between branches, causing repeated merge conflicts. The flow `branch → dev (squash) → main (merge commit)` means every dev→main merge re-encounters conflicts that were already resolved, because git can't see they share ancestry.

## Why This Matters
In this project, dev fell 20 commits behind main because PRs were merged directly to main (bypassing dev). When we tried to sync, every merge produced the same conflicts. The `sync-main-to-dev.yml` workflow was created to prevent this, but the root cause is discipline: never merge to main except from dev.

## Recognition Pattern
- dev and main diverging (commits on both sides)
- Same merge conflicts appearing repeatedly
- PRs targeting main directly instead of dev
- `git log origin/main..origin/dev` and `git log origin/dev..origin/main` both showing commits

## The Approach
1. **All work flows through dev**: `feature/fix branch → dev → main`
2. **Never merge directly to main** — only release PRs from dev
3. **Use merge commits (not squash)** for dev→main to preserve shared history
4. **Feature→dev can use squash merge** (keeps dev history clean)
5. **Auto-sync**: `sync-main-to-dev.yml` creates a PR after every main push
6. **Version bumps also go through dev** — no exceptions to the flow
7. **After tagging a release**: verify `origin/main` matches expectations by reading from remote, not local working copy
