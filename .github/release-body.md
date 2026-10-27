# oh-my-copilot v5.15.0

A minor release from v5.14.0: the first part of the factory engine, still
**experimental**. `omg factory run <issue>` drives one GitHub issue through
plan, implement lane, draft PR, an independent review lane and fix rounds, then
parks at `awaiting-human: prepare`. Prepare, gates and the merge gate come in
later releases. It runs only when you start it by hand, and merging is always
human. The release also fixes a team worker push-rule bypass.

Install with `npm install -g oh-my-copilot@5.15.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Added

- `omg factory run <issue> [--dry-run] [--json]`, plus `status` and `cancel`.
  Rerun the same command to resume after any `awaiting-human` stop. The issue
  needs an `Acceptance criteria` heading or an `omg-plan:` line from an owner,
  member or collaborator.
- A mandatory AI-credit cap per lane (`factory.run.laneMaxCredits`, default and
  minimum 30; the engine refuses a run without it), an optional
  `factory.run.maxRunCredits`, and per-run wall-time and retry limits.
- `copilot_run` gains `startRef` (worktree at a validated commit),
  `profile: "review"` (no write tool, no git that mutates refs, tree or
  config) and an in-process `allowLive` that MCP callers cannot pass.

## Security

- The engine holds its own copy of every state file and compares it around each
  lane. It also checks the shared git dir (refs, config, hooks, worktrees,
  global config, both HEADs) and stops at `awaiting-human` on any change.
- The engine's git runs without hooks or fsmonitor, pushes only
  `factory/<issue>`, and accepts only an exactly matching review verdict. The
  implementer can never approve.
- Lanes are not sandboxed. Treat any lane as possibly prompt-injected; a human
  gate always precedes the merge.

## Fixed

- Team worker `git push` denial could be bypassed with aliases, quote-split
  spellings, full-path git binaries, `send-pack`, `http-push` and
  `subtree push`. This affected v5.14.0 and earlier.
- Git 2.56 error wording for a bad gitfile is accepted, which was the real
  cause of the "flaky" non-git CI test. It is also in 5.14.0's build but was
  missing from its notes.

Reference is in `docs/REFERENCE.md`. Fork deviations (kept and dropped) are
listed in `CHANGELOG.md`.
