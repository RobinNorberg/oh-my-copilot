/**
 * Request normalization for cassette digests (design:
 * .omc/plans/2026-10-29-copilot-replay-design.md, section 4). The recorder and
 * the replay matcher both digest `normalize(text)`, so run-specific noise
 * (dirs, ids, clocks, pids, durations) never makes two equivalent requests differ.
 *
 * Changing any rule here changes digests: bump {@link NORMALIZER_VERSION} and
 * the cassette version together.
 */
import { createHash } from 'crypto';
import { substitutePaths } from './redact.js';
export const NORMALIZER_VERSION = 1;
/** The stored `delta` is cut at this many UTF-8 bytes. */
export const DELTA_MAX_BYTES = 4096;
// Order matters: UUIDs before hex runs (a UUID's last group is 12 hex digits),
// ISO timestamps before epoch-ms (both hold digit runs).
const RULES = [
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
    [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<ts>'],
    [/\b1\d{12}\b/g, '<ts>'],
    [/\b[0-9a-f]{12,}\b/gi, '<hex>'],
    [/\bpid \d+/gi, 'pid <n>'],
    [/\b\d+(?:\.\d+)? ?ms\b/g, '<ms>'],
];
/** Normalize text for digesting: placeholders, LF line ends, no trailing whitespace, run-specific tokens masked. */
export function normalize(text, options = {}) {
    let out = options.dirs ? substitutePaths(text, options.dirs) : text;
    out = out.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
    for (const [pattern, replacement] of RULES)
        out = out.replace(pattern, replacement);
    return out.replace(/\s+$/, '');
}
/** `sha256:<hex>` of a string. */
export function digest(text) {
    return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
/** Digest of the normalized text. */
export function normalizedDigest(text, options = {}) {
    return digest(normalize(text, options));
}
/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a character,
 * marking the cut. Text that fits is returned unchanged.
 */
export function truncateUtf8(text, maxBytes = DELTA_MAX_BYTES) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= maxBytes)
        return text;
    const marker = '…[truncated]';
    let end = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
    // Back off continuation bytes (10xxxxxx) so the cut lands on a character boundary.
    while (end > 0 && (bytes[end] & 0xc0) === 0x80)
        end--;
    return bytes.subarray(0, end).toString('utf8') + marker;
}
/**
 * The stored `delta` of a request: redact, then normalize, then truncate.
 * Redacting first means the cut can never leave part of a token below the
 * length its pattern needs.
 */
export function diskDelta(text, redactor, maxBytes = DELTA_MAX_BYTES) {
    return truncateUtf8(normalize(redactor.redact(text)), maxBytes);
}
//# sourceMappingURL=normalize.js.map