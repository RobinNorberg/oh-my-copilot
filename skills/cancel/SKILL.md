---
name: cancel
aliases: [cancel-ralph]
description: Cancel any active OMC mode (autopilot, ralph, ultragoal, swarm, ultrapilot, pipeline, team) and clean up retired legacy state
argument-hint: "[--force|--all]"
level: 2
---

# Cancel Skill

Intelligent cancellation that detects and cancels the active OMC mode.

**The cancel skill is the standard way to complete and exit any OMC mode.**
When the stop hook detects work is complete, it instructs the LLM to invoke
this skill for proper state cleanup. If cancel fails or is interrupted,
retry with `--force` flag, or wait for the 2-hour staleness timeout as
a last resort.

## What It Does

Automatically detects which mode is active and cancels it:
- **Autopilot**: Stops workflow, preserves progress for resume
- **Ralph**: Stops the persistence loop
- **Legacy Ultrawork state**: Cleanup-only removal for upgraded installations; it is not an active workflow
- **UltraQA (retired)**: No live workflow remains; clears stale pre-5.0.0 `ultraqa-state.json` if present
- **Ultragoal**: Clears the session-scoped ultragoal runtime guard (`.omg/state/.../ultragoal-state.json`) so PreToolUse `/goal` enforcement and Stop reinforcement release. Durable `.omg/ultragoal/` plan/ledger artifacts are preserved.
- **Swarm**: Stops coordinated agent swarm, releases claimed tasks
- **Ultrapilot**: Stops parallel autopilot workers
- **Pipeline**: Stops sequential agent pipeline
- **Team**: Requests shutdown from all teammates through the active team/conversation surface, waits for responses/timeouts, clears OMC team state, clears linked ralph if present. Claude Code 2.1.178+ has no TeamDelete.
- **Team+Ralph (linked)**: Cancels team first (graceful shutdown), then clears ralph state. Cancelling ralph when linked also cancels team first.

## Usage

```
/oh-my-copilot:cancel
```

Or say: "cancelomc", "stopomc"

## Critical: Deferred Tool Handling

The state management tools (`state_clear`, `state_read`, `state_write`, `state_list_active`,
`state_get_status`) may be registered as **deferred tools** by Claude Code. Before calling
any state tool, you MUST first load all of them via `ToolSearch`:

```
ToolSearch(query="select:mcp__plugin_oh-my-copilot_t__state_clear,mcp__plugin_oh-my-copilot_t__state_read,mcp__plugin_oh-my-copilot_t__state_write,mcp__plugin_oh-my-copilot_t__state_list_active,mcp__plugin_oh-my-copilot_t__state_get_status")
```

If `state_clear` is unavailable or fails, use this **Node fallback** as an **emergency
escape from the stop hook loop**. This is NOT a full replacement for the cancel flow —
it only removes state files to unblock the session. Linked active modes (for example,
autopilot→ralph) must be cleared separately by running the fallback once per mode.

Replace `ralplan` in the first line with the specific mode (e.g. `ralph`, `ultrawork`,
`ultragoal`).

**WARNING:** Do NOT use this fallback for `autopilot` or `omc-teams`. Autopilot requires
`state_write(active=false)` to preserve resume data. omc-teams requires tmux session
cleanup that cannot be done via file deletion alone.

This runs identically in bash, zsh, and PowerShell. It reuses the plugin's own state-root
resolver, so it honours `OMC_STATE_DIR`, workspace markers, and git worktrees exactly as
the state tools do — no shell reimplementation of the project-identifier hash.

