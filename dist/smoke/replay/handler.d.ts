/**
 * Cassette request handlers and the `withCassette` SDK wrapper (design:
 * .omc/plans/2026-10-29-copilot-replay-design.md, sections 2, 4 and 8).
 *
 * The SDK's experimental `CopilotClientOptions.requestHandler` receives every
 * model-layer request the runtime issues. {@link withCassette} (applied in
 * `loadCopilotSdk`, so every client of the codebase is covered) injects one per
 * client when `OMG_COPILOT_CASSETTE_MODE` is set:
 *
 * - record: a pass-through tap. Each request is forwarded by the SDK's own
 *   default, the response is teed, redacted (redact.ts) and kept in memory;
 *   `client.stop()` writes the recording through {@link writeCassette}, which
 *   gates it and writes nothing if a secret survived. One part per client and scenario,
 *   under `<state>/parts/` (`<pid>-<n>.failed` when it could not be written);
 *   the smoke merges them (replay/run.ts).
 * - replay: never forwards. The handler class overrides both SDK hooks without
 *   calling `super` and holds no upstream: every request is answered from the
 *   cassette through {@link ReplayMatcher}, a miss with HTTP 418.
 *
 * WebSocket transport is refused in both modes (recordings set
 * `COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES=1`).
 */
import type { LoadedSdk } from '../copilot-sdk-driver.js';
import { type Cassette, type CassetteResponse } from './cassette.js';
import { type LiveRequest, type MatchMode } from './matcher.js';
import { type PlaceholderDirs, type RedactionIdentity } from './redact.js';
/** What the SDK hands each hook (`CopilotRequestContext`, SDK 1.0.16). */
export interface CopilotRequestContextLike {
    requestId?: string;
    sessionId?: string;
    agentId?: string;
    parentAgentId?: string;
    interactionType?: string;
    transport: 'http' | 'websocket';
    url: string;
    headers?: Record<string, string[] | string | undefined>;
    signal?: AbortSignal;
}
/** The SDK's `CopilotRequestHandler` base: its defaults forward upstream (`fetch`, a WebSocket forwarder). */
export interface CopilotRequestHandlerLike {
    sendRequest(request: Request, ctx: CopilotRequestContextLike): Promise<Response>;
    openWebSocket(ctx: CopilotRequestContextLike): Promise<unknown>;
}
export type CopilotRequestHandlerCtor = new () => CopilotRequestHandlerLike;
export type CassetteMode = 'record' | 'replay';
export interface CassetteConfig {
    mode: CassetteMode;
    /** `OMG_COPILOT_CASSETTE`: the cassette (replay) or recording root (record). */
    dir: string;
    /** `OMG_COPILOT_CASSETTE_STATE`: shared by every process of one run (claims, ordinals, logs, record parts). */
    stateDir: string;
    scenario?: string;
    /** `OMG_COPILOT_CASSETTE_MATCH` (replay only). */
    matchMode?: MatchMode;
    /** `OMG_COPILOT_CASSETTE_DIRS`: placeholder dirs on top of TMP and USERHOME. */
    dirs?: PlaceholderDirs;
}
export declare const REQUEST_HANDLER_MISSING = "replay needs @github/copilot-sdk with requestHandler (>= 1.0.16)";
/** Per-client recordings, `<state>/parts/<pid>-<n>`, merged by the smoke. */
export declare const RECORD_PARTS_DIR = "parts";
/** `<state>/parts/<pid>-<n>.failed`: a recording that could not be written (gate refusal, write error); the merge refuses. */
export declare const RECORD_FAILED_SUFFIX = ".failed";
export declare class CassetteConfigError extends Error {
    name: string;
}
/**
 * The cassette env, checked (section 8.5): null when neither the mode nor the
 * dir is set; otherwise the mode must be exactly `record` or `replay` and the
 * dir and state dir are required. Recording is refused under `CI` and into a
 * fixtures dir.
 */
export declare function readCassetteConfig(env: NodeJS.ProcessEnv): CassetteConfig | null;
interface RequestShape {
    messages: unknown[];
    tools: string[];
    /** Responses API with `previous_response_id`: `input` already holds only the new items. */
    incremental: boolean;
}
/** New messages per live stream since its previous request. */
export declare class DeltaTracker {
    private readonly seen;
    next(key: string, shape: RequestShape): unknown[];
}
export interface AnalyzedRequest {
    live: LiveRequest;
    /** The raw new messages, one JSON per line (memory only; disk gets {@link diskDelta}). */
    deltaText: string;
}
/**
 * The matcher's view of one request. A request with no user message (`GET
 * /models`, no body) has no `promptDigest` and is served from the global
 * stream; every other one advances its live stream's delta.
 */
export declare function analyzeRequest(method: string, body: string, ctx: CopilotRequestContextLike, dirs: PlaceholderDirs, deltas: DeltaTracker): AnalyzedRequest;
/**
 * Tool-call ids a response issues, in any wire format (buffered or SSE): chat
 * `tool_calls[].id`, Responses `function_call` items' `call_id`, Anthropic
 * `tool_use` blocks' `id`. The next request of the stream must answer each.
 */
