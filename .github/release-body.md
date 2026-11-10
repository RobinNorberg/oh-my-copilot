# oh-my-copilot v5.23.0

This release lets the software factory act on human review, hands issues to the Copilot coding agent on request, adds committed team routing and decisions, and stops read commands from fighting a running engine. One engine still runs per checkout.

Install with `npm install -g oh-my-copilot@5.23.0`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## Factory

- Human review feedback now starts a fix round and gates the merge. Open threads of trusted reviewers start a fix lane (`factory.review.human`: `fix`, `gate-only`, `off`), a change request or a review that cannot be read whole parks at `human-review`, and `factory.review.waitForRequested` parks at `review-requested`. `omg factory run <n> --allow-unsandboxed-lanes` acknowledges, per head, that you checked the PR yourself after a lane ran without the enforced sandbox.
- The Copilot coding agent can implement GitHub issue runs. It is opt-in and billed by GitHub: set `factory.run.implementer: "coding-agent"` and list each repository in `factory.codingAgent.repos` in the user config. `factory.codingAgent.maxSessionsPerDay` (default 5) and `maxWaitMinutes` (default 90) bound it. The run parks at `coding-agent-wait` while the agent works and adopts its pull request when it finishes.
- `omg factory setup --team` creates `.copilot/team/routing.md` (path owners, first matching row wins) and `.copilot/team/decisions.md` (append-only). The factory reads them from the base commit, shows owners and decisions to the lanes, and parks a PR that rewrites `decisions.md` at `decisions-rewritten`.
- `omg factory poll` reminds you of gates parked longer than `factory.poll.remindAfterHours` (default 24, `0` = off). Reminders are printed, never posted.
- Read commands (`check`, `board`, `pr`, `triage`, `enqueue`, poll start-up) no longer fetch while an engine runs. They use the last fetched base and warn. Engine starts wait up to 60 s for a read's fetch before exit 6. The base fetch never prompts for credentials and gives up after 45 s.
- Path globs in `routing.md` follow `.gitignore` rules: `**` matches whole path segments.

## Caveats

- **The coding agent lane has never been exercised against the live service.** The tests use fakes. The first live use should be watched. It is opt-in per repository, and every agent session is billed by GitHub to your Copilot plan.
- **Poll does not re-run runs parked at `coding-agent-wait`.** Run `omg factory run <n>` to check on the agent.
- **Azure DevOps paths are tested against fixtures and rendered output only.**
- **Parallel runs need separate clones** on one host with one `OMC_STATE_DIR`. There is no credit cap across clones, and clones on different hosts do not see each other's claims.
- **A run resumed after an engine crash parks at the merge step** (`human-review`) until you pass `--allow-unsandboxed-lanes`, because a lane lost in the crash has no sandbox record.
- **Top-level PR conversation comments are not read** by the human review step. It reads review threads and reviews. Comments left on the agent's pull request before adoption are not read either.
- **The engine's base fetch never prompts for credentials.** Sign in (for example through Git Credential Manager) before `omg factory run`; an expired login gives a stale-base warning.
- This release was published without the maintainer's local full test suite as a gate; the CI test suite on the release commit is the test evidence.
- The live Copilot smoke runs in the CI publish job.
- **Gates run the PR's code outside the sandbox.** Prepare checks and the local gate (`npm test` and the like) run code written by a lane as you, with your GitHub or Azure DevOps token in the environment, before any human review. Lane sessions themselves are sandboxed. Run the factory only on repositories and issues you trust until a later release moves gates into the sandbox.
- **Two clones on the local forge do not see each other's claims.** Each clone has its own project id and mirror, so the same item can be started from both. Claims coordinate clones of a GitHub or Azure DevOps repository only.
- Dogfood round 3 (local forge, Windows, 19 premium requests) passed the happy path, the human review fix round, parallel clones, a ci-fix park and a mid-lane cancel. Known issues from it: after the outside cause of a gate failure is removed, `run` starts more ci-fix lanes on the same head instead of re-running the gate; after a mid-lane cancel, `run clean` and `run reset` both refuse until you discard the worktree's changes (`git checkout -- .` in the lane worktree); `board` and `poll` can keep an old "no open trusted threads" line after a changes-requested review; `triage --apply` on the local forge can add a priority label that contradicts the item's frontmatter. Azure DevOps and the Copilot coding agent were not exercised live.
