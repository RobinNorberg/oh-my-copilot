# oh-my-copilot v5.19.5

A Windows security hardening plus release tooling, CI and test reliability
release. Apart from the Windows hardening there are no user-facing behaviour
changes, so the field agent can upgrade safely.

Install with `npm install -g oh-my-copilot@5.19.5`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Security

- Windows: no omg process runs an executable planted in the project folder
  (port of upstream #4768). Windows looks up a bare command name (`git`,
  `npm`, `gh`) in the current directory before `PATH`, so a `git.cmd` or
  `git.exe` committed to a repository could run in its place. v5.19.3
  covered the `omg` bin, the Copilot hooks, the setup scripts and the
  factory; now every entry point, hook script, MCP server, the team runtime
  and the HUD set `NoDefaultCurrentDirectoryInExePath=1` before anything
  spawns, and allowlisted child environments carry it on.

## Release tooling

- A test file that fails in setup (no failing title) is rerun as the whole
  file and classified real / mixed / load-flaky, instead of failing the suite
  as `passed 0/0 isolated reruns`.
- Heartbeats are no longer dropped during the suite: they are throttled per
  phase, `PR #N gates green; merge waits for the suite` is never throttled,
  and the suite writes `suite running, N min` every 5 min.
- `omg release` refuses to run from a different installed omg version than
  the checkout's own and prints the command to use:
  `node bin/oh-my-copilot.js release ...` (`--dry-run` only warns).
- Triage reruns 3 titles at a time; a title failing a pooled rerun still gets
  the usual serial reruns, so no verdict is easier to get.
- More than 20 new failing titles rerun their files as a whole instead of
  failing the phase, so no full-suite rerun is needed.

## CI and tests

- CI and the release suite start the longest test files first.
- The largest factory test files are split into 24 files (test count and
  titles unchanged); the largest is now 515 s, down from 2,094 s, on the
  5.19.4 durations.
- `omg ship gates` gives the flaky verdict again when a known-flaky shard
  failure also fails `CI Gate`; `omg factory heal` classifies such runs by
  the failed shard.
- 24 load-flaky tests from the v5.19.4 release suites joined the known-flaky
  list.

## Caveats

- On Node 20, libuv ignores `NoDefaultCurrentDirectoryInExePath`, so full
  protection against a planted executable needs Node 22+. The Node 22
  minimum is planned for v5.20.0.
- This release was published without the live Copilot smoke.
