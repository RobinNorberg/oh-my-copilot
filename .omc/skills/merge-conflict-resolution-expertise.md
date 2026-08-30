# Merge Conflict Resolution in Multi-Branch Workflows

## The Insight
When using `git checkout --ours` to resolve merge conflicts in bulk, you MUST verify the result against the intended state — not just trust that "ours" is correct. In squash-merge workflows, "ours" may refer to a branch that lost history from the squash, meaning it can silently revert changes that were previously merged.

## Why This Matters
In this project, `git checkout --ours` during a dev→main merge silently reverted the README install command from `@omcp` back to `@omg`. The change appeared correct locally (uncommitted working copy had the fix), masking that git's committed state was wrong. This shipped to npm as a regression.

## Recognition Pattern
- Resolving merge conflicts with bulk `--ours` or `--theirs`
- Working with branches that were squash-merged on GitHub (not merge-committed)
- Seeing the same conflicts repeatedly across merges (sign of lost shared history)
- Local `git diff` shows no changes but `git show origin/branch -- file` shows old content

## The Approach
1. **Never use bulk `--ours`/`--theirs` without spot-checking** key files after resolution
2. After resolving conflicts, run `git diff origin/target -- <key-files>` to verify the merge result against the target branch
3. **Check for uncommitted changes** (`git status`) before declaring a merge complete — floating uncommitted edits mask committed regressions
4. For squash-merged branches, prefer creating a fresh branch from the target and cherry-picking, rather than merging (avoids the lost-history problem)
5. After every merge to main, verify the published state by reading from `origin/main`, not the local working copy
