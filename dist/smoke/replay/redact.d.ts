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
import type { CassetteResponse } from './cassette.js';
/** Bumped whenever a rule changes what is redacted (recorded as `manifest.redaction.rules`). */
export declare const REDACTION_RULES_VERSION = 1;
/** Rule 1: request headers kept on disk (lower case). Everything else, `authorization` first, is dropped. */
export declare const REQUEST_HEADER_ALLOW: readonly ["content-type", "accept", "x-initiator", "openai-intent", "x-interaction-type", "copilot-vision-request"];
/** Rule 2: response headers kept on disk (lower case), plus every `x-ratelimit-*`. */
export declare const RESPONSE_HEADER_ALLOW: readonly ["content-type"];
/** Replaces each deny-set literal (rule 3). */
export declare const SECRET_PLACEHOLDER = "<secret>";
/** Rule 5 replacement for every email outside the reserved example domains. */
export declare const EMAIL_PLACEHOLDER = "user@example.invalid";
/** Minimum length of an env value that joins the deny set (shorter values would shred ordinary text). */
export declare const MIN_DENY_LITERAL_LENGTH = 8;
/** Rule 6 placeholder names, in the order the design lists them. */
export declare const PATH_PLACEHOLDERS: readonly ["PROJECT", "HOME", "ROOT", "REMOTE", "TMP", "USERHOME"];
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
/**
 * Rule 3's deny set: the bearer part of every Authorization value the handler
 * saw, every credential-named env value of at least
 * {@link MIN_DENY_LITERAL_LENGTH} characters (a git config value only when its
 * key is credential-bearing), and the sdk host's stdin credentials. Memory only.
 */
export declare function buildDenySet(sources: {
    env?: NodeJS.ProcessEnv;
    authorizations?: Iterable<string>;
    credentials?: Iterable<string>;
}): Set<string>;
/** Rule 1: keep only allowlisted request headers, lower-cased. */
export declare function filterRequestHeaders(headers: Record<string, string>): Record<string, string>;
export declare function isAllowedResponseHeader(key: string): boolean;
/** Rule 2: keep only allowlisted response headers, lower-cased. */
export declare function filterResponseHeaders(headers: Record<string, string>): Record<string, string>;
/** The event blocks of an SSE stream, without the blank line ending each. Pass the chunks joined: a chunk boundary may fall anywhere. */
export declare function sseBlocks(text: string): string[];
/** The raw `data:` payload of one SSE block (its `data:` lines joined). */
export declare function sseDataText(block: string): string;
/** The parsed `data:` payload of one SSE block (undefined when it is not JSON, e.g. `[DONE]`). */
export declare function sseData(block: string): unknown;
/**
 * The joined text of every streamed field split over two or more deltas. The
 * gate scans these: a secret split across SSE chunks or WebSocket messages
 * only shows once its deltas are joined.
 */
export declare function reassembledDeltas(events: readonly unknown[]): string[];
/** Each WebSocket message's parsed JSON (undefined when it is not JSON). */
export declare function wsData(messages: readonly {
    data: string;
}[]): unknown[];
/**
 * Turn the machine's dirs into `${NAME}` placeholders (rule 6). Used by the
 * recorder through {@link Redactor} and by the replay side before digesting a
 * live request, so both sides normalize to the same text.
 */
export declare function substitutePaths(text: string, dirs: PlaceholderDirs, onHit?: (rule: string) => void): string;
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
export declare function restorePlaceholders(text: string, dirs: PlaceholderDirs, options?: RestoreOptions): string;
/**
 * The recording-side redactor. One instance per recording: it holds the deny
 * set and the dirs, and accumulates `hits` for the manifest.
 */
export declare class Redactor {
    readonly hits: Record<string, number>;
    private readonly literals;
    private readonly dirs;
    private readonly identity;
    constructor(options?: RedactorOptions);
    private count;
    redact(text: string): string;
    /**
     * Redact one response for disk: rule 2 on the headers, then the body. A
     * streamed text field split over several SSE events or WebSocket messages
     * is redacted as its joined text; when that changes it, the whole redacted
     * text goes into the field's first delta and its later deltas become empty,
     * so every event stays valid and the stream still joins to the redacted
     * text. SSE chunks are re-cut one per event (a recorded chunk boundary can
     * fall inside an event); replay serves the one stored response either way.
     */
    redactResponse(res: CassetteResponse): CassetteResponse;
    /**
     * Redact a stream's SDK session events for disk (`events/<stream>.jsonl`).
     * Delta events (`assistant.message_delta`, `assistant.tool_call_delta`, ...)
     * are redacted per message as their joined text, as {@link redactResponse} does.
     */
    redactEvents<T>(events: readonly T[]): T[];
    /** Redact each split streamed field as its joined text, in place; returns the numbers of the events it rewrote. */
    private redactDeltas;
    /** Redact every string (values and keys) in a JSON-shaped value. */
    redactValue<T>(value: T): T;
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
export declare function scanForSecrets(text: string, options?: ScanOptions): SecretHit[];
//# sourceMappingURL=redact.d.ts.map