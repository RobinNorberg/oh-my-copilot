import { describe, expect, it } from 'vitest';
import { decisionsAppendOnly, recentDecisions } from '../decisions.js';
describe('decisionsAppendOnly', () => {
    const base = '# Decisions\n- one\n- two\n';
    it('accepts unchanged, appended, and an absent or empty base', () => {
        expect(decisionsAppendOnly(base, base).ok).toBe(true);
        expect(decisionsAppendOnly(base, `${base}- three\n`).ok).toBe(true);
        expect(decisionsAppendOnly(undefined, 'anything').ok).toBe(true);
        expect(decisionsAppendOnly('', undefined).ok).toBe(true);
    });
    it('accepts CRLF-converted text', () => {
        expect(decisionsAppendOnly(base, `${base.replace(/\n/g, '\r\n')}- three\r\n`).ok).toBe(true);
    });
    it('rejects a rewrite, a removed line, a deleted file and an extended last line', () => {
        expect(decisionsAppendOnly(base, '# Decisions\n- one\n- TWO\n')).toMatchObject({ ok: false });
        expect(decisionsAppendOnly(base, '# Decisions\n- two\n')).toMatchObject({ ok: false });
        expect(decisionsAppendOnly(base, undefined)).toMatchObject({ ok: false, reason: expect.stringContaining('deleted') });
        expect(decisionsAppendOnly('- one', '- one and more')).toMatchObject({ ok: false });
        expect(decisionsAppendOnly('- one', '- one and\n- two')).toMatchObject({ ok: false });
    });
    it('rejects prepending', () => {
        expect(decisionsAppendOnly(base, `- zero\n${base}`)).toMatchObject({ ok: false });
    });
});
describe('decisionsAppendOnly with a base that has no trailing newline', () => {
    it('accepts a new line after it, with LF or CRLF', () => {
        expect(decisionsAppendOnly('- one', '- one\n- two').ok).toBe(true);
        expect(decisionsAppendOnly('- one', '- one\r\n- two\r\n').ok).toBe(true);
        expect(decisionsAppendOnly('# D\r\n- one', '# D\r\n- one\r\n- two').ok).toBe(true);
    });
    it('still rejects extending the last line, rewrites and deletion', () => {
        expect(decisionsAppendOnly('- one', '- one more')).toMatchObject({ ok: false });
        expect(decisionsAppendOnly('- one', '- ONE\n- two')).toMatchObject({ ok: false });
        expect(decisionsAppendOnly('- one', undefined)).toMatchObject({ ok: false });
    });
    it('handles a trailing-newline base, a CRLF base, an empty base, an absent base and a BOM', () => {
        expect(decisionsAppendOnly('- one\n', '- one\n- two').ok).toBe(true);
        expect(decisionsAppendOnly('- one\r\n', '- one\n- two\n').ok).toBe(true);
        expect(decisionsAppendOnly('', '- x').ok).toBe(true);
        expect(decisionsAppendOnly(undefined, undefined).ok).toBe(true);
        expect(decisionsAppendOnly('﻿- one\n', '- one\n- two').ok).toBe(true);
    });
});
describe('recentDecisions', () => {
    it('caps after control characters are made visible and never splits a surrogate pair', () => {
        const noisy = recentDecisions(`- ${'\u0001'.repeat(10)}`).lines[0];
        expect(noisy).not.toContain('\u0001');
        const emoji = recentDecisions(`- ${'\u{1F600}'.repeat(600)}`).lines[0];
        expect(emoji.endsWith('...')).toBe(true);
        expect(Array.from(emoji.slice(0, -3)).every((c) => c === '\u{1F600}' || c === '-' || c === ' ')).toBe(true);
    });
    it('returns newest first without headings or blanks', () => {
        expect(recentDecisions('# H\n\n- a\n- b\n- c\n').lines).toEqual(['- c', '- b', '- a']);
    });
    it('cuts at the byte cap and says so', () => {
        const r = recentDecisions('- aaaa\n- bbbb\n- cccc\n', 14);
        expect(r.lines).toEqual(['- cccc', '- bbbb']);
        expect(r.truncated).toBe(true);
    });
    it('cuts one very long line', () => {
        expect(recentDecisions(`- ${'x'.repeat(2000)}`).lines[0].length).toBeLessThan(510);
    });
});
//# sourceMappingURL=decisions.test.js.map