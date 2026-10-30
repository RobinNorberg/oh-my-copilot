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
 *   gates it and writes nothing if a secret survived. One part per client,
 *   under `<state>/parts/`; the smoke merges the parts (PR 4).
 * - replay: never forwards. The handler class overrides both SDK hooks without
 *   calling `super` and holds no upstream: every request is answered from the
 *   cassette through {@link ReplayMatcher}, a miss with HTTP 418.
 *
 * WebSocket transport is refused in both modes (recordings set
 * `COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES=1`).
 */
import { existsSync } from 'fs';
import { homedir, hostname, tmpdir, userInfo } from 'os';
import { join, resolve } from 'path';
import { getRuntimePackageVersion } from '../../lib/version.js';
import { CASSETTE_ENV, cassetteRuntimeEnv } from '../copilot-session-env.js';
import { CASSETTE_FORMAT, CASSETTE_VERSION, GLOBAL_STREAM, MANIFEST_FILE, readCassette, writeCassette, } from './cassette.js';
import { liveKey, MISS_STATUS, ReplayMatcher, StreamPositions } from './matcher.js';
import { diskDelta, digest, normalize, normalizedDigest, truncateUtf8 } from './normalize.js';
import { buildDenySet, filterRequestHeaders, REDACTION_RULES_VERSION, Redactor, restorePlaceholders, sseBlocks, sseData, } from './redact.js';
export const REQUEST_HANDLER_MISSING = 'replay needs @github/copilot-sdk with requestHandler (>= 1.0.16)';
/** Per-client recordings, `<state>/parts/<pid>-<n>`, merged by the smoke. */
export const RECORD_PARTS_DIR = 'parts';
export class CassetteConfigError extends Error {
    name = 'CassetteConfigError';
}
/**
 * The cassette env, checked (section 8.5): null when neither the mode nor the
 * dir is set; otherwise the mode must be exactly `record` or `replay` and the
 * dir and state dir are required. Recording is refused under `CI` and into a
 * fixtures dir.
 */
