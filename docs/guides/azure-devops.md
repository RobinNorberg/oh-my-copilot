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

## Agent Awareness

Five agents have built-in ADO knowledge (planner, verifier, debugger, analyst, explore). They automatically use ADO MCP tools for:

- Work item queries and CRUD
- PR creation and review
- Build log investigation
- Cross-repo code search
- Wiki documentation lookup

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
