# oh-my-copilot v5.12.2

A patch release from v5.12.1: Windows provider-launch hardening, race fixes,
and a clean Windows test suite.

Install with `npm install -g oh-my-copilot@5.12.2`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Security

- Windows: hardened native .cmd/.bat provider launch (argument quoting and
  supervisor launch path); upgrading is recommended for Windows users with
  npm-installed providers.

## Fixed

- Race fixes (#268-#276): SessionEnd lease and job updates no longer mistake
  revision drift for a lost lease, a released worker's reserved action claim
  is undone, the state lock retries an early `SQLITE_BUSY` instead of reading
  unlocked, the Windows supervisor stdin EPIPE is handled, and
  `getProjectIdentifier` caches its git probes per process with signature
  validation.
- The rules and directory-context injectors now inject for `apply_patch`
  edits (GPT-family models).
- Windows: atomic and team writes retry transient rename errors, atomic-write
  rollback no longer fails silently, `omg ask claude` passes prompts over
  stdin, and autoresearch tolerates `core.autocrlf`.

## Added

- `omg release <X.Y.Z>`: a resumable, gated release pipeline for maintainers.
- `omg progress emit|watch|status`: agent progress events with stall detection.
- `omg smoke copilot --tier 2 --scenario filetools`: an opt-in live check of
  file-tool hooks on Copilot.

## Tests

- The Windows test suite went from 810 failures to a clean full run: shared
  platform helpers, POSIX-only gates, load-tolerant timing and root-cause
  fixes for four full-suite flakes.

Fork deviations (kept and dropped) are listed in `CHANGELOG.md`.