```
node -e "const MODE='ralplan';const p=require('node:path'),fs=require('node:fs'),{pathToFileURL}=require('node:url');const root=process.env.CLAUDE_PLUGIN_ROOT;if(root===undefined||root===''){console.error('ERROR: CLAUDE_PLUGIN_ROOT is not set');process.exit(1)}import(pathToFileURL(p.join(root,'scripts','lib','state-root.mjs')).href).then(async m=>{const dir=p.join(await m.resolveOmcStateRoot(process.cwd()),'state');if(fs.existsSync(dir)===false){console.error('ERROR: state directory not found at '+dir);process.exit(1)}const sid=process.env.CLAUDE_SESSION_ID||process.env.CLAUDECODE_SESSION_ID||'';if(sid===''){fs.rmSync(p.join(dir,MODE+'-state.json'),{force:true});console.log('Cleared legacy '+MODE+' state in '+dir);return}const sdir=p.join(dir,'sessions',sid);for(const f of [MODE+'-state.json',MODE+'-stop-breaker.json','skill-active-state.json'])fs.rmSync(p.join(sdir,f),{force:true});const now=Date.now();fs.mkdirSync(sdir,{recursive:true});fs.writeFileSync(p.join(sdir,'cancel-signal-state.json'),JSON.stringify({active:true,requested_at:new Date(now).toISOString(),expires_at:new Date(now+30000).toISOString(),mode:MODE,source:'node_fallback'}));console.log('Cleared '+MODE+' state for session '+sid)})"
```

The cancel signal it writes is what tells the stop hook a cancellation is in progress; it
expires 30 seconds after it is written.

## Auto-Detection

`/oh-my-copilot:cancel` follows the session-aware state contract:
- By default the command inspects the current session via `state_list_active` and `state_get_status`, navigating `.omg/state/sessions/{sessionId}/…` to discover which mode is active.
- When a session id is provided or already known, that session-scoped path is authoritative. Legacy files in `.omg/state/*.json` are consulted only as a compatibility fallback if the session id is missing or empty.
- Swarm is a shared SQLite/marker mode (`.omg/state/swarm.db` / `.omg/state/swarm-active.marker`) and is not session-scoped.
- The default cleanup flow calls `state_clear` with the session id to remove only the matching session files; modes stay bound to their originating session.

Active modes are still cancelled in dependency order:
1. Autopilot (includes linked ralph and retired-state cleanup)
2. Ralph
3. Legacy Ultrawork/UltraQA state cleanup
4. Ultragoal (standalone runtime guard — `state_clear(mode="ultragoal")`; preserves durable `.omg/ultragoal/` artifacts)
5. Swarm (standalone)
6. Ultrapilot (standalone)
7. Pipeline (standalone)
8. Team (Claude Code native)
9. OMC Teams (tmux CLI workers)
10. Plan Consensus (standalone)
11. Self-Improve (standalone — clear state, clean orphaned worktrees, preserve iteration_state for resume, set status: "user_stopped" in the resolved `<self-improve-root>/state/agent-settings.json`; new runs use `.omg/self-improve/topics/<topic-slug>/`, with flat `.omg/self-improve/` retained only for legacy single-track resumes)

## Force Clear All

Use `--force` or `--all` when you need to erase every session plus legacy artifacts, e.g., to reset the workspace entirely.

```
/oh-my-copilot:cancel --force
```

```
/oh-my-copilot:cancel --all
```

Steps under the hood:
1. `state_list_active` enumerates `.omg/state/sessions/{sessionId}/…` to find every known session.
2. `state_clear` runs once per session to drop that session’s files.
3. A global `state_clear` without `session_id` removes legacy files under `.omg/state/*.json`, `.omg/state/swarm*.db`, and compatibility artifacts (see list).
4. Team artifacts (`~/.claude/teams/*/`, `~/.claude/tasks/*/`, `.omg/state/team-state.json`) are best-effort cleared as part of the legacy fallback.
   - Cancel for native team does NOT affect omc-teams state, and vice versa.

Every `state_clear` command honors the `session_id` argument, so even force mode still uses the session-aware paths first before deleting legacy files.

