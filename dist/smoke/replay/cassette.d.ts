/**
 * Copilot replay cassettes, format version 1 (design:
 * .omc/plans/2026-10-29-copilot-replay-design.md, sections 3 and 5).
 *
 * One cassette is one directory:
 *
 *   manifest.json        {@link CassetteManifest}
 *   interactions.jsonl   one {@link CassetteInteraction} per model request
 *   events/<stream>.jsonl  the scenario's SDK events, redacted (optional)
 *   report.json          the record run's smoke report, redacted (optional)
 *
 * Shared types for the matcher (matcher.ts) and the handlers live here.
 *
 * Writing is fail closed: {@link writeCassette} runs the redaction gate over
 * every serialized file first and writes nothing if anything secret-looking
 * survived. {@link verifyCassetteDir} is the same gate over a directory on
 * disk; a failing verify leaves a {@link REDACTION_FAILED_MARKER} that
 * {@link readCassette} (and so the importer) refuses.
 */
import { type RedactionIdentity, type SecretHit } from './redact.js';
export declare const CASSETTE_FORMAT = "omg-copilot-cassette";
export declare const CASSETTE_VERSION = 1;
export declare const MANIFEST_FILE = "manifest.json";
export declare const INTERACTIONS_FILE = "interactions.jsonl";
export declare const EVENTS_DIR = "events";
export declare const REPORT_FILE = "report.json";
/** Written by a failing gate; a cassette dir that holds it is never read or imported. */
export declare const REDACTION_FAILED_MARKER = "REDACTION-FAILED";
/** The `--record-full` sidecar (local debugging only); the gate rejects a cassette that contains it. */
export declare const RECORD_FULL_SIDECAR = "full-requests";
/** Stream id of requests outside any agent thread (e.g. `GET /models`), keyed by method + path only. */
export declare const GLOBAL_STREAM = "global";
export type CassetteTransport = 'http' | 'ws';
export interface CassetteStream {
    id: string;
    /** Digest of the normalized first user message of the stream's first request. */
    promptDigest: string;
    /** Order in which the stream's session first issued a request in the scenario (1-based). */
    session: number;
    /** `root`, or `root/2` for the second subagent spawned under root. */
    agent: string;
    /** Number of interactions recorded for this stream. */
    interactions: number;
    label?: string;
}
export interface CassetteManifest {
    format: typeof CASSETTE_FORMAT;
    version: typeof CASSETTE_VERSION;
    scenario: string;
    recordedAt: string;
    omg: {
        version: string;
        gitSha?: string;
        dirty?: boolean;
    };
    sdk: {
        version: string;
    };
    runtime?: {
        version?: string;
        protocolVersion?: number;
    };
    platform: string;
    arch: string;
    node?: string;
    model?: string;
    maxCredits?: number;
    cost?: {
        credits?: number;
        premiumRequests?: number;
    };
    redaction: {
        rules: number;
        hits: Record<string, number>;
    };
    streams: CassetteStream[];
    selfVerify?: {
        ok: boolean;
        misses: number;
        drift: number;
    };
}
export interface CassetteRequest {
    method: string;
    path: string;
    transport: CassetteTransport;
    interactionType?: string;
    model?: string;
    /** Allowlisted headers only (redact.ts rule 1). */
    headers: Record<string, string>;
    /** Digest of the normalized new messages since the stream's previous request. */
    deltaDigest: string;
    toolNamesDigest?: string;
    /** Tool-call ids of the previous recorded response that this request must answer. */
    expectsToolResults?: string[];
    /** `diskDelta()` of the new messages: redacted, normalized, cut at DELTA_MAX_BYTES (drift reports only). */
    delta?: string;
}
export interface CassetteWsMessage {
    dir: 'in' | 'out';
    data: string;
}
interface CassetteResponseBase {
    status: number;
    /** Allowlisted headers only (redact.ts rule 2). */
    headers: Record<string, string>;
}
export type CassetteResponse = CassetteResponseBase & {
    kind: 'sse';
    chunks: string[];
} | CassetteResponseBase & {
    kind: 'json';
    body: unknown;
} | CassetteResponseBase & {
    kind: 'text';
    body: string;
} | CassetteResponseBase & {
    kind: 'ws';
    messages: CassetteWsMessage[];
};
export type CassetteResponseKind = CassetteResponse['kind'];
export interface CassetteInteraction {
    /** A {@link CassetteStream.id}, or {@link GLOBAL_STREAM}. */
    stream: string;
    /** Position in the stream; strictly increasing within a stream. */
    seq: number;
    req: CassetteRequest;
    res: CassetteResponse;
    /** Informational; replay does not sleep. */
    ms?: number;
}
export interface Cassette {
    manifest: CassetteManifest;
    interactions: CassetteInteraction[];
    /** SDK events per stream id. */
    events?: Record<string, unknown[]>;
    report?: unknown;
}
export declare class CassetteFormatError extends Error {
    name: string;
}
export interface GateHit extends SecretHit {
    /** Path relative to the cassette dir, `/`-separated. */
    file: string;
    /** 1-based line of the hit (0 for a file-level problem, or a hit only a decoded level of a .json file shows). */
    line: number;
}
export declare class CassetteGateError extends Error {
    readonly hits: GateHit[];
    name: string;
    constructor(hits: GateHit[]);
}
export declare function formatGateHits(hits: readonly GateHit[]): string;
/**
 * Validate a parsed manifest. Refuses any other `format` and any `version`
 * this build does not know (a newer one first, with the hint to upgrade).
 */
