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
import type { CassetteResponse } from './cassette.js';

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
// A name suffix that holds a count, a version or a setting rather than a secret (`token_count`, `password_policy`).
const NOT_SECRET_SUFFIX = String.raw`(?!_(?:count|version|policy|length|len|limit|type|size|id|name|file|path|url|endpoint|expires?|expiry|ttl)(?![A-Za-z0-9]))`;
// A secret-bearing name, possibly ending a longer identifier: `client_secret`, camelCase `clientSecret`,
// `AWS_SECRET_ACCESS_KEY`. The prefix is lazy, so the rules' lookbehind still anchors the name at a word start.
const SECRET_NAME = String.raw`[A-Za-z0-9]*?(?:api[_-]?key|private[_-]?key|secret|password|passwd|passphrase|pwd|token)${NOT_SECRET_SUFFIX}(?:_[A-Za-z0-9]+)*`;
const UNQUOTED_CHAR = String.raw`[^\s"'\x60\\,;&|<>(){}\[\]]`;
const UNQUOTED_VALUE = `${UNQUOTED_CHAR}{8,}`;
// A plain number or a version string is never a secret value (`token_count: 12345678`, `v2.0.1-beta`).
const PLAIN_VALUE = String.raw`(?!(?:\d+|v?\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.]+)?)(?!${UNQUOTED_CHAR}))`;

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
  // A token-shaped value (8+ token characters), so "Bearer of bad news" stays.
  { name: 'bearer', pattern: /\bBearer\s+[\w.~+/=-]{8,}/gi },
  { name: 'aws-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Needs a digit, so prose like "sk-learn-is-a-fine-library" stays.
  { name: 'openai-key', pattern: /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g },
  { name: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36,}/g },
  // Needs a digit or base64 symbol, so "Basic instructions" stays.
  { name: 'basic-auth', pattern: /(\bBasic\s+)(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2}/gi },
  {
    name: 'generic',
    // The name may end a longer identifier (`client_secret`, `AWS_SECRET_ACCESS_KEY`) and quotes may be escaped any
    // number of times; the value never takes the backslashes of its closing quote, so escaped JSON stays valid.
    pattern: new RegExp(String.raw`((?<![A-Za-z0-9])${SECRET_NAME}(?:\\*["'])?\s*[:=]\s*\\*["'])${PLACEHOLDER_VALUE}${PLAIN_VALUE}(?:[^"'\\]|\\+(?![\\"'])){8,}`, 'gi'),
  },
  // Unquoted values: env files and `--flag=value` (`=`), YAML (`name: value`, which must hold a digit or symbol so
  // prose like "password: requirements" stays) and `--flag value`. A `$VAR` reference or a placeholder is not a value.
  {
    name: 'generic',
    pattern: new RegExp(String.raw`((?<![A-Za-z0-9])${SECRET_NAME}[ \t]*=[ \t]*)(?![<$])${PLAIN_VALUE}${UNQUOTED_VALUE}`, 'gi'),
  },
  {
    name: 'generic',
    pattern: new RegExp(String.raw`((?<![A-Za-z0-9])${SECRET_NAME}:[ \t]*)(?![<$])${PLAIN_VALUE}(?=${UNQUOTED_CHAR}*[0-9+/=_])${UNQUOTED_VALUE}`, 'gi'),
  },
  {
    name: 'generic',
    pattern: new RegExp(String.raw`((?<![\w-])--(?:[A-Za-z0-9]+-)*${SECRET_NAME}[ \t]+)(?![<$-])${PLAIN_VALUE}${UNQUOTED_VALUE}`, 'gi'),
  },
];

