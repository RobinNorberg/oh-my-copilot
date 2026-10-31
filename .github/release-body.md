# oh-my-copilot v5.19.0

A feature release that connects the shipyard skills to `omg factory`, from
harbor intake to dependency-ordered delivery, and brings Azure DevOps closer
to parity with GitHub, on top of v5.18.2.

Install with `npm install -g oh-my-copilot@5.19.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Security

- Tracker writes on GitHub (`gh issue create`, `gh issue edit`,
  `gh issue list --search`) and on Azure DevOps (`wit/workItems` `POST` and
  `PATCH`) are allowed only for `omg factory enqueue`, each as one exact
  shape. Nothing closes, deletes or unlinks; `omg factory run`,
  `omg factory check` and `omg ship` still refuse them.
- The factory listener and the SessionEnd chain reject issue numbers that
  are not positive integers.

## Added

- `omg factory enqueue --spec <id> --file <tickets.json>` on GitHub and
  Azure DevOps: launch's signed tickets become children of the spec, with
  dependency edges, an idempotent re-run and neutralized model text.
- `omg factory check --parent <spec>` and
  `omg factory run --next [--parent <spec>]`: check a spec's children and run
  the first runnable one.
- Outcome comments on each item and rollup lines on its spec when a factory
  run parks at merge or ends.
- `omg factory init --check` and `--migrate` for old route tables.
- `omg factory board`: a read-only board of intake items and factory runs on
  GitHub and Azure DevOps.
- Azure Pipelines CI history for heal (groundwork, via
  `factory.heal.pipeline`).

## Changed

- Factory intake goes to harbor; launch delivers through `omg factory` on
  GitHub (`--team` keeps Team delivery).
- `omg factory run` parks at `blocked-by` until dependencies are satisfied;
  a merged factory PR into the base counts as satisfied.
- Two-axis factory review (spec and `docs/standards/`) when the base has
  `docs/standards/`.
- `omg factory status` is now `omg factory chain status` (the old name stays
  as an alias).
- The maintainer Azure DevOps acceptance script walks the shipyard–factory
  flow.
- The README has a skills guide for the current skill set, with colored
  category badges; the stars chart is gone.

## Fixed

- CI failures no longer start a session for the nonexistent `diagnose`
  skill; `omg factory init --no-narrow` refuses.
- The SessionEnd chain refuses routes to captain skills (`launch`,
  `ask-navigator`, `loft`, `drydock`), retired skills and unknown skills.
- `omg ralph from-map` reads the navigator's `Type:` lines.

This release was published without the live Copilot smoke (quota exhausted).
The Azure DevOps parts are fixture-tested and have not been run against a
live org. `omg factory heal scan` on Azure DevOps is still refused (in
progress), and `omg factory poll` and `factory.intake.autoStart` are not in
this release. Details are in `CHANGELOG.md`.
