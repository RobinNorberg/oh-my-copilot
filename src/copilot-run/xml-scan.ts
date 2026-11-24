/**
 * A tolerant single-pass XML tag scanner for the textual reads of a
 * repository's NuGet and MSBuild files (dotnet-sandbox.ts nugetConfigVerdict,
 * factory/run/dotnet-package-refs.ts). It never backtracks: every step moves
 * forward, and each `indexOf` either finds its end and jumps past it or ends
 * the scan, so a crafted file costs linear time (a backtracking regex over
 * `<!--` or an unclosed quote repeated took seconds at 256 KB).
 *
 * Not an XML parser. It reports the tags in order (comments skipped, a
 * quoted attribute value may hold `>`), and in `odd` every shape a reader
 * that relies on it should not trust: CDATA, a DOCTYPE, a processing
 * instruction other than a leading `<?xml ...?>` declaration, an entity
 * reference other than the five predefined ones, an unquoted attribute, an
 * unterminated comment, tag or value (the scan ends there), a stray `<`, a
 * close tag that does not match, an unclosed element, or a second root.
 */

export interface XmlTag {
  /** The tag name as written. */
  name: string;
  /** `</name>`. */
  close: boolean;
  /** `<name ... />`. */
  selfClose: boolean;
  /** [name, value] as written (entities not decoded). */
  attrs: Array<[string, string]>;
  /** The name of the element directly around this tag ('' at the top; for a close tag: around the element it closes). */
  parent: string;
}

export interface XmlScan {
  tags: XmlTag[];
  /** The text outside comments, tags and markup declarations (entities not decoded), joined by spaces. */
  text: string;
  /** Why the scan is not to be trusted (see the module comment); empty when nothing odd was seen. */
  odd: string[];
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const NAME_END = new Set([' ', '\t', '\n', '\r', '/', '>', '<', '=', '"', "'"]);
const PREDEFINED = ['amp;', 'lt;', 'gt;', 'quot;', 'apos;'];

/** True when every `&` of `s` starts one of the five predefined entity references (no numeric or named other). */
export function onlyPredefinedEntities(s: string): boolean {
  for (let k = s.indexOf('&'); k >= 0; k = s.indexOf('&', k + 1)) {
    if (!PREDEFINED.some((e) => s.startsWith(e, k + 1))) return false;
  }
  return true;
}

/** Scan `xml` (see the module comment). */
export function scanXml(xml: string): XmlScan {
  const n = xml.length;
  const tags: XmlTag[] = [];
  const text: string[] = [];
  const odd = new Set<string>();
  const stack: string[] = [];
  let rootClosed = false;
  let sawElement = false;
  let i = 0;
  // Where an XML declaration may stand: the first `<`, with only whitespace before it.
  const first = xml.indexOf('<');
  const declAt = first >= 0 && xml.slice(0, first).trim() === '' ? first : -1;
  const pushText = (s: string): void => {
    if (!s) return;
    if (!onlyPredefinedEntities(s)) odd.add('an entity reference other than the five predefined ones');
    text.push(s);
  };
  for (;;) {
    const lt = xml.indexOf('<', i);
    pushText(xml.slice(i, lt < 0 ? n : lt));
    if (lt < 0) break;
    i = lt;
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end < 0) { odd.add('an unterminated comment'); break; }
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      odd.add('a CDATA section');
      const end = xml.indexOf(']]>', i + 9);
      if (end < 0) { odd.add('an unterminated CDATA section'); break; }
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', i)) {
      odd.add('a DOCTYPE or markup declaration');
      const end = xml.indexOf('>', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      if (end < 0) { odd.add('an unterminated processing instruction'); break; }
      let t = i + 2;
      while (t < end && !NAME_END.has(xml[t]) && xml[t] !== '?') t++;
      const target = xml.slice(i + 2, t);
      // The XML declaration: only first in the file (whitespace before it is already odd for XML, but harmless here).
      if (target !== 'xml' || i !== declAt) odd.add('a processing instruction');
      i = end + 2;
      continue;
    }
    // A tag.
    let j = i + 1;
    const close = xml[j] === '/';
    if (close) j++;
    const nameStart = j;
    while (j < n && !NAME_END.has(xml[j])) j++;
    const name = xml.slice(nameStart, j);
    const attrs: Array<[string, string]> = [];
    let selfClose = false;
    let ended = false;
    let cut = false;
    while (j < n) {
      const c = xml[j];
      if (isSpace(c)) { j++; continue; }
      if (c === '>') { j++; ended = true; break; }
      if (c === '/' && xml[j + 1] === '>') { j += 2; selfClose = true; ended = true; break; }
      if (c === '<') { odd.add('a stray <'); ended = true; break; }
      const an = j;
      while (j < n && !NAME_END.has(xml[j])) j++;
      if (j === an) { odd.add('a stray character in a tag'); j++; continue; }
      const attr = xml.slice(an, j);
      while (j < n && isSpace(xml[j])) j++;
      if (xml[j] !== '=') { attrs.push([attr, '']); continue; }
      j++;
      while (j < n && isSpace(xml[j])) j++;
      const q = xml[j];
      if (q === '"' || q === "'") {
        const end = xml.indexOf(q, j + 1);
        if (end < 0) { odd.add('an unterminated attribute value'); cut = true; break; }
        const value = xml.slice(j + 1, end);
        if (!onlyPredefinedEntities(value)) odd.add('an entity reference other than the five predefined ones');
        attrs.push([attr, value]);
        j = end + 1;
      } else {
        odd.add('an unquoted attribute value');
        const vs = j;
        while (j < n && !isSpace(xml[j]) && xml[j] !== '>') j++;
        attrs.push([attr, xml.slice(vs, j)]);
      }
    }
    if (cut) break;
    if (!ended) { odd.add('an unterminated tag'); break; }
    if (!name) { odd.add('a tag without a name'); i = j; continue; }
    if (close) {
      if (stack[stack.length - 1] !== name) odd.add('a close tag that does not match');
      else stack.pop();
      tags.push({ name, close, selfClose: false, attrs, parent: stack[stack.length - 1] ?? '' });
      if (stack.length === 0) rootClosed = true;
    } else {
      if (stack.length === 0 && (sawElement || rootClosed)) odd.add('a second root element');
      sawElement = true;
      tags.push({ name, close, selfClose, attrs, parent: stack[stack.length - 1] ?? '' });
      if (selfClose) { if (stack.length === 0) rootClosed = true; } else stack.push(name);
    }
    i = j;
  }
  if (stack.length > 0) odd.add('an unclosed element');
  return { tags, text: text.join(' '), odd: [...odd] };
}
