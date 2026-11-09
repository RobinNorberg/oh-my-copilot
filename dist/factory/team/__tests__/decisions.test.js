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
        expect(decisionsAppendOnly('- one', '- one\n- two')).toMatchObject({ ok: false });
    });
    it('rejects prepending', () => {
        expect(decisionsAppendOnly(base, `- zero\n${base}`)).toMatchObject({ ok: false });
    });
});
describe('recentDecisions', () => {
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