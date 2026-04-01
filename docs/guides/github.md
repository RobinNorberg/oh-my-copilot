# GitHub Integration

oh-my-copilot supports GitHub natively — auto-detection, issue/PR triage, code review workflows, and project board management.

## Auto-Detection

When your git remote points to `github.com`, OMC automatically:

- Detects the GitHub platform on session start
- Uses `gh` CLI for all GitHub operations
- Reads `.omc/config.json` for project-specific settings

## Setup

```bash
/oh-my-copilot:omc-gh-setup
```

This configures your GitHub connection — verifies `gh` CLI auth, auto-detects owner/repo from git remote, and writes `.omc/config.json`:

```json
{
  "github": {
    "owner": "RobinNorberg",
    "repo": "oh-my-copilot",
    "defaultBranch": "dev",
    "labelTriage": "needs-triage",
    "configuredAt": "2026-04-01T12:00:00Z"
  }
}
```

Dual-platform support: a project can have both `github` and `ado` keys in the same config file (useful for mirrors or migrations).

## Triage

```bash
/oh-my-copilot:omc-gh-triage
```

Scans 6 GitHub surfaces in parallel and produces a prioritized summary:

- Open issues assigned to you
- Untriaged issues (by label or no-label filter)
- PRs requesting your review
- PRs you authored (review + CI status)
- Failing CI workflows on the default branch
- Dependabot / security alerts

## PR Review

### Interactive

```bash
/oh-my-copilot:omc-gh-review
```

Walk through open PRs: read diffs, view existing review threads, post inline or general comments, and submit approve/request-changes decisions.

### Automated

```bash
/oh-my-copilot:omc-gh-auto-review
```

Discovers PRs where you are requested as reviewer, fetches diffs, spawns a `code-reviewer` agent, and posts structured inline findings as a single batched review (one notification, not one per comment).

Configurable via `.omc/config.json`:

| Setting | Default | Purpose |
|---------|---------|---------|
| `severityThreshold` | `"MEDIUM"` | Minimum severity to post |
| `autoSubmit` | `false` | Automatically submit review decision |
| `maxFilesPerReview` | `50` | Cap on files analysed |
| `excludePatterns` | `["*.lock", "*.min.js", "*.generated.*"]` | Globs to skip |

## Project Boards

```bash
/oh-my-copilot:omc-gh-project
```

Manage GitHub Projects (v2) boards — list items, update statuses, assign iterations, and add issues/PRs to projects. Uses `gh project` commands with GraphQL API fallback for advanced field operations.

## CLI Interface

All GitHub skills use `gh` CLI exclusively. No MCP tools are required.

| Command Pattern | Purpose |
|----------------|---------|
| `gh issue list` | Query issues with filters |
| `gh pr list / view / diff` | PR discovery and diff reading |
| `gh pr review` | Submit review decisions |
| `gh run list` | Check CI workflow status |
| `gh api` | Dependabot alerts, review comments, GraphQL |
| `gh project` | Projects v2 board management |

## Comparison with Azure DevOps Integration

| Capability | GitHub | Azure DevOps |
|-----------|--------|-------------|
| **Detection** | `github.com` remote | `dev.azure.com` / `*.visualstudio.com` remote |
| **CLI** | `gh` | `az` + `azure-devops` extension |
| **MCP Tools** | None (gh CLI only) | 70+ `mcp__azure-devops__*` tools |
| **Config** | `.omc/config.json` → `github` key | `.omg/config.json` → `ado` key |
| **Triage** | Issues + PRs + Actions + Dependabot | Work items + PRs + Pipelines + AdvSec |
| **PR Review** | 3-state (approve/request-changes/comment) | 5-value vote system (-10 to +10) |
| **Sprint/Project** | GitHub Projects v2 (field-based) | Iterations + capacity + WIQL |
| **Auth** | `gh auth login` | `az login` + PAT |
