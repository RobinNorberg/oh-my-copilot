# oh-my-copilot v5.25.2

This patch fixes what the second live test of the software factory found. With 5.25.1 a factory run reached the merge step end to end on a real GitHub repository, but only after a manual setting. This release removes the need for it.

Install with `npm install -g oh-my-copilot@5.25.2`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## Fixed

- **The factory's CI gate works on repositories other than oh-my-copilot** (#493). The built-in list of required checks was this project's own 19 CI job names, so on any other repository the gate waited for checks that never exist. With no `ship.requiredChecks` configured, the gate on GitHub now requires the checks your branch protection or rulesets require. When those cannot be read, it requires every check GitHub reports for the commit. All of them must pass, and every check suite of the commit must be finished.
- **A configured check that never reports is named.** The run parks at `missing-checks` with the name and where to change it, and no longer waits 90 minutes in silence.
- **A check with the result "neutral" counts as passed.**
- **The merge park text gives the resume command once.** The comment for a cancelled run no longer repeats the old merge command. The board shows the current review state.
- **After a human review fix round** the park text names the thread, the commit that addressed it, and that resolving or answering it continues the run.
- **Lane prompts name the repository's own format and lint scripts** (from `package.json` on the base branch), so a lane formats its code before it finishes.

## Security

- **"No CI checks are configured" is never said by mistake.** The gate goes green without CI only when the base commit has no checks, neither the base nor the pull request contains a CI definition file, and the commit's check suites were read and are empty. Any failed read keeps the gate waiting.
- **Lanes may not change CI definition files** of other CI systems either (for example `azure-pipelines.yml`, `.gitlab-ci.yml`, `.circleci/`, `Jenkinsfile`). A human must make that change.
- **oh-my-copilot's own 19 required checks are unchanged.** They now live in this repository's committed `.copilot/omg.jsonc`, and `omg ship`, the factory and `omg release` fall back to them for this repository.

## Caveats

- **This version has not been run live.** The second live test ran 5.25.1 with `ship.requiredChecks` set by hand. The new default is tested with fakes.
- **Azure DevOps behaviour changed and is not verified live.** It used to wait on the 19 names and now requires every policy evaluation that is not advisory.
- **A third-party CI app that is slow to start can be missed** when it created no check suite on the base commit and your branch protection does not name its check. Name required checks in branch protection or in `ship.requiredChecks`.
- `omg ship` does not read branch protection. Without configured names it requires every reported check.
- The engine does not answer on an outdated review thread. You resolve it and rerun.
- All caveats of 5.24.0, 5.25.0 and 5.25.1 still apply.
- **Test evidence:** this release was published with CI on the release commit, not the maintainer's local full test suite.
