/**
 * Azure DevOps rich-text fields (System.Description, AcceptanceCriteria,
 * comments) to plain text (factory forges design §5, §8.5). Headings become
 * `## …` and list items `- `, so the plan rules (ACCEPTANCE) and the check
 * rules read them like a GitHub issue body. Entities are decoded once and
 * every other tag is dropped: the result is text that goes into prompts
 * fenced as untrusted; it is never rendered and keeps no markup.
 */

const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™',
};

function codePoint(n: number): string {
  // Out of range and surrogates become U+FFFD; C0/C1 controls other than tab/newline are dropped.
  if (!Number.isFinite(n) || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
  if ((n < 0x20 && n !== 0x09 && n !== 0x0a) || (n >= 0x7f && n < 0xa0)) return '';
  return String.fromCodePoint(n);
}

/** One pass, so `&amp;lt;` stays `&lt;`. Unknown names are kept verbatim. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, ref: string) => {
    if (ref[0] === '#') return codePoint(ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10));
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

const BLOCK = /<\/?(?:p|div|ul|ol|table|thead|tbody|tr|blockquote|pre|section|article|header|footer|hr)\b[^>]*>/gi;

export function adoHtmlToText(html: unknown): string {
  if (typeof html !== 'string' || html === '') return '';
  const text = html
    // Source whitespace is insignificant in HTML.
    .replace(/\s+/g, ' ')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n## ')
    .replace(/<\/h[1-6]\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(BLOCK, '\n')
    .replace(/<\/?t[dh]\b[^>]*>/gi, ' ')
    // Every other tag, and a tag cut off at the end.
    .replace(/<[^>]*(?:>|$)/g, '');
  const lines = decodeEntities(text)
    .replace(/[\r\u2028\u2029]/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim());
  const out: string[] = [];
  // `<li><p>x</p></li>` leaves the marker on its own line: it prefixes the next text line.
  let marker = '';
  let blank = false;
  for (const line of lines) {
    if (line === '-' || line === '##') {
      marker = line;
    } else if (line === '') {
      blank = out.length > 0;
    } else {
      const next = marker ? `${marker} ${line}` : line;
      // One blank line between blocks, none between items of one list.
      if (blank && !(next.startsWith('- ') && out[out.length - 1].startsWith('- '))) out.push('');
      out.push(next);
      marker = '';
      blank = false;
    }
  }
  return out.join('\n');
}