// `icon@2x.png` is a retina asset name, not an address.
const EMAIL = /\b[A-Za-z0-9._%+-]+@(?![0-9]+x\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
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
  // The separator spelling is captured once, so `\n` after an escaped `\\` is not taken for a tail separator.
  // `\` doubles per JSON level, so any run of backslashes is a separator. The one after `Users` may be either
  // spelling (`C:\Users/name`), so the user name never survives a mixed path.
  /\b[A-Za-z]:(\\+|\/)Users(?:\1|\\+|\/)(?!<user>)[^\\/\s"'<>|:*?]+(?:(?:\1|\/)[^\\/\s"'<>|:*?]+)*/gi,
  // Percent-encoded (`file:///c%3A/Users/...`, `C%3A%5CUsers%5C...`).
  /\b[A-Za-z]%3A(?:%5C|%2F|\/)Users(?:%5C|%2F|\/)(?!<user>)(?:[^\\/\s"'<>|:*?%]|%(?!5C|2F)[0-9A-F]{2})+(?:(?:%5C|%2F|\/)(?:[^\\/\s"'<>|:*?%]|%(?!5C|2F)[0-9A-F]{2})+)*/gi,
  // POSIX, Git Bash (`/c/Users/...`) and WSL (`/mnt/c/Users/...`).
  /(?<![\w.$}-])\/(?:home|Users|(?:mnt\/)?[A-Za-z]\/Users)\/(?!<user>)[^/\s"'\\<>|:*?]+(?:\/[^/\s"'\\<>|:*?]+)*/g,
];
/** Length of the `<root>/Users/<name>` head of a {@link USER_HOME_PATHS} match. */
function userHomeHeadLength(match: string): number {
  return /^(?:[A-Za-z]:(\\+|\/)Users(?:\1|\\+|\/)[^\\/]+|[A-Za-z]%3A(?:%5C|%2F|\/)Users(?:%5C|%2F|\/)(?:[^\\/%]|%(?!5C|2F)[0-9A-F]{2})+|\/(?:home|Users|(?:mnt\/)?[A-Za-z]\/Users)\/[^\\/]+)/i.exec(match)?.[0].length ?? match.length;
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

// Named like credentials but never secret: the agent socket path and public keys.
const PLAIN_KEY_ENV = /^SSH_AUTH_SOCK$|PUBLIC_KEY$/i;

function isDenyEnvKey(key: string, env: NodeJS.ProcessEnv): boolean {
  if (GIT_CONFIG_PLAIN_ENV.test(key) || PLAIN_KEY_ENV.test(key)) return false;
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

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** The event blocks of an SSE stream, without the blank line ending each. Pass the chunks joined: a chunk boundary may fall anywhere. */
export function sseBlocks(text: string): string[] {
  return text.split(/\r?\n\r?\n/).filter((block) => block.trim() !== '');
}

/** The parsed `data:` payload of one SSE block (undefined when it is not JSON, e.g. `[DONE]`). */
export function sseData(block: string): unknown {
  const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
  return data ? parseJson(data) : undefined;
}

/** The block with its `data:` lines replaced by one line holding `value`. */
function withSseData(block: string, value: unknown): string {
  const lines = block.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('data:'));
  return lines.flatMap((l, i) => (!l.startsWith('data:') ? [l] : i === at ? [`data: ${JSON.stringify(value)}`] : [])).join('\n');
}

/** One delta of a streamed text field: `holder[field]` in parsed event number `event`. */
interface DeltaSlot { event: number; holder: Record<string, unknown>; field: string }

/**
 * The streamed text fields of parsed events (SSE payloads, WebSocket
 * messages or SDK session events), each as its deltas in order: Chat Completions
 * `choices[i].delta.<field>` and `choices[i].delta.tool_calls[j].function.arguments`,
 * and every Responses API `*.delta` event (`response.output_text.delta`,
 * `response.function_call_arguments.delta`, ...) per item and part.
 */
function deltaStreams(events: readonly unknown[]): DeltaSlot[][] {
  const streams = new Map<string, DeltaSlot[]>();
  const add = (key: string, event: number, holder: Record<string, unknown>, field: string) => {
    if (typeof holder[field] !== 'string') return;
    const slots = streams.get(key) ?? [];
    slots.push({ event, holder, field });
    streams.set(key, slots);
  };
  events.forEach((value, event) => {
    if (!isRecord(value)) return;
    if (Array.isArray(value.choices)) {
      value.choices.forEach((choice: unknown, i) => {
        if (!isRecord(choice) || !isRecord(choice.delta)) return;
        const delta = choice.delta;
        const key = `choice:${choice.index ?? i}`;
        for (const field of Object.keys(delta)) if (field !== 'role') add(`${key}:${field}`, event, delta, field);
        if (!Array.isArray(delta.tool_calls)) return;
        delta.tool_calls.forEach((call: unknown, j) => {
          if (isRecord(call) && isRecord(call.function)) add(`${key}:tool:${call.index ?? j}`, event, call.function, 'arguments');
        });
      });
    }
    if (typeof value.type === 'string' && value.type.endsWith('.delta')) {
      add([value.type, value.item_id, value.output_index, value.content_index, value.summary_index].join(':'), event, value, 'delta');
    }
    // SDK session events (`assistant.message_delta` `deltaContent`, `assistant.tool_call_delta` `inputDelta`, ...),
    // per message, tool call or reasoning id.
    if (typeof value.type === 'string' && value.type.endsWith('_delta') && isRecord(value.data)) {
      const data = value.data;
      const ids = Object.keys(data).filter((k) => /Id$/.test(k)).map((k) => `${k}=${String(data[k])}`).join(':');
      for (const field of Object.keys(data)) if (/delta/i.test(field)) add(`${value.type}:${ids}:${field}`, event, data, field);
    }
  });
  return [...streams.values()];
}

const joinDeltas = (slots: readonly DeltaSlot[]) => slots.map((s) => s.holder[s.field] as string).join('');

/**
 * The joined text of every streamed field split over two or more deltas. The
 * gate scans these: a secret split across SSE chunks or WebSocket messages
 * only shows once its deltas are joined.
 */
export function reassembledDeltas(events: readonly unknown[]): string[] {
  return deltaStreams(events).filter((slots) => slots.length > 1).map(joinDeltas);
}

/** Each WebSocket message's parsed JSON (undefined when it is not JSON). */
export function wsData(messages: readonly { data: string }[]): unknown[] {
  return messages.map((m) => parseJson(m.data));
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
  return `\${${name}}${match.slice(headLength).replace(/\\+|\/|%5C|%2F/gi, '/')}`;
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

  /**
   * Redact one response for disk: rule 2 on the headers, then the body. A
   * streamed text field split over several SSE events or WebSocket messages
   * is redacted as its joined text; when that changes it, the whole redacted
   * text goes into the field's first delta and its later deltas become empty,
   * so every event stays valid and the stream still joins to the redacted
   * text. SSE chunks are re-cut one per event (a recorded chunk boundary can
   * fall inside an event); replay serves the one stored response either way.
   */
  redactResponse(res: CassetteResponse): CassetteResponse {
    const headers = this.redactValue(filterResponseHeaders(res.headers));
    switch (res.kind) {
      case 'sse': {
        const blocks = sseBlocks(res.chunks.join(''));
        const events = blocks.map(sseData);
        const changed = this.redactDeltas(events);
        return { ...res, headers, chunks: blocks.map((b, i) => `${this.redact(changed.has(i) ? withSseData(b, events[i]) : b)}\n\n`) };
      }
      case 'ws': {
        const events = wsData(res.messages);
        const changed = this.redactDeltas(events);
        return { ...res, headers, messages: res.messages.map((m, i) => ({ dir: m.dir, data: this.redact(changed.has(i) ? JSON.stringify(events[i]) : m.data) })) };
      }
      case 'json': return { ...res, headers, body: this.redactValue(res.body) };
      case 'text': return { ...res, headers, body: this.redact(res.body) };
    }
  }

  /**
   * Redact a stream's SDK session events for disk (`events/<stream>.jsonl`).
   * Delta events (`assistant.message_delta`, `assistant.tool_call_delta`, ...)
   * are redacted per message as their joined text, as {@link redactResponse} does.
   */
  redactEvents<T>(events: readonly T[]): T[] {
    const copy = events.map((e) => structuredClone(e));
    this.redactDeltas(copy);
    return copy.map((e) => this.redactValue(e));
  }

  /** Redact each split streamed field as its joined text, in place; returns the numbers of the events it rewrote. */
  private redactDeltas(events: unknown[]): Set<number> {
    const changed = new Set<number>();
    for (const slots of deltaStreams(events)) {
      if (slots.length < 2) continue;
      const joined = joinDeltas(slots);
      const redacted = this.redact(joined);
      if (redacted === joined) continue;
      slots.forEach((s, i) => { s.holder[s.field] = i === 0 ? redacted : ''; changed.add(s.event); });
    }
    return changed;
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
  const tokenStart = hits.length;
  for (const { name, pattern } of TOKEN_RULES) {
    for (const m of text.matchAll(pattern)) {
      // `GH_TOKEN=ghp_...` is one finding: the specific rule's, not also the generic assignment's.
      const end = m.index + m[0].length;
      if (name === 'generic' && hits.slice(tokenStart).some((h) => h.rule !== 'generic' && h.index >= m.index && h.index < end)) continue;
      push(name, m.index, m[0]);
    }
  }
  for (const pattern of USER_HOME_PATHS) for (const m of text.matchAll(pattern)) push('path.USERHOME', m.index, m[0]);
  for (const m of text.matchAll(EMAIL)) if (isRedactableEmail(m[0])) push('email', m.index, m[0]);
  for (const [rule, value] of Object.entries(options.identity ?? {}) as Array<[keyof RedactionIdentity, string | undefined]>) {
    if (!value || value.length < 3) continue;
    const pattern = new RegExp(String.raw`(?<![A-Za-z0-9_.-])${escapeRegExp(value)}(?![A-Za-z0-9_-])`, 'gi');
    for (const m of text.matchAll(pattern)) push(rule, m.index, m[0]);
  }
  return hits.sort((a, b) => a.index - b.index);
}
