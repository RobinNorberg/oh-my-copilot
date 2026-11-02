# oh-my-copilot v5.19.3

A security release for Windows, plus a skill-name fix for Copilot CLI. Every
published version up to and including v5.19.2 is affected by the Windows
fixes. Linux and macOS are not.

Install with `npm install -g oh-my-copilot@5.19.3`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Security

- On Windows, `/omc-setup` ran `npm`, `omg`, `bd`, `br` and `gh` through
  cmd.exe with the project as the current folder, so a repository could plant
  `npm.cmd` (or the others) and have it run as the user. Setup now runs those
  commands from the home folder with `NoDefaultCurrentDirectoryInExePath=1`.
- On Windows, a bare `git`, `gh`, `node` or `npm` spawned by oh-my-copilot
  could resolve to a `git.exe` or `git.cmd` planted in the project folder or a
  lane worktree. The `omg` launcher, the Copilot hook dispatcher, the
  omc-setup scripts, the `omg factory` / `omg ship` / `omg port` runner, the
  `copilot_run` host and the psmux/cmd.exe worker fallback now set
  `NoDefaultCurrentDirectoryInExePath=1`.
- **Node 20:** the variable does not protect no-shell spawns before Node 22.
  On Node 20 only the factory/ship/port runner and the team host git are
  protected (they resolve a bare name from absolute `PATH` entries only).
  Use Node 22 or later on Windows.

## Behaviour change

On Windows, a bare repository-local `.cmd`/`.bat` such as `gradlew`, `mvnw` or
`build.bat`, run through cmd under oh-my-copilot (a factory lane gate, a
`ralph` feedback command, a team worker), must now be called as `.\gradlew`.
PowerShell and Git Bash are unaffected.

## Skill names on Copilot CLI

Copilot CLI 1.0.66 and later registers plugin skills by their bare name and
rejects `/oh-my-copilot:<name>`. Docs, prompts and the messages oh-my-copilot
writes now use `/omc-setup`, `/ralph` and so on on Copilot CLI, and
`/oh-my-copilot:<name>` on Claude Code. Unattended factory paths (factory
listener, `omg intake`, chain links) check the name with
`copilot skill list --json` and refuse a skill that another skill shadows or
that cannot be verified.

## Also in this release

- omc-setup checks run through `scripts/setup-config.mjs` instead of inline
  `node -e`, so setup works on hosts that refuse inline interpreter code.
- `docs/FIELD-TESTING.md`: a guide for testing the published package with a
  remote Copilot CLI agent, with a `Field report` issue form.
- CI builds once and caches `node_modules`; a `CI Gate` job sums up the
  blocking checks.

This release was published without the live Copilot smoke (quota exhausted).
