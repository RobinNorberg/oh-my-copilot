# oh-my-copilot v5.28.0

This release makes the software factory run end to end on Windows and hardens it from a night of live runs on its own backlog (five issues, all merged). See CHANGELOG.md for every change.

Install with `npm install -g oh-my-copilot@5.28.0`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## Factory

- **`ship.prepare.build`:** prepare can rebuild committed build output (for example `dist/` and `bridge/`) in the gate sandbox and commit only the declared output directories.
- **Windows:** checks that need git clone, fetch or push fall back to the gate container, then to a plain run that is never auto-merged (`factory.run.sandbox.windowsGitTransport: "strict"` keeps the old park). esbuild builds no longer park: the gate copies `node_modules` packages when the sandbox cannot open the junctions.
- **Per-test verdict against the base:** tests that fail on the base too are listed and not counted, so a few sandbox-only failures no longer park every run. Such a head never auto-merges.
- **Stalled lanes end on their own** after `factory.run.laneIdleMinutes` (default 15) without an event, and get a fresh retry.
- **A PR that conflicts with its moved base goes back to prepare** instead of waiting for CI that never runs.
- **A run whose PR a human merged is recorded as merged**, after a clean tamper check, instead of resuming lanes.
- **Bench regression gate:** `omg factory bench compare --fail-on-regression` and `omg release --bench`; the committed baseline is a live 5.27.0 run (11 of 12 issues passed, 21 premium requests).

## Fixed

- Check names, CI definition file names and release CI failing-test lines are made safe before they reach park reasons, merge reasons and forge comments.
- A malformed `factory.run.sandbox` block in the user config is refused instead of ignored.
- Plugin hooks keep working in a config folder shared with WSL or macOS.

## Caveats

- **Windows sandbox gap:** a check that runs without the sandbox shares your host with the PR's code; such runs warn, leave a PR note and never auto-merge. See "Known gap: git transport in the Windows sandbox" in docs/REFERENCE.md.
- **Test evidence:** this release was published with CI on the release commit, not the maintainer's local full test suite.
