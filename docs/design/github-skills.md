# GitHub Skills Design

> **Skill Prefix:** `omc-gh-*`
> **Author:** oh-my-copilot
> **Status:** Implementing

## Summary

5 GitHub-specific skills for OMC, mirroring the existing Azure DevOps skill set. Skills use `gh` CLI exclusively (no MCP tools needed), auto-detect GitHub remotes from `git remote -v`, and store configuration in `.omc/config.json` under a `github` key — parallel to the existing `ado` key.

## Skill Inventory

| # | Skill | Purpose | ADO Equivalent |
|---|-------|---------|----------------|
| 1 | `omc-gh-setup` | Detect GitHub remote, verify `gh` auth, write config | `omc-ado-setup` |
| 2 | `omc-gh-triage` | Issues + PRs + failing Actions + Dependabot alerts | `omc-ado-triage` |
| 3 | `omc-gh-review` | Interactive PR review (read diff, post comments, approve) | `omc-ado-review` |
| 4 | `omc-gh-auto-review` | Automated review: spawn code-reviewer, post inline findings | `omc-ado-auto-review` |
| 5 | `omc-gh-project` | GitHub Projects v2 board management | `omc-ado-sprint` |

## Architecture Decisions

### 1. `gh` CLI as sole interface (no MCP tools)

- `gh` is mature, well-documented, and covers all needed operations
- No GitHub MCP server exists in the current OMC tool inventory
- `gh` output supports `--json` with `--jq` for structured parsing
- If a GitHub MCP server is added later, skills can be updated to MCP-preferred/CLI-fallback

### 2. Remote detection: `git remote -v` parsing

Three URL patterns detected:

```
https://github.com/{owner}/{repo}.git
git@github.com:{owner}/{repo}.git
https://github.com/{owner}/{repo}
```

Extracted values: `owner` (org or user), `repo` (repository name). Simpler than ADO which has `org/project/repo`.

### 3. Config storage: `.omc/config.json` with `github` key

```json
{
  "ado": { ... },
  "github": {
    "owner": "myorg",
    "repo": "my-service",
    "defaultBranch": "main",
    "labelTriage": "needs-triage",
    "configuredAt": "2026-04-01T12:00:00Z"
  }
}
```

A project can have both ADO and GitHub config simultaneously.

### 4. Integration with execution modes

| Mode | Integration Point |
|------|------------------|
| `autopilot` | `omc-gh-setup` runs when GitHub remote detected and no config exists |
| `team` | `omc-gh-triage` can feed items into `team-plan` stage |
| `ralph` | `omc-gh-auto-review` as verification step in ralph loop |
| `psm` | PSM already supports GitHub; GH skills complement but don't replace PSM |

## Skill Details

### 1. `omc-gh-setup`

**Triggers:** `"gh setup"`, `"github setup"`, `"configure github"`

**Workflow:**
1. Verify `gh` CLI installed and authenticated
2. Parse `git remote -v` for `github.com` URLs, extract owner/repo
3. Verify access via `gh repo view`
4. Discover labels for triage config
5. Write `.omc/config.json` with `github` key
6. Smoke test with `gh issue list`

### 2. `omc-gh-triage`

**Triggers:** `"gh triage"`, `"github triage"`, `"triage issues"`, `"github status"`

**Parallel data gathering:**
- Open issues assigned to me
- Untriaged issues (by label)
- PRs needing my review
- PRs I authored (status check)
- Failing CI on default branch
- Dependabot/security alerts

**Output:** Structured triage summary with prioritized recommended actions.

### 3. `omc-gh-review`

**Triggers:** `"gh review"`, `"review pr"`, `"review pull request"`, `"github review"`

**Workflow:** List PRs -> select -> show details/diff -> read existing comments -> post comments -> submit approve/request-changes.

### 4. `omc-gh-auto-review`

**Triggers:** `"auto review"`, `"auto-review prs"`, `"automated pr review"`

**Agent:** `code-reviewer` (spawned per PR)

**Workflow:** Find PRs requesting review -> fetch diff -> spawn code-reviewer agent -> post findings as batched inline review comments (reduces notification spam vs ADO's per-comment threading).

**Config options:** `severityThreshold`, `autoSubmit`, `maxFilesPerReview`, `excludePatterns`.

### 5. `omc-gh-project`

**Triggers:** `"gh project"`, `"github project"`, `"project board"`, `"manage board"`

**Workflow:** Discover projects -> list items -> view/update status -> assign iterations -> add issues/PRs to project.

**Caveat:** GitHub Projects v2 CLI support is evolving. Some operations require `gh api graphql` fallback.

## Comparison Matrix

| Capability | ADO Skill | GitHub Skill | Key Difference |
|-----------|-----------|-------------|----------------|
| **Setup** | Extension + PAT + `az devops configure` | `gh auth login` (one command) | GH is significantly simpler |
| **Config** | `ado.*` (6 fields) | `github.*` (4 fields) | Coexist in same file |
| **Triage** | Work items + PRs + pipelines + AdvSec | Issues + PRs + Actions + Dependabot | Different naming, same structure |
| **PR Review** | 5-value vote, MCP threads | 3-state review, `gh pr review` | GH batches comments per review |
| **Auto Review** | MCP-preferred, `az` fallback | `gh`-only | GH avoids notification spam via review batching |
| **Sprint/Project** | Iterations + capacity + WIQL | Projects v2 + fields + GraphQL | GH lacks capacity tracking |

## What NOT to Build

| Excluded Feature | Reason |
|-----------------|--------|
| git-workflow / branch naming | Already handled by `project-session-manager` |
| reviewer-protocol / lockout | Policy enforcement belongs in team/ralph logic |
| CI validation gates | Belongs in GitHub Actions, not agent-side |
| PR screenshots | Ad-hoc concern; `visual-verdict` exists |
| GitHub Actions templates | Scaffolding — `executor` generates on demand |
| Release runbook | Already covered by `release` skill |
| Multi-account auth | Environment concern, not orchestration |

## Priority

| Order | Skill | Effort | Impact |
|-------|-------|--------|--------|
| 1 | `omc-gh-setup` | Low | Prerequisite for all others |
| 2 | `omc-gh-triage` | Medium | Daily driver, high visibility |
| 3 | `omc-gh-review` | Medium | Core developer workflow |
| 4 | `omc-gh-auto-review` | Medium-High | Automated review pipeline |
| 5 | `omc-gh-project` | High | Defer if time-constrained |
