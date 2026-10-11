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
 */
import { readStdin } from '../lib/stdin.mjs';
import { isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const INPUT_NEEDED_TYPES = new Set(['permission_prompt', 'elicitation_dialog']);

/** The notification to dispatch for one hook payload, or null. */
export function notificationFor(payload, env = process.env) {
  if (!payload || typeof payload !== 'object') return null;
  if (env.OMC_TEAM_WORKER) return null;
  if (!INPUT_NEEDED_TYPES.has(payload.notification_type)) return null;
  const sessionId = payload.sessionId ?? payload.session_id;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  return {
    event: 'ask-user-question',
    data: {
      sessionId,
      projectPath: typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd(),
      question: [title, message].filter(Boolean).join(': ') || 'User input requested',
      profileName: env.OMC_NOTIFY_PROFILE,
    },
  };
}

export async function runNotificationHook() {
  try {
    const input = await readStdin();
    const dispatch = notificationFor(JSON.parse(input || '{}'));
    if (!dispatch) return;
    const { dispatchNotificationInBackground } = await import('../../dist/hooks/background-notifications.js');
    dispatchNotificationInBackground(dispatch.event, dispatch.data);
  } catch {
    // Fire-and-forget: a notification failure never surfaces in the session.
  }
}

if (!isMainThread || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) void runNotificationHook();
