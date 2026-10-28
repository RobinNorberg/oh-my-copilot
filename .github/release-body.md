# oh-my-copilot v5.17.1

The first published release of the 5.17 line, from v5.16.0. v5.17.0 was
tagged but never published: its tag run failed the release boundary while
building the package archive, so nothing reached npm or GitHub Releases. All
of the 5.17.0 features below ship in 5.17.1, together with that fix.

Four themes: self-driving release gates and `omg port drive`; `omg factory
run` up to the human merge gate; sandboxed factory lanes; and self-healing
CI. Merge stays a human step everywhere: there is no auto-merge, and the
factory engine refuses `gh pr merge`.

Install with `npm install -g oh-my-copilot@5.17.1`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Added

- `--drive` / `--detach` for `omg release` and `omg ship gates`: the run
  continues through CI waits and transient GitHub errors until done, a real
  failure or a human decision (`--drive-max`, default 6 h). Drive never
  implies `--yes`.
- Smoke reuse by input hash in `omg release`, and isolated flake triage for
  new suite failures (three solo reruns; candidates written for the owner,
  the known-flaky list is never written).
- `omg port drive`: apply an upstream head, run the gates, commit and open a
  draft PR, with human gates for package deltas, risky conflicts, leaks and
  leftover markers. An optional reconcile lane is tamper-checked.
- `omg factory run` (experimental) now runs prepare, the CI gates and parks at
  `awaiting-human: merge`, with `conflict-fix` and `ci-fix` lanes and
  `omg factory run clean`.
- `omg factory heal` (experimental): `scan` classifies red `dev` runs without
  an LLM; `run` diagnoses one in a read-only debugger lane; `approve` starts a
  `ci-heal` run that ends at the human merge gate.
- Opt-in Tier 2 smoke scenarios `factory-run`, `factory-run-fix` and
  `sandbox-lane`, and the free `sdk.sandbox` static check.

## Changed

- Release and ship gates only count runs for the current PR head, `eslint src`
  is a release gate, and `gh pr merge` retries transient GitHub errors.
- Factory write lanes refuse to run without the Copilot OS sandbox
  (`awaiting-human: sandbox-unavailable`) unless the user config sets
  `factory.run.sandbox.writeUnsandboxed: "detect-only"`. Review lanes without
  a confirmed sandbox get no shell.
- The engine commits a write lane's changes with hardened git, and refuses
  lane changes to agent instructions, hooks, skills and CI.

## Fixed

- The package archive passes the release boundary: the heal evidence module
  is renamed to `heal-evidence`, and a new suite test runs the boundary's
  archive-path rule over every packaged file, so a forbidden name fails
  before tagging (#318).

## Security

- The engine refuses to commit links that leave the lane worktree (directory
  junctions on Windows, new symlinks) and strips skip-CI markers and trailers
  from lane commit messages.
- CI logs are treated as untrusted in `omg factory heal`: capped, redacted and
  fenced, with a token-free lane environment and a sealed diagnosis.

Upgrade notes are in `docs/MIGRATION.md`. Fork deviations (kept and dropped)
are listed in `CHANGELOG.md`.