Legacy compatibility list (removed only under `--force`/`--all`):
- `.omg/state/autopilot-state.json`
- `.omg/state/ralph-state.json`
- `.omg/state/ralph-plan-state.json`
- `.omg/state/ralph-verification.json`
- `.omg/state/ultrawork-state.json`
- `.omg/state/ultraqa-state.json`
- `.omg/state/swarm.db`
- `.omg/state/swarm.db-wal`
- `.omg/state/swarm.db-shm`
- `.omg/state/swarm-active.marker`
- `.omg/state/swarm-tasks.db`
- `.omg/state/ultrapilot-state.json`
- `.omg/state/ultrapilot-ownership.json`
- `.omg/state/pipeline-state.json`
- `.omg/state/omc-teams-state.json`
- `.omg/state/plan-consensus.json`
- `.omg/state/ralplan-state.json`
- `.omg/state/boulder.json`
- `.omg/state/hud-state.json`
- `.omg/state/subagent-tracking.json`
- `.omg/state/subagent-tracker.lock`
- `.omg/state/rate-limit-daemon.pid`
- `.omg/state/rate-limit-daemon.log`
- `.omg/state/checkpoints/` (directory)
- `.omg/state/sessions/` (empty directory cleanup after clearing sessions)

## Implementation Steps

When you invoke this skill:

### 1. Parse Arguments

Read the invocation arguments directly: force mode is on when the arguments contain
`--force` or `--all`, and off otherwise. This is a decision you make while executing the
skill, not a shell command to run.

### 2. Detect Active Modes

The skill now relies on the session-aware state contract rather than hard-coded file paths:
1. Call `state_list_active` to enumerate `.omg/state/sessions/{sessionId}/…` and discover every active session.
2. For each session id, call `state_get_status` to learn which active mode is running and whether dependent modes exist; treat any Ultrawork record as retired cleanup input only.
3. If a `session_id` was supplied to `/oh-my-copilot:cancel`, skip legacy fallback entirely and operate solely within that session path; otherwise, consult legacy files in `.omg/state/*.json` only if the state tools report no active session. Swarm remains a shared SQLite/marker mode outside session scoping.
4. Any cancellation logic in this doc mirrors the dependency order discovered via state tools (autopilot → ralph → …).

### 3A. Force Mode (if --force or --all)

Use force mode to clear every session plus legacy artifacts via `state_clear`. Direct file removal is reserved for legacy cleanup when the state tools report no active sessions.

### 3B. Smart Cancellation (default)

#### If Team Active (Claude Code implicit team)

Teams are detected through OMC team state, not removed Claude Code `~/.claude/teams` config directories:

```bash
# Check for active OMC team state
state_read(mode="team")
```

**Two-pass cancellation protocol:**

**Pass 1: Graceful Shutdown**
```
For the active OMC team state:
  1. Read team_name and worker labels from OMC state/handoffs/task bookkeeping
  2. For each active teammate:
     a. Ask or notify the named teammate through the active conversation/team messaging surface
     b. Wait up to 15 seconds for shutdown_response
     c. If response received: mark member acknowledged
     d. If timeout: mark member as unresponsive, continue to next
  3. Log: "Graceful pass: X/Y members responded"
```

**Pass 2: Reconciliation**
```
After graceful pass:
  1. Wait 5 more seconds for unresponsive teammates that may still be processing
  2. Record any remaining unresponsive teammates in the cancellation report
  3. Do not call TeamDelete; Claude Code 2.1.178+ removed per-team native cleanup
```

**OMC State Cleanup:**
```
  1. Clear team state: state_clear(mode="team")
  2. Check for linked ralph: state_read(mode="ralph") — if linked_team is true:
     a. Clear ralph state: state_clear(mode="ralph")
  3. Run OMC tmux/CLI orphan scan only for legacy `omc team` / `/omc-teams` workers (see below)
  4. Emit structured cancel report
```

**Orphan Detection (Post-Cleanup):**

For legacy OMC tmux/CLI worker runs, verify no worker processes remain:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-orphans.mjs" --team-name "{team_name}"
```

The orphan scanner:
1. Checks `ps aux` (Unix) or `tasklist` (Windows) for OMC worker processes with `--team-name` matching the cleaned-up team
2. Sends SIGTERM, waits 5s, sends SIGKILL if still alive
3. Reports cleanup results as JSON

Use `--dry-run` to inspect without killing. The scanner is safe to run multiple times.

**Structured Cancel Report:**
```
Team "{team_name}" cancelled:
  - Members signaled: N
  - Responses received: M
  - Unresponsive: K (list names if any)
  - OMC state cleared: yes/no
  - Manual cleanup needed: yes/no
    Path: OMC team state / tmux worker processes, if any
