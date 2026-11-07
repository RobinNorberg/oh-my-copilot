# oh-my-copilot v5.19.8

An upstream port (oh-my-claudecode 27e7f235e..4d5d22187, 22 commits). It adds
about 30 new skills, the verification ledger and a watch-pr policy, and fixes
ralph, jev, team worktrees and resume, session-end and Windows.

Install with `npm install -g oh-my-copilot@5.19.8`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Added

- About 30 new skills (96 bundled now). They include the PR-care suite
  (`babysit`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`), the
  pstack series, a panel, generator and utility suite, and review-and-climb
  skills (`hillclimb`, `reflect`, `personal-mode`, `stacked-delivery`). Where
  they name Claude Code tools or paths, they are adapted to Copilot CLI.
- The verification ledger, watch-pr policy, playbook checker and credits
  registry.
- `omg team resume` resumes runtime v2 teams. An SDK team counts as resumed
  only while a worker host is alive.
- An opt-in HUD account element for Claude Code. It is hidden on Copilot CLI.

## Changed

- On Claude Code, the SessionEnd foreground budget is now max(1 s, half the
  hook timeout). Before, it was a fixed 300 ms. Copilot CLI keeps 1.5 s,
  because it runs SessionEnd after every turn. `OMC_SESSION_END_BUDGET_MS`
  overrides the budget on both hosts.

## Fixed (ported)

- Team worktrees and branches that hold unmerged worker commits are kept.
- Ralph failure signatures are stable. Jev model routing and its context
  pruning are fixed.
- Config rewrites keep unmanaged keys. A run awaiting confirmation is no
  longer flagged as crashed.
- On Windows, the HUD fallback runs without a console window, and the epic
  verifier runs.

## Caveats

- `reflect` and `personal-mode` read Claude Code transcripts.
- On Node 20, full protection against a planted executable on Windows needs
  Node 22+. The Node 22 minimum is planned for a later release.
- This release was published without the live Copilot smoke.
