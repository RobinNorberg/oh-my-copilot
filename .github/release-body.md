# oh-my-copilot v5.1.0

Full upstream parity: this release ports the three oh-my-claudecode releases
published since the v5.0.0 rebase — upstream v5.1.0, v5.2.0, and v5.3.0 —
into the fork, adapted throughout to the `omg` CLI, the `.omg/` runtime root,
the `.copilot/` host surface, and the `/oh-my-copilot:` skill namespace.

Install the release globally with `npm install -g oh-my-copilot@5.1.0`.

## Highlights

- **Five new skills (51 canonical total)** — the complete Shipyard
  governed-delivery methodology: `drydock` (lays the shared repo harness and
  audits drift with `--check`), `launch` (per-feature delivery pipeline with
  fog gate, yard gate, and five human checkpoints), `ask-navigator` (charts
  foggy efforts into decision-ticket maps), `loft` (throwaway artifacts that
  settle design questions before real work), and `minimal-code-discipline`
  (opt-in YAGNI writing-time discipline). Map: `docs/shipyard.md`.
- **Workspace checkpoints**: `omg checkpoint create/list/rollback` shadow
  snapshots for autonomous runs, plus `omg graph run --checkpoint`. The fork
  additionally suppresses CRLF conversion so Windows rollbacks are
  byte-faithful.
- **Remote graph approval gates**: `omg graph run --approval-mode remote`
  with notification dispatch, reply-channel decisions, and
  `omg graph approvals list/decide` (the contained run-dir remains
  Linux-only).
- **Delegation enforcement rewrite**: the pre-tool-use hook gained a real
  shell-command parser (heredocs, here-strings, ANSI-C quoting, fd
  duplication, coprocesses), eliminating false-positive delegation warnings,
  with bounded cross-platform temp/scratchpad path allowances. The template
  now allows the fork's `.omg/` state root alongside legacy `.omc/`.
- **Hook runner Windows stdio overhaul**: protocol writes guarded against
  closed consumers, fail-open tree reaping, EPIPE-safe teardown, and
  runner-aware SessionEnd ceilings.
- **Team model routing hardening**: shared default-model resolution across
  launch and scale-up, a cursor default-model hook
  (`externalModels.defaults.cursorModel`), and a platform-aware POSIX worker
  launch wrapper.
- **HUD**: paste-ready update hints, pid-aware cache lock recovery, bounded
  `.err` reclamation, and per-render git path memoization.
- **LSP hardening**: document lifecycle serialization, retired queue
  cancellation, and bounded directory diagnostics.

## Upstream credits

All ported work originates from
[Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
v5.1.0–v5.3.0; see `CHANGELOG.md` for the per-release breakdown and the
fork-specific adaptations.
