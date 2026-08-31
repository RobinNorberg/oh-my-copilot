# PR Review — Verify Branch Before Reviewing

## The Insight
When reviewing a PR, Claude's local working tree may be on the wrong branch — a feature branch, main, or even a different PR's branch. Reviewing code from the wrong branch produces an entirely incorrect analysis that must be discarded and redone, wasting a full review cycle.

## Why This Matters
This happened in a real session: Claude reviewed code from a local feature branch instead of the PR's source branch, produced a detailed critical analysis with findings, and the entire review had to be retracted because none of it applied to the actual PR changes. The user lost the time spent on the review AND had to redirect Claude to start over.

## Recognition Pattern
- Any task involving "review PR", "code review", "check this PR"
- When a PR number or URL is provided
- Before reading any diff or source code for review purposes

## The Approach
Before reading a single line of code for review:

1. **Fetch the latest** from the remote:
   ```bash
   git fetch origin
   ```
2. **Identify the PR's source branch** — from the PR URL, number, or user instruction
3. **Checkout the PR branch**:
   ```bash
   git checkout <pr-source-branch>
   git pull origin <pr-source-branch>
   ```
4. **Verify you're on the right branch**:
   ```bash
   git log --oneline -3
   git branch --show-current
   ```
   Confirm the latest commits match what the PR should contain.
5. **Only then** start reading diffs and reviewing code:
   ```bash
   git diff <target-branch>...HEAD
   ```

Never skip step 4. A 5-second verification prevents a 30-minute wasted review.