export declare function parseManifest(value: unknown, where?: string): CassetteManifest;
/** Validate one parsed interaction. */
export declare function parseInteraction(value: unknown, where: string): CassetteInteraction;
/** Read and validate a cassette directory. Refuses a gate-failed cassette and unknown formats or versions. */
export declare function readCassette(dir: string): Cassette;
/** The files of a cassette as `relative path -> content`, in write order (manifest last). */
export declare function serializeCassette(cassette: Cassette): Map<string, string>;
export interface GateOptions {
    /** Deny-set literals (record time only; never written anywhere). */
    denyLiterals?: Iterable<string>;
    /** Identity strings to look for (record time only). */
    identity?: RedactionIdentity;
}
/**
 * The gate over in-memory file contents (relative path -> text). Scans the
 * serialized text, then every decoded string level of each JSON document
 * (a .json file, or a .jsonl line) and of each reassembled stream, so a
 * secret is found however deeply escaped it sits or however it was split.
 * A decoded hit repeating a text hit is reported once.
 */
export declare function gateFiles(files: ReadonlyMap<string, string>, options?: GateOptions): GateHit[];
export interface WriteCassetteOptions extends GateOptions {
    /** Allow writing into a non-empty directory whose files this write all replaces (any other file is refused). */
    overwrite?: boolean;
}
/**
 * Validate, gate, then write a cassette. Fail closed: if the gate finds
 * anything, a {@link CassetteGateError} is thrown and no file is written.
 */
export declare function writeCassette(dir: string, cassette: Cassette, options?: WriteCassetteOptions): string[];
export interface VerifyResult {
    ok: boolean;
    hits: GateHit[];
    /** Set when the gate wrote the marker. */
    marker?: string;
}
/**
 * The gate over a cassette directory on disk (`omg smoke cassette verify`):
 * only the cassette's own files, each BOM-less UTF-8 that parses, the
 * cassette must validate, no symlink, no `--record-full` sidecar, no header outside the allowlists, and no secret
 * pattern (plus the deny set when given). On failure it deletes nothing and
 * writes {@link REDACTION_FAILED_MARKER} listing the masked hits, unless
 * `writeMarker` is false.
 */
export declare function verifyCassetteDir(dir: string, options?: GateOptions & {
    writeMarker?: boolean;
}): VerifyResult;
/** Every cassette dir (a dir holding manifest.json) under `root`, the root itself included. Does not follow symlinks. */
export declare function findCassetteDirs(root: string): string[];
export {};
//# sourceMappingURL=cassette.d.ts.map