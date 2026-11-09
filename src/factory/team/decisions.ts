/**
 * `.copilot/team/decisions.md` (night-3 goal 5): the team's shared, append-only
 * decision log. Lanes read it (newest first, capped, fenced as repository
 * content). The base commit's text must stay a byte prefix of any PR head's
 * text: a PR may only append.
 */

import { visibleLine } from '../../forge/review-feedback.js';

export const DEFAULT_DECISIONS_MAX_BYTES = 8192;
const MAX_LINE_CHARS = 500;

const lf = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, '\n');

/**
 * Whether `head` only appends to `base` (undefined = file absent). An absent
 * base accepts anything; an absent head with a present base is a deletion.
 * Line endings are compared as LF; the last base line must be complete.
 */
export function decisionsAppendOnly(base: string | undefined, head: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (base === undefined || lf(base) === '') return { ok: true };
  const b = lf(base);
  if (head === undefined) return { ok: false, reason: 'decisions.md is deleted' };
  const h = lf(head);
  if (h === b) return { ok: true };
  if (!h.startsWith(b)) return { ok: false, reason: 'existing decisions.md lines are changed or removed' };
  // A base without a trailing newline: the only legitimate append starts a new line after it.
  if (!b.endsWith('\n') && !h.startsWith(`${b}\n`)) return { ok: false, reason: 'the last existing decisions.md line is extended' };
  return { ok: true };
}

/** The newest decision lines (blank lines and `#` headings skipped) up to `maxBytes`, newest first. */
export function recentDecisions(text: string, maxBytes = DEFAULT_DECISIONS_MAX_BYTES): { lines: string[]; truncated: boolean } {
  const all = lf(text).split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  const lines: string[] = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    // Control and format characters become <U+XXXX> first, so the caps count what the lane sees; cut by code points, never inside a surrogate pair.
    const shown = visibleLine(all[i]);
    const points = Array.from(shown);
    const line = points.length > MAX_LINE_CHARS ? `${points.slice(0, MAX_LINE_CHARS).join('')}...` : shown;
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    if (bytes > maxBytes) return { lines, truncated: true };
    lines.push(line);
  }
  return { lines, truncated: false };
}
