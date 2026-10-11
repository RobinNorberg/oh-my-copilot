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
 * - a `permission_prompt` sends no command arguments at all: only the title
 *   (letters and spaces, else `Permission needed`), the tool category
 *   (`Run command`) and, for a command, the binary's base name
 *   (`Permission needed: Run command: curl`). The message is the full command
 *   line, and no redaction pattern list is complete;
 * - an `elicitation_dialog` question is passed through `redactTokens` and
 *   capped at QUESTION_MAX_CHARS; when that redactor fails REDACT_SELF_TEST
 *   (a stale dist) the text is not sent, only ASK_USER_GENERIC_TEXT;
 * - a `permission_prompt` notification is not replyable: a remote reply is
 *   never injected into the pane, where Enter would answer Copilot's
 *   permission menu (and approve the command), and notify() drops the pane's
 *   earlier reply mappings;
 * - fail closed on a stale build: the committed dist/ can predate this file.
 *   A permission prompt is sent only when the loaded dist/notifications/index.js
 *   exports NOTIFICATION_CAPS.nonReplyable and its redactTokens passes
 *   REDACT_SELF_TEST (permissionPromptSupported);
 * - per session, a permission prompt is sent at most once per COOLDOWN_MS and
 *   an identical ask_user question once per COOLDOWN_MS, keyed on a hash of
 *   the original title and message, not the sent text
 *   (`<state>/sessions/<sessionId>/notification-input-cooldown.json`).
 */
import { readStdin } from '../lib/stdin.mjs';
import { resolveOmcStateRoot } from '../lib/state-root.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';
import { isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export const INPUT_NEEDED_TYPES = new Set(['permission_prompt', 'elicitation_dialog']);
export const QUESTION_MAX_CHARS = 200;
export const COOLDOWN_MS = 30_000;
/** [input, secret]: inputs a current redactTokens masks and an older dist build does not. */
export const REDACT_SELF_TEST = [
  ['--password=selftest1', 'selftest1'],
  ['{"password":"selftest2"}', 'selftest2'],
  ['X-API-Key: selftest3', 'selftest3'],
];
/** The ask_user text sent when the loaded redactor fails REDACT_SELF_TEST. */
export const ASK_USER_GENERIC_TEXT = 'Copilot is asking you a question';
const PERMISSION_TITLE = 'Permission needed';

const cap = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The binary of a command line: the first word that is not an env assignment,
 * without quotes and directories, or '' when none looks like a program name.
 * Words split as a shell splits them: quotes anywhere in a word keep their
 * spaces inside it (`"C:\Program Files\Git\bin\git.exe" push` -> `git.exe`,
 * `PW="correct horse" psql` -> `psql`, never `horse`). A statement that starts with a PowerShell variable
 * (`$env:X = 'v';`) is skipped whole, so its value is never taken for the binary.
 */
export function commandBinary(commandLine) {
  for (const statement of commandLine.split(/;|&&|\|\||\||\n/)) {
    const words = (statement.match(/(?:"[^"]*"?|'[^']*'?|`[^`]*`?|[^\s"'`])+/g) ?? []).map((raw) => raw.replace(/^["'`(]+|["'`)]+$/g, ''))
      .filter((word) => word && !word.includes('=') && !word.startsWith('-'));
    if (words.length === 0) continue;
    if (words[0].startsWith('$')) continue;
    const base = words[0].split(/[\\/]/).pop() ?? '';
    return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(base) ? base : '';
  }
  return '';
}

/**
 * The text of a permission prompt: title, tool category and, for a command,
 * its binary. `Run command: curl -H "..." https://x` -> `Run command: curl`.
 */
