/**
 * Untrusted-text handling for the heal evidence bundle (design §4, §8). CI
 * logs are a prompt-injection surface: anyone who can open a PR can put text
 * into one. Every log-derived line is cleaned (ANSI, the GitHub prefix and
 * control characters removed), capped, and fenced in the debugger prompt
 * between per-run random delimiter lines. A line that carries the delimiter
 * prefix is dropped before it can reach a fence, so log text can never close
 * or reopen one.
 */

import { randomBytes } from 'crypto';
import { cleanLine } from './logs.js';

/** Every delimiter starts with this; a line carrying it is never fenced. */
export const DELIMITER_PREFIX = 'HEAL-UNTRUSTED-';
/** Characters per evidence line after cleaning. */
export const MAX_EVIDENCE_LINE_CHARS = 400;

// Control characters (tab kept), line and paragraph separators, and bidi/format controls.
const CONTROL = /(?!\t)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export const REDACTED = '[redacted]';
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // A whole PEM private key inside one string (JSON values); line by line, sanitizeLines tracks the block.
  [/-----BEGIN [A-Z0-9 ]*KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*KEY-----|$)/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // URL userinfo: https://user:pass@host, https://token@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`],
];

/** Secrets a CI log may echo (tokens, keys, URL credentials), replaced by {@link REDACTED}. */
export function redactSecrets(s: string): string {
  return SECRET_PATTERNS.reduce((acc, [re, by]) => acc.replace(re, by), s);
}

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*KEY-----/;
const KEY_END = /-----END [A-Z0-9 ]*KEY-----/;

/** One raw log line as evidence: prefix, ANSI and control characters gone, secrets redacted, capped. */
export function sanitizeLine(raw: string): string {
  return redactSecrets(cleanLine(raw).replace(CONTROL, ' ')).replace(/\s+$/, '').slice(0, MAX_EVIDENCE_LINE_CHARS);
}

/** True when the line could be read as a fence delimiter (any case). */
export function carriesDelimiter(line: string): boolean {
  return line.toUpperCase().includes(DELIMITER_PREFIX);
}

/** Sanitized lines with the delimiter-carrying ones dropped; `dropped` counts them. */
export function sanitizeLines(raw: readonly string[]): { lines: string[]; dropped: number } {
  const lines: string[] = [];
  let dropped = 0;
  let inKey = false;
  for (const r of raw) {
    // A private key block spans lines: every line from BEGIN to END is redacted (to the end of the file without END).
    const clean = cleanLine(r);
    if (!inKey && KEY_BEGIN.test(clean) && !KEY_END.test(clean)) { inKey = true; lines.push(REDACTED); continue; }
    if (inKey) { if (KEY_END.test(clean)) inKey = false; lines.push(REDACTED); continue; }
    const line = sanitizeLine(r);
    if (carriesDelimiter(line)) dropped += 1;
    else lines.push(line);
  }
  return { lines, dropped };
}

/** The first lines whose UTF-8 size (newlines included) fits `maxBytes`. */
export function capBytes(lines: readonly string[], maxBytes: number): { lines: string[]; cut: boolean } {
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    const n = Buffer.byteLength(line, 'utf8') + 1;
    if (size + n > maxBytes) return { lines: out, cut: true };
    size += n;
    out.push(line);
  }
  return { lines: out, cut: false };
}

/**
 * A JSON value with every string cleaned and capped and the delimiter prefix
 * defused, so a log-derived string inside a JSON file cannot fake a fence.
 */
export function sanitizeJson<T>(value: T, maxString = MAX_EVIDENCE_LINE_CHARS): T {
  const clean = (s: string) => redactSecrets(s).replace(CONTROL, ' ').replace(/HEAL-UNTRUSTED-/gi, 'HEAL_UNTRUSTED_').slice(0, maxString);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return clean(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [clean(k), walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** A fresh per-run delimiter (unguessable, so log text cannot carry it in advance). */
export function newDelimiter(): string {
  return `${DELIMITER_PREFIX}${randomBytes(8).toString('hex')}`;
}

/**
 * One bundle file as untrusted data in the prompt: numbered lines between the
 * delimiter's BEGIN and END lines. Lines carrying the delimiter are dropped
 * here too (defense in depth: the bundle never holds one).
 */
export function fenceUntrusted(delimiter: string, name: string, lines: readonly string[]): string {
  const kept = lines.map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => !carriesDelimiter(line) && !line.includes(delimiter));
  const width = String(lines.length).length;
  return [
    `<<<${delimiter} BEGIN file=${name} lines=${lines.length}`,
    ...kept.map(({ line, n }) => `${String(n).padStart(width)}| ${line}`),
    `${delimiter} END file=${name}>>>`,
  ].join('\n');
}
