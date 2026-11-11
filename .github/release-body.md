# oh-my-copilot v5.24.0

This is a security-hardening release for the software factory. An audit found ways for a lane, or for a PR's code, to reach your machine through the gate, git and the lane commit; this release closes them as far as the platforms allow, and the limits are listed under Caveats. It also fixes the issues found in dogfood round 3 and stops OpenClaw session-end work when OpenClaw is disabled.

Install with `npm install -g oh-my-copilot@5.24.0`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## New (opt-in)

- **A private git repository per run** (#481, #483). With `factory.run.layout: "private"` (user config or the base-committed `omg.jsonc` on a trusted base; default `"shared"`, unchanged) lanes, prepare and gates work in an engine-owned clone outside your checkout, under `%LOCALAPPDATA%\omg\fw` or `factory.run.workDir`. Results enter your repository only as one verified commit per import, checked against the protected paths, and are then pushed as before. Cost: one seed per repository plus a full clone per run. Not supported in this layout yet: the Copilot coding agent as implementer (the run parks with a message) and parallel runs in one checkout. It has never run against a live Copilot session, and "lanes never touch your repository" holds only with the enforced sandbox; steps that ran without it are compared against a full snapshot of your repository.

## Security

- Prepare checks and the local gate now run the PR's code inside the Copilot OS sandbox: writes only in the checkout and job temp, git dir and `node_modules` read-only, no network by default, no tokens in the environment (#474). Key `factory.run.sandbox.gates` is `"enforced"` (default), `"ack"` or `"unsandboxed"` (user config only). New parks: `gates-unsandboxed`, `gate-no-verdict`, `gate-sandbox-incompatible`. New flag `--allow-unsandboxed-gates` accepts one head. Gates that run without the sandbox get an allowlisted environment.
- Git hardening from the audit (#476): `refs/replace/*` and `info/grafts` are refused, the local-forge mirror is checked and pinned on every push, fetch and `ls-remote`, the base is sealed, and the prepare checkout is compared with the pushed head before the gate.
- Lane commits (#484): the engine reads the changed files itself and stages their bytes, so git never reads the lane worktree. The lane's process tree must be proven gone first. A secret-shape scan parks `secret-shaped-content` (override with `--allow-secret-shapes` or `factory.run.secretScan.allowPaths`). Redaction patterns now include JWTs, `sk-` keys and `.npmrc` tokens (#482).
- Tamper quarantine (#484): if hooks or program-affecting git config change during a run, the engine puts them back, saves what it replaced in a quarantine folder with an undo command (`undo.txt`), and holds new runs until you run `omg factory run release --tamper`.

## Factory fixes

- The gate re-runs on resume after `ci-fix-failed` instead of starting more ci-fix lanes (#478).
- `run reset` and `run clean --discard` discard a cancelled run's worktrees safely; `--lane-stopped` confirms a lane is gone (#478).
- Local-forge claims are shared between clones of one repository; shallow clones get their own key (#478).
- Board, poll and triage on the local forge: the stale "no open trusted threads" line and the priority label that contradicted frontmatter are fixed, as are several message errors (#478).
- Session end no longer creates `openclaw` actions or folders when OpenClaw is disabled (#480, issue #479).
- Large PRs are split across several sandboxed calls, too-long file names fail with a clear reason, and `git worktree prune` is never run (#482).

## Upgrade notes

- A run that was mid-flight on 5.23.0 continues. Its old prepare checkout is discarded and prepared again; no lane runs again. Do not remove it with `git worktree remove`.
- The repository now has a committed `.copilot/omg.jsonc` for its own test fixtures. It is not in the npm package.
- Gates that need the network or write outside the checkout fail in the sandbox and park at `gate-sandbox-incompatible`, with advice.
- Dogfood round 3 issues listed as open in the 5.23.0 notes are fixed: the gate re-run after a ci-fix park, reset and clean after a mid-lane cancel, the stale board and poll line, and the triage label.

## Caveats

- **Known gap: the Copilot sandbox on Windows cannot deny paths.** Gate and lane code can read files under your user profile, including credential stores. What is isolated: no network by default, no tokens in the environment, git dir and `node_modules` read-only, writes confined to the checkout and job temp. Output redaction is pattern-based and only reduces exposure. Strict mode is opt-in: `factory.run.sandbox.requireDeniedPaths` parks such a host at `gates-unsandboxed`.
- **The sandboxed gate path has never run against a live Copilot session.** Open live checks: how the runtime passes the command, output caps, exit code semantics for a killed shell, pwsh 7, very large PRs, and Linux bwrap and macOS.
- **Process-tree proof and staging have residuals.** Processes started outside the lane's tree (for example through WMI or Task Scheduler) are not found. An "unproven" listing only warns on ordinary runs. A folder swapped away and back between two checks can pass. The secret scan has gaps.
- **Tamper quarantine also puts back your own changes.** If you change hooks or program-affecting git config during a run, it is restored and your version is saved with an undo command. `git push -u <existing remote> <branch>` is not treated as tamper.
- **Azure DevOps paths are tested against fixtures only.** The Copilot coding agent lane has never run live.
- **Test evidence:** this release was published with CI on the release commit, not the maintainer's local full test suite.
