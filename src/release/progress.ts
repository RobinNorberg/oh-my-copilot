/**
 * Progress events for `omg release`, in the agent-progress line contract:
 *
 *   <ISO-8601 UTC> phase=<id> status=<start|ok|fail|blocked|heartbeat|done> [note=<v>] [agent=<v>]
 *
 * Written to `$OMG_PROGRESS_FILE` when set, else `<state root>/progress/release.log`.
 * Values that are not bare-safe are double-quoted with `\\`, `\"`, `\n`, `\r`,
 * `\t` escaped. The signature mirrors `emitProgress` of the shared progress
 * library so this module can be replaced by it. Emitting never throws: a
 * broken progress log must not break the release it reports on.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export type ReleaseProgressStatus = 'start' | 'ok' | 'fail' | 'blocked' | 'heartbeat' | 'done';

export interface ReleaseProgressInput {
  phase: string;
  status: ReleaseProgressStatus;
  note?: string;
  agent?: string;
  /** Explicit log path; wins over OMG_PROGRESS_FILE and the default location. */
  file?: string;
}

const BARE_VALUE = /^[A-Za-z0-9._:/@+,%#~-]+$/;
const MAX_NOTE = 500;

function quote(value: string): string {
  if (BARE_VALUE.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

export function formatReleaseProgress(input: Omit<ReleaseProgressInput, 'file'>, at: Date = new Date()): string {
  const parts = [at.toISOString(), `phase=${quote(input.phase)}`, `status=${input.status}`];
  if (input.note !== undefined) parts.push(`note=${quote(input.note.slice(0, MAX_NOTE))}`);
  if (input.agent !== undefined) parts.push(`agent=${quote(input.agent)}`);
  return parts.join(' ');
}

/** `$OMG_PROGRESS_FILE`, else `<stateRoot>/progress/release.log`. */
export function releaseProgressFile(stateRoot: string): string {
  return process.env.OMG_PROGRESS_FILE || join(stateRoot, 'progress', 'release.log');
}

/** Append one event; true when written. */
export function emitReleaseProgress(input: ReleaseProgressInput, stateRoot: string): boolean {
  try {
    const path = input.file || releaseProgressFile(stateRoot);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${formatReleaseProgress(input)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
