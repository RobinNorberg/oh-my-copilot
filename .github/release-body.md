# oh-my-copilot v5.18.1

A security and fix release for headless `omg team` SDK workers, on top of
v5.18.0.

Install with `npm install -g oh-my-copilot@5.18.1`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Security

- SDK team workers start credential-free: the detached host, the worker
  runtime and its shells no longer inherit the leader's tokens, cloud
  credentials, ssh-agent, webhook or database URLs. git runs no credential
  helper, sends no configured extra header and uses no ssh-agent; `gh` and
  `az` see an empty config dir. The Copilot token reaches the session over
  stdin and RPC instead of the environment.
- Workers keep their own Copilot home; the leader's `COPILOT_HOME` and
  `COPILOT_MODEL` no longer override it.
- The worker shell policy also refuses `git credential fill`, `gh auth
  token`, `gh auth git-credential` and `az account get-access-token`.
- Factory lanes and workers drop a wider set of secret-named variables.

Workers are still not sandboxed; this is hygiene against accidental use.

## Fixed

- Team worker starts fail within about 1.5 s when the provider already
  exited, instead of waiting out the 8-30 s ack timeout.

This release was published without the live Copilot smoke (quota exhausted).
Details are in `CHANGELOG.md`.
