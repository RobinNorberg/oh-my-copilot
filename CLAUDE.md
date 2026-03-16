# Development Guidelines

## Branch Strategy
- **Default base branch: `dev`** (NOT `main`)
- All PRs must target `dev` branch
- Never create PRs targeting `main` directly
- Always create worktrees from `dev`: `git worktree add <path> -b <branch> dev`

## PR Creation
When creating a PR, always use:
```
gh pr create --base dev ...
```

## Commit Convention
- Use English for all commit messages, PR titles, and issue comments
- Format: `type(scope): description`
