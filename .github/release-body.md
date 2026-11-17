# oh-my-copilot v5.29.1

A packaging release: the published package no longer declares the two optional SDKs as peers, and `tsx` is a dev dependency. Socket.dev scores declared peers as dependencies, so this clears the SDK, `koffi` and `esbuild` alerts from the package's dependency list. See CHANGELOG.md.

Install with `npm install -g oh-my-copilot@5.29.1`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## Changed

- **`@anthropic-ai/claude-agent-sdk` and `@github/copilot-sdk` are no longer declared.** Both are still loaded on demand when you use the features that need them, and each "not installed" message names the install command:
  - Copilot SDK (SDK teams, `copilot_run`, smoke tier 2, factory sandbox): `npm i -g @github/copilot-sdk --omit=optional --ignore-scripts`. `--transport auto` still falls back to panes without it.
  - Claude Agent SDK (only `omg graph` agent nodes): install it next to oh-my-copilot.
- **`tsx` is a dev dependency.** The statechart skill strips TypeScript with Node itself (`--experimental-strip-types` on Node 22.13–22.17 and 23.4–23.5, natively on newer versions). A copy run from inside `node_modules` needs Bun, Deno or `tsx` on PATH; the copies `omg setup` and the plugin install use are not affected.
- The published package now has 8 runtime dependencies (106 production packages in the lock, down from 137).

## Caveats

- **Test evidence:** this release was published with CI on the release commit, not the maintainer's local full test suite.