export function readCassetteConfig(env) {
    const mode = env[CASSETTE_ENV.mode];
    const dir = env[CASSETTE_ENV.dir];
    if (!mode && !dir)
        return null;
    if (mode !== 'record' && mode !== 'replay') {
        throw new CassetteConfigError(`${CASSETTE_ENV.mode} must be exactly "record" or "replay", got ${JSON.stringify(mode ?? '')}`);
    }
    if (!dir)
        throw new CassetteConfigError(`${CASSETTE_ENV.mode}=${mode} needs ${CASSETTE_ENV.dir}`);
    const state = env[CASSETTE_ENV.state];
    if (!state)
        throw new CassetteConfigError(`${CASSETTE_ENV.mode}=${mode} needs ${CASSETTE_ENV.state}`);
    if (mode === 'record' && env.CI && env.CI !== 'false')
        throw new CassetteConfigError('recording a cassette is refused under CI');
    if (mode === 'record' && /[\\/]fixtures[\\/]cassettes(?:[\\/]|$)/i.test(resolve(dir))) {
        throw new CassetteConfigError(`refusing to record into the fixtures dir ${dir}; record elsewhere and import`);
    }
    return { mode, dir: resolve(dir), stateDir: resolve(state), scenario: env[CASSETTE_ENV.scenario] || undefined };
}
// ---------------------------------------------------------------------------
// Request analysis (shared by both sides, so digests agree)
// ---------------------------------------------------------------------------
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Messages and tool names of a Chat Completions, Responses or Anthropic Messages body. */
function requestShape(body) {
    if (!isRecord(body))
        return null;
    const input = body.input;
    const messages = Array.isArray(body.messages) ? body.messages
        : Array.isArray(input) ? input
            : typeof input === 'string' ? [{ role: 'user', content: input }] : null;
    if (!messages)
        return null;
    const tools = (Array.isArray(body.tools) ? body.tools : []).map((t) => {
        if (!isRecord(t))
            return '';
        const name = isRecord(t.function) ? t.function.name : t.name;
        return typeof name === 'string' ? name : '';
    });
    return { messages, tools, incremental: typeof body.previous_response_id === 'string' };
}
function contentText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content))
        return content.map((p) => (typeof p === 'string' ? p : isRecord(p) && typeof p.text === 'string' ? p.text : '')).join('\n');
    return JSON.stringify(content ?? '');
}
/** The first user message's text: the scenario, lane or worker prompt of the stream. */
function firstUserText(messages) {
    const first = messages.find((m) => isRecord(m) && m.role === 'user' && (m.type === undefined || m.type === 'message'));
    return isRecord(first) ? contentText(first.content) : undefined;
}
/** Tool-call ids the delta answers: chat `tool` messages, Responses `function_call_output`, Anthropic `tool_result`. */
function toolResultIds(delta) {
    const ids = [];
    for (const m of delta) {
        if (!isRecord(m))
            continue;
        if (m.role === 'tool' && typeof m.tool_call_id === 'string')
            ids.push(m.tool_call_id);
        if (m.type === 'function_call_output' && typeof m.call_id === 'string')
            ids.push(m.call_id);
        if (Array.isArray(m.content)) {
            for (const p of m.content)
                if (isRecord(p) && p.type === 'tool_result' && typeof p.tool_use_id === 'string')
                    ids.push(p.tool_use_id);
        }
    }
    return ids;
}
/** New messages per live stream since its previous request. */
export class DeltaTracker {
    seen = new Map();
    next(key, shape) {
        const prev = this.seen.get(key) ?? 0;
        this.seen.set(key, shape.messages.length);
        if (shape.incremental || prev > shape.messages.length)
            return shape.messages;
        return shape.messages.slice(prev);
    }
}
/**
 * The matcher's view of one request. A request with no user message (`GET
 * /models`, no body) has no `promptDigest` and is served from the global
 * stream; every other one advances its live stream's delta.
 */
export function analyzeRequest(method, body, ctx, dirs, deltas) {
    let parsed;
    try {
        parsed = body ? JSON.parse(body) : undefined;
    }
    catch {
        parsed = undefined;
    }
    const live = {
        sessionId: ctx.sessionId ?? '',
        ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
        ...(ctx.parentAgentId !== undefined ? { parentAgentId: ctx.parentAgentId } : {}),
        method,
        path: pathOf(ctx.url),
        transport: ctx.transport === 'websocket' ? 'ws' : 'http',
        ...(isRecord(parsed) && typeof parsed.model === 'string' ? { model: parsed.model } : {}),
    };
    const shape = requestShape(parsed);
    const prompt = shape ? firstUserText(shape.messages) : undefined;
    if (!shape || prompt === undefined)
        return { live, deltaText: '' };
    const delta = deltas.next(liveKey(live.sessionId, live.agentId), shape);
    const deltaText = delta.map((m) => JSON.stringify(m)).join('\n');
    live.promptDigest = normalizedDigest(prompt, { dirs });
    live.deltaDigest = normalizedDigest(deltaText, { dirs });
    live.toolNamesDigest = digest([...shape.tools].sort().join('\n'));
    live.toolResultIds = toolResultIds(delta);
    live.delta = truncateUtf8(normalize(deltaText, { dirs }));
    return { live, deltaText };
}
function pathOf(url) {
    try {
        return new URL(url).pathname;
    }
    catch {
        return url.split('?')[0];
    }
}
/**
 * Tool-call ids a response issues, in any wire format (buffered or SSE): chat
 * `tool_calls[].id`, Responses `function_call` items' `call_id`, Anthropic
 * `tool_use` blocks' `id`. The next request of the stream must answer each.
 */
