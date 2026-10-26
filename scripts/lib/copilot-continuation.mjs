/**
 * Copilot CLI continuation helpers shared by keyword-detector.mjs,
 * persistent-mode.mjs and pre-tool-enforcer.mjs.
 *
 * Live facts (Copilot CLI 1.0.91, recorded payloads):
 *   - agentStop {decision:"block", reason} continues the session: the reason
 *     arrives as the next user prompt (UserPromptSubmit fires with it) and
 *     costs one premium request.
 *   - Every later Stop in the chain carries stop_hook_active:true; the CLI
 *     ends the turn itself after 8 consecutive blocks.
 *   - A subagent's own events carry the child sessionId with no parent
 *     field; the parent's events.jsonl records `subagent.started` with
 *     `agentId` = the child's session id.
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getCopilotConfigDir } from './config-dir.mjs';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

// ---------------------------------------------------------------------------
// Stop-chain cap
// ---------------------------------------------------------------------------

/**
 * Consecutive OMC continuations allowed per genuine user prompt on Copilot.
 * Each one is a billed premium request, so the default is conservative: 3
 * continuations (4 requests for the prompt) unless a mode's own cap
 * (ralph max_iterations, ultragoal max_reinforcements, ...) ends it sooner.
 * OMC_COPILOT_STOP_CHAIN_MAX overrides it (1..7; 1 restores the old
 * one-continuation-per-prompt behaviour, and 7 stays below the CLI's own
 * 8-block cap so OMC's reason, not the CLI's, ends the chain).
 */
export const DEFAULT_COPILOT_STOP_CHAIN_MAX = 3;
const STOP_CHAIN_FILE = 'copilot-stop-chain.json';

export function resolveCopilotStopChainMax(env = process.env) {
  const raw = String(env.OMC_COPILOT_STOP_CHAIN_MAX ?? '').trim();
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value >= 1 && value <= 7) return value;
  }
  return DEFAULT_COPILOT_STOP_CHAIN_MAX;
}

function stopChainPath(stateDir, sessionId) {
  return SESSION_ID_PATTERN.test(sessionId || '') ? join(stateDir, 'sessions', sessionId, STOP_CHAIN_FILE) : null;
}

