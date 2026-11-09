/**
 * `.copilot/team/decisions.md` (night-3 goal 5): the team's shared, append-only
 * decision log. Lanes read it (newest first, capped, fenced as repository
 * content). The base commit's text must stay a byte prefix of any PR head's
 * text: a PR may only append.
 */
export const DEFAULT_DECISIONS_MAX_BYTES = 8192;
const MAX_LINE_CHARS = 500;
const lf = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, '\n');
/**
 * Whether `head` only appends to `base` (undefined = file absent). An absent
 * base accepts anything; an absent head with a present base is a deletion.
 * Line endings are compared as LF; the last base line must be complete.
 */
export function decisionsAppendOnly(base, head) {
    if (base === undefined || lf(base) === '')
        return { ok: true };
    const b = lf(base);
    if (head === undefined)
        return { ok: false, reason: 'decisions.md is deleted' };
    const h = lf(head);
    if (h === b)
        return { ok: true };
    if (!h.startsWith(b))
        return { ok: false, reason: 'existing decisions.md lines are changed or removed' };
    if (!b.endsWith('\n'))
        return { ok: false, reason: 'the last existing decisions.md line is extended' };
    return { ok: true };
}
/** The newest decision lines (blank lines and `#` headings skipped) up to `maxBytes`, newest first. */
export function recentDecisions(text, maxBytes = DEFAULT_DECISIONS_MAX_BYTES) {
    const all = lf(text).split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
    const lines = [];
    let bytes = 0;
    for (let i = all.length - 1; i >= 0; i--) {
        const line = all[i].length > MAX_LINE_CHARS ? `${all[i].slice(0, MAX_LINE_CHARS)}...` : all[i];
        bytes += Buffer.byteLength(line, 'utf8') + 1;
        if (bytes > maxBytes)
            return { lines, truncated: true };
        lines.push(line);
    }
    return { lines, truncated: false };
}
//# sourceMappingURL=decisions.js.map