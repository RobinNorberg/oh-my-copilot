/**
 * Unit tests for the leader inbox reader (F2): worker messages to
 * `leader-fixed` that are neither delivered nor answered by a later reply.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readLeaderInbox } from '../mailbox-outstanding.js';

function mailbox(dir: string, owner: string, messages: unknown[]): void {
  writeFileSync(join(dir, `${owner}.json`), JSON.stringify({ worker: owner, messages }));
}

describe('readLeaderInbox', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omc-leader-inbox-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty list when the mailbox directory or leader mailbox is missing', async () => {
    expect(await readLeaderInbox(join(dir, 'missing'))).toEqual([]);
    expect(await readLeaderInbox(dir)).toEqual([]);
  });

  it('lists undelivered worker messages to the leader, oldest first', async () => {
    mailbox(dir, 'leader-fixed', [
      { message_id: 'm2', from_worker: 'worker-2', to_worker: 'leader-fixed', body: 'question', created_at: '2026-11-07T10:05:00.000Z' },
      { message_id: 'm1', from_worker: 'worker-1', to_worker: 'leader-fixed', body: 'BLOCKER: base?', created_at: '2026-11-07T10:00:00.000Z' },
      { message_id: 'm3', from_worker: 'worker-1', to_worker: 'leader-fixed', body: 'seen', created_at: '2026-11-07T10:01:00.000Z', delivered_at: '2026-11-07T10:02:00.000Z' },
    ]);

    expect(await readLeaderInbox(dir)).toEqual([
      { message_id: 'm1', from: 'worker-1', created_at: '2026-11-07T10:00:00.000Z', body: 'BLOCKER: base?' },
      { message_id: 'm2', from: 'worker-2', created_at: '2026-11-07T10:05:00.000Z', body: 'question' },
    ]);
  });

  it('treats a leader reply to the sender at or after the message as an answer', async () => {
    mailbox(dir, 'leader-fixed', [
      { message_id: 'm1', from_worker: 'worker-1', to_worker: 'leader-fixed', body: 'old blocker', created_at: '2026-11-07T10:00:00.000Z' },
      { message_id: 'm2', from_worker: 'worker-1', to_worker: 'leader-fixed', body: 'new blocker', created_at: '2026-11-07T10:10:00.000Z' },
    ]);
    mailbox(dir, 'worker-1', [
      { message_id: 'r1', from_worker: 'leader-fixed', to_worker: 'worker-1', body: 'use dev', created_at: '2026-11-07T10:05:00.000Z' },
      { message_id: 'x1', from_worker: 'worker-2', to_worker: 'worker-1', body: 'not the leader', created_at: '2026-11-07T10:20:00.000Z' },
    ]);

    const inbox = await readLeaderInbox(dir);
    expect(inbox.map((message) => message.message_id)).toEqual(['m2']);
  });

  it('tolerates a malformed leader mailbox', async () => {
    writeFileSync(join(dir, 'leader-fixed.json'), '{not json');
    expect(await readLeaderInbox(dir)).toEqual([]);
  });
});
