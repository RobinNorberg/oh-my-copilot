# oh-my-copilot v5.21.0

The software factory now runs offline: the `local` forge works from a
committed backlog in your repository, with no GitHub or Azure DevOps. This
release also fixes the findings of two factory and team dogfood rounds, and
ports two upstream ranges (oh-my-claudecode 27e7f235e..4d5d22187 and
4d5d22187..c5b71636e). Version 5.19.8 was never published; its changes ship
here.

Install with `npm install -g oh-my-copilot@5.21.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Offline mode: the local forge

- `omg factory setup --forge local` writes the config, a closed sample item
  and `ship.base` (`dev` if it exists, else the current branch).
- Backlog items are committed files, `.copilot/backlog/<id>-<slug>.md` with
  frontmatter. The engine pushes run branches to a bare mirror it owns, the
  git remote `omg-local`, and runs your gate command
  (`factory.forge.local.gate`) as the check `local-gate`. You merge with the
  `git merge --no-ff --no-edit` command the run prints.
- `check`, `board`, `enqueue`, `poll` and `run --next` work with no origin.
  `check`, `board` and `setup` print what offline mode does not do.
- A head that changes the gate's definition parks at
  `gate-definition-changed` before any push.
- See `docs/FACTORY-OFFLINE.md`.

## Dogfood fixes

- Prepare runs only the checks the target repository has, so a factory run in
  another repository no longer fails on this repository's tsc and inventory
  scripts. `ship.prepare.checks` replaces the detected checks.
- SDK workers start with launch progress instead of 1-3 silent minutes, get a
  branch worktree by default, and get a 50 AI credit cap (was 10, which one
  small task already exceeded).
- A capped worker's task becomes `capped` instead of staying `in_progress`.
  A worker blocker reaches the leader: `omg team status` lists it under
  `leader_inbox`, and guidance says how to answer it.
- `omg team shutdown` needs no `--force` when every task is terminal, and
  names each dirty worktree it keeps.
- A spec whose children are all closed, or a local spec without tickets, is
  no longer runnable, so `run --next` does not implement the whole spec.
- A WinGet-installed `copilot` no longer triggers the non-standard path
  warning.

## Upstream ports

- About 30 new skills (98 bundled now), including the PR-care suite
  (`babysit`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`), the
  review-and-climb skills, `statechart` (TLA+ model check drawn as a Mermaid
  statechart) and `ketchup-video`. `arena`, `reflect`, `sharpen` and
  `interrogate` follow pstack v0.9.125.
- The verification ledger, watch-pr policy, playbook checker and credits
  registry.
- `omg team resume` resumes runtime v2 teams. An SDK team counts as resumed
  only while a worker host is alive.
- On Claude Code, the SessionEnd foreground budget is now max(1 s, half the
  hook timeout). Copilot CLI keeps 1.5 s.
- Fixes for team worktrees, ralph, jev, config rewrites and Windows.
- `tsx` is now a runtime dependency, for the `statechart` launcher on Node 20.

## Upgrade notes

- New config keys:
  - `ship.prepare.checks`: argv commands prepare runs instead of the detected
    checks; `[]` runs none. Read only from the user config or the base's
    committed `.copilot/omg.jsonc`.
  - `factory.forge.kind: "local"` with `factory.forge.local.gate`: offline
    mode. Over a GitHub or Azure DevOps origin it counts only from the user
    config or the base-committed `.copilot/omg.jsonc`.
  - `team.sdk.compactProtocol`: a shorter worker protocol for SDK workers.
    Off by default.
  - `team.sdk.blockerTimeoutMinutes`: fails a task whose blocker stays
    unanswered. Off by default.
- Changed defaults: `team.sdk.maxCreditsPerWorker` is 50. SDK teams use
  branch worktrees when `team.ops.worktreeMode` is unset; set it to keep the
  shared checkout. `factory.run.maxRunCredits` must be at least
  `laneMaxCredits` + 30.
- Exit codes:
  - 2: the local forge's base branch is missing, or `ship.base` is not a
    plain branch name.
  - 3: `omg team shutdown` kept a worker worktree with uncommitted changes.
  - 5: no usable forge, for every factory command (`omg factory run` exited
    1 before; `omg factory setup` with no origin and no flags exited 2).
- `omg factory run reset <n>`: starts a cancelled local run over, after
  `omg factory run clean <n>`. Before, a cancelled offline item could never
  run again.
- `omg factory run <n> --allow-gate-change`: accepts a parked gate
  definition change once.
- A factory run parks at `prepare-checks` when `ship.prepare.checks` changes
  during the run.

## Caveats

- This release was published without the live Copilot smoke.
- `reflect` and `personal-mode` read Claude Code transcripts.
- `statechart` installs TLC and Java with mise on its first run and needs the
  network.
- On Node 20, full protection against a planted executable on Windows needs
  Node 22+. The Node 22 minimum is planned for a later release.
