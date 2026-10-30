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
import { closeSync, mkdirSync, readFileSync, readdirSync, writeSync } from 'fs';
import { join } from 'path';
import { appendFileNoFollow, openAppendExclusive } from '../../lib/append-no-follow.js';
export const GLOBAL_STREAM = 'global';
/**
 * 418, not the design's 599: OpenAI-style clients retry 408, 409, 429 and
 * every 5xx with backoff, which would turn a miss into slow retries instead of
 * an immediate turn failure. 418 is in no retry set and never comes from the
 * real API, so a miss cannot be mistaken for an upstream answer.
 */
export const MISS_STATUS = 418;
const EXCERPT_CHARS = 400;
const CLAIMS_DIR = 'claims';
const SESSIONS_DIR = 'sessions';
const MISSES_FILE = 'misses.jsonl';
const DRIFT_FILE = 'drift.jsonl';
const SERVED_FILE = 'served.jsonl';
/**
 * Positions of live streams: the session ordinal (the order in which sessions
 * first issued a request, allocated across every process of the run) and the
 * agent path (`root`, `root/2`). The recorder (handler.ts) and the matcher both
 * track through this class, so a recorded position means the same on replay.
 */
export class StreamPositions {
    stateDir;
    sessionOrdinals = new Map();
    agentPaths = new Map();
    childCounts = new Map();
    constructor(stateDir) {
        this.stateDir = stateDir;
        mkdirSync(join(stateDir, SESSIONS_DIR), { recursive: true });
    }
    /** Records the session ordinal and agent path of the request's live stream. */
    track(req) {
        let ordinal = this.sessionOrdinals.get(req.sessionId);
        if (ordinal === undefined) {
            ordinal = this.allocateOrdinal(req.sessionId);
            this.sessionOrdinals.set(req.sessionId, ordinal);
        }
        const key = liveKey(req.sessionId, req.agentId);
        const known = this.agentPaths.get(key);
        if (known)
            return { ordinal, path: known };
        let path = 'root';
        if (req.parentAgentId !== undefined) {
            const parentKey = liveKey(req.sessionId, req.parentAgentId);
            const n = (this.childCounts.get(parentKey) ?? 0) + 1;
            this.childCounts.set(parentKey, n);
            path = `${this.agentPaths.get(parentKey) ?? 'root'}/${n}`;
        }
        this.agentPaths.set(key, path);
        return { ordinal, path };
    }
    /**
     * Next free session ordinal across every process of the run: the first n for
     * which `<state>/sessions/<n>` can be created exclusively, so a recorded
     * `session` means the same thing for a team whose sessions live in several
     * sdk hosts.
     */
    allocateOrdinal(sessionId) {
        const dir = join(this.stateDir, SESSIONS_DIR);
        for (let n = readdirSync(dir).length + 1;; n += 1) {
            let fd;
            try {
                fd = openAppendExclusive(join(dir, String(n)));
            }
            catch (err) {
                if (err.code === 'EEXIST')
                    continue;
                throw err;
            }
            try {
                writeSync(fd, `${JSON.stringify({ pid: process.pid, sessionId })}\n`);
            }
            finally {
                closeSync(fd);
            }
            return n;
        }
    }
}
export class ReplayMatcher {
    cassette;
    stateDir;
    mode;
    byStream = new Map();
    bound = new Map();
    positions;
    globalCursors = new Map();
    constructor(opts) {
        this.cassette = opts.cassette;
        this.stateDir = opts.stateDir;
        this.mode = opts.mode;
        for (const it of opts.cassette.interactions) {
            const list = this.byStream.get(it.stream) ?? [];
            list.push(it);
            this.byStream.set(it.stream, list);
        }
        for (const list of this.byStream.values())
            list.sort((a, b) => a.seq - b.seq);
        mkdirSync(join(this.stateDir, CLAIMS_DIR), { recursive: true });
        this.positions = new StreamPositions(this.stateDir);
        // Created up front: on Windows two processes creating a log at the same
        // moment makes appendFileNoFollow refuse the loser's first line.
        for (const file of [MISSES_FILE, DRIFT_FILE, SERVED_FILE]) {
            try {
                closeSync(openAppendExclusive(join(this.stateDir, file)));
            }
            catch (err) {
                if (err.code !== 'EEXIST')
                    throw err;
            }
        }
    }
    /** Never throws: a failure to read or write the replay state is answered as a miss. */
    match(req) {
        try {
            return this.matchOrThrow(req);
        }
        catch (err) {
            const reason = `replay state: ${err.message}`;
            return { kind: 'miss', stream: '-', seq: 0, reason, status: MISS_STATUS, body: `omg replay: cassette miss (-/0: ${reason})` };
        }
    }
    matchOrThrow(req) {
        if (req.promptDigest === undefined)
            return this.matchGlobal(req);
        const key = liveKey(req.sessionId, req.agentId);
        const { ordinal, path } = this.positions.track(req);
        let bound = this.bound.get(key);
        const drift = [];
        if (!bound) {
            const bind = this.bind(req, ordinal, path);
            if ('reason' in bind)
                return this.miss(req, '-', 0, bind.reason);
            bound = bind.bound;
            this.bound.set(key, bound);
            if (bind.fallback) {
                drift.push({ stream: bound.stream.id, seq: 0, kind: 'fallback', detail: `promptDigest ${req.promptDigest} matched no free stream; bound by session ${bound.stream.session} agent ${path}` });
            }
        }
        const id = bound.stream.id;
        const it = bound.queue[bound.cursor];
        if (!it)
            return this.miss(req, id, bound.queue[bound.queue.length - 1]?.seq ?? 0, 'stream exhausted', drift);
        const r = it.req;
        if (r.method !== req.method || r.path !== req.path || r.transport !== req.transport) {
            return this.miss(req, id, it.seq, `expected ${r.method} ${r.path} (${r.transport}), got ${req.method} ${req.path} (${req.transport})`, drift);
        }
        const carried = new Set(req.toolResultIds ?? []);
        const missing = (r.expectsToolResults ?? []).filter((callId) => !carried.has(callId));
        if (missing.length > 0)
            return this.miss(req, id, it.seq, `no tool result for ${missing.join(', ')}`, drift);
        if (r.deltaDigest !== req.deltaDigest) {
            if (this.mode === 'strict')
                return this.miss(req, id, it.seq, 'deltaDigest differs', drift);
            drift.push({ stream: id, seq: it.seq, kind: 'delta', detail: diffExcerpt(r.delta ?? '', req.delta ?? '') });
        }
        if (this.mode === 'strict' && r.toolNamesDigest !== req.toolNamesDigest) {
            return this.miss(req, id, it.seq, 'toolNamesDigest differs', drift);
        }
        if (r.model !== req.model) {
            if (this.mode === 'strict')
                return this.miss(req, id, it.seq, `model ${req.model ?? '-'} differs from recorded ${r.model ?? '-'}`, drift);
            drift.push({ stream: id, seq: it.seq, kind: 'model', detail: `recorded ${r.model ?? '-'}, live ${req.model ?? '-'}` });
        }
        // Logged before the cursor moves: a failed append is a miss and must not consume the interaction.
        this.served(id, it.seq);
        this.logDrift(drift);
        bound.cursor += 1;
        return { kind: 'hit', stream: id, seq: it.seq, interaction: it, drift };
    }
    /**
     * Non-conversation requests: in recorded order per method + path. Once they
     * run out, a GET or HEAD repeats the last answer (logged as `global-repeat`
     * drift); any other method misses, as an exhausted stream does.
     */
    matchGlobal(req) {
        const key = `${req.method} ${req.path}`;
        const list = (this.byStream.get(GLOBAL_STREAM) ?? []).filter((it) => it.req.method === req.method && it.req.path === req.path);
        if (list.length === 0)
            return this.miss(req, GLOBAL_STREAM, 0, `no global interaction for ${key}`);
        const cursor = this.globalCursors.get(key) ?? 0;
        const drift = [];
        let it = list[cursor];
        if (!it) {
            it = list[list.length - 1];
            if (req.method !== 'GET' && req.method !== 'HEAD')
                return this.miss(req, GLOBAL_STREAM, it.seq, `global stream exhausted for ${key}`);
            drift.push({ stream: GLOBAL_STREAM, seq: it.seq, kind: 'global-repeat', detail: `${key} served ${cursor + 1} times, recorded ${list.length}` });
        }
        this.served(GLOBAL_STREAM, it.seq);
        this.logDrift(drift);
        this.globalCursors.set(key, cursor + 1);
        return { kind: 'hit', stream: GLOBAL_STREAM, seq: it.seq, interaction: it, drift };
    }
    bind(req, ordinal, path) {
        const streams = this.cassette.manifest.streams;
        const byPrompt = streams.filter((s) => s.promptDigest === req.promptDigest);
        for (const s of byPrompt) {
            if (this.claim(s, req))
                return { bound: this.boundFor(s), fallback: false };
        }
        if (this.mode === 'strict') {
            return { reason: byPrompt.length > 0 ? `every stream with promptDigest ${req.promptDigest} is claimed` : `no stream with promptDigest ${req.promptDigest}` };
        }
        const byPosition = streams.filter((s) => s.session === ordinal && s.agent === path);
        for (const s of byPosition) {
            if (this.claim(s, req))
                return { bound: this.boundFor(s), fallback: true };
        }
        return { reason: `no free stream for promptDigest ${req.promptDigest} or session ${ordinal} agent ${path}` };
    }
    boundFor(stream) {
        return { stream, queue: this.byStream.get(stream.id) ?? [], cursor: 0 };
    }
    /** O_EXCL claim file; false when another matcher (any process) holds the stream. */
    claim(stream, req) {
        let fd;
        try {
            fd = openAppendExclusive(join(this.stateDir, CLAIMS_DIR, stream.id));
        }
        catch (err) {
            if (err.code === 'EEXIST')
                return false;
            throw err;
        }
        try {
            writeSync(fd, `${JSON.stringify({ pid: process.pid, sessionId: req.sessionId, agentId: req.agentId ?? null })}\n`);
        }
        finally {
            closeSync(fd);
        }
        return true;
    }
    miss(req, stream, seq, reason, drift = []) {
        const entry = { stream, seq, reason, method: req.method, path: req.path };
        this.append(MISSES_FILE, entry);
        this.logDrift(drift);
        return { kind: 'miss', stream, seq, reason, status: MISS_STATUS, body: `omg replay: cassette miss (${stream}/${seq}: ${reason})` };
    }
    served(stream, seq) {
        this.append(SERVED_FILE, { stream, seq });
    }
    logDrift(drift) {
        for (const d of drift)
            this.append(DRIFT_FILE, d);
    }
    append(file, value) {
        if (!appendFileNoFollow(join(this.stateDir, file), `${JSON.stringify(value)}\n`)) {
            throw new Error(`${file} is not a regular file`);
        }
    }
}
/** Merges what every matcher of one replay run wrote to the state dir (for the `scn.<name>.replay` check). */
export function summarizeReplayState(stateDir, cassette) {
    const served = readJsonl(join(stateDir, SERVED_FILE));
    const servedCount = new Map();
    for (const s of served) {
        const set = servedCount.get(s.stream) ?? new Set();
        set.add(s.seq);
        servedCount.set(s.stream, set);
    }
    const unclaimed = [];
    const unconsumed = [];
    for (const stream of cassette.manifest.streams) {
        let claimed = true;
        try {
            readFileSync(join(stateDir, CLAIMS_DIR, stream.id));
        }
        catch {
            claimed = false;
        }
        if (!claimed) {
            unclaimed.push(stream.id);
            continue;
        }
        const total = cassette.interactions.filter((it) => it.stream === stream.id).length;
        if ((servedCount.get(stream.id)?.size ?? 0) < total)
            unconsumed.push(stream.id);
    }
    return {
        misses: readJsonl(join(stateDir, MISSES_FILE)),
        drift: readJsonl(join(stateDir, DRIFT_FILE)),
        unclaimed,
        unconsumed,
    };
}
/** Excerpt of both texts from shortly before their first difference, at most 400 chars of each side together. */
export function diffExcerpt(recorded, live) {
    let i = 0;
    while (i < recorded.length && i < live.length && recorded[i] === live[i])
        i += 1;
    const start = Math.max(0, i - 40);
    const half = EXCERPT_CHARS / 2;
    return `@${i} recorded: ${JSON.stringify(recorded.slice(start, start + half))} live: ${JSON.stringify(live.slice(start, start + half))}`;
}
export function liveKey(sessionId, agentId) {
    return `${sessionId}\u0000${agentId ?? ''}`;
}
function readJsonl(file) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return [];
        throw err;
    }
    const lines = text.split('\n');
    // Text after the last newline may be a line another process is still writing: kept if it parses, dropped if torn.
    const tail = lines.pop() ?? '';
    const out = lines.filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
    if (tail.trim() !== '') {
        try {
            out.push(JSON.parse(tail));
        }
        catch {
            // torn final line
        }
    }
    return out;
}
//# sourceMappingURL=matcher.js.map