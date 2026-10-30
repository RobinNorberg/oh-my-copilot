/**
 * Request normalization for cassette digests (design:
 * .omc/plans/2026-10-29-copilot-replay-design.md, section 4). The recorder and
 * the replay matcher both digest `normalize(text)`, so run-specific noise
 * (dirs, ids, clocks, pids, durations) never makes two equivalent requests differ.
 *
 * Changing any rule here changes digests: bump {@link NORMALIZER_VERSION} and
 * the cassette version together.
 */
import { type PlaceholderDirs, type Redactor } from './redact.js';
export declare const NORMALIZER_VERSION = 1;
/** The stored `delta` is cut at this many UTF-8 bytes. */
export declare const DELTA_MAX_BYTES = 4096;
export interface NormalizeOptions {
    /** This machine's dirs, substituted with `${NAME}` placeholders first (section 5, rule 6). */
    dirs?: PlaceholderDirs;
}
/** Normalize text for digesting: placeholders, LF line ends, no trailing whitespace, run-specific tokens masked. */
export declare function normalize(text: string, options?: NormalizeOptions): string;
/** `sha256:<hex>` of a string. */
export declare function digest(text: string): string;
/** Digest of the normalized text. */
export declare function normalizedDigest(text: string, options?: NormalizeOptions): string;
/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a character,
 * marking the cut. Text that fits is returned unchanged.
 */
export declare function truncateUtf8(text: string, maxBytes?: number): string;
/**
 * The stored `delta` of a request: redact, then normalize, then truncate.
 * Redacting first means the cut can never leave part of a token below the
 * length its pattern needs.
 */
export declare function diskDelta(text: string, redactor: Redactor, maxBytes?: number): string;
//# sourceMappingURL=normalize.d.ts.map