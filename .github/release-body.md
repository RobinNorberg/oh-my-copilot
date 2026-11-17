# oh-my-copilot v5.29.0

This release cuts the package's supply-chain surface (Socket.dev flagged 5.27.0 at 58/100 on supply chain) and brings in 14 upstream fixes. See CHANGELOG.md for every change.

Install with `npm install -g oh-my-copilot@5.29.0`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## Breaking

- **Node 22.13+ is required (23.4+ on the 23 line); Node 20 is no longer supported.** State locking and the job database now use Node's built-in `node:sqlite` instead of the native `better-sqlite3` addon. Existing database files open as before.

## Smaller, safer install

- **No Claude Agent SDK dependency.** It bundled a whole Claude Code CLI and the sharp native binaries. It is now an optional peer that only `omg graph` agent nodes load, with an install hint when it is missing. 22 fewer packages are installed.
- **No npm install script.** On macOS the optional contained-fs addon is built on request (`node scripts/build-contained-fs.mjs` from the installed package); `omg graph` and `omg team` name that command when it is missing.
- **No native SQLite addon,** so no deprecated `prebuild-install` or `tar-fs` either.
- **zod 4.6.7** fixes CVE-2023-54404 (memory exhaustion). MCP tool schemas are unchanged; zod's validation messages are worded differently.
- The unused `vscode-languageserver-protocol` dependency is removed, and the default MCP servers pin `exa-mcp-server` and `@playwright/mcp`.

## Security fixes

- Hook scripts no longer use an unchecked session id in file paths; a crafted id could read, write or delete files outside `.omg/state/sessions/`.
- `omg intake schedule` validates `--cron` and quotes `--cwd`, so neither can inject crontab lines or shell text.

## From upstream

- Upstream oh-my-claudecode dev through f11ded4c0: exited team workers are no longer nudged, tmux `-u` for non-UTF-8 locales, torn event logs are kept, `ast_grep_replace` fixes, notepad and session-end fixes.

## Caveats

- **macOS:** after installing, build the contained-fs addon once if you use `omg graph` or tmux teams.
- **Test evidence:** this release was published with CI on the release commit, not the maintainer's local full test suite.
