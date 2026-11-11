# oh-my-copilot v5.25.1

This patch fixes what the first live test of the software factory found. The test ran against a real GitHub repository and real Copilot sessions. The main fix: the sandboxed prepare checks failed on ordinary Vite and vitest projects in 5.24.0 and 5.25.0.

Install with `npm install -g oh-my-copilot@5.25.1`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## Fixed

- **Sandboxed gates work on Vite and vitest projects** (#490). vitest passed its tests and then failed, because it writes a cache under `node_modules`, which was read-only in the gate sandbox. The gate checkout now gets its own `node_modules` folder for each run: your packages are linked read-only, and the tool cache folders (`.cache`, `.vite`, `.vite-temp`, `.vitest`, `.tmp`) are fresh and writable. The base calibration uses the same kind of folder, so a failure that only happens in the sandbox parks at `gate-sandbox-incompatible` and no longer counts as a failed check.
- **Lanes no longer commit oh-my-copilot's own runtime files.** Untracked files under `.omg/` (except `.omg/skills/`) are never added to a lane commit. Lanes no longer write project memory into their worktree. In the live test such a file, which contained a local path, was committed to a PR branch.
- **`omg factory setup` on GitHub detects the default branch.** A repository with only `main` is no longer assumed to have `dev`.
- **A failed check shows its output.** `omg factory run status <n>` and the board show the end of the failing check's output. The issue comment names the failing checks and points to that command.
- **Open human review threads are named** when a run that is parked before the merge step is resumed.
- Clearer messages for `factory check` without `node_modules`, for `run clean` after a cancel, and at the end of `setup`.

## Security

- **Output from a PR's own code is never posted to the forge.** The output of a failing check, test names, the output of a sandboxed `npm ci` and the target of a changed `node_modules` link stay in the local run state. Before this fix a draft of the first item would have put test output into issue comments; that never shipped.
- A changed `node_modules` link in the gate checkout parks the run. The sandbox is only ever given your real `node_modules`, read-only.

## Caveats

- **The fix was proven on a scratch Vite and vitest project** with sandbox sessions that have no model turn. A full factory run to the merge step on a real repository has not been repeated with this version.
- **Monorepos with nested `node_modules` and workspace links are unchanged.** A gate there may still fail in the sandbox. It parks at `gate-sandbox-incompatible` with the folder named.
- **A human review comment made while a run is parked at prepare is named, not acted on.** The fix round for it starts at the merge step, as before.
- **The ci-fix lane still receives the failing output** in its prompt, and its commits are pushed. That path existed before this release.
- Sandbox sessions without a model turn were not billed in the live test.
- Parallel runs and `--allow-unsandboxed-gates` were not exercised live. All caveats of 5.24.0 and 5.25.0 still apply.
- **Test evidence:** this release was published with CI on the release commit, not the maintainer's local full test suite.
