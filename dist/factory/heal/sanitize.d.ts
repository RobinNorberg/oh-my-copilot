/**
 * Untrusted-text handling for the heal evidence bundle (design §4, §8). CI
 * logs are a prompt-injection surface: anyone who can open a PR can put text
 * into one. Every log-derived line is cleaned (ANSI, the GitHub prefix and
 * control characters removed), capped, and fenced in the debugger prompt
 * between per-run random delimiter lines. A line that carries the delimiter
 * prefix is dropped before it can reach a fence, so log text can never close
 * or reopen one.
 */
/** Every delimiter starts with this; a line carrying it is never fenced. */
export declare const DELIMITER_PREFIX = "HEAL-UNTRUSTED-";
/** Characters per evidence line after cleaning. */
export declare const MAX_EVIDENCE_LINE_CHARS = 400;
export declare const REDACTED = "[redacted]";
/** What a secret-shaped match is (named in a lane-commit park; the value never is). */
export type SecretShapeKind = 'private-key' | 'github-token' | 'aws-access-key' | 'npm-token' | 'api-key' | 'jwt' | 'npmrc-auth-token' | 'azure-devops-pat';
/**
 * Token and key shapes: the one list behind both the log redaction below and
 * the lane-commit content scan (lane-commit.ts). Each is specific enough that
 * ordinary source text does not match: a PEM PRIVATE key header (RSA, EC,
 * OPENSSH, ENCRYPTED...; public keys and certificates are not secrets),
 * GitHub's prefixed tokens, AWS access key ids, npm tokens, `sk-` / `sk-ant-`
 * API keys, a three-part JWT, an `.npmrc` `_authToken=` with a literal value
 * (not `${NPM_TOKEN}`), and the Azure DevOps PAT format that carries the
 * `AZDO` signature (the older 52-character PAT has no distinguishable shape).
 */
export declare const SECRET_SHAPES: readonly {
    kind: SecretShapeKind;
    re: RegExp;
}[];
/** The kinds of secret shape in `text` (each once, in list order); never the matched values. */
export declare function secretShapeKinds(text: string): SecretShapeKind[];
/** Secrets a CI log may echo (tokens, keys, URL credentials), replaced by {@link REDACTED}. */
export declare function redactSecrets(s: string): string;
/** One raw log line as evidence: prefix, ANSI and control characters gone, secrets redacted, capped. */
export declare function sanitizeLine(raw: string): string;
/** True when the line could be read as a fence delimiter (any case). */
export declare function carriesDelimiter(line: string): boolean;
/** Sanitized lines with the delimiter-carrying ones dropped; `dropped` counts them. */
export declare function sanitizeLines(raw: readonly string[]): {
    lines: string[];
    dropped: number;
};
/** The first lines whose UTF-8 size (newlines included) fits `maxBytes`. */
export declare function capBytes(lines: readonly string[], maxBytes: number): {
    lines: string[];
    cut: boolean;
};
/**
 * A JSON value with every string cleaned and capped and the delimiter prefix
 * defused, so a log-derived string inside a JSON file cannot fake a fence.
 */
export declare function sanitizeJson<T>(value: T, maxString?: number): T;
/** A fresh per-run delimiter (unguessable, so log text cannot carry it in advance). */
export declare function newDelimiter(): string;
/**
 * One bundle file as untrusted data in the prompt: numbered lines between the
 * delimiter's BEGIN and END lines. Lines carrying the delimiter are dropped
 * here too (defense in depth: the bundle never holds one).
 */
export declare function fenceUntrusted(delimiter: string, name: string, lines: readonly string[]): string;
//# sourceMappingURL=sanitize.d.ts.map