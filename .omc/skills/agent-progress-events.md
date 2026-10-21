---
name: agent-progress-events
description: Lead-side recipe for agent progress events — brief lanes to push `phase=… status=…` lines, arm Claude Code's Monitor tool with `omg progress watch --stall 10m`, and react to stalled / blocked / failed lanes without polling them
triggers:
  - agent progress
  - progress events
  - lane progress
  - stalled agent
  - omg progress
---

# Agent progress events (lead recipe)

Lanes push one line per phase boundary; the lead arms one Monitor and is
woken by new lines instead of polling agents or noticing silence by hand.
The contract (format, escaping, location, statuses) lives in
`src/lib/agent-progress.ts`; `docs/REFERENCE.md` → `omg progress` has the
command reference.

## 1. Pick one shared directory per session
Lanes run in their own worktrees, so each one's default
`<worktree>/.omg/progress/` is invisible to the lead. Use one directory all
lanes can write, e.g. `<scratchpad>/progress/`, and a fresh one per session
(old `done` logs are harmless, but yesterday's crashed lane would be
reported as stalled once). With `OMC_STATE_DIR` set, the default location
is already shared across worktrees of one repo.

## 2. Brief snippet (paste into every lane brief, fill `<dir>` and `<lane>`)
```
PROGRESS: at each phase boundary, and at least every ~10 min during long
steps, run
  omg progress emit <phase> <start|ok|fail|blocked|heartbeat> --note "<short>" --agent <lane> --file <dir>/<lane>.log
and finish with `omg progress emit report done --agent <lane> --file <dir>/<lane>.log`.
Use `blocked` (with the reason in --note) when you need the lead, `fail`
when a gate failed and you are stopping. If `omg` is not on PATH, append
the same line yourself:
  <ISO-8601 UTC> phase=<id> status=<status> note=<no-spaces-or-"quoted">
```
`emit` exits 0 even when the write fails (it warns on stderr), so it is
safe inside `&&` chains.

## 3. Arm the Monitor (one per session, before or after spawning lanes)
```
omg progress watch --dir <dir> --stall 10m
```
- Streams every new line, and one `status=stalled` line when a lane's last
  `start` / `heartbeat` / `ok` is older than `--stall` (`note="no event for
  12m after status=start"`, `idle=`, `last_ts=`).
- At startup it reports lanes already failed / blocked / stalled; add
  `--replay` to also print the existing history.
- Exits 0 once every lane seen has emitted `done` (in `--dir` mode only
  after at least one new event, so old finished logs do not end it). Re-arm
  for the next batch of lanes.
- `omg progress status --dir <dir>` is the one-shot table when a summary is
  wanted; `omg progress watch --dir <dir> --once` prints only what needs
  attention.

## 4. React
| Line | Do |
|---|---|
| `status=blocked` | Read the note; answer the lane via SendMessage (or decide for it). |
| `status=fail` | Wait for the lane's report, then hand the fix to a fresh agent. |
| `status=stalled` | Check the lane (ListAgents / its output); nudge once via SendMessage; if it is dead, recycle it and restart the phase in a fresh agent. A lane that resumes emits a normal line, and a later stall is reported again. |
| `status=done` | Process the lane's report and recycle the agent. |
