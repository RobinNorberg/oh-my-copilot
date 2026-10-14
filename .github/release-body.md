# oh-my-copilot v5.11.0

A minor release. The standalone MCP server gains five `copilot_run_*` tools
that let Claude Code (or any MCP client) delegate a task to a headless Copilot
session in its own git worktree. There is no upstream port in this release;
upstream oh-my-claudecode `dev` stays ported through 7cb577e94.

Install with `npm install -g oh-my-copilot@5.11.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Added

### `copilot_run_*` MCP tools: delegate a task to Copilot

- `copilot_run_start`, `copilot_run_status`, `copilot_run_wait`,
  `copilot_run_cancel` and `copilot_run_cleanup` on the standalone MCP server
  (`t`). A job runs a headless `@github/copilot-sdk` session on a prompt in the
  background and reports the final assistant text, the session id, the premium
  requests and AI credits spent, and the worktree path, branch and
  `git diff --stat` to review.
- Opt-in: `copilot_run_start` refuses unless `OMG_COPILOT_RUN_ALLOW=1` is set
  in the MCP server env, and it passes the budget governor (the spend is
  recorded as `copilot-run:<jobId>`). `OMC_DISABLE_TOOLS=copilot-run` hides
  the tools.
- Isolation: by default Copilot works in a new git worktree and branch, not in
  the caller's tree. The write tool is confined to it and refused on the
  `omg ship` merge-rule paths; the shell policy is a denylist, not a sandbox.
- Limits: a timeout (15 min default), a credit cap, cancel and the server's
  shutdown abort the session; at most 2 jobs run at once. The jobs' own
  sessions and sdk team workers do not get the tools, and the Copilot
  sessions omg starts never inherit the opt-in.
- Cleanup never removes a worktree with uncommitted or unmerged work. Ignored
  files go with it; symlinks and junctions in it are unlinked first, so a
  linked `node_modules` target survives.

## Fixed

- `omg team` worker worktree removal unlinks untracked symlinks and junctions
  before `git worktree remove`, so a junctioned `node_modules` target is no
  longer emptied on Windows. A worktree with initialized submodules is refused
  before any link is touched.

See [REFERENCE.md](https://github.com/RobinNorberg/oh-my-copilot/blob/main/docs/REFERENCE.md#mcp-tools-copilot_run_-delegate-a-task-to-copilot)
and `CHANGELOG.md` for details.
