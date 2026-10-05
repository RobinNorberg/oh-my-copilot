# oh-my-copilot v5.6.2

A patch release that brings the fork to parity with upstream oh-my-claudecode
`dev` through 486b85bbb (4280efb1f..486b85bbb). Upstream is still at version
5.6.1; the fork bumps its own patch version. There are **no breaking
changes** and nothing to migrate.

Install with `npm install -g oh-my-copilot@5.6.2`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## What's in

- **contained-fs builds on install (#4217).** A `postinstall` hook builds the
  contained-fs native addon on macOS when it is missing and the toolchain is
  available.
- **Safer `team shutdown` (#4218).** Stale reservations left by dead
  processes are removed before shutdown and before a new team starts, a
  missing team reports `No team state found for <name>`, and shutdown errors
  print a message and exit 1.
- **Faster git-guardrails hook (#4221).** The destructive-git PreToolUse hook
  runs in a worker thread instead of a second Node process, and only reads
  mode state when the command is destructive.

## Behaviour change

- `npm install` now runs `scripts/postinstall-contained-fs.mjs`. On macOS it
  tries to build `native/contained-fs-darwin-<arch>.node` if none is present;
  when Node headers or Xcode Command Line Tools are missing it prints a
  warning with the manual `node scripts/build-contained-fs.mjs` command.
  On Linux, Windows and source checkouts it does nothing. It **never fails
  the install**: it always exits 0.

See [`CHANGELOG.md`](CHANGELOG.md) for details.

## Requirements

- GitHub Copilot CLI 1.0.88 or later (1.0.91 verified for stdin prompts);
  Claude Code remains supported.
- `node` on PATH, as in v5.6.1.
- Factory and intake: the host binary on PATH and `gh` authenticated for the
  repository.

## Upstream credits

Ported work originates from
[Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
`dev` 4280efb1f..486b85bbb (#4217, #4218, #4221); see `CHANGELOG.md` for the
breakdown.
