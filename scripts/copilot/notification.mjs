#!/usr/bin/env node
/**
 * Copilot CLI `notification` hook (fork-owned; no upstream hooks/hooks.json
 * counterpart, wired by FORK_HOOKS in scripts/copilot/build-hooks.mjs).
 *
 * Copilot fires it asynchronously, its output is ignored. Payload, observed on
 * Copilot CLI 1.0.91 (camelCase and PascalCase registrations get the same one):
 *   { sessionId, timestamp, cwd, message, title, hook_event_name: "Notification",
 *     notification_type: "permission_prompt" | "elicitation_dialog" | "shell_completed" | ... }
 *
 * A session blocked on the user (`permission_prompt`, `elicitation_dialog`,
 * the latter including the `ask_user` tool) dispatches OMC's
 * `ask-user-question` notification, the one upstream sends from PreToolUse
 * for Claude Code's AskUserQuestion. That PreToolUse path never fires on
 * Copilot, whose tool is `ask_user`. Team workers (OMC_TEAM_WORKER) are
 * skipped: SDK workers raise `permission_prompt` for every request their host
 * policy answers, and no worker waits on a human.
 *
 * Safety:
 * - the text is passed through `redactTokens` (dist/notifications/redact.js)
 *   and capped at QUESTION_MAX_CHARS before it reaches the notify path; a
 *   permission prompt's message is the full command line (`Run command: ...`);
 * - a `permission_prompt` notification is not replyable: a remote reply is
 *   never injected into the pane, where Enter would answer Copilot's
 *   permission menu (and approve the command);
 * - per session, a permission prompt is sent at most once per COOLDOWN_MS and
 *   an identical ask_user question once per COOLDOWN_MS
 *   (`<state>/sessions/<sessionId>/notification-input-cooldown.json`).
 */
import { readStdin } from '../lib/stdin.mjs';
import { resolveOmcStateRoot } from '../lib/state-root.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';
import { isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const INPUT_NEEDED_TYPES = new Set(['permission_prompt', 'elicitation_dialog']);
export const QUESTION_MAX_CHARS = 200;
export const COOLDOWN_MS = 30_000;

/**
 * The notification to dispatch for one hook payload, or null. `redact` is
 * `redactTokens`; it runs on the whole text before the cap, so the command's
 * binary (its first word) always survives and a cut never splits a secret
 * out of its pattern.
 */
export function notificationFor(payload, env = process.env, redact) {
  if (!payload || typeof payload !== 'object') return null;
  if (env.OMC_TEAM_WORKER) return null;
  if (!INPUT_NEEDED_TYPES.has(payload.notification_type)) return null;
  if (typeof redact !== 'function') return null; // fail closed: never send unredacted text
  const sessionId = payload.sessionId ?? payload.session_id;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const text = redact([title, message].filter(Boolean).join(': ')).replace(/\s+/g, ' ');
  const question = text.length > QUESTION_MAX_CHARS ? `${text.slice(0, QUESTION_MAX_CHARS - 1)}…` : text;
  return {
    event: 'ask-user-question',
    data: {
      sessionId,
      projectPath: typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd(),
      question: question || 'User input requested',
      profileName: env.OMC_NOTIFY_PROFILE,
      ...(payload.notification_type === 'permission_prompt' ? { replyable: false } : {}),
    },
  };
}

/** The per-session cooldown file, or null for a session id unsafe as a path segment. */
export function cooldownPath(stateRoot, sessionId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) return null;
  return join(stateRoot, 'state', 'sessions', sessionId, 'notification-input-cooldown.json');
}

/**
 * Whether to send now; records the send when it does. A permission prompt is
 * rate-limited per session, an ask_user question deduplicated by its text.
 */
export function takeCooldown(path, type, question, nowMs = Date.now(), windowMs = COOLDOWN_MS) {
  let record = {};
  try { record = JSON.parse(readFileSync(path, 'utf8')) ?? {}; } catch { record = {}; }
  const last = record[type];
  if (last && Number.isFinite(last.at) && nowMs - last.at >= 0 && nowMs - last.at < windowMs
    && (type === 'permission_prompt' || last.question === question)) {
    return false;
  }
  record[type] = { at: nowMs, question };
  try { atomicWriteFileSync(path, JSON.stringify(record)); } catch { /* best effort: send anyway */ }
  return true;
}

export async function runNotificationHook(env = process.env) {
  const debug = (line) => { if (env.OMC_DEBUG_HOOKS) process.stderr.write(`[omg-hook] Notification: ${line}\n`); };
  try {
    const input = await readStdin();
    const payload = JSON.parse(input || '{}');
    if (!INPUT_NEEDED_TYPES.has(payload?.notification_type)) return;
    const [{ redactTokens }, { dispatchNotificationInBackground }] = await Promise.all([
      import('../../dist/notifications/redact.js'),
      import('../../dist/hooks/background-notifications.js'),
    ]);
    const dispatch = notificationFor(payload, env, redactTokens);
    if (!dispatch) return;
    if (env.OMC_NOTIFY === '0') { debug('OMC_NOTIFY=0, not dispatched'); return; }
    const path = cooldownPath(await resolveOmcStateRoot(dispatch.data.projectPath), dispatch.data.sessionId);
    if (path && !takeCooldown(path, payload.notification_type, dispatch.data.question)) {
      debug(`${payload.notification_type} within ${COOLDOWN_MS} ms cooldown, not dispatched`);
      return;
    }
    dispatchNotificationInBackground(dispatch.event, dispatch.data);
    debug(`dispatched ${dispatch.event}`);
  } catch (err) {
    // Fire-and-forget: a notification failure never surfaces in the session.
    debug(`failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (!isMainThread || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) void runNotificationHook();
