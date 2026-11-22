# oh-my-copilot v5.32.0

This release ports upstream oh-my-claudecode through e400eab90, and makes factory lane commits deterministic in repositories whose `.gitattributes` rewrite files at checkout (line endings, git-lfs and other filters). See CHANGELOG.md.

Install with `npm install -g oh-my-copilot@5.32.0`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

There is no new factory bench run in this release. The bench baseline is unchanged from v5.31.0.

## Highlights

- **A lane commit holds only the files the lane changed.** In a repository that asks for CRLF checkouts with `core.autocrlf` off (the Linux and macOS default), or that uses git-lfs or another clean/smudge filter, a lane's commit could include an untouched file as a whole-file rewrite, depending on timing. Lane worktrees are now checked out the way the engine stages them, so every file holds its blob's bytes and an untouched file is never committed.
- **Upstream port through e400eab90.** 22 of 26 upstream commits ported: team readiness and pane fixes, opt-in redaction, hook text and planner switches, and plugin cache data-loss fixes.

## From upstream

- **Team panes and readiness.** Pane signals are read through one per-provider pattern table; Copilot keeps its own idle box, busy line and folder-trust dialog, and the team monitor reads a Copilot worker's pane with Copilot's patterns. The idle nudge and the monitor share one pane state. Claude's trust dialog is answered only once Yes is focused, and a dropped Down key is sent again. `OMC_TEAM_READY_TIMEOUT_MS` extends a worker's startup readiness wait.
- **Team dispatch queue** no longer erases requests or takes a live lock.
- **Opt-in key-shape redaction.** `OMC_REDACT_KEY_SHAPES=1` also masks key shapes (`sk_live_`, `AIza`, `gsk_`, `xai-`, `hf_`, JWTs) and secret-named NAME=value pairs in notification logs and reply-listener error lines. With the switch off, the fork's default redaction rules give the same output as before. The URL-credential, `mysql -p` and `login -p` rules no longer take quadratic time on long inputs.
- **Opt-in hook switches.** `OMC_CONTEXT_TEXT_SANITIZE=1` cleans control and direction characters out of the text the hooks inject. `OMC_PROJECT_MEMORY_FRAME=1` marks the project-memory summary as reference only. `OMC_PLANNER_WRITE_GUARD=1` limits the planner agent to Markdown files under `.omg/plans/` (see Caveats). `OMC_AGENT_TYPE_DENY` lists agent types whose subagent spawns are refused with `OMC_AGENT_TYPE_DENY_MODE=deny` (or logged with `shadow`). `OMC_JEV_ROW_TELEMETRY`, `OMC_JEV_POINTER_EXPAND` and `point:shadow` add opt-in JEV telemetry and pointer expansion.
- **Project memory.** MCP writes take the shared lock.
- **Plugin cache.** `repair-plugin-cache` never links runnable versions to an unbuilt one, and a dangling link is read as an unreadable cache-occupancy registry, not an absent one.
- **HUD.** A newer installed but unbuilt version is reported as such, instead of a false update hint.
- Session search reads transcripts for named project filters, and the contained-fs addon build finds the running node's headers.

## Changed / Upgrade notes

- **The factory needs git 2.41 or newer (was 2.38).** `omg factory run`, `omg factory bench init` and `bench run` stop on an older git, and `omg factory check --host` reports it. Ubuntu 24.04 (git 2.43) runs the factory. Ubuntu 20.04 and 22.04 need the git PPA: `sudo add-apt-repository ppa:git-core/ppa && sudo apt-get update && sudo apt-get install git`. The private layout still needs 2.44 (Ubuntu 24.04 needs the git PPA for it).
- **Lanes see files as committed, gates see them checked out.** A write lane's worktree holds committed line endings (LF in a repository that asks for CRLF checkouts) and git-lfs pointer files instead of their content. The gates' prepare checkout still applies `.gitattributes`. A lane test that reads an LFS asset or depends on checkout line endings can fail in the lane and pass at the gate. The write lane prompts tell the lane to keep the committed line endings and never edit or replace an LFS pointer file.
- **Lane worktrees are checked out attribute-free from this release on.** Each lane gets a new worktree, so a run resumed after the upgrade needs no action. Worktrees left by earlier lanes are never reused; `omg factory run clean <issue>` removes them once the run is merged or cancelled.

## Deferred

- `OMC_AGENT_EXTRA_DISALLOWED_TOOLS` (upstream 7184060c9): it does not reach the Copilot plugin's agent projection, and its preset names Claude Desktop tools.
- The doctor's project-local `.claude/settings.local.json` conflict check (upstream c5f9f6902): waits until it is settled whether Copilot CLI reads a project-local settings file.

## Caveats

- **Test evidence:** published with CI on the release commit, not the maintainer's local full test suite. The live Tier 2 smoke runs in the tag's CI.
- The lane git guard's deny is covered by tests and the scripted bench lanes; no guarded git command has run in a live bench yet.
- `OMC_PLANNER_WRITE_GUARD=1` protects nothing under the Copilot host yet: Copilot's PreToolUse payload carries no agent identity, and an `apply_patch` call names no file path.- **Redaction:** with the default rules, a `NAME="value"` secret that contains a backslash-escaped quote keeps the text after that quote unmasked: `API_TOKEN="abc\"sensitive-suffix"` is logged as `API_TOKEN=****sensitive-suffix"`. v5.31.0 behaves the same. `OMC_REDACT_KEY_SHAPES=1` masks the whole value. A fix is planned.
