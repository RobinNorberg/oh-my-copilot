# oh-my-copilot v5.30.0

Faster, cheaper factory lanes on Windows, and a lane model setting. See CHANGELOG.md.

Install with `npm install -g oh-my-copilot@5.30.0`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## Factory benchmark

The 12-issue live factory bench on `mai-code-2`, against the v5.27.0 baseline on `claude-sonnet-5.5`:

| | v5.27.0 baseline | v5.30.0 |
|---|---|---|
| Pass | 11/12 | 12/12 |
| Wall time | 1334 s | 1333 s |
| Premium requests | 21 | 18 |
| AI credits | 95.1 | 22.3 |
| Hook time on the lanes' critical path | 311 s | 77 s |

## Added

- **`factory.run.laneModel` / `omg factory run --model <id>`** starts every lane on that Copilot model; `omg factory bench run --model` checks it against your plan first.
- **Lanes run and register only the hooks they need.** A lane session loads a generated plugin mirror that registers only PreToolUse (`pre-tool-enforcer`, `git-guardrails`) and PermissionRequest, so the Copilot CLI no longer starts a process for every other hook event. Other sessions are unchanged.

## Fixed

- **Lanes can run the tests in the Windows OS sandbox.** Write lanes get a real copy of your node_modules (one per work item, moved between lanes of the same item) made before the lane starts, and sandboxed lanes are told there is no network and not to install packages.
- **Copilot's glob and grep tools work in sandboxed lanes** (the bundled ripgrep is granted read-only).
- **A lane that declines on purpose** (`DECLINED: <reason>`) parks at once instead of being retried.
- **An issue whose text holds a key or token parks at intake**, before any lane or premium request.
- The implement prompt names only the guide files the repository has.

## Caveats

- **Test evidence:** published with CI on the release commit, not the maintainer's local full test suite. The live Tier 2 smoke runs in the tag's CI.
- The `git-guardrails` deny inside a lane is covered by tests and the CLI's hook discovery; no guarded git command ran during the live bench.
