/**
 * Replay matcher: maps each model request the runtime routes through the
 * request handler to a recorded interaction (design
 * .omc/plans/2026-10-29-copilot-replay-design.md, sections 3 and 4).
 *
 * A live stream is one `(sessionId, agentId)` of the handler context. It is
 * bound to a recorded stream on its first request, by `promptDigest` or, in
 * tolerant mode only, by `(session ordinal, agent path)`. Binding claims the
 * recorded stream with an exclusive file under `<state>/claims/`, so matchers
 * in separate processes (team sdk hosts) never replay the same recording.
 * Session ordinals are allocated across processes the same way, with
 * exclusive files under `<state>/sessions/`. Interactions are then served
 * strictly in order per stream. Requests with no prompt (for example
 * `GET /models`) are served from the `global` stream by method + path.
 *
 * The matcher works on digests the caller already computed (normalization
 * and redaction live in the cassette library); it never sees a full request
 * body and never forwards anything.
 */
export interface CassetteStream {
    id: string;
    promptDigest: string;
    /** 1-based order in which the stream's session first issued a request. */
    session: number;
    /** `root`, or `root/2` for the second subagent spawned under root. */
    agent: string;
    interactions: number;
    label?: string;
}
export interface CassetteRequest {
    method: string;
    path: string;
    transport: string;
    interactionType?: string;
    model?: string;
    headers?: Record<string, string>;
    deltaDigest?: string;
    toolNamesDigest?: string;
    /** Tool-call ids the previous recorded response issued; the request must carry a result for each. */
    expectsToolResults?: string[];
    delta?: string;
}
export interface CassetteResponse {
    status: number;
    headers?: Record<string, string>;
    kind: 'sse' | 'json' | 'text' | 'ws';
    chunks?: string[];
    body?: unknown;
    messages?: Array<{
        dir: 'in' | 'out';
        data: string;
    }>;
}
export interface CassetteInteraction {
    /** A stream id from the manifest, or `global`. */
    stream: string;
    seq: number;
    req: CassetteRequest;
    res: CassetteResponse;
    ms?: number;
}
export interface MatcherCassette {
    manifest: {
        streams: CassetteStream[];
    };
    interactions: CassetteInteraction[];
}
/** One request as the replay handler sees it, digests already computed. */
export interface LiveRequest {
    sessionId: string;
    agentId?: string;
    parentAgentId?: string;
    method: string;
    path: string;
    transport: string;
    model?: string;
    /** Digest of the normalized first user message; absent for non-conversation requests (served from `global`). */
    promptDigest?: string;
    deltaDigest?: string;
    toolNamesDigest?: string;
    /** Tool-call ids the request's delta carries results for. */
    toolResultIds?: string[];
    /** Normalized delta, for the drift excerpt. */
    delta?: string;
}
export type MatchMode = 'strict' | 'tolerant';
export type DriftKind = 'fallback' | 'delta' | 'model' | 'global-repeat';
export interface DriftEntry {
    stream: string;
    seq: number;
    kind: DriftKind;
    detail: string;
}
export interface MissEntry {
    stream: string;
    seq: number;
    reason: string;
    method: string;
    path: string;
}
export type MatchResult = {
    kind: 'hit';
    stream: string;
    seq: number;
    interaction: CassetteInteraction;
    drift: DriftEntry[];
} | {
    kind: 'miss';
    stream: string;
    seq: number;
    reason: string;
    status: typeof MISS_STATUS;
    body: string;
};
export declare const GLOBAL_STREAM = "global";
/**
 * 418, not the design's 599: OpenAI-style clients retry 408, 409, 429 and
 * every 5xx with backoff, which would turn a miss into slow retries instead of
 * an immediate turn failure. 418 is in no retry set and never comes from the
 * real API, so a miss cannot be mistaken for an upstream answer.
 */
export declare const MISS_STATUS = 418;
export interface ReplayMatcherOptions {
    cassette: MatcherCassette;
    /** `OMG_COPILOT_CASSETTE_STATE`: shared by every process of one replay run. */
    stateDir: string;
    mode: MatchMode;
}
/**
 * Positions of live streams: the session ordinal (the order in which sessions
 * first issued a request, allocated across every process of the run) and the
 * agent path (`root`, `root/2`). The recorder (handler.ts) and the matcher both
 * track through this class, so a recorded position means the same on replay.
 */
export declare class StreamPositions {
    private readonly stateDir;
    private readonly sessionOrdinals;
    private readonly agentPaths;
    private readonly childCounts;
    constructor(stateDir: string);
    /** Records the session ordinal and agent path of the request's live stream. */
    track(req: Pick<LiveRequest, 'sessionId' | 'agentId' | 'parentAgentId'>): {
        ordinal: number;
        path: string;
    };
    /**
     * Next free session ordinal across every process of the run: the first n for
     * which `<state>/sessions/<n>` can be created exclusively, so a recorded
     * `session` means the same thing for a team whose sessions live in several
     * sdk hosts.
     */
    private allocateOrdinal;
}
export declare class ReplayMatcher {
    private readonly cassette;
    private readonly stateDir;
    private readonly mode;
    private readonly byStream;
    private readonly bound;
    private readonly positions;
    private readonly globalCursors;
    constructor(opts: ReplayMatcherOptions);
    /** Never throws: a failure to read or write the replay state is answered as a miss. */
    match(req: LiveRequest): MatchResult;
    private matchOrThrow;
    /**
     * Non-conversation requests: in recorded order per method + path. Once they
     * run out, a GET or HEAD repeats the last answer (logged as `global-repeat`
     * drift); any other method misses, as an exhausted stream does.
     */
    private matchGlobal;
    private bind;
    private boundFor;
    /** O_EXCL claim file; false when another matcher (any process) holds the stream. */
    private claim;
    private miss;
    private served;
    private logDrift;
    private append;
}
export interface ReplayStateSummary {
    misses: MissEntry[];
    drift: DriftEntry[];
    /** Recorded streams no matcher claimed. */
    unclaimed: string[];
    /** Claimed streams with interactions left unserved. */
    unconsumed: string[];
}
/** Merges what every matcher of one replay run wrote to the state dir (for the `scn.<name>.replay` check). */
export declare function summarizeReplayState(stateDir: string, cassette: MatcherCassette): ReplayStateSummary;
/** Excerpt of both texts from shortly before their first difference, at most 400 chars of each side together. */
export declare function diffExcerpt(recorded: string, live: string): string;
export declare function liveKey(sessionId: string, agentId: string | undefined): string;
//# sourceMappingURL=matcher.d.ts.map