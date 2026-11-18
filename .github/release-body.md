# oh-my-copilot v5.29.2

Adds Microsoft's MAI Code 2 models to the Copilot tiers, makes tier aliases pick a model your Copilot plan actually offers, and handles the new Copilot CLI / SDK protocol mismatch. See CHANGELOG.md.

Install with `npm install -g oh-my-copilot@5.29.2`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## Model tiers

Each tier is a fallback list; Copilot uses the first model your plan offers.

| Tier | Models |
|---|---|
| fable | `claude-fable-5.2`, `gpt-6.2-astra` |
| opus | `claude-opus-5.5`, `gpt-6.1-sol`, `claude-sonnet-5.5`, `mai-code-2` |
| sonnet | `mai-code-2`, `claude-sonnet-5.5`, `mai-code-2-flash` |
| haiku | `mai-code-2-flash`, `claude-haiku-5.5`, `gpt-6-luna` |

- **Sonnet-tier agents (executor, debugger, test-engineer and others) now default to MAI Code 2**, and haiku-tier agents (explore, writer) to MAI Code 2 Flash, for their cost. Set `agents.<name>.model` to go back to a Claude model for any agent.
- **Tier aliases follow your plan.** `agents.<name>.model: "opus"` and team workers resolve to the first tier model your plan offers (read once from Copilot's model list, cached for 24 h, no prompt sent). When the plan has none (for example `fable` on Copilot Pro), the agent or worker uses the session model and omg prints a warning; a stale override omg wrote earlier is removed.
- `claude-fable-5.2` and `gpt-6.2-astra` are listed by their expected ids, which could not be confirmed on a plan without them.

## Fixed

- **Copilot CLI 1.0.113 and newer speak SDK protocol 4; the latest `@github/copilot-sdk` (1.0.34) speaks only 3.** Every SDK feature (SDK teams, `copilot_run`, smoke tier 2, the factory sandbox) now fails with a clear message naming both versions and the fix instead of a raw protocol error, and `omg team --transport auto` checks first and falls back to tmux panes. Until a protocol-4 SDK ships, use `@github/copilot` 1.0.112 or pane transport.

## Caveats

- **MAI Code 2 is not tuned for very long-horizon agentic work** (Microsoft's model card). A factory benchmark comparison follows this release; switching the sonnet tier back is a one-line change.
- **Test evidence:** this release was published with CI on the release commit, not the maintainer's local full test suite.
