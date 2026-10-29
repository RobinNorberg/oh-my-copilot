# oh-my-copilot v5.18.0

A minor release from v5.17.1 with three themes: the factory works on Azure
DevOps as well as GitHub, factory lanes run in a tighter sandbox, and two
flaky tests are fixed, one of them a real crash-resume bug.

The Azure DevOps adapter is tested only against documented sample responses,
not yet against a live organization, and the factory is still experimental.
Merge stays a human step everywhere: there is no auto-merge, and the factory
engine refuses `gh pr merge`.

Install with `npm install -g oh-my-copilot@5.18.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Added

- Factory forges: GitHub and Azure DevOps behind one forge interface, and
  `omg factory run` on Azure DevOps through a guarded `az devops invoke`
  adapter.
- `omg factory setup` wizard for forge, intake and progress settings, and
  `omg factory check` to see which issues are runnable, need a plan or are
  blocked.
- Opt-in progress sync: the run's stage is written to a `factory:<stage>`
  label on GitHub or to the board column and state on Azure DevOps.

## Changed

- Windows factory lanes can start `node` and `git` through read-only tool
  grants, and lanes write only their private home and temp directories.
- The Azure DevOps skills use real `az devops invoke` routes instead of
  commands that do not exist.

## Fixed

- Windows lanes launched no process until `LOCALAPPDATA` reached the sandbox
  env (#321).
- A SIGKILLed atomic writer left a rollback link that made graph runs refuse
  to resume (#338). Team launch-ack and nudge test races are fixed (#339).

## Security

- Azure and Git credentials are kept out of lanes, the SDK policy checks
  every path field (`..`, hard links), `events.jsonl` cannot be forged from a
  lane, and hook debug logs do not follow links.

Upgrade notes are in `docs/MIGRATION.md`. Known limitations and fork
deviations are listed in `CHANGELOG.md`.
