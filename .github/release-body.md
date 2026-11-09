# oh-my-copilot v5.22.0

This release adds triage and a cloud heartbeat to the software factory, reads
human review feedback on GitHub, Azure DevOps and the local forge, and hardens
the offline mode. Parallel runs work as separate clones. One engine still runs
per checkout.

Install with `npm install -g oh-my-copilot@5.22.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Factory

- `omg factory triage [--apply]` proposes `priority:p0`..`p3`, `needs-split` and
  `needs-plan` for intake items on GitHub, Azure DevOps and the local forge. It
  is a dry run unless you pass `--apply`.
- `omg factory setup --workflows` writes a scheduled heartbeat (GitHub Actions
  or an Azure Pipelines file). It is read-only by default, starts no lane and
  uses no model. `--mode triage` also runs `triage --apply`.
- `omg factory poll` counts open human review threads on factory PRs
  (`k human thread(s) (m ignored)`). Trusted reviewers come from
  `factory.review.trustedReviewers`, write access on GitHub and
  `trustedAuthors` on Azure DevOps.
- `omg factory pr list|view|diff|review` inspects and reviews local-forge PRs
  without running any hook of your checkout.
- Parallel runs: a second engine in one checkout, or on an item another clone
  holds, exits 6 (busy) and touches nothing. Clones on one host coordinate
  through claim files. `run --next` skips claimed items, `run release` clears a
  stale claim, and `run status` without an issue lists the engines and claims.
- Local forge hardening: gates that run `npx`, a PATH program or an outside
  program park at `gate-definition-unknown`. Leftover gate processes are
  killed on Windows and after a crash. Lanes can no longer read the OMC state
  root. The reopen rule and the store locks are tighter.

## Cost

- `omg budget status --by role|kind|run` groups usage by who spent it.
- `modelProfile` (`quality-first`, `balanced`, `economy`) maps agent tiers to
  Copilot models during `omg setup`, and is reversible.

## Caveats

- **Review feedback is read, not acted on.** The engine does not start a fix
  round from human review comments yet. Poll and `omg factory pr` only show them.
- **The Copilot coding agent is not wired in.** The GitHub adapter can read and
  assign the agent, but no command or config key uses it. Implement lanes are
  still `copilot_run` lanes.
- **Parallel runs need separate clones** on one host with one `OMC_STATE_DIR`.
  There is no credit cap across clones, and clones on different hosts do not
  see each other's claims.
- **Azure DevOps paths are tested against fixtures and rendered output only:**
  triage writes, review feedback reads and the heartbeat pipeline.
- **Triage proposes no `owner:<x>` label and writes no assignee.**
- **Triage on the local forge edits backlog files in the working tree.** Commit
  them on the base branch.
- Team routing and committed team decisions are not part of this release.
- `omg factory check`, `board` and poll start-up can still fetch while an engine runs. Avoid running them in a checkout with a live engine.
- This release was published without the maintainer's local full test suite as a gate; the CI test suite on the release commit is the test evidence.
- The live Copilot smoke runs in the CI publish job.
