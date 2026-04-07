# Azure DevOps Integration

oh-my-copilot supports Azure DevOps natively — auto-detection, work item management, PR operations, and triage workflows.

## Auto-Detection

When your git remote points to `dev.azure.com` or `*.visualstudio.com`, OMC automatically:

- Detects the ADO platform on session start
- Injects available `mcp__azure-devops__*` MCP tool context into agent prompts
- Reads `.omg/config.json` for project-specific settings

## Setup

```bash
/oh-my-copilot:omc-ado-setup
```

This configures your ADO connection — verifies `az` CLI auth, auto-detects org/project from git remote, and writes `.omg/config.json`:

```json
{
  "version": 1,
  "platform": "azure-devops",
  "ado": {
    "org": "my-org",
    "project": "my-project",
    "defaultWorkItemType": "User Story",
    "areaPath": "MyProject\\Team Alpha",
    "iterationPath": "MyProject\\Sprint 5"
  }
}
```

Cross-project support: when code and work items live in different ADO projects, add `workItemOrg` and `workItemProject` fields.

## Triage

```bash
/oh-my-copilot:omc-ado-triage
```

Scans 5 ADO surfaces in parallel and produces a prioritized summary:

- Untriaged work items
- Your active work items
- Open pull requests with review status
- Pipeline build status
- Security alerts

Uses MCP tools when available, falls back to `az` CLI.

## PR Review

### Interactive

```bash
/oh-my-copilot:omc-ado-review
```

Walk through open PRs: read diffs, view existing review threads, post inline or general comments, manage reviewers, and submit vote decisions. ADO uses a 5-value vote system:

| Vote | Meaning |
|------|---------|
| `10` | Approved |
| `5` | Approved with suggestions |
| `0` | No vote |
| `-5` | Waiting for author |
| `-10` | Rejected |

### Automated

```bash
/oh-my-copilot:omc-ado-auto-review
```

Discovers PRs where you are assigned as reviewer, fetches diffs, spawns a `code-reviewer` agent, and posts structured inline findings as review threads.

Configurable via `.omg/config.json`:

| Setting | Default | Purpose |
|---------|---------|---------|
| `severityThreshold` | `"MEDIUM"` | Minimum severity to post |
| `autoSubmit` | `false` | Automatically submit vote |
| `maxFilesPerReview` | `50` | Cap on files analysed |
| `excludePatterns` | `["*.lock", "*.min.js", "*.generated.*"]` | Globs to skip |

## Sprint Planning

```bash
/oh-my-copilot:omc-ado-sprint
```

Full sprint planning cycle — query iterations, check team capacity, review and groom the backlog, and assign work items to sprints. Supports:

- Listing current and upcoming iterations
- Viewing team capacity and assigned work
- Moving work items between iterations
- Backlog grooming with priority adjustments
- Capacity-based sprint load balancing

## Agent Awareness

Five agents have built-in ADO knowledge (planner, verifier, debugger, analyst, explore). They automatically use ADO MCP tools for:

- Work item queries and CRUD
- PR creation and review
- Build log investigation
- Cross-repo code search
- Wiki documentation lookup

## MCP Tools

When the `azure-devops` MCP server is available, OMC uses 70+ dedicated tools organized by domain:

| Domain | Tool Prefix | Examples |
|--------|------------|---------|
| **Work Items** | `wit_*` | `wit_get_work_item`, `wit_create_work_item`, `wit_update_work_item` |
| **Repos & PRs** | `repo_*` | `repo_list_pull_requests_by_repo_or_project`, `repo_create_pull_request` |
| **Pipelines** | `pipelines_*` | `pipelines_get_build_status`, `pipelines_run_pipeline` |
| **Test Plans** | `testplan_*` | `testplan_list_test_cases`, `testplan_create_test_case` |
| **Wiki** | `wiki_*` | `wiki_get_page_content`, `wiki_create_or_update_page` |
| **Security** | `advsec_*` | `advsec_get_alerts`, `advsec_get_alert_details` |
| **Search** | `search_*` | `search_code`, `search_workitem`, `search_wiki` |

When MCP tools are unavailable, all skills fall back to `az` CLI with the `azure-devops` extension.

## Provider API

The `AzureDevOpsProvider` exposes programmatic access:

| Method | Description |
|--------|-------------|
| `listWorkItems()` | WIQL queries with injection prevention |
| `createWorkItem()` | Create with type, area/iteration paths, tags |
| `addTag()` / `removeTag()` | Work item tag management |
| `addComment()` | Add discussion comments |
| `listPullRequests()` | List PRs by status |
| `createPullRequest()` | Create PR with source/target branches |
| `mergePullRequest()` | Complete a PR |

All commands use `execFileSync` with WIQL escaping for security.

## Comparison with GitHub Integration

| Capability | Azure DevOps | GitHub |
|-----------|-------------|--------|
| **Detection** | `dev.azure.com` / `*.visualstudio.com` remote | `github.com` remote |
| **CLI** | `az` + `azure-devops` extension | `gh` |
| **MCP Tools** | 70+ `mcp__azure-devops__*` tools | None (gh CLI only) |
| **Config** | `.omg/config.json` → `ado` key | `.omc/config.json` → `github` key |
| **Triage** | Work items + PRs + Pipelines + AdvSec | Issues + PRs + Actions + Dependabot |
| **PR Review** | 5-value vote system (-10 to +10) | 3-state (approve/request-changes/comment) |
| **Sprint/Project** | Iterations + capacity + WIQL | GitHub Projects v2 (field-based) |
| **Auth** | `az login` + PAT | `gh auth login` |
