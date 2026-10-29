import { describe, expect, it } from 'vitest';
import { hasAcceptanceCriteria } from '../../../factory/run/plan-rules.js';
import { adoHtmlToText, decodeEntities } from '../html.js';
describe('adoHtmlToText', () => {
    it('turns headings and list items into markdown the plan rules read', () => {
        const html = '<div><h2>Acceptance criteria</h2><ul><li>Run <code>npm test</code></li><li><p>Exit code 0</p></li></ul></div>';
        const text = adoHtmlToText(html);
        expect(text).toBe('## Acceptance criteria\n\n- Run npm test\n- Exit code 0');
        expect(hasAcceptanceCriteria(text)).toBe(true);
    });
    it('decodes entities once and keeps no markup', () => {
        expect(adoHtmlToText('<p>a &lt;b&gt; &amp;amp; &#65;&#x42; &quot;q&quot;&nbsp;z</p>')).toBe('a <b> &amp; AB "q" z');
    });
    it('drops scripts, styles, comments and attributes', () => {
        expect(adoHtmlToText('<p onclick="x()">ok</p><script>alert(1)</script><style>p{}</style><!-- note --><img src=x onerror=y>')).toBe('ok');
    });
    it('drops a tag cut off at the end and an unterminated script', () => {
        expect(adoHtmlToText('text <a href="x')).toBe('text');
        expect(adoHtmlToText('safe<script>never')).toBe('safe');
    });
    it('collapses source whitespace and keeps paragraph breaks', () => {
        expect(adoHtmlToText('<p>one\n  two</p>\n\n<p>three</p><br><br><br>four')).toBe('one two\n\nthree\n\nfour');
    });
    it('is empty for a non-string or empty field', () => {
        expect(adoHtmlToText(undefined)).toBe('');
        expect(adoHtmlToText(null)).toBe('');
        expect(adoHtmlToText('')).toBe('');
        expect(adoHtmlToText('<ul><li></li></ul>')).toBe('');
    });
});
describe('decodeEntities', () => {
    it('drops control characters and replaces invalid code points', () => {
        expect(decodeEntities('a&#0;b&#27;c')).toBe('abc');
        expect(decodeEntities('&#xD800;&#x110000;')).toBe('��');
        expect(decodeEntities('&#9;&#10;')).toBe('\t\n');
    });
    it('keeps unknown names verbatim', () => {
        expect(decodeEntities('&bogus; &amp;')).toBe('&bogus; &');
    });
});
//# sourceMappingURL=html.test.js.map