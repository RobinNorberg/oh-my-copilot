/**
 * `.copilot/team/decisions.md` (night-3 goal 5): the team's shared, append-only
 * decision log. Lanes read it (newest first, capped, fenced as repository
 * content). The base commit's text must stay a byte prefix of any PR head's
 * text: a PR may only append.
 */
export declare const DEFAULT_DECISIONS_MAX_BYTES = 8192;
/**
 * Whether `head` only appends to `base` (undefined = file absent). An absent
 * base accepts anything; an absent head with a present base is a deletion.
 * Line endings are compared as LF; the last base line must be complete.
 */
export declare function decisionsAppendOnly(base: string | undefined, head: string | undefined): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** The newest decision lines (blank lines and `#` headings skipped) up to `maxBytes`, newest first. */
export declare function recentDecisions(text: string, maxBytes?: number): {
    lines: string[];
    truncated: boolean;
};
//# sourceMappingURL=decisions.d.ts.map