```

**Implementation note:** The cancel skill is executed by the LLM, not as a bash script. When you detect an active team:
1. Read `state_read(mode="team")` to find the active OMC team
2. Identify active named teammates from state, handoffs, or task bookkeeping
3. For each teammate, ask or notify the named teammate through the active conversation/team messaging surface
4. Wait briefly for shutdown responses (15s per member timeout)
5. Record unresponsive teammates after a reconciliation wait
6. Clear team state: `state_clear(mode="team", session_id)`
7. Report structured summary to user

#### If Autopilot Active

Autopilot handles its own primary-first cleanup: named workflows additionally remove only their session-owned nested ralplan enforcement state before linked ralph and retired ultraqa cleanup.

1. Read autopilot state via `state_read(mode="autopilot", session_id)` to capture the exact current run, including `workflowRunId` when present.
2. Pause that exact run with the narrow mutation `state_write(mode="autopilot", session_id, active=false, state={workflowRunId: "<exact run id>"})`. Do **not** replay or copy the state readback. On Linux with `flock`, the tool revalidates the held run and workflow integrity under its mutation lock before changing only `active` to `false`; it preserves workflow, pipeline tracking, and task identity. `target_state_sha256` may be included only when it is the exact SHA-256 of the current serialized state.
   - If this write fails, stop immediately. Do not clear nested ralplan, linked state, cancel signals, or runtime artifacts.
3. For a named workflow, clear only `ralplan` state owned by the same `session_id`; never clear another session's standalone ralplan state. Record a failure but keep the paused primary resumable.
4. Only after the primary pause commits, check linked ralph via `state_read(mode="ralph", session_id)`:
   - Clear ralph and require success.
5. Check for retired ultraqa state via `state_read(mode="ultraqa", session_id)` and clear it if present.
6. Report every dependent clear failure explicitly; the already-paused autopilot state remains resumable and cleanup may be retried.

Force cancellation follows the same primary-first rule for every autopilot group: clear the exact autopilot primary first, abort its dependent cleanup if the primary clear fails, and never continue as though that group succeeded.

#### If Ralph Active (but not Autopilot)

1. Clear ralph: `state_clear(mode="ralph", session_id)`

#### If Legacy Ultrawork State Exists

1. Read Ultrawork state only to identify a stale upgraded-installation record.
2. Clear it with `state_clear(mode="ultrawork", session_id)`; never reactivate or route it.

#### If UltraQA State Present (retired)

UltraQA was retired in 5.0.0. No live workflow exists; if a stale
`ultraqa-state.json` remains from a pre-5.0.0 run, clear it directly:
`state_clear(mode="ultraqa", session_id)`

#### If Ultragoal Active (standalone)

Clear the runtime guard only: `state_clear(mode="ultragoal", session_id)`.
Durable `.omg/ultragoal/{brief.md,goals.json,ledger.jsonl}` artifacts are preserved.

#### No Active Modes

Report: "No active OMC modes detected. Use --force to clear all state files anyway."

## Implementation Notes

The cancel skill runs as follows:
1. Parse the `--force` / `--all` flags, tracking whether cleanup should span every session or stay scoped to the current session id.
2. Use `state_list_active` to enumerate known session ids and `state_get_status` to learn each active mode; treat any Ultrawork record as cleanup-only legacy state.
3. When operating in default mode, call `state_clear` with that session_id to remove only the session’s files, then run mode-specific cleanup (autopilot → ralph → …) based on the state tool signals.
4. In force mode, iterate every active session, call `state_clear` per session, then run a global `state_clear` without `session_id` to drop legacy files (`.omg/state/*.json`, compatibility artifacts) and report success. Swarm remains a shared SQLite/marker mode outside session scoping.
5. Team artifacts (`~/.claude/teams/*/`, `~/.claude/tasks/*/`, `.omg/state/team-state.json`) remain best-effort cleanup items invoked during the legacy/global pass.
6. **Always** clear skill-active state as the final step, regardless of which mode was active or whether `--force` was used:
   ```
   state_clear(mode="skill-active", session_id)
   ```
   This ensures the stop hook does not keep firing skill-protection reinforcements after cancel due to a stale `skill-active-state.json`. See issue #2118.

State tools always honor the `session_id` argument, so even force mode still clears the session-scoped paths before deleting compatibility-only legacy state.

Mode-specific subsections below describe what extra cleanup each handler performs after the state-wide operations finish.
## Messages Reference

| Mode | Success Message |
|------|-----------------|
| Autopilot | "Autopilot cancelled at phase: {phase}. Progress preserved for resume." |
| Ralph | "Ralph cancelled. Persistent mode deactivated." |
| Legacy Ultrawork state | "Retired Ultrawork state removed." |
| Legacy UltraQA state | "Retired UltraQA state cleared." |
| Ultragoal | "Ultragoal cancelled. Runtime /goal guard released; durable plan/ledger preserved." |
| Swarm | "Swarm cancelled. Coordinated agents stopped." |
| Ultrapilot | "Ultrapilot cancelled. Parallel autopilot workers stopped." |
| Pipeline | "Pipeline cancelled. Sequential agent chain stopped." |
| Team | "Team cancelled. Teammates shut down and cleaned up." |
| Plan Consensus | "Plan Consensus cancelled. Planning session ended." |
| Force | "All OMC modes cleared. You are free to start fresh." |
| None | "No active OMC modes detected." |

## What Gets Preserved

| Mode | State Preserved | Resume Command |
|------|-----------------|----------------|
| Autopilot | Yes (phase, files, spec, plan, verdicts) | `/oh-my-copilot:autopilot` |
| Ralph | No | N/A |
| Ultrawork | No | N/A |
| Ultragoal | Yes (durable plan/ledger under `.omg/ultragoal/`) | Resume via `/ultragoal` / `omc ultragoal complete-goals` |
| Swarm | No | N/A |
| Ultrapilot | No | N/A |
| Pipeline | No | N/A |
| Plan Consensus | Yes (plan file path preserved) | N/A |

## Notes

- **Dependency-aware**: Autopilot cancellation cleans up Ralph and any retired ultraqa state
- **Local-only**: Clears state files in `.omg/state/` directory
- **Resume-friendly**: Autopilot state is preserved for seamless resume
- **Team-aware**: Detects native Claude Code teams and performs graceful shutdown

## MCP Worker Cleanup

When cancelling modes that may have spawned MCP workers (team bridge daemons), the cancel skill should also:

1. **Check for active MCP workers**: Look for heartbeat files at `.omg/state/team-bridge/{team}/*.heartbeat.json`
2. **Send shutdown signals**: Write shutdown signal files for each active worker
3. **Kill tmux sessions**: Run `tmux kill-session -t omc-team-{team}-{worker}` for each worker
4. **Clean up heartbeat files**: Remove all heartbeat files for the team
5. **Clean up shadow registry**: Remove `.omg/state/team-mcp-workers.json`

### Force Clear Addition

When `--force` is used, also clean up the heartbeat files and the shadow registry:

```
node -e "const fs=require('node:fs'),p=require('node:path');fs.rmSync(p.join('.omg','state','team-bridge'),{recursive:true,force:true});fs.rmSync(p.join('.omg','state','team-mcp-workers.json'),{force:true});console.log('Cleared team bridge heartbeats and shadow registry')"
```

Then kill any leftover `omc-team-*` tmux sessions. This is a no-op where tmux is not
installed, so it is safe to run everywhere:

```
node -e "const{execFileSync}=require('node:child_process');let out='';try{out=execFileSync('tmux',['list-sessions','-F','#{session_name}'],{encoding:'utf8'})}catch{out=''};for(const s of out.split(/\r?\n/).map(x=>x.trim()).filter(x=>x.startsWith('omc-team-'))){try{execFileSync('tmux',['kill-session','-t',s]);console.log('Killed '+s)}catch{}}"
```
