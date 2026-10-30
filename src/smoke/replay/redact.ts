/**
 * Cassette redaction (design: .omc/plans/2026-10-29-copilot-replay-design.md,
 * section 5). Two entry points over the same rule set:
 *
 * - {@link Redactor.redact}: the recording side. Rewrites a string before any
 *   byte of it is buffered for disk and counts hits per rule.
 * - {@link scanForSecrets}: the gate. Detect-only: rules 3 to 5 plus the
 *   user-home path fallback, and every deny-set literal when one is known.
 *   Any hit fails the gate; callers never write or import a cassette that has one.
 *
 * Strings may hold JSON (a body, an SSE `data:` payload) and JSON inside JSON
 * (tool-call `arguments`), so literals and paths are matched in their plain,
 * once- and twice-JSON-escaped spellings.
 */

import { isCredentialEnvKey } from '../copilot-session-env.js';

/** Bumped whenever a rule changes what is redacted (recorded as `manifest.redaction.rules`). */
export const REDACTION_RULES_VERSION = 1;

/** Rule 1: request headers kept on disk (lower case). Everything else, `authorization` first, is dropped. */
export const REQUEST_HEADER_ALLOW = [
  'content-type', 'accept', 'x-initiator', 'openai-intent', 'x-interaction-type', 'copilot-vision-request',
] as const;
/** Rule 2: response headers kept on disk (lower case), plus every `x-ratelimit-*`. */
export const RESPONSE_HEADER_ALLOW = ['content-type'] as const;
const RESPONSE_HEADER_PREFIX_ALLOW = ['x-ratelimit-'] as const;

/** Replaces each deny-set literal (rule 3). */
export const SECRET_PLACEHOLDER = '<secret>';
/** Rule 5 replacement for every email outside the reserved example domains. */
export const EMAIL_PLACEHOLDER = 'user@example.invalid';
/** Minimum length of an env value that joins the deny set (shorter values would shred ordinary text). */
export const MIN_DENY_LITERAL_LENGTH = 8;

/** Rule 6 placeholder names, in the order the design lists them. */
export const PATH_PLACEHOLDERS = ['PROJECT', 'HOME', 'ROOT', 'REMOTE', 'TMP', 'USERHOME'] as const;
export type PathPlaceholder = typeof PATH_PLACEHOLDERS[number];
/** The machine's directories behind each placeholder (record side: the smoke's dirs; replay side: the replay sandbox's). */
export type PlaceholderDirs = Partial<Record<PathPlaceholder, string>>;

export interface RedactionIdentity {
  /** `os.userInfo().username`. */
  user?: string;
  /** `os.hostname()`. */
  host?: string;
  /** The Copilot login (`lastLoggedInUser.login`). */
  login?: string;
}

export interface RedactorOptions {
  /** Rule 3: known secret literals (memory only, never written). Build with {@link buildDenySet}. */
  denyLiterals?: Iterable<string>;
  /** Rule 6: directories to turn into `${NAME}` placeholders. */
  dirs?: PlaceholderDirs;
  /** Rule 5: identity strings. */
  identity?: RedactionIdentity;
}

export interface SecretHit {
  rule: string;
  /** Offset of the match in the scanned text. */
  index: number;
  /** The match, masked for printing; the raw value is never returned. */
  masked: string;
}

interface PatternRule {
  name: string;
  pattern: RegExp;
}

// Placeholders this module writes; the generic rule must not flag its own output.
const PLACEHOLDER_VALUE = String.raw`(?!<(?:secret|redacted:[\w.-]+)>)`;

/**
 * Rule 4 token patterns, plus the private-key block. Each match is replaced
 * with `<redacted:<name>>`, keeping capture group 1 when a rule has one: the
 * generic rule keeps its key and opening quote, so `"password":"x"` (plain or
 * escaped) stays valid JSON.
 */
