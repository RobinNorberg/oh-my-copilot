# oh-my-copilot v5.31.0

The factory now runs end to end on Linux (WSL Ubuntu): 17/17 on bench fixture v3, with the same pass rate and premium requests as the Windows run of that fixture. See CHANGELOG.md.

Install with `npm install -g oh-my-copilot@5.31.0`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## Factory benchmark

The 17-issue live factory bench on `mai-code-2`. The v3 runs and the v4 run are different fixtures (v4 redesigned #13 and #17), so their numbers are not comparable to each other. The Windows and Linux v3 runs used different hosts and different builds, so they are not a controlled comparison either.

| | Windows bench-11, fixture v3 (v5.30.0 + M1/M2, 2026-11-20) | Linux, WSL Ubuntu, fixture v3 (dev, 2026-11-22) | Windows, fixture v4 (dev, 2026-11-22) |
|---|---|---|---|
| Pass | 17/17 | 17/17 | 17/17 |
| Premium requests | 28 | 28 | 33 |
| AI credits | 35.59 | 29.81 | 38.49 |
| Wall time (sum over issues) | 1700 s | 825 s | 2237 s |

In the Windows v4 run, #13 took the ci-fix lane and #15 the conflict-fix lane live. #17 was solved without tripping the lane git guard, which the bench records as a finding: the guard is still not exercised live. This v4 run is the new committed bench baseline that `omg release --bench` compares against.

## Added

- **Linux support for the factory.** Lanes and gates get a read-only linked `node_modules`, so the repository's tests run in the OS sandbox. Hosts without a keyring authenticate with the stored Copilot login, for lanes, gate commands, team workers and model reads.
- **`omg factory check --host`** checks node, git, the OS sandbox, the Copilot binary, the SDK and its protocol handshake, and the login in one pass, with a fix command for each failure. docs/REFERENCE.md gains a "Linux setup" section for Ubuntu 20.04, 22.04 and 24.04.
- **Up-front refusals** for git older than 2.38 and bubblewrap older than 0.5.0, instead of a later, unclear failure. The bubblewrap check is skipped when the lane sandbox is off (`factory.run.sandbox.enabled: false`, `writeUnsandboxed: "detect-only"` or `OMG_SANDBOX=off`).
- **A model per lane kind.** `factory.run.laneModels` and `--review-model <id>` let review lanes run a cheaper model than implement lanes.
- **Faster lanes.** The PreToolUse enforcer runs only its guards in a lane, with the state root resolved once. A lane's `node_modules` copy no longer blocks the engine's event loop. The implement prompt lists up to 8 files the lane likely needs, found by a free pre-scan.
- **Bench fixture v4.** The ci-fix issue (#13) and the git-guard issue (#17) now exercise their paths, a merged run that skipped its path is reported as a bench finding, `bench compare` reads results across fixture versions, and `bench init --force` clears engine state left by an earlier fixture at the same path.

## Fixed

- **Gates fail with `tsc: not found` on Linux** when the repository's `node_modules` is a symlink.
- **`omg ralph verify`** kills the whole process tree when a feedback command times out. On POSIX, feedback commands now run without a controlling terminal: a command that opens `/dev/tty` gets ENXIO. On Windows, the process tree is not killed when the 30 s grace period runs out or `taskkill` fails.
- **A lane asked to use a file outside its worktree** declines instead of being retried.
- **A rerun parked at the merge** prepares again when its PR conflicts with the moved base.
- Windows-only test failures in the teleport, ralph-afk and ralph-closeout tests, and two CI-flaky tests.
- **A `node_modules` link planted by a lane is no longer granted** read-only to the next session. Nothing under `node_modules` is granted without a target the engine recorded.
- **Behaviour change:** a plain `copilot_run` write job outside the factory no longer gets a linked `node_modules` read-only in the sandbox. Jobs that relied on it must install or copy their dependencies another way.

## Caveats

- The lane git guard's deny is covered by tests and the scripted bench lanes; no guarded git command ran in a live bench (#17 in the v4 run was solved without one).
