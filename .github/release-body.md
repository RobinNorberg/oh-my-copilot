# oh-my-copilot v5.19.1

The first published release of the v5.19.0 work, plus a build fix and three
Azure DevOps parity features. The v5.19.0 tag was never published: its
release job failed because the build rewrote a runtime file committed by
mistake, which broke the inventory drift check.

Install with `npm install -g oh-my-copilot@5.19.1`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Fixed

- `.omg/projection-manifest.json` (runtime build output) and
  `.claude/settings.local.json` (a personal settings file) were committed by
  mistake; the build rewrote the first, which broke the release's inventory
  check. Both are untracked again, and a new lint test fails when git tracks
  anything under `.omg/` except `.omg/skills/`.

## New in 5.19.1

- `omg factory poll`: a foreground polling loop for GitHub and Azure DevOps,
  for where webhooks cannot reach. Each tick runs a read-only heal scan where
  heal is configured (on Azure DevOps too), and reports new intake items,
  finished PRs, open review threads (Azure DevOps) and board changes. A tick
  never spawns anything and never writes to the tracker or forge, except the
  run that `factory.intake.autoStart` starts.
- `omg factory heal` and the ci-heal run on Azure DevOps, over Azure
  Pipelines. They need `factory.heal.pipeline` on the base branch;
  `omg factory setup --heal-pipeline <id>|none` can pick it. ci-heal parks
  at the human merge and never merges.
- `factory.intake.autoStart`: off by default and read only from trusted
  config (the user config and the base branch). When it is on, poll starts
  at most one `omg factory run --next` per idle tick. It fails closed: it
  needs a trusted `budget.softLimit`, refuses a corrupt budget ledger, and
  refuses when `OMC_BUDGET_GOVERNOR=0`.

## Included from v5.19.0 (never published on its own)

The full v5.19.0 notes are in `CHANGELOG.md`. In short:

- The shipyard skills hand delivery to `omg factory`: harbor takes intake,
  launch pushes its signed tickets with `omg factory enqueue`, and
  `omg factory run --next --parent <spec>` delivers them in dependency order,
  with outcome comments on each item and rollup lines on the spec.
- Tracker writes on GitHub and Azure DevOps are allowed only for
  `omg factory enqueue`, each as one exact shape.
- Azure DevOps: `omg factory enqueue`, `omg factory board`, and Azure
  Pipelines CI history for heal.
- `omg factory check --parent`, the `blocked-by` gate, two-axis factory
  review, `omg factory init --check` and `--migrate`, and the README skills
  guide.
- The SessionEnd chain refuses routes to captain, retired and unknown
  skills; CI failures no longer start a session for the nonexistent
  `diagnose` skill.

This release was published without the live Copilot smoke (quota exhausted).
The Azure DevOps parts are fixture-tested only and have not been run against
a live org. Details are in `CHANGELOG.md`.
