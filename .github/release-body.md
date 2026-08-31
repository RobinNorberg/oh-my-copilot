# oh-my-copilot v5.0.0

The fork's own major release: oh-my-copilot has been rebased from v4.13.102 onto
upstream oh-my-claudecode v5.0.2 and hardened to run on both Windows and Unix.

Install the release globally with `npm install -g oh-my-copilot@5.0.0`.

## Highlights

- **Upstream v5 surface adopted**: the canonical Tier-0 workflows
  (`plan` → `execute` → `review` → `verify`), with the legacy skill names
  (`ultrawork`, `ultraqa`, `ultrapilot`, `swarm`, `pipeline`, and others)
  retired outright — see the migration guide for replacements.
- **New directory conventions**: runtime state lives under `.omg/`
  (previously `.omc/`), the host CLI surface under `.copilot/` and
  `~/.copilot`, and the project config at `.copilot/omg.jsonc`.
  Existing checkouts move state manually: `mv .omc .omg`.
- **Cross-platform hardening**: portable file locking on Windows and macOS,
  a Node-based setup/uninstall lifecycle with no bash or jq requirement,
  a platform-neutral hook manifest that survives marketplace updates,
  portable skill commands, NTFS-safe file-identity encoding, and fixes for
  Windows permission enforcement and team-bridge startup.
- **Security fixes**: Windows deny-list enforcement that previously failed
  open, home-containment checks that rejected every Windows path, and
  removal of current-directory binary resolution that could execute a
  repo-planted executable.

## Upgrading

Read `docs/MIGRATION.md` for the v4.13.102 → v5.0.0 upgrade guide, including
the directory moves and the retired-skill replacement table.
