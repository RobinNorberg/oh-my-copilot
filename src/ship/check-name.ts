/**
 * A forge-reported check name or state in a reason text (it may reach a PR
 * comment, the console or progress sync): one line, no control or format
 * characters (bidi, zero-width), no backticks, no '@' that could mention
 * someone (a full-width '＠' instead), no '|' that could split a table cell
 * ('¦'), capped at `max` code points (a surrogate pair is never split).
 * Decisions keep the raw names; only the text is sanitised.
 */
export const checkText = (s: string, max: number): string =>
  Array.from(s.replace(/\p{Cf}/gu, '').replace(/`/g, "'").replace(/@/g, '＠').replace(/\|/g, '¦')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('') || '(unnamed)';

/** A check name in a code span, so markdown links, HTML and `owner/repo#1` cross-references stay literal text. */
export const checkName = (s: string): string => `\`${checkText(s, 80)}\``;