const TOKEN_RULES: readonly PatternRule[] = [
  { name: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { name: 'capi-token', pattern: /\btid=[^;\s"\\]+;exp=\d+[^"\s\\]*/g },
  { name: 'jwt', pattern: /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g },
  { name: 'bearer', pattern: /\bBearer\s+(?!<redacted:)[^\s"'\\]+/gi },
  { name: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: 'generic',
    // The name may end a longer identifier (`client_secret`, `AWS_SECRET_ACCESS_KEY`) and quotes may be escaped any
    // number of times; the value never takes the backslashes of its closing quote, so escaped JSON stays valid.
    pattern: new RegExp(String.raw`((?<![A-Za-z0-9])(?:api[_-]?key|secret|password|token)(?:_[A-Za-z0-9]+)*(?:\\*["'])?\s*[:=]\s*\\*["'])${PLACEHOLDER_VALUE}(?:[^"'\\]|\\+(?![\\"'])){8,}`, 'gi'),
  },
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
// Reserved names (RFC 2606/6761) carry no identity: the smoke's own git identity is omg-smoke@example.invalid.
const RESERVED_EMAIL = /@(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|invalid|test|localhost)$/i;
// `git@github.com:owner/repo` is a transport, not a person.
const TRANSPORT_EMAIL = /^git@/i;

/**
 * Absolute paths under some user's home in any spelling (plain, forward-slash,
 * JSON-escaped): rule 6's fallback on the record side, a gate hit when found later.
 * The home segment must not be a placeholder this module wrote.
 */
const USER_HOME_PATHS: readonly RegExp[] = [
  // The separator spelling is captured once, so `\n` after an escaped `\\` is not taken for a separator.
  // `\` doubles per JSON level, so any run of backslashes is a separator.
  /\b[A-Za-z]:(\\+|\/)Users\1(?!<user>)[^\\/\s"'<>|:*?]+(?:(?:\1|\/)[^\\/\s"'<>|:*?]+)*/gi,
  // POSIX, Git Bash (`/c/Users/...`) and WSL (`/mnt/c/Users/...`).
  /(?<![\w.$}-])\/(?:home|Users|(?:mnt\/)?[A-Za-z]\/Users)\/(?!<user>)[^/\s"'\\<>|:*?]+(?:\/[^/\s"'\\<>|:*?]+)*/g,
];
/** Length of the `<root>/Users/<name>` head of a {@link USER_HOME_PATHS} match. */
function userHomeHeadLength(match: string): number {
  return /^(?:[A-Za-z]:(\\+|\/)Users\1|\/(?:home|Users|(?:mnt\/)?[A-Za-z]\/Users)\/)[^\\/]+/i.exec(match)?.[0].length ?? match.length;
}

// One path segment character (no separators, quotes, whitespace or reserved Windows characters).
const SEGMENT_CHAR = String.raw`[^\\/\s"'<>|:*?]`;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const jsonEscape = (s: string) => JSON.stringify(s).slice(1, -1);

/** The spellings a literal can take inside text that holds JSON, longest first. */
function escapedVariants(literal: string): string[] {
  const once = jsonEscape(literal);
  const twice = jsonEscape(once);
  return [...new Set([twice, once, literal])].sort((a, b) => b.length - a.length);
}

function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 4)}****`;
}

function isWindowsPath(dir: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith('\\\\');
}

// Key material the session env helper does not name (COPILOT_HMAC_KEY signs CAPI requests).
const KEY_ENV = /HMAC|_KEY$/i;
// Git config env that names files, counts or setting names, never secrets.
const GIT_CONFIG_PLAIN_ENV = /^GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM|COUNT|KEY_\d+)$/i;
// GIT_CONFIG_VALUE_<n> is a secret only when GIT_CONFIG_KEY_<n> is credential-bearing (http.extraheader).
const GIT_CONFIG_SECRET_KEY = /extraheader|password|token|secret|auth|cookie/i;

function isDenyEnvKey(key: string, env: NodeJS.ProcessEnv): boolean {
  if (GIT_CONFIG_PLAIN_ENV.test(key)) return false;
  const value = /^GIT_CONFIG_VALUE_(\d+)$/i.exec(key);
  if (value) {
    const configKey = env[`GIT_CONFIG_KEY_${value[1]}`];
    return configKey === undefined || GIT_CONFIG_SECRET_KEY.test(configKey);
  }
  return isCredentialEnvKey(key) || KEY_ENV.test(key);
}

/**
 * Rule 3's deny set: the bearer part of every Authorization value the handler
 * saw, every credential-named env value of at least
 * {@link MIN_DENY_LITERAL_LENGTH} characters (a git config value only when its
 * key is credential-bearing), and the sdk host's stdin credentials. Memory only.
 */
export function buildDenySet(sources: {
  env?: NodeJS.ProcessEnv;
  authorizations?: Iterable<string>;
  credentials?: Iterable<string>;
}): Set<string> {
  const out = new Set<string>();
  const add = (value: string | undefined) => {
    const v = value?.trim();
    if (v && v.length >= MIN_DENY_LITERAL_LENGTH) out.add(v);
  };
  const env = sources.env ?? {};
  for (const [key, value] of Object.entries(env)) if (isDenyEnvKey(key, env)) add(value);
  for (const auth of sources.authorizations ?? []) {
    add(auth);
    add(auth.replace(/^\s*[A-Za-z-]+\s+/, ''));
  }
  for (const cred of sources.credentials ?? []) add(cred);
  return out;
}

/** Rule 1: keep only allowlisted request headers, lower-cased. */
export function filterRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if ((REQUEST_HEADER_ALLOW as readonly string[]).includes(k)) out[k] = value;
  }
  return out;
}

export function isAllowedResponseHeader(key: string): boolean {
  const k = key.toLowerCase();
  return (RESPONSE_HEADER_ALLOW as readonly string[]).includes(k) || RESPONSE_HEADER_PREFIX_ALLOW.some((p) => k.startsWith(p));
}

/** Rule 2: keep only allowlisted response headers, lower-cased. */
export function filterResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) if (isAllowedResponseHeader(key)) out[key.toLowerCase()] = value;
  return out;
}

interface PathMatcher {
  name: PathPlaceholder;
  pattern: RegExp;
  /** Length of the dir spelling (a case-insensitive match has the same length). */
  headLength: number;
}

/**
 * One matcher per placeholder dir and spelling: the dir itself, then its tail
 * of path segments joined by that spelling's separator (or `/`). The dir
 * must end at a segment boundary (`/tmp/p` does not match `/tmp/proj`).
 * Windows dirs match in any case. Ordered longest spelling first so a nested
 * dir wins over its parent and an escaped spelling over the plain one.
 */
function pathMatchers(dirs: PlaceholderDirs): PathMatcher[] {
  const out: PathMatcher[] = [];
  for (const name of PATH_PLACEHOLDERS) {
    const dir = dirs[name]?.replace(/[\\/]+$/, '');
    if (!dir) continue;
    const win = isWindowsPath(dir);
    // spelling -> its tail separator as a regex source
    const spellings = new Map<string, string>([[dir.replace(/\\/g, '/'), '/']]);
    if (win) {
      const back = dir.replace(/\//g, '\\');
      spellings.set(back, String.raw`\\`);
      spellings.set(jsonEscape(back), String.raw`\\\\`);
      spellings.set(jsonEscape(jsonEscape(back)), String.raw`\\\\\\\\`);
    }
    for (const [spelling, sep] of spellings) {
      out.push({
        name,
        headLength: spelling.length,
        pattern: new RegExp(`${escapeRegExp(spelling)}(?!${SEGMENT_CHAR})(?:(?:${sep}|/)${SEGMENT_CHAR}+)*`, win ? 'gi' : 'g'),
      });
    }
  }
  return out.sort((a, b) => b.headLength - a.headLength);
}

/** `${NAME}` plus the matched tail, separators normalized to `/`. */
function placeholderPath(name: string, match: string, headLength: number): string {
  return `\${${name}}${match.slice(headLength).replace(/\\+|\//g, '/')}`;
}

/**
 * Turn the machine's dirs into `${NAME}` placeholders (rule 6). Used by the
 * recorder through {@link Redactor} and by the replay side before digesting a
 * live request, so both sides normalize to the same text.
 */
export function substitutePaths(text: string, dirs: PlaceholderDirs, onHit?: (rule: string) => void): string {
  let out = text;
  for (const { name, pattern, headLength } of pathMatchers(dirs)) {
    out = out.replace(pattern, (match) => {
      onHit?.(`path.${name}`);
      return placeholderPath(name, match, headLength);
    });
  }
  return out;
}

export interface RestoreOptions {
  /**
   * How many JSON string levels the placeholders sit inside (0: plain text,
   * 1: a JSON body or SSE payload, 2: a tool call's `arguments` string inside
   * one). Default 0. Only matters for dirs that contain `\` or `"`.
   */
  jsonDepth?: number;
  /** `/` (default) writes Windows dirs with forward slashes, which needs no escaping; `native` keeps the dir's own separator. */
  separator?: '/' | 'native';
}

/** Substitute `${NAME}` placeholders back with this machine's dirs (the replay side of rule 6). */
export function restorePlaceholders(text: string, dirs: PlaceholderDirs, options: RestoreOptions = {}): string {
  const depth = options.jsonDepth ?? 0;
  return text.replace(/\$\{(PROJECT|HOME|ROOT|REMOTE|TMP|USERHOME)\}((?:\/[^\\/\s"'<>|:*?]+)*)/g, (match, name: PathPlaceholder, tail: string) => {
    const dir = dirs[name]?.replace(/[\\/]+$/, '');
    if (!dir) return match;
    const nativeBack = options.separator === 'native' && isWindowsPath(dir);
    let path = nativeBack ? `${dir.replace(/\//g, '\\')}${tail.replace(/\//g, '\\')}` : `${dir.replace(/\\/g, '/')}${tail}`;
    for (let i = 0; i < depth; i++) path = jsonEscape(path);
    return path;
  });
}

function replaceIdentity(text: string, value: string | undefined, placeholder: string, onHit: (rule: string) => void, rule: string): string {
  // Short names would shred ordinary words; the deny set covers real secrets.
  if (!value || value.length < 3) return text;
  const pattern = new RegExp(String.raw`(?<![A-Za-z0-9_.-])${escapeRegExp(value)}(?![A-Za-z0-9_-])`, 'gi');
  return text.replace(pattern, () => { onHit(rule); return placeholder; });
}

function isRedactableEmail(email: string): boolean {
  return email !== EMAIL_PLACEHOLDER && !RESERVED_EMAIL.test(email) && !TRANSPORT_EMAIL.test(email);
}

/**
 * The recording-side redactor. One instance per recording: it holds the deny
 * set and the dirs, and accumulates `hits` for the manifest.
 */
export class Redactor {
  readonly hits: Record<string, number> = {};
  private readonly literals: string[];
  private readonly dirs: PlaceholderDirs;
  private readonly identity: RedactionIdentity;

  constructor(options: RedactorOptions = {}) {
    const variants = new Set<string>();
    for (const literal of options.denyLiterals ?? []) if (literal) for (const v of escapedVariants(literal)) variants.add(v);
    this.literals = [...variants].sort((a, b) => b.length - a.length);
    this.dirs = options.dirs ?? {};
    this.identity = options.identity ?? {};
  }

  private count = (rule: string) => { this.hits[rule] = (this.hits[rule] ?? 0) + 1; };

  redact(text: string): string {
    let out = text;
    for (const literal of this.literals) {
      if (!out.includes(literal)) continue;
      out = out.split(literal).join(SECRET_PLACEHOLDER);
      this.count('secret');
    }
    for (const { name, pattern } of TOKEN_RULES) {
      out = out.replace(pattern, (_m, keep?: string) => { this.count(name); return `${typeof keep === 'string' ? keep : ''}<redacted:${name}>`; });
    }
    out = substitutePaths(out, this.dirs, this.count);
    for (const pattern of USER_HOME_PATHS) {
      out = out.replace(pattern, (match) => {
        this.count('path.USERHOME');
        return placeholderPath('USERHOME', match, userHomeHeadLength(match));
      });
    }
    out = out.replace(EMAIL, (email) => {
      if (!isRedactableEmail(email)) return email;
      this.count('email');
      return EMAIL_PLACEHOLDER;
    });
    out = replaceIdentity(out, this.identity.login, '<login>', this.count, 'login');
    out = replaceIdentity(out, this.identity.user, '<user>', this.count, 'user');
    out = replaceIdentity(out, this.identity.host, '<host>', this.count, 'host');
    return out;
  }

  /** Redact every string (values and keys) in a JSON-shaped value. */
  redactValue<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[this.redact(k)] = this.redactValue(v);
      return out as T;
    }
    return value;
  }
}

export interface ScanOptions {
  /** Deny-set literals to look for (record time). */
  denyLiterals?: Iterable<string>;
  /** Identity strings to look for (record time). */
  identity?: RedactionIdentity;
}

/**
 * The gate's detect-only pass over one text: rule 3 (deny set), rule 4
 * (token patterns), rule 5 (emails, identity) and user-home paths. Returns
 * every hit with its value masked; an empty list is the only passing result.
 */
export function scanForSecrets(text: string, options: ScanOptions = {}): SecretHit[] {
  const hits: SecretHit[] = [];
  const push = (rule: string, index: number, value: string) => hits.push({ rule, index, masked: rule === 'secret' ? '****' : mask(value) });
  for (const literal of options.denyLiterals ?? []) {
    if (!literal) continue;
    for (const variant of escapedVariants(literal)) {
      let at = text.indexOf(variant);
      while (at !== -1) {
        push('secret', at, variant);
        at = text.indexOf(variant, at + variant.length);
      }
    }
  }
  for (const { name, pattern } of TOKEN_RULES) for (const m of text.matchAll(pattern)) push(name, m.index, m[0]);
  for (const pattern of USER_HOME_PATHS) for (const m of text.matchAll(pattern)) push('path.USERHOME', m.index, m[0]);
  for (const m of text.matchAll(EMAIL)) if (isRedactableEmail(m[0])) push('email', m.index, m[0]);
  for (const [rule, value] of Object.entries(options.identity ?? {}) as Array<[keyof RedactionIdentity, string | undefined]>) {
    if (!value || value.length < 3) continue;
    const pattern = new RegExp(String.raw`(?<![A-Za-z0-9_.-])${escapeRegExp(value)}(?![A-Za-z0-9_-])`, 'gi');
    for (const m of text.matchAll(pattern)) push(rule, m.index, m[0]);
  }
  return hits.sort((a, b) => a.index - b.index);
}
