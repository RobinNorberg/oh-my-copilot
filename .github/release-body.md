# oh-my-copilot v5.25.0

This release lets several factory runs work at the same time in one checkout. It builds on the opt-in private layout from 5.24.0, where each run works in its own engine-owned git repository. The default is unchanged: one engine per checkout.

Install with `npm install -g oh-my-copilot@5.25.0`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## New (opt-in)

- **Parallel runs in one checkout** (#487). Set `factory.run.layout: "private"` and `factory.run.maxConcurrent` (default 1) in your user config. `omg factory run --next --parallel N` starts up to N engines as child processes and refills a slot when one finishes. Lanes, prepare and gates run in parallel. Imports into your repository and pushes run one at a time under a lock.
- **Shared credit limit.** `factory.run.maxInFlightCredits` (default `laneMaxCredits` x `maxConcurrent`) caps the credits that lanes of all running engines may hold at once.
- **Status and cleanup.** `omg factory run status` lists the live engines with their slot and layout. `omg factory run release <issue>` frees the slot, lock and credit reservation of an engine that died. It never frees a live one.

## Fixed

- Private layout follow-ups from the 5.24.0 review: `run clean` checks for a live local gate process before it removes a run directory, and several park messages now say what to check before a rerun.

## Rules to know

- Parallel runs need the private layout. With the shared layout, asking for more than one concurrent run is refused with a message.
- The parallel settings in a committed `.copilot/omg.jsonc` take effect only when your user config opts in (it sets `maxConcurrent`, `maxInFlightCredits` or the private layout). A committed `maxConcurrent` alone does nothing.
- A run that started in the shared layout is not moved to the private layout. While it is live, parallel private runs wait, and the message names it.
- The credit pool is one per repository and is shared between clones on one machine.

## Caveats

- **Parallel runs have never run against a live Copilot session.** The tests use fake lanes and real git. Two real processes were tested only for the slot pick and the import lock.
- **Azure DevOps:** when the base branch moves twice while runs are in parallel, the check that tells another run's fetch from a change fetches a commit by its id. Whether Azure DevOps allows that is unverified. If it does not, such a run stops as busy until you cancel it.
- **Some lock waits still ignore Ctrl+C** for up to a few minutes outside the main path. They are bounded.
- Without a forge configuration from `omg factory setup`, the committed parallel settings are never read.
- All caveats of 5.24.0 still apply: the Copilot sandbox on Windows cannot deny paths, the sandboxed gates and the private layout have never run live, and Azure DevOps paths are tested against fixtures only.
- **Test evidence:** this release was published with CI on the release commit, not the maintainer's local full test suite.
