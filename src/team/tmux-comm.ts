import { mkdir, appendFile, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { sendToWorker } from './tmux-session.js';
import { TeamPaths, absPath } from './state-paths.js';

interface MailboxMessage {
  message_id: string;
  from_worker: string;
  to_worker: string;
  body: string;
  created_at: string;
  notified_at?: string;
  delivered_at?: string;
}

interface MailboxFile {
  worker: string;
  messages: MailboxMessage[];
}

function mailboxPath(teamName: string, workerName: string, cwd: string): string {
  return absPath(cwd, TeamPaths.mailbox(teamName, workerName));
}

async function readMailboxFile(teamName: string, workerName: string, cwd: string): Promise<MailboxFile> {
  const canonicalPath = mailboxPath(teamName, workerName, cwd);
  try {
    const raw = await readFile(canonicalPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MailboxFile>;
    if (parsed && Array.isArray(parsed.messages)) {
      return { worker: workerName, messages: parsed.messages as MailboxMessage[] };
    }
  } catch {
    // file missing or malformed — return empty mailbox
  }
  return { worker: workerName, messages: [] };
}

async function writeMailboxFile(teamName: string, workerName: string, cwd: string, mailbox: MailboxFile): Promise<void> {
  const canonicalPath = mailboxPath(teamName, workerName, cwd);
  await mkdir(join(canonicalPath, '..'), { recursive: true });
  await writeFile(canonicalPath, JSON.stringify(mailbox, null, 2), 'utf-8');
}

/**
 * Send a short trigger to a worker via tmux send-keys.
 * Uses literal mode (-l) to avoid stdin buffer interference.
 * Message MUST be < 500 chars.
 * Returns false on error — never throws.
 * File state is written BEFORE this is called (write-then-notify pattern).
 */
export async function sendTmuxTrigger(
  paneId: string,
  triggerType: string,
  payload?: string
): Promise<boolean> {
  const message = payload ? `${triggerType}:${payload}` : triggerType;
  if (message.length > 500) {
    console.warn(`[tmux-comm] sendTmuxTrigger: message rejected (${message.length} chars > 500 limit)`);
    return false;
  }
  const truncated = message;
  try {
    return await sendToWorker('', paneId, truncated);
  } catch {
    return false;
  }
}

/**
 * Write an instruction to a worker inbox, then send tmux trigger.
 * Write-then-notify: file is written first, trigger is sent after.
 * Notified flag set only on successful trigger.
 */
export async function queueInboxInstruction(
  teamName: string,
  workerName: string,
  instruction: string,
  paneId: string,
  cwd: string
): Promise<void> {
  const inboxPath = join(cwd, `.omg/state/team/${teamName}/workers/${workerName}/inbox.md`);
  await mkdir(join(inboxPath, '..'), { recursive: true });

  // Write FIRST (write-then-notify)
  const entry = `\n\n---\n${instruction}\n_queued: ${new Date().toISOString()}_\n`;
  await appendFile(inboxPath, entry, 'utf-8');

  // Notify AFTER write
  await sendTmuxTrigger(paneId, 'check-inbox');
}

/**
 * Send a direct message from one worker to another.
 * Write to mailbox first, then send tmux trigger to recipient.
 */
export async function queueDirectMessage(
  teamName: string,
  fromWorker: string,
  toWorker: string,
  body: string,
  toPaneId: string,
  cwd: string
): Promise<void> {
  const mailbox = await readMailboxFile(teamName, toWorker, cwd);
  const message: MailboxMessage = {
    message_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from_worker: fromWorker,
    to_worker: toWorker,
    body,
    created_at: new Date().toISOString(),
  };

  // Write FIRST
  mailbox.messages.push(message);
  await writeMailboxFile(teamName, toWorker, cwd, mailbox);

  // Update notifiedAt after successful trigger
  const notified = await sendTmuxTrigger(toPaneId, 'new-message', fromWorker);
  if (notified) {
    const updated = await readMailboxFile(teamName, toWorker, cwd);
    const entry = updated.messages.find((candidate) => candidate.message_id === message.message_id);
    if (entry) entry.notified_at = new Date().toISOString();
    await writeMailboxFile(teamName, toWorker, cwd, updated);
  }
}

/**
 * Broadcast a message to all workers.
 * Write to each mailbox first, then send triggers.
 */
export async function queueBroadcastMessage(
  teamName: string,
  fromWorker: string,
  body: string,
  workerPanes: Record<string, string>, // workerName -> paneId
  cwd: string
): Promise<void> {
  const workerNames = Object.keys(workerPanes);

  // Write to all mailboxes FIRST
  const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (const toWorker of workerNames) {
    const mailbox = await readMailboxFile(teamName, toWorker, cwd);
    const message: MailboxMessage = {
      message_id: messageId,
      from_worker: fromWorker,
      to_worker: toWorker,
      body,
      created_at: new Date().toISOString(),
    };
    mailbox.messages.push(message);
    await writeMailboxFile(teamName, toWorker, cwd, mailbox);
  }

  // Send triggers to all (best-effort)
  await Promise.all(
    workerNames.map(toWorker =>
      sendTmuxTrigger(workerPanes[toWorker], 'new-message', fromWorker)
    )
  );
}

/**
 * Read unread messages from a worker mailbox.
 * Returns messages since the given cursor (message ID or timestamp).
 */
export async function readMailbox(
  teamName: string,
  workerName: string,
  cwd: string
): Promise<Array<{ id: string; from: string; body: string; createdAt: string }>> {
  const mailbox = await readMailboxFile(teamName, workerName, cwd);
  return mailbox.messages.map((message) => ({
    id: message.message_id,
    from: message.from_worker,
    body: message.body,
    createdAt: message.created_at,
  }));
}
