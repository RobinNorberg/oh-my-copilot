# oh-my-copilot v5.19.2

A security release for team workers on Windows. Every published version up
to and including v5.19.1 is affected. Linux and macOS are not.

Install with `npm install -g oh-my-copilot@5.19.2`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Security

- On Windows, a repository containing a planted `node.cmd` (or `node.exe`,
  `node.com`, `node.bat`) could run code as the user when `omg team` launched
  an npm-installed provider (`codex.cmd`, `copilot.cmd`, `claude.cmd`; pnpm
  and yarn shims too). npm's shim runs a bare `node`, and cmd.exe searched the
  worker's folder before PATH. A provider started as an `.exe` could likewise
  pick up a planted `git.exe` from the repo when it ran `git`.
- Every Windows provider launch now sets `NoDefaultCurrentDirectoryInExePath=1`
  (a provider cannot clear it), and the supervisor refuses any provider path
  that is not an existing, fully qualified path.

## Behaviour change

Under worker providers on Windows, a bare repository-local command such as
`gradlew`, `mvnw` or `build.bat` no longer resolves from cmd or a Node spawn;
use `.\gradlew`. PowerShell is unaffected.

This release was published without the live Copilot smoke (quota exhausted).