export function responseToolCallIds(res) {
    const ids = new Set();
    const visit = (v) => {
        if (Array.isArray(v)) {
            v.forEach(visit);
            return;
        }
        if (!isRecord(v))
            return;
        if (v.type === 'function_call' && typeof v.call_id === 'string')
            ids.add(v.call_id);
        if (v.type === 'tool_use' && typeof v.id === 'string')
            ids.add(v.id);
        if (Array.isArray(v.tool_calls))
            for (const c of v.tool_calls)
                if (isRecord(c) && typeof c.id === 'string')
                    ids.add(c.id);
        Object.values(v).forEach(visit);
    };
    if (res.kind === 'json')
        visit(res.body);
    if (res.kind === 'sse')
        visit(sseBlocks(res.chunks.join('')).map(sseData));
    return [...ids];
}
/** Every value of a header, from the SDK's `string[]` map (any case). */
function headerValues(headers, name) {
    const out = [];
    for (const [key, value] of Object.entries(headers ?? {})) {
        if (key.toLowerCase() !== name || value === undefined)
            continue;
        out.push(...(Array.isArray(value) ? value : [value]));
    }
    return out;
}
function flatHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers ?? {}))
        if (value !== undefined)
            out[key] = Array.isArray(value) ? value.join(', ') : value;
    return out;
}
/** A response as recorded: SSE by content type, else JSON when it parses, else text. */
function cassetteResponse(status, headers, text) {
    const head = {};
    headers.forEach((value, key) => { head[key] = value; });
    if (/text\/event-stream/i.test(headers.get('content-type') ?? ''))
        return { status, headers: head, kind: 'sse', chunks: [text] };
    try {
        if (text)
            return { status, headers: head, kind: 'json', body: JSON.parse(text) };
    }
    catch { /* not JSON */ }
    return { status, headers: head, kind: 'text', body: text };
}
/** The 418 a replay miss answers (not retried by the runtime, never sent by the real API). */
function missResponse(body) {
    return new Response(body, { status: MISS_STATUS, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
/**
 * A stored response served to the runtime, `${NAME}` placeholders restored to
 * this machine's dirs (forward slashes, so no JSON escaping is needed): SSE as
 * a stream of its chunks, JSON and text buffered.
 */
function replayResponse(res, dirs) {
    const restore = (text) => restorePlaceholders(text, dirs);
    const headers = new Headers(res.headers);
    let body;
    switch (res.kind) {
        case 'sse': {
            const chunks = res.chunks.map(restore);
            const encoder = new TextEncoder();
            body = new ReadableStream({
                start(controller) {
                    for (const chunk of chunks)
                        controller.enqueue(encoder.encode(chunk));
                    controller.close();
                },
            });
            if (!headers.has('content-type'))
                headers.set('content-type', 'text/event-stream');
            break;
        }
        case 'json':
            body = restore(JSON.stringify(res.body));
            if (!headers.has('content-type'))
                headers.set('content-type', 'application/json');
            break;
        case 'text':
            body = restore(res.body);
            break;
        case 'ws':
            return missResponse('omg replay: cassette miss (a WebSocket recording answered an HTTP request)');
    }
    return new Response([204, 205, 304].includes(res.status) ? null : body, { status: res.status, headers });
}
const WS_REFUSED = 'omg cassette: WebSocket model requests are not supported; the runtime must run with COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES=1';
// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------
/** Credentials known only in memory (the sdk host's stdin handoff): every recorder of this process redacts and gates them. */
const extraDenyLiterals = new Set();
/** Add secret literals to this process's redaction deny set (never written anywhere). */
export function addRecordingDenyLiterals(values) {
    for (const v of values)
        if (v)
            extraDenyLiterals.add(v);
}
function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}
/**
 * One client's recording. Stream ids are `s<ordinal>-<agent path>`, with
 * ordinals from the same cross-process allocation the matcher uses
 * ({@link StreamPositions}), so parts from several processes never collide.
 */
export class CassetteRecorder {
    options;
    positions;
    deltas = new DeltaTracker();
    streams = new Map();
    seqs = new Map();
    lastToolCalls = new Map();
    recorded = [];
    pending = new Set();
    authorizations = new Set();
    retiredHits = {};
    errors = [];
    redactor = null;
    redactorDenySize = -1;
    order = 0;
    constructor(options) {
        this.options = options;
        this.positions = new StreamPositions(options.stateDir);
    }
    /** The deny set as of now: env credentials, every Authorization seen, the process's extra literals. */
    denyLiterals() {
        return buildDenySet({ env: this.options.env ?? process.env, authorizations: this.authorizations, credentials: extraDenyLiterals });
    }
    /** A redactor over the current deny set; rebuilt (hits carried over) when the set grows. */
    currentRedactor() {
        const deny = this.denyLiterals();
        if (!this.redactor || deny.size !== this.redactorDenySize) {
            for (const [rule, n] of Object.entries(this.redactor?.hits ?? {}))
                this.retiredHits[rule] = (this.retiredHits[rule] ?? 0) + n;
            this.redactor = new Redactor({ denyLiterals: deny, dirs: this.options.dirs, identity: this.options.identity });
            this.redactorDenySize = deny.size;
        }
        return this.redactor;
    }
    /** Before forwarding: assign the request its stream and seq, in arrival order. */
    begin(method, body, ctx) {
        for (const auth of headerValues(ctx.headers, 'authorization'))
            this.authorizations.add(auth);
        const analyzed = analyzeRequest(method, body, ctx, this.options.dirs, this.deltas);
        const { live } = analyzed;
        let stream = GLOBAL_STREAM;
        if (live.promptDigest !== undefined) {
            const { ordinal, path } = this.positions.track(live);
            stream = `s${ordinal}-${path.replace(/\//g, '.')}`;
            if (!this.streams.has(stream)) {
                this.streams.set(stream, { id: stream, promptDigest: live.promptDigest, session: ordinal, agent: path, interactions: 0 });
            }
        }
        const seq = (this.seqs.get(stream) ?? 0) + 1;
        this.seqs.set(stream, seq);
        const toolCalls = deferred();
        const expects = stream === GLOBAL_STREAM ? Promise.resolve([]) : this.lastToolCalls.get(stream) ?? Promise.resolve([]);
        if (stream !== GLOBAL_STREAM)
            this.lastToolCalls.set(stream, toolCalls.promise);
        return { order: this.order++, stream, seq, method, ctx, analyzed, expects, toolCalls, started: Date.now() };
    }
    /** The upstream failed: nothing is recorded for this request. */
    abandon(p) {
        p.toolCalls.resolve([]);
    }
    /**
     * After forwarding: hand the runtime one branch of the teed body and record
     * the other. Redaction runs before the interaction is kept.
     */
    tap(p, response) {
        const [mine, theirs] = response.body ? response.body.tee() : [null, null];
        const work = (async () => {
            const text = mine ? await new Response(mine).text() : '';
            const raw = cassetteResponse(response.status, response.headers, text);
            p.toolCalls.resolve(responseToolCallIds(raw));
            const expects = await p.expects;
            const redactor = this.currentRedactor();
            const { live, deltaText } = p.analyzed;
            this.recorded.push({
                order: p.order,
                interaction: {
                    stream: p.stream,
                    seq: p.seq,
                    req: {
                        method: p.method,
                        path: live.path,
                        transport: 'http',
                        ...(p.ctx.interactionType !== undefined ? { interactionType: p.ctx.interactionType } : {}),
                        ...(live.model !== undefined ? { model: live.model } : {}),
                        headers: redactor.redactValue(filterRequestHeaders(flatHeaders(p.ctx.headers))),
                        deltaDigest: live.deltaDigest ?? digest(''),
                        ...(live.toolNamesDigest !== undefined ? { toolNamesDigest: live.toolNamesDigest } : {}),
                        ...(expects.length > 0 ? { expectsToolResults: expects } : {}),
                        ...(deltaText ? { delta: diskDelta(deltaText, redactor) } : {}),
                    },
                    res: redactor.redactResponse(raw),
                    ms: Date.now() - p.started,
                },
            });
        })().catch((err) => {
            p.toolCalls.resolve([]);
            this.errors.push(err instanceof Error ? err : new Error(String(err)));
        });
        this.pending.add(work);
        void work.finally(() => this.pending.delete(work));
        return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    /** Everything recorded so far, once every tapped response finished. */
    async cassette() {
        while (this.pending.size > 0)
            await Promise.all([...this.pending]);
        if (this.errors.length > 0)
            throw new Error(`cassette recording failed: ${this.errors.map((e) => e.message).join('; ')}`);
        const interactions = [...this.recorded].sort((a, b) => a.order - b.order).map((r) => r.interaction);
        const counts = new Map();
        for (const it of interactions)
            counts.set(it.stream, (counts.get(it.stream) ?? 0) + 1);
        const hits = { ...this.retiredHits };
        for (const [rule, n] of Object.entries(this.redactor?.hits ?? {}))
            hits[rule] = (hits[rule] ?? 0) + n;
        return {
            manifest: {
                format: CASSETTE_FORMAT,
                version: CASSETTE_VERSION,
                scenario: this.options.scenario ?? 'unknown',
                recordedAt: new Date().toISOString(),
                omg: { version: getRuntimePackageVersion() },
                sdk: { version: this.options.sdkVersion ?? 'unknown' },
                platform: process.platform,
                arch: process.arch,
                node: process.versions.node,
                redaction: { rules: REDACTION_RULES_VERSION, hits },
                streams: [...this.streams.values()].filter((s) => counts.has(s.id)).map((s) => ({ ...s, interactions: counts.get(s.id) ?? 0 })),
            },
            interactions,
        };
    }
    /**
     * Write the recording to `dir` through the gate (fail closed: a
     * CassetteGateError and nothing written). Null when nothing was recorded.
     */
    async finish(dir) {
        const cassette = await this.cassette();
        if (cassette.interactions.length === 0)
            return null;
        return writeCassette(dir, cassette, { denyLiterals: this.denyLiterals(), identity: this.options.identity });
    }
}
/** A recording handler: forwards through the SDK's default (`super`), taps the response. */
export function createRecordingHandler(Base, recorder) {
    class RecordingHandler extends Base {
        async sendRequest(request, ctx) {
            const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
            const pending = recorder.begin(request.method, body, ctx);
            let response;
            try {
                response = await super.sendRequest(request, ctx);
            }
            catch (err) {
                recorder.abandon(pending);
                throw err;
            }
            return recorder.tap(pending, response);
        }
        async openWebSocket() {
            throw new Error(WS_REFUSED);
        }
    }
    return new RecordingHandler();
}
// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------
/** Answers requests from one cassette; holds no upstream of any kind. */
export class CassetteReplayer {
    dirs;
    matcher;
    deltas = new DeltaTracker();
    constructor(cassette, stateDir, mode, dirs) {
        this.dirs = dirs;
        this.matcher = new ReplayMatcher({ cassette, stateDir, mode });
    }
    respond(method, body, ctx) {
        const { live } = analyzeRequest(method, body, ctx, this.dirs, this.deltas);
        const result = this.matcher.match(live);
        return result.kind === 'miss' ? missResponse(result.body) : replayResponse(result.interaction.res, this.dirs); // the matcher hands back our own cassette's interaction
    }
}
/**
 * A replay handler. It extends the SDK base only because the SDK dispatches
 * through it; both hooks are overridden without `super`, and nothing in the
 * class can reach an upstream (section 8.1).
 */
export function createReplayHandler(Base, replayer) {
    class ReplayHandler extends Base {
        async sendRequest(request, ctx) {
            const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
            return replayer.respond(request.method, body, ctx);
        }
        async openWebSocket() {
            throw new Error(WS_REFUSED);
        }
    }
    return new ReplayHandler();
}
/** The cassette of a replay run: `<dir>` itself, or `<dir>/<scenario>`. Refuses one from another platform. */
export function loadReplayCassette(config) {
    const dir = config.scenario && !existsSync(join(config.dir, MANIFEST_FILE)) ? join(config.dir, config.scenario) : config.dir;
    const cassette = readCassette(dir);
    if (cassette.manifest.platform !== process.platform) {
        throw new CassetteConfigError(`${dir}: cassette recorded on ${cassette.manifest.platform}, cannot replay on ${process.platform}`);
    }
    return cassette;
}
const replayers = new Map();
let recordParts = 0;
/**
 * The SDK with a client that records or replays every model request, per the
 * cassette env; `loaded` unchanged when that env is unset. Throws (never a
 * plain client) when the env is invalid, the cassette cannot be read, or the
 * SDK has no `CopilotRequestHandler`.
 */
export function withCassette(loaded, env = process.env, options = {}) {
    const config = readCassetteConfig(env);
    if (!config)
        return loaded;
    const HandlerBase = loaded.module.CopilotRequestHandler;
    const { mode, stateDir, scenario } = config;
    if (typeof HandlerBase !== 'function')
        throw new CassetteConfigError(REQUEST_HANDLER_MISSING);
    const Base = HandlerBase;
    const dirs = { TMP: tmpdir(), USERHOME: homedir(), ...options.dirs };
    let replayer = null;
    if (mode === 'replay') {
        const key = JSON.stringify([config.dir, stateDir, scenario, options.matchMode, dirs]);
        replayer = replayers.get(key) ?? new CassetteReplayer(loadReplayCassette(config), stateDir, options.matchMode ?? 'tolerant', dirs);
        replayers.set(key, replayer);
    }
    const replaying = replayer;
    const Client = loaded.module.CopilotClient;
    const newRecorder = () => new CassetteRecorder({
        stateDir,
        scenario,
        sdkVersion: loaded.version,
        dirs,
        identity: { user: userInfo().username, host: hostname() },
    });
    class CassetteClient extends Client {
        constructor(opts) {
            const recorder = replaying ? null : newRecorder();
            const requestHandler = recorder ? createRecordingHandler(Base, recorder) : createReplayHandler(Base, replaying);
            super({ ...opts, requestHandler, ...(replaying ? { useLoggedInUser: false } : {}) });
            if (recorder) {
                const stop = this.stop.bind(this);
                this.stop = async () => {
                    const errors = await stop();
                    try {
                        await recorder.finish(join(stateDir, RECORD_PARTS_DIR, `${process.pid}-${++recordParts}`));
                    }
                    catch (err) {
                        errors.push(err instanceof Error ? err : new Error(String(err)));
                    }
                    return errors;
                };
            }
            else {
                const create = this.createSession.bind(this);
                this.createSession = async (session) => {
                    // listModels is unauthenticated in replay, so the model must be pinned; no session credential either.
                    if (!session.model)
                        throw new CassetteConfigError('replay needs a pinned model (--model)');
                    const rest = { ...session };
                    delete rest.gitHubToken;
                    return create(rest);
                };
            }
        }
    }
    const Connection = loaded.module.RuntimeConnection;
    const RuntimeConnection = Object.assign(Object.create(Connection), {
        forStdio: (opts) => Connection.forStdio({ ...opts, env: cassetteRuntimeEnv(opts.env ?? process.env, mode) }),
    });
    return {
        ...loaded,
        module: { ...loaded.module, CopilotClient: CassetteClient, RuntimeConnection },
    };
}
//# sourceMappingURL=handler.js.map