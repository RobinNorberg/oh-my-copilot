# Stale Main Branch Re-Introduces Removed Dependencies

## The Insight

When working on a fork with active PRs, your local `main` can be behind `origin/main` by the time you start a new task. Merging a stale `main` into a feature branch silently **re-introduces code that was removed by recently-merged PRs**. The merge succeeds cleanly — no conflicts — because git sees the removal and the stale state as divergent histories that auto-resolve to "keep both".

## Why This Matters

In this session, PR #16 removed `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk` from package.json. Our local `main` was one commit behind (still had the SDKs). When we merged `main` into `dev` and created our port branch, the SDKs came back in package.json and package-lock.json. The build passed, tests passed, the PR looked clean — but we shipped reversed work from PR #16.

This is insidious because:
1. **No merge conflict** — git auto-resolves cleanly in the wrong direction
2. **No test failure** — the re-added deps install fine
3. **No type error** — the code compiles with or without the deps
4. **Only caught by code review** — the user noticed Anthropic SDK references in the PR diff

## Recognition Pattern

- Starting work that involves syncing branches (`dev` with `main`, feature branch from `main`)
- Recently-merged PRs that **removed** dependencies, files, or features
- `git log main` shows a different HEAD than `git log origin/main`
- PR diff unexpectedly shows additions in files you didn't intend to change (package.json, package-lock.json)

## The Approach

**Mandatory first step before ANY branch sync or port work:**

```bash
# Always fetch before syncing — never trust local main
git fetch origin main:main

# Verify local main matches remote
git log --oneline main -1
git log --oneline origin/main -1
# These MUST show the same commit
```

**When reviewing your own PR before requesting review:**
- Check `package.json` diff — are dependencies being added that shouldn't be?
- Check for files that a recent PR deleted — are they reappearing?
- Run `git log origin/main..HEAD --stat` to see the full diff from latest remote main

**If you already pushed with stale main:**
```bash
git fetch origin main:main
git merge main --no-edit
# This brings in the removal commit, fixing the issue
git push
```

## Broader Principle

This applies to ANY removal PR, not just dependencies:
- Removed source files reappear
- Deleted config entries come back
- Reverted features get un-reverted

The root cause is always the same: **local ref staleness + clean auto-merge = silent regression**.