export declare function responseToolCallIds(res: CassetteResponse): string[];
/** Add secret literals to this process's redaction deny set (never written anywhere). */
export declare function addRecordingDenyLiterals(values: Iterable<string>): void;
interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}
interface PendingInteraction {
    order: number;
    stream: string;
    seq: number;
    method: string;
    ctx: CopilotRequestContextLike;
    analyzed: AnalyzedRequest;
    expects: Promise<string[]>;
    toolCalls: Deferred<string[]>;
    started: number;
}
export interface CassetteRecorderOptions {
    stateDir: string;
    scenario?: string;
    sdkVersion?: string | null;
    dirs: PlaceholderDirs;
    /** Source of credential env values for the deny set (default `process.env`). */
    env?: NodeJS.ProcessEnv;
    identity?: RedactionIdentity;
}
/**
 * One client's recording. Stream ids are `s<ordinal>-<agent path>`, with
 * ordinals from the same cross-process allocation the matcher uses
 * ({@link StreamPositions}), so parts from several processes never collide.
 */
export declare class CassetteRecorder {
    private readonly options;
    private readonly positions;
    private readonly deltas;
    private readonly streams;
    private readonly seqs;
    private readonly lastToolCalls;
    private readonly recorded;
    private readonly pending;
    private readonly authorizations;
    private readonly retiredHits;
    private readonly errors;
    private redactor;
    private redactorDenySize;
    private order;
    constructor(options: CassetteRecorderOptions);
    /** The deny set as of now: env credentials, every Authorization seen, the process's extra literals. */
    denyLiterals(): Set<string>;
    /** A redactor over the current deny set; rebuilt (hits carried over) when the set grows. */
    private currentRedactor;
    /** Before forwarding: assign the request its stream and seq, in arrival order. */
    begin(method: string, body: string, ctx: CopilotRequestContextLike): PendingInteraction;
    /** The upstream failed: nothing is recorded for this request. */
    abandon(p: PendingInteraction): void;
    /**
     * After forwarding: hand the runtime one branch of the teed body and record
     * the other. Redaction runs before the interaction is kept.
     */
    tap(p: PendingInteraction, response: Response): Response;
    /** Everything recorded so far, once every tapped response finished. */
    cassette(): Promise<Cassette>;
    /**
     * Write the recording to `dir` through the gate (fail closed: a
     * CassetteGateError and nothing written). Null when nothing was recorded.
     */
    finish(dir: string): Promise<string[] | null>;
}
/** A recording handler: forwards through the SDK's default (`super`), taps the response. */
export declare function createRecordingHandler(Base: CopilotRequestHandlerCtor, recorderOf: CassetteRecorder | (() => CassetteRecorder)): CopilotRequestHandlerLike;
/** Answers requests from one cassette; holds no upstream of any kind. */
export declare class CassetteReplayer {
    private readonly dirs;
    private readonly matcher;
    private readonly deltas;
    constructor(cassette: Cassette, stateDir: string, mode: MatchMode, dirs: PlaceholderDirs);
    respond(method: string, body: string, ctx: CopilotRequestContextLike): Response;
}
/**
 * A replay handler. It extends the SDK base only because the SDK dispatches
 * through it; both hooks are overridden without `super`, and nothing in the
 * class can reach an upstream (section 8.1).
 */
export declare function createReplayHandler(Base: CopilotRequestHandlerCtor, replayerOf: CassetteReplayer | (() => CassetteReplayer | null)): CopilotRequestHandlerLike;
/** The cassette of a replay run: `<dir>` itself, or `<dir>/<scenario>`. Refuses one from another platform. */
export declare function loadReplayCassette(config: CassetteConfig): Cassette;
export interface WithCassetteOptions {
    /** Dirs turned into placeholders (on top of TMP, USERHOME and the env's `OMG_COPILOT_CASSETTE_DIRS`). */
    dirs?: PlaceholderDirs;
    matchMode?: MatchMode;
}
/** What a cassette client adds to the SDK client. */
export interface CassetteClientControl {
    /** The marker callers test instead of re-reading the env. */
    readonly cassette: CassetteMode;
    /**
     * Record or replay this client's next requests as `scenario`, with that
     * scenario's state dir: for the smoke driver, whose one client runs several
     * scenarios. Every other client takes its scenario from the env. Throws when
     * the scenario's cassette cannot be replayed.
     */
    setCassetteScenario(scenario: string, stateDir: string): void;
}
/**
 * The SDK with a client that records or replays every model request, per the
 * cassette env; `loaded` unchanged when that env is unset. Throws (never a
 * plain client) when the env is invalid, the cassette cannot be read, or the
 * SDK has no `CopilotRequestHandler`. The returned SDK and its clients carry
 * the mode as `cassette`.
 */
export declare function withCassette(loaded: LoadedSdk, env?: NodeJS.ProcessEnv, options?: WithCassetteOptions): LoadedSdk;
export {};
//# sourceMappingURL=handler.d.ts.map