export function permissionPromptText(title, message, redact) {
  const at = message.indexOf(':');
  const category = at > 0 ? message.slice(0, at).trim() : '';
  const safeCategory = /^[A-Za-z][A-Za-z ]{0,39}$/.test(category) ? category : '';
  const derived = safeCategory && /command|shell|run|exec/i.test(safeCategory) ? commandBinary(message.slice(at + 1)) : '';
  // A binary that looks like a secret (an assignment, or one the redactor masks) is not sent.
  const binary = derived && !derived.includes('=') && redact(derived) === derived ? derived : '';
  const safeTitle = /^[A-Za-z ]{1,40}$/.test(title) ? title : PERMISSION_TITLE;
  const text = [safeTitle, safeCategory, binary].filter(Boolean).join(': ');
  return redact(text).replace(/\s+/g, ' ');
}

/**
 * The notification to dispatch for one hook payload, or null. `redact` is
 * `redactTokens`; for a question it runs on the whole text before the cap, so
 * a cut never splits a secret out of its pattern.
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
  const permission = payload.notification_type === 'permission_prompt';
  let question;
  if (permission) question = permissionPromptText(title, message, redact);
  else if (!redactorCurrent(redact)) question = ASK_USER_GENERIC_TEXT; // stale dist: no question text
  else question = cap(redact([title, message].filter(Boolean).join(': ')).replace(/\s+/g, ' '), QUESTION_MAX_CHARS);
  return {
    event: 'ask-user-question',
    data: {
      sessionId,
      projectPath: typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd(),
      question: question || 'User input requested',
      profileName: env.OMC_NOTIFY_PROFILE,
      ...(permission ? { replyable: false } : {}),
    },
  };
}

/**
 * Whether the loaded notify module may carry a permission prompt: it honours
 * `replyable: false` and its redactor masks the current patterns.
 */
export function permissionPromptSupported(notifications) {
  if (notifications?.NOTIFICATION_CAPS?.nonReplyable !== true) return false;
  return redactorCurrent(notifications.redactTokens);
}

/** Whether `redact` masks every REDACT_SELF_TEST secret (false for an older dist build). */
export function redactorCurrent(redact) {
  if (typeof redact !== 'function') return false;
  try {
    return REDACT_SELF_TEST.every(([input, secret]) => !String(redact(input)).includes(secret));
  } catch {
    return false;
  }
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

/** The dist modules the hook dispatches through (the background child loads the same index.js). */
async function loadDistModules() {
  const [notifications, { dispatchNotificationInBackground }] = await Promise.all([
    import('../../dist/notifications/index.js'),
    import('../../dist/hooks/background-notifications.js'),
  ]);
  return { notifications, dispatchNotificationInBackground };
}

/** `deps` (tests): `readInput()` replaces stdin, `load()` the dist modules. */
export async function runNotificationHook(env = process.env, deps = {}) {
  const debug = (line) => { if (env.OMC_DEBUG_HOOKS) process.stderr.write(`[omg-hook] Notification: ${line}\n`); };
  try {
    const input = await (deps.readInput ?? readStdin)();
    const payload = JSON.parse(input || '{}');
    if (!INPUT_NEEDED_TYPES.has(payload?.notification_type)) return;
    const { notifications, dispatchNotificationInBackground } = await (deps.load ?? loadDistModules)();
    if (payload.notification_type === 'permission_prompt' && !permissionPromptSupported(notifications)) {
      debug('dist/notifications predates non-replyable prompts or current redaction, permission prompt not dispatched');
      return;
    }
    const dispatch = notificationFor(payload, env, notifications?.redactTokens);
    if (!dispatch) return;
    if (env.OMC_NOTIFY === '0') { debug('OMC_NOTIFY=0, not dispatched'); return; }
    const path = cooldownPath(await resolveOmcStateRoot(dispatch.data.projectPath), dispatch.data.sessionId);
    // Dedupe on the original text: a stale dist sends the same generic text for every question.
    const questionKey = createHash('sha256').update(JSON.stringify([payload.title, payload.message])).digest('hex');
    if (path && !takeCooldown(path, payload.notification_type, questionKey)) {
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