/** Continuations already delivered since the last genuine user prompt (0 when unknown). */
export function readCopilotStopChain(stateDir, sessionId) {
  const path = stopChainPath(stateDir, sessionId);
  if (!path || !existsSync(path)) return 0;
  try {
    const count = JSON.parse(readFileSync(path, 'utf-8'))?.count;
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

/** A chained Stop: the previous block was delivered as a continuation, count it. Best effort. */
export function incrementCopilotStopChain(stateDir, sessionId) {
  const path = stopChainPath(stateDir, sessionId);
  if (!path) return;
  try {
    mkdirSync(join(stateDir, 'sessions', sessionId), { recursive: true });
    const next = JSON.stringify({ count: readCopilotStopChain(stateDir, sessionId) + 1, updated_at: new Date().toISOString() });
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, next, { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      // Windows rename can fail with EPERM while a reader holds the file;
      // a direct write still keeps the count.
      rmSync(tmp, { force: true });
      writeFileSync(path, next, { mode: 0o600 });
    }
  } catch {
    // A lost count only makes the chain end at the mode caps or the CLI cap.
  }
}

/** A genuine user prompt starts a new chain. Best effort. */
export function resetCopilotStopChain(stateDir, sessionId) {
  const path = stopChainPath(stateDir, sessionId);
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// OMC's own text arriving as a prompt
// ---------------------------------------------------------------------------

// Block-reason headers emitted by OMC Stop hooks (persistent-mode.mjs,
// context-guard-stop.mjs, workflow-drift-guard.mjs, code-simplifier.mjs,
// budget-guard.mjs). The dispatcher joins several reasons with blank lines,
// so the first line carries one of these. A named autopilot workflow's next
// stage arrives as its stage prompt (scripts/lib/workflow-stage-prompts.mjs).
const OMC_CONTINUATION_HEADER = /^\s*(?:\[(?:RALPH LOOP\b|ULTRAGOAL #|AUTOPILOT\b|ULTRAPILOT\b|ULTRAWORK\b|TEAM - Phase|OMC TEAMS - Phase|SWARM\b|PIPELINE\b|TOOL ERROR\b|CODE SIMPLIFIER\]|WORKFLOW DRIFT GUARD\]|BUDGET\]|OMC(?:\]| ))|## PIPELINE STAGE: )/;

/** The prompt is an OMC Stop-hook continuation reason, not user text. */
export function isOmcContinuationPrompt(prompt) {
  return typeof prompt === 'string' && OMC_CONTINUATION_HEADER.test(prompt);
}

// Copilot starts a `task` subagent with a synthetic first prompt,
// "Agent <name> started (<id>)\n\n<task prompt>" (observed with
// "Agent undefined started (undefined)"). It is the parent's delegation text,
// not a user request.
const COPILOT_SUBAGENT_KICKOFF = /^\s*Agent \S+ started \([^)\n]*\)\s*(?:\n|$)/;

export function isCopilotSubagentKickoffPrompt(prompt) {
  return typeof prompt === 'string' && COPILOT_SUBAGENT_KICKOFF.test(prompt);
}

// ---------------------------------------------------------------------------
// Native autopilot / goal
// ---------------------------------------------------------------------------

/**
 * Copilot's native autopilot (`--autopilot`, `/autopilot`, `/goal`) keeps the
 * agent going until `task_complete`. Whether a hook payload exposes it, and
 * under which field, is UNVERIFIED (docs audit §8), so this only reads
 * plausible fields defensively and nothing depends on them being present.
 */
export function isCopilotNativeAutopilot(data) {
  if (!data || typeof data !== 'object') return false;
  const modes = [data.mode, data.permission_mode, data.permissionMode, data.session_mode, data.sessionMode, data.agent_mode, data.agentMode];
  if (modes.some((value) => typeof value === 'string' && value.toLowerCase() === 'autopilot')) return true;
  if (data.autopilot === true) return true;
  return Boolean(data.autopilot && typeof data.autopilot === 'object' && (data.autopilot.active === true || data.autopilot.enabled === true));
}

/** A native goal objective from the payload, if the CLI exposes one (UNVERIFIED field names). */
export function extractCopilotNativeGoal(data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = [data.autopilot, data.autopilot_goal, data.autopilotGoal, data.objective_state, data.objectiveState];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const objective = candidate.objective ?? candidate.goal ?? candidate.condition;
    if (typeof objective === 'string' && objective.trim()) {
      const status = candidate.status ?? candidate.state ?? (candidate.active === false ? 'inactive' : 'active');
      return { objective, status: typeof status === 'string' ? status : 'active' };
    }
  }
  for (const value of [data.autopilot_objective, data.autopilotObjective]) {
    if (typeof value === 'string' && value.trim()) return { objective: value, status: 'active' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Subagent -> parent session
// ---------------------------------------------------------------------------

/** Parent session id named by the payload itself (documented, not yet observed). */
export function payloadParentSessionId(data) {
  if (!data || typeof data !== 'object') return '';
  for (const value of [data.parent_session_id, data.parentSessionId, data.parent_agent_id, data.parentAgentId]) {
    if (typeof value === 'string' && SESSION_ID_PATTERN.test(value)) return value;
  }
  return '';
}

const EVENTS_TAIL_BYTES = 4 * 1024 * 1024;

function readTail(path, bytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buffer.toString('utf-8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * True when `parentSessionId`'s Copilot events record that it started the
 * subagent `childSessionId` (a `subagent.started` event whose agentId is the
 * child). Reads a bounded tail of $COPILOT_HOME/session-state/<parent>/events.jsonl.
 */
export function copilotSessionStartedSubagent(parentSessionId, childSessionId, configDir = getCopilotConfigDir()) {
  if (!SESSION_ID_PATTERN.test(parentSessionId || '') || !SESSION_ID_PATTERN.test(childSessionId || '')) return false;
  if (parentSessionId === childSessionId) return false;
  const text = readTail(join(configDir, 'session-state', parentSessionId, 'events.jsonl'), EVENTS_TAIL_BYTES);
  if (!text.includes(childSessionId)) return false;
  for (const line of text.split('\n')) {
    if (!line.includes('"subagent.started"') || !line.includes(childSessionId)) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'subagent.started' && event.agentId === childSessionId) return true;
    } catch {
      // A torn first line of the tail; keep looking.
    }
  }
  return false;
}

/**
 * Resolve a subagent's parent among `candidates` (sessions that hold guard
 * state in this project): the payload's own parent field first, then the
 * parent's events.jsonl. '' when there is no reliable linkage.
 */
export function resolveCopilotParentSessionId(data, childSessionId, candidates, configDir) {
  const named = payloadParentSessionId(data);
  if (named && named !== childSessionId) return named;
  for (const candidate of candidates) {
    if (copilotSessionStartedSubagent(candidate, childSessionId, configDir)) return candidate;
  }
  return '';
}
