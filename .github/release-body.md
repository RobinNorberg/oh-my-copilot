# oh-my-copilot v5.26.0

This release adds six things to the software factory, and fixes what we found when we ran the factory on oh-my-copilot's own backlog. Three of its pull requests were merged into this release.

Install with `npm install -g oh-my-copilot@5.26.0`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## New

- **`omg factory bench`.** A benchmark for the factory on the local forge: 12 seeded issues with hidden acceptance tests, 4 of them traps (edit a CI file, commit a secret, read outside the repository, widen the committed config). `--fake` costs nothing and runs in CI. `--live` needs `--max-requests`, checks your default model, and refuses unless your gates are sandboxed. `compare` diffs two results. First live baseline: both graded tasks reached the merge step with their hidden tests green at 2 premium requests each, and all 3 traps were contained.
- **`omg factory run --max-requests <n>`.** Stops starting lanes once the run's lanes used n premium requests. The lane in flight finishes, so a run can end a little above n.
- **`omg factory dashboard`.** One self-contained HTML page (or `--json`) of all factory runs from local state: status, parks, time per phase, credits and premium requests per run, role and day, and bench results.
- **Container isolation for gates (opt-in).** `factory.run.sandbox.isolation: "container"` in your user config runs prepare checks, the local gate and the base comparison in Docker or Podman with no credentials, no user profile and no network while repository code runs. Packages download in a separate step without running any scripts. Disk and time limits stop only our own containers. Docker is tested; Podman is not.
- **Opt-in auto-merge by trust tier.** `factory.merge.auto` in your user config, per repository: `docs` (root README/CHANGELOG/CONTRIBUTING and `docs/`), `tests`, `small`. Every check on the head must have succeeded, the factory review must approve that commit, and no human review may be open. Agent prompts, CI files, manifests, lockfiles, install scripts, build output and the factory's own code never auto-merge. The default is unchanged: a human merges.
- **Monorepo gates.** npm, pnpm and yarn workspaces get a per-package gate `node_modules` tree, with the package list read from the base branch.

## Fixed (found by running the factory on its own repository)

- **Lanes failed on larger repositories.** Git output was capped at 1 MiB, so the change check failed on any repository with about 10,000 files. The cap is now 256 MiB, and anything above it still fails closed.
- **Every open run blocked after a merge to dev.** GitHub's recorded base of a pull request goes stale. The engine now reads the base branch's live tip, still requires the fetched base to match it, and reads base CI history from a base whose CI has finished.
- **Checks that need git parked on the base.** The gate's copy of the base branch now gets a small git repository of exactly that commit.
- **Two git reads failed open.** A failed read of untracked files, or of the main checkout's status, is no longer taken as "nothing there".
- **Auto-merge on GitHub** keeps the merge human when dev moved after prepare, and treats any check that did not succeed as blocking, including known-flaky failures.

## Caveats

- **On Windows, Git for Windows cannot clone, fetch or push inside the Copilot sandbox.** Tests that push to a temporary remote fail in prepare and park at `gate-sandbox-incompatible`. Use container isolation, or set `ship.prepare.checks` in your user config.
- **Do not run Claude Code or Copilot in a checkout while the factory works in it.** Tools that write into the folder trip `lane-tampered`. Use a separate clone.
- **Factory lanes do not rebuild committed build output.** In a repository that commits `dist/`, a maintainer rebuilds it before merging.
- **Auto-merge has known limits**, listed in docs/REFERENCE.md: for example a test that mocks the code it tests, or a tool that install scripts call and the engine cannot follow.
- **Azure DevOps** still compares against the target commit it reports, which can lag; a run then refuses until it is rerun.
- **Test evidence:** this release was published with CI on the release commit, not the maintainer's local full test suite.
