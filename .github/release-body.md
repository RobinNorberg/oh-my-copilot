# oh-my-copilot v5.12.1

A patch release, and the first npm release of the v5.12.0 content: v5.12.0
was tagged but never published to npm because its release job failed on the
SessionStart parity test. Coming from 5.11.0, everything below is new.

v5.12.0 ports upstream oh-my-claudecode `dev` through faedfd200
(7cb577e94..51bec397e and 51bec397e..faedfd200, 280 commits, upstream v5.7.0
to v5.7.6) and binds the generated-artifact authorization check to the fork.

Install with `npm install -g oh-my-copilot@5.12.1`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Fixed in 5.12.1

- The SessionStart hook writes `update-check.json` with a deterministic key
  order, whichever registry answer lands first (#253).
- The SessionStart parity test no longer reaches the live npm registry.

## Breaking for MCP callers

- The five retired `merge_readiness_*` MCP tools and their runtime are removed
  (upstream #4422). The configured MCP server now exposes 56 tools. A client
  that still calls one gets an unknown-tool error; use `/oh-my-copilot:review`
  or `omg ship gates <pr>` instead. See the
  [migration note](https://github.com/RobinNorberg/oh-my-copilot/blob/main/docs/MIGRATION.md#v5110--v5120-merge-readiness-mcp-tools-removed).

## Added

- `omg ask muse`: a Muse advisor provider.
- `claudeMdEnabled: false` in `~/.copilot/.omc-config.json` leaves your own
  global `~/.copilot/CLAUDE.md` untouched on install, update, setup and doctor.
- `OMC_JEV_PLAN_MODE` keeps Jev from deciding in plan mode.
- A deadline-bounded state-lock API shared across acquire and release.

## Changed

- The rules and directory-context injectors run only for
  `Read|Write|Edit|MultiEdit` (PostToolUse). Copilot CLI matches these Claude
  tool names against its own `view`, `create` and `edit` tools.
- Frontmatter in skills, commands, rules, agents and wiki accepts a UTF-8 BOM,
  CRLF, YAML block scalars and quoted flow values; rule globs support `{a,b}`.
- State-manager, learner and factcheck globs match literally; numeric CLI
  options reject non-integer values.
- Retired tiered agent names (`executor-low` and others) are gone; pass a
  `model` instead.

## Fixed in 5.12.0

- HUD plugin mode no longer imports Zod from the plugin cache; the stdin cache
  is scoped per session; quota identity follows the stored OAuth account.
- Team: stable cmux worker startup, validated shutdown acknowledgements, stale
  Cursor verdicts quarantined.
- Fork: the "Authorize generated artifacts" check now trusts
  `RobinNorberg/oh-my-copilot`; fork repository links point at
  `RobinNorberg/oh-my-copilot`; stale `dist/` outputs whose source is gone are
  removed.

Fork deviations (kept and dropped) are listed in `CHANGELOG.md`.
