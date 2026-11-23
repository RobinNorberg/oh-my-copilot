/**
 * `omg factory dashboard --serve`: the dashboard as a live page on a
 * loopback-only, read-only local HTTP server (node `http`, no dependency).
 *
 * Exposure: it binds 127.0.0.1 only (never another address, no `--host`).
 * Every route lives under `/t/<token>/`, a fresh 32-byte random token per
 * start that is printed once to the terminal and never written anywhere;
 * anything else is an empty 404. A request whose `Host` is not exactly
 * `127.0.0.1:<port>` or `localhost:<port>` is refused (DNS rebinding), as is
 * one with a foreign `Origin`, and the API and event stream refuse
 * `Sec-Fetch-Site` other than `same-origin` / `none`. No CORS header is ever
 * sent. GET and HEAD only; a request body, an overlong URL or header block,
 * and a slow request are cut off; connections and event streams are capped.
 *
 * Read-only: the handlers serve what the collector (collect-v2.ts, local
 * reads only) last produced, and one run's detail through the same trust
 * check (readRun). Nothing here writes a file, starts, resumes, approves,
 * cancels or merges anything. The page copies commands to the clipboard and
 * never runs them. `--forge` (the CLI's `forgeRefresh`) reads the forge at
 * start and on a slow timer, never per request or per event.
 *
 * Updates: fs.watch on the state, heal, slot and ledger dirs (flat dirs,
 * non-recursive) plus a poll of a cheap signature (names, sizes, mtimes).
 * A change schedules one recompute at most `debounceMs` later and at most
 * one per `minIntervalMs`, so a writer that rewrites files in a loop cannot
 * pin a CPU. The summary's rev is a hash of its time-independent part; when
 * it changes, every event stream gets `event: changed`.
 *
 * `--all-repos` (options.repos): one view per repository this host's engine
 * ledger knows (run/ledger-roots.ts), the list re-read every RESCAN_MS. A
 * repository is selected by the id the server issued for it (its 16-hex
 * ledger id), checked against the server's own list: `api/v1/repos`,
 * `api/v1/repo/<id>/summary`, `api/v1/repo/<id>/run/<key>`; an unknown or
 * malformed id is a 404 and no path ever comes from a request. Every view's
 * recompute goes through one debounced, rate-limited pass, and fs.watch
 * handles are capped across views (MAX_WATCHERS; the rest are polled). An
 * event names the view: `data: <id> <rev>`, or `data: repos <rev>` for the
 * list. Full roots are only ever JSON text values.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createServer } from 'http';
import { readdirSync, statSync, watch } from 'fs';
import { basename, join } from 'path';
import { plainText } from '../check/score.js';
import { commandText, rootWord } from '../attention/actions.js';
import { readRun } from '../attention/collect.js';
import { GATE_GROUPS, gateSteps, statusArgv } from '../run/gate-next.js';
import { FACTORY_PHASES, runLabel } from '../run/state.js';
import { dashboardPageHtml } from './client.js';
/** The only address the server listens on. */
export const DASHBOARD_HOST = '127.0.0.1';
export const TOKEN_BYTES = 32;
export const MAX_URL_LENGTH = 512;
export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_CONNECTIONS = 32;
export const MAX_STREAMS = 16;
export const POLL_MS = 5_000;
export const DEBOUNCE_MS = 250;
export const MIN_RECOMPUTE_INTERVAL_MS = 1_000;
export const PING_MS = 15_000;
/** A recompute this often even without a file change: time-based notes ("possibly hung") appear. */
export const TICK_MS = 60_000;
export const FORGE_REFRESH_MS = 5 * 60_000;
export const GATE_DETAIL_MAX = 20_000;
/** --all-repos: fs.watch handles across every repository (the rest are polled only). */
export const MAX_WATCHERS = 64;
/** --all-repos: the repository set is re-read this often. */
export const RESCAN_MS = 60_000;
/** --all-repos: at most this many repositories are served. */
export const MAX_REPOS = 200;
/** A repository id the server issues: the ledger id (16 hex). */
export const SERVED_REPO_ID = /^[0-9a-f]{16}$/;
const HISTORY_MAX = 100;
const RUN_KEY = /^(?:([1-9][0-9]{0,8})|(heal-[0-9a-f]{8}))$/;
/** Constant-time token comparison; a different length still costs one compare and is false. */
export function tokenEquals(given, expected) {
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) {
        timingSafeEqual(b, b);
        return false;
    }
    return timingSafeEqual(a, b);
}
/** A `/api/v1/run/<key>` key: a positive integer (no leading zero) or `heal-<8 hex>`; null for anything else. */
export function parseRunKey(s) {
    const m = RUN_KEY.exec(s);
    if (!m)
        return null;
    return m[1] !== undefined ? Number(m[1]) : m[2];
}
export function contentSecurityPolicy(nonce) {
    return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
/**
 * The one sentence a row of a state that is not trusted shows: fixed here,
 * never the collector's text (which may quote the state, a parse error or a
 * local path). The page has its own copy and ignores this for such rows.
 */
export const UNTRUSTED_WHY = Object.freeze({
    seal: 'This run state is not the engine\'s last write: its integrity seal fails. Nothing from it is shown; read it with the status command.',
    ledger: 'This run state is not the engine\'s last write: the engine ledger does not hold these bytes. Nothing from it is shown; read it with the status command.',
    unverified: 'This run state cannot be verified on this host: the engine ledger has no record of it. Nothing from it is shown; read it with the status command.',
    missing: 'This run\'s state file is missing; the engine ledger holds its last write. Nothing from it is shown; read it with the status command.',
    owner: 'An owner file the engine did not write holds this run. Nothing from it is shown; read it with the status command.',
    unreadable: 'This run state cannot be read. Nothing from it is shown; read it with the status command.',
});
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const untrustedTrust = (t) => (typeof t === 'string' && Object.prototype.hasOwnProperty.call(UNTRUSTED_WHY, t) ? t : 'unverified');
/** A gate name the shared gate table knows, in the engine's name shape; null for anything else. */
const knownGate = (g) => (typeof g === 'string' && SAFE_NAME.test(g) && gateSteps(g).known ? g : null);
const knownPhase = (p) => (typeof p === 'string' && FACTORY_PHASES.includes(p) ? p : null);
const finiteOrNull = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
/** A run label (`#12`, `heal-0123abcd`) back to its key, re-validated; null for anything else. */
export function keyOfLabel(label) {
    if (typeof label !== 'string')
        return null;
    const k = parseRunKey(label.startsWith('#') ? label.slice(1) : label);
    if (k === null || (typeof k === 'number') !== label.startsWith('#'))
        return null;
    return k;
}
/**
 * The served form of one attention item. A trusted row is the collector's
 * (plus the command lines). Any other row is built from an allowlist, never
 * by spreading the collector's object: the re-validated key, the group, the
 * trust value, the age, a known gate name and phase, the fixed sentence of
 * its trust, and the status command when the collector offered it, rebuilt
 * here from the key. No title, PR, head, reason, credits, notes or log.
 */
export function servedItem(i, platform = process.platform) {
    if (i.trust === 'ok')
        return { ...i, next: i.next.map((n) => ({ ...n, ...commandText(n.argv, platform) })) };
    const trust = untrustedTrust(i.trust);
    const key = keyOfLabel(i.key);
    const status = key === null ? null : statusArgv(key);
    const offered = status !== null && Array.isArray(i.next) && i.next.some((n) => Array.isArray(n?.argv) && n.argv.length === status.length && n.argv.every((a, k) => a === status[k]));
    return {
        key: key === null ? '' : runLabel(key),
        group: GATE_GROUPS.includes(i.group) ? i.group : 'inspect',
        gate: knownGate(i.gate), phase: knownPhase(i.phase), ageMs: finiteOrNull(i.ageMs),
        credits: null, cap: null, pr: null, head: null, title: '',
        why: UNTRUSTED_WHY[trust],
        next: offered && status ? [{ label: 'read the run state', argv: status, billed: false, ...commandText(status, platform) }] : [],
        trust, notes: [],
    };
}
const trustedRun = (r) => r.verified === true && r.trust === 'ok';
/** A run row: a verified run as collected; any other from an allowlist (key, kind, trust, a known phase and gate name; nothing else). */
export function servedRun(r) {
    if (trustedRun(r))
        return r;
    const key = keyOfLabel(r.key);
    const gate = knownGate(r.gate?.name);
    return {
        key: key === null ? '' : runLabel(key), kind: typeof key === 'string' ? 'ci-heal' : 'issue', trust: untrustedTrust(r.trust), verified: false, title: '',
        phase: knownPhase(r.phase), gate: gate ? { name: gate, reason: '', at: '' } : null, outcome: 'unknown', pr: null, head: null, forge: null,
        credits: null, premiumRequests: null, lanes: null, roles: {}, startedAt: null, updatedAt: null, elapsedMs: null,
        engineMs: null, waitingMs: null, waitingSince: null, timeline: [], mergeReadyAt: null, engineToMergeReadyMs: null, mergeWaitMs: null,
    };
}
/** Fixed, engine-authored warnings: a line per run whose state cannot be read, and a count of the rest (printed in the terminal, never served). */
export function servedWarnings(raw, items, runs) {
    const unreadable = [...new Set([...items, ...runs].filter((x) => x.trust === 'unreadable' && x.key !== '').map((x) => x.key))].sort();
    const out = unreadable.map((k) => `run ${k}: the state cannot be read`);
    if (raw.length > 0)
        out.push(`${raw.length} warning(s): the terminal running the server prints them`);
    return out;
}
export function servedSummary(d, rev, platform = process.platform) {
    // Defence in depth: whatever the collector passes, a row of a state that is not trusted carries no text or number from that state.
    const items = d.attention.items.map((i) => servedItem(i, platform));
    const runs = d.runs.map(servedRun);
    const untrusted = new Set(runs.filter((r) => !r.verified).map((r) => r.key));
    const known = new Set(runs.map((r) => r.key));
    const tasks = d.tasks.map((t) => {
        // A board row with no run (--forge backlog) holds tracker text, not state text.
        const boardOnly = t.outcome === 'no run' && !known.has(t.key);
        if (boardOnly || (t.verified === true && !untrusted.has(t.key)))
            return t;
        const key = keyOfLabel(t.key);
        const run = runs.find((r) => r.key === t.key);
        return { key: key === null ? '' : runLabel(key), verified: false, title: '', phase: run?.phase ?? null, gate: run?.gate?.name ?? null, outcome: 'unknown', pr: null, credits: null, wallMs: null, tracker: t.tracker };
    });
    const verifiedKeys = new Set(runs.filter((r) => r.verified).map((r) => r.key));
    const liveRuns = d.live.runs.map((r) => (r.verified === true && verifiedKeys.has(r.key) ? r : { key: keyOfLabel(r.key) === null ? '' : r.key, verified: false, phase: null, lane: null, heartbeatAgeMs: null, credits: null, inFlightCredits: 0 }));
    const warnings = servedWarnings(d.warnings, items, runs);
    return {
        ...d,
        // The repository's folder name, never its absolute local path.
        attention: { ...d.attention, repo: basename(d.attention.repo), items, warnings },
        live: { ...d.live, runs: liveRuns, inFlightCredits: liveRuns.reduce((a, r) => a + r.inFlightCredits, 0) },
        runs, tasks,
        cost: { ...d.cost, excluded: { runs: d.cost.excluded.runs, missing: d.cost.excluded.missing } },
        warnings,
        rev,
    };
}
/** The rev: a hash of the summary without its clock-derived fields, so only a change of state changes it. */
export function summaryRev(d) {
    const stable = JSON.stringify(d, (k, v) => (k === 'generatedAt' || /Ms$/.test(k) ? undefined : v));
    return createHash('sha256').update(stable).digest('hex').slice(0, 32);
}
/** JSON that is also safe if a browser ever sniffed it as HTML. */
const jsonText = (v) => JSON.stringify(v).replace(/[<>&\p{Zl}\p{Zp}]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
/** Multi-line plain text: each line through plainText (which turns newlines into spaces), joined back. */
const plainLines = (v, max) => v.slice(0, max).split(/\r?\n/).map((l) => plainText(l)).join('\n');
const text = (v, max = 300) => plainText(String(v ?? '')).replace(/\s+/g, ' ').trim().slice(0, max);
/** One cheap signature of a directory: names, sizes and mtimes (a missing dir is its own value). */
export function dirSignature(dir) {
    let names;
    try {
        names = readdirSync(dir).sort();
    }
    catch {
        return `${dir}:none`;
    }
    const parts = [dir];
    for (const n of names) {
        try {
            const st = statSync(join(dir, n));
            parts.push(`${n}:${st.size}:${st.mtimeMs}`);
        }
        catch {
            parts.push(`${n}:gone`);
        }
    }
    return parts.join('|');
}
/** An event stream whose client does not read holds at most this much in the server's buffer before it is dropped. */
export const STREAM_BUFFER_MAX = 64 * 1024;
/**
 * One write to an event stream. A client that stops reading (write returns
 * false, or the buffer passes STREAM_BUFFER_MAX) is destroyed and leaves the
 * set: the server never buffers without bound for it. False: dropped.
 */
export function writeEvent(s, chunk, streams) {
    const ok = s.write(chunk);
    if (ok && s.writableLength <= STREAM_BUFFER_MAX)
        return true;
    streams.delete(s);
    s.destroy();
    return false;
}
const SECURITY_HEADERS = Object.freeze({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
});
export async function startDashboardServer(o) {
    const clock = o.now ?? Date.now;
    const log = o.log ?? (() => { });
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const platform = o.platform ?? process.platform;
    const maxStreams = o.maxStreams ?? MAX_STREAMS;
    const debounceMs = o.debounceMs ?? DEBOUNCE_MS;
    const minIntervalMs = o.minIntervalMs ?? MIN_RECOMPUTE_INTERVAL_MS;
    const headersTimeout = o.headersTimeoutMs ?? 5_000;
    const multi = o.repos ?? null;
    if (!multi && (typeof o.root !== 'string' || !o.collect))
        throw new Error('startDashboardServer: a root and a collector, or a repository list');
    const maxWatchers = multi?.maxWatchers ?? MAX_WATCHERS;
    // --- the views: one per repository (one in the single-repository mode) ----------------------
    let forgeBusy = false;
    if (!multi && o.forgeRefresh)
        await o.forgeRefresh().catch((e) => log(`--forge: ${text(e instanceof Error ? e.message : e)}`));
    let recomputes = 0;
    const views = new Map();
    // The collector's raw warnings (error text, local paths) go to the terminal only, once per change; the page gets fixed lines.
    const loggedWarnings = new Map();
    const compute = (v) => {
        const d = v.source.collect(clock());
        recomputes++;
        const raw = d.warnings.map((w) => text(w, 500));
        if (raw.join('\n') !== (loggedWarnings.get(v.source.id) ?? '')) {
            loggedWarnings.set(v.source.id, raw.join('\n'));
            for (const w of raw)
                log(`dashboard warning: ${multi ? `repository ${v.source.id}: ` : ''}${w}`);
        }
        // The rev is of what is served, so a change only in what an untrusted state says sends no event.
        const served = servedSummary(d, '', platform);
        return { ...served, rev: summaryRev({ ...served, rev: undefined }) };
    };
    const addView = (source) => {
        let summary;
        try {
            summary = compute({ source });
        }
        catch (error) {
            log(`dashboard: ${multi ? `repository ${source.id}: ` : ''}the state could not be read: ${text(error instanceof Error ? error.message : error)}`);
            if (!multi)
                throw error;
            return null;
        }
        const v = { source, summary, body: jsonText(summary), sig: '', watchers: new Map() };
        v.sig = signature(v);
        views.set(source.id, v);
        return v;
    };
    const single = multi ? null : { id: '', root: o.root, collect: o.collect, watchDirs: o.watchDirs ?? [], pollDirs: o.pollDirs ?? [] };
    if (single)
        addView(single);
    let reposSummary = null;
    let reposBody = '';
    let skipped = 0;
    let listWarnings = [];
    const rebuildRepos = () => {
        const next = reposSummaryOf([...views.values()], skipped, listWarnings, clock(), platform);
        const changed = reposSummary === null || next.rev !== reposSummary.rev;
        reposSummary = next;
        reposBody = jsonText(next);
        return changed;
    };
    const applyList = (list) => {
        const wanted = new Map(list.repos.slice(0, MAX_REPOS).map((r) => [r.id, r]));
        let changed = false;
        for (const [id, v] of views) {
            // A repository that disappeared (or whose root changed) is dropped.
            const w = wanted.get(id);
            if (!w || w.root !== v.source.root) {
                closeWatchers(v);
                views.delete(id);
                changed = true;
            }
        }
        for (const [id, r] of wanted) {
            if (views.has(id) || !SERVED_REPO_ID.test(id))
                continue;
            if (addView(r))
                changed = true;
        }
        skipped = list.skipped;
        listWarnings = list.warnings.map((w) => text(w, 500));
        return changed;
    };
    if (multi) {
        applyList(await multi.list());
        rebuildRepos();
    }
    const streams = new Set();
    const broadcast = (chunk) => {
        for (const s of streams)
            writeEvent(s, chunk, streams);
    };
    const recompute = (v) => {
        let next;
        try {
            next = compute(v);
        }
        catch (error) {
            log(`dashboard: ${multi ? `repository ${v.source.id}: ` : ''}the state could not be read: ${text(error instanceof Error ? error.message : error)}`);
            return;
        }
        if (next.rev === v.summary.rev)
            return;
        v.summary = next;
        v.body = jsonText(next);
        // The single-repository stream names the rev only, as before; with --all-repos it names the repository id first.
        broadcast(`event: changed\ndata: ${multi ? `${v.source.id} ` : ''}${next.rev}\n\n`);
    };
    const announceRepos = () => {
        if (multi && rebuildRepos())
            broadcast(`event: changed\ndata: repos ${reposSummary.rev}\n\n`);
    };
    // One recompute pass over the changed views at most per minIntervalMs, the first `debounceMs` after a change;
    // later changes in the window join it, so writers in many repositories cannot pin a CPU either.
    const dirty = new Set();
    let timer = null;
    let lastRun = 0;
    let closed = false;
    const schedule = (id) => {
        if (closed)
            return;
        if (id === null)
            for (const k of views.keys())
                dirty.add(k);
        else
            dirty.add(id);
        if (timer)
            return;
        const delay = Math.max(debounceMs, lastRun + minIntervalMs - Date.now());
        timer = setTimeout(() => {
            timer = null;
            lastRun = Date.now();
            const ids = [...dirty];
            dirty.clear();
            for (const k of ids) {
                const v = views.get(k);
                if (v)
                    recompute(v);
            }
            announceRepos();
        }, delay);
        timer.unref();
    };
    // --- watching: fs.watch up to a global cap of watchers, a poll of every view's dirs ------------------
    let watcherCount = 0;
    function closeWatchers(v) {
        for (const w of v.watchers.values())
            w.close();
        watcherCount -= v.watchers.size;
        v.watchers.clear();
    }
    const ensureWatchers = () => {
        for (const v of views.values()) {
            for (const dir of v.source.watchDirs) {
                if (v.watchers.has(dir) || watcherCount >= maxWatchers)
                    continue;
                try {
                    const id = v.source.id;
                    const w = watch(dir, { persistent: false }, () => schedule(id));
                    w.on('error', () => {
                        w.close();
                        if (v.watchers.delete(dir))
                            watcherCount--;
                        schedule(id);
                    });
                    v.watchers.set(dir, w);
                    watcherCount++;
                }
                catch {
                    // Not there yet (no factory run): the poll picks it up when it appears.
                }
            }
        }
    };
    ensureWatchers();
    const poll = setInterval(() => {
        ensureWatchers();
        for (const v of views.values()) {
            const s = signature(v);
            if (s !== v.sig) {
                v.sig = s;
                schedule(v.source.id);
            }
        }
    }, o.pollMs ?? POLL_MS);
    poll.unref();
    const tick = setInterval(() => schedule(null), o.tickMs ?? TICK_MS);
    tick.unref();
    const ping = setInterval(() => broadcast(': ping\n\n'), o.pingMs ?? PING_MS);
    ping.unref();
    let forgeTimer = null;
    if (!multi && o.forgeRefresh) {
        const refresh = o.forgeRefresh;
        forgeTimer = setInterval(() => {
            if (forgeBusy)
                return;
            forgeBusy = true;
            refresh().catch((e) => log(`--forge: ${text(e instanceof Error ? e.message : e)}`)).finally(() => {
                forgeBusy = false;
                schedule(null);
            });
        }, o.forgeRefreshMs ?? FORGE_REFRESH_MS);
        forgeTimer.unref();
    }
    // --all-repos: the repository set is re-read on a slow timer (new repositories appear, gone ones are dropped).
    let rescanTimer = null;
    let rescanning = false;
    if (multi) {
        rescanTimer = setInterval(() => {
            if (rescanning || closed)
                return;
            rescanning = true;
            Promise.resolve().then(() => multi.list()).then((list) => {
                if (closed)
                    return;
                if (applyList(list))
                    ensureWatchers();
                announceRepos();
            }).catch((e) => log(`dashboard: the repository list could not be re-read: ${text(e instanceof Error ? e.message : e)}`)).finally(() => {
                rescanning = false;
            });
        }, multi.rescanMs ?? RESCAN_MS);
        rescanTimer.unref();
    }
    // --- HTTP ------------------------------------------------------------------------------
    let port = 0;
    const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];
    const allowedOrigins = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    const newNonce = () => randomBytes(16).toString('base64');
    const send = (req, res, status, headers = {}, payload = '', nonce = newNonce()) => {
        res.statusCode = status;
        res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce));
        for (const [k, v] of Object.entries(SECURITY_HEADERS))
            res.setHeader(k, v);
        for (const [k, v] of Object.entries(headers))
            res.setHeader(k, v);
        res.setHeader('Content-Length', Buffer.byteLength(payload));
        res.end(req.method === 'HEAD' ? undefined : payload);
    };
    const refuse = (req, res, status, headers = {}) => {
        send(req, res, status, { Connection: 'close', ...headers });
    };
    const sendJson = (req, res, rev, payload) => {
        const etag = `"${rev}"`;
        if (req.headers['if-none-match'] === etag)
            return send(req, res, 304, { ETag: etag });
        return send(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag }, payload);
    };
    const revQuery = (query) => query === null || /^rev=[0-9a-f]{0,64}$/.test(query);
    const handle = (req, res) => {
        const h = req.headers;
        if (typeof h.host !== 'string' || !allowedHosts().includes(h.host))
            return refuse(req, res, 421);
        if (h.origin !== undefined && !allowedOrigins().includes(String(h.origin)))
            return refuse(req, res, 403);
        if (req.method !== 'GET' && req.method !== 'HEAD')
            return refuse(req, res, 405, { Allow: 'GET, HEAD' });
        if (h['transfer-encoding'] !== undefined || (h['content-length'] !== undefined && h['content-length'] !== '0'))
            return refuse(req, res, 400);
        const url = req.url ?? '';
        if (url.length > MAX_URL_LENGTH)
            return refuse(req, res, 414);
        // The raw path, never decoded: only exact route strings match, so no encoding reaches anything.
        if (!url.startsWith('/t/'))
            return refuse(req, res, 404);
        const slash = url.indexOf('/', 3);
        if (slash < 0 || !tokenEquals(url.slice(3, slash), token))
            return refuse(req, res, 404);
        const rest = url.slice(slash + 1);
        const q = rest.indexOf('?');
        const path = q < 0 ? rest : rest.slice(0, q);
        const query = q < 0 ? null : rest.slice(q + 1);
        const site = h['sec-fetch-site'];
        const sameSite = site === undefined || site === 'same-origin' || site === 'none';
        if (path === '' && query === null) {
            const nonce = newNonce();
            return send(req, res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, dashboardPageHtml(nonce, { allRepos: multi !== null }), nonce);
        }
        if (!multi && path === 'api/v1/summary' && revQuery(query)) {
            if (!sameSite)
                return refuse(req, res, 403);
            const v = views.get('');
            return sendJson(req, res, v.summary.rev, v.body);
        }
        if (!multi && path.startsWith('api/v1/run/') && query === null) {
            if (!sameSite)
                return refuse(req, res, 403);
            const key = parseRunKey(path.slice('api/v1/run/'.length));
            const detail = key === null ? null : runDetail(o.root, o.ledgerDir, views.get('').summary, key);
            if (!detail)
                return refuse(req, res, 404);
            return send(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, jsonText(detail));
        }
        if (multi && path === 'api/v1/repos' && revQuery(query)) {
            if (!sameSite)
                return refuse(req, res, 403);
            return sendJson(req, res, reposSummary.rev, reposBody);
        }
        if (multi && path.startsWith('api/v1/repo/')) {
            if (!sameSite)
                return refuse(req, res, 403);
            // `api/v1/repo/<id>/summary` or `api/v1/repo/<id>/run/<key>`: the id must be one this server issued.
            const m = /^api\/v1\/repo\/([0-9a-f]{16})\/(summary|run\/([^/]*))$/.exec(path);
            const v = m ? views.get(m[1]) : undefined;
            if (!m || !v)
                return refuse(req, res, 404);
            if (m[2] === 'summary')
                return revQuery(query) ? sendJson(req, res, v.summary.rev, v.body) : refuse(req, res, 404);
            if (query !== null)
                return refuse(req, res, 404);
            const key = parseRunKey(m[3]);
            const detail = key === null ? null : runDetail(v.source.root, o.ledgerDir, v.summary, key);
            if (!detail)
                return refuse(req, res, 404);
            return send(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, jsonText(detail));
        }
        if (path === 'events' && query === null) {
            if (!sameSite)
                return refuse(req, res, 403);
            if (req.method === 'HEAD')
                return send(req, res, 200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
            if (streams.size >= maxStreams)
                return refuse(req, res, 503, { 'Retry-After': '10' });
            res.writeHead(200, {
                ...SECURITY_HEADERS, 'Content-Security-Policy': contentSecurityPolicy(newNonce()),
                'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no',
            });
            req.socket.setTimeout(0);
            streams.add(res);
            res.on('close', () => streams.delete(res));
            writeEvent(res, `retry: 3000\n\nevent: changed\ndata: ${multi ? `repos ${reposSummary.rev}` : views.get('').summary.rev}\n\n`, streams);
            return;
        }
        return refuse(req, res, 404);
    };
    const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES, headersTimeout: headersTimeout, requestTimeout: headersTimeout * 2, keepAliveTimeout: 5_000, connectionsCheckingInterval: Math.min(1_000, headersTimeout) }, (req, res) => {
        // A request body is never read: one that arrives is refused above and the socket closed.
        try {
            handle(req, res);
        }
        catch (error) {
            log(`dashboard: request failed: ${text(error instanceof Error ? error.message : error)}`);
            if (!res.headersSent)
                refuse(req, res, 500);
            else
                res.destroy();
        }
    });
    server.maxConnections = o.maxConnections ?? MAX_CONNECTIONS;
    server.maxRequestsPerSocket = 100;
    const stopTimers = () => {
        closed = true;
        clearInterval(poll);
        clearInterval(tick);
        clearInterval(ping);
        if (forgeTimer)
            clearInterval(forgeTimer);
        if (rescanTimer)
            clearInterval(rescanTimer);
        if (timer)
            clearTimeout(timer);
        for (const v of views.values())
            closeWatchers(v);
    };
    try {
        await new Promise((resolveListen, rejectListen) => {
            server.once('error', rejectListen);
            server.listen({ host: DASHBOARD_HOST, port: o.port ?? 0, exclusive: true }, () => {
                server.off('error', rejectListen);
                resolveListen();
            });
        });
    }
    catch (error) {
        stopTimers();
        throw error;
    }
    const address = server.address();
    if (address.address !== DASHBOARD_HOST) {
        stopTimers();
        server.close();
        throw new Error(`refusing to serve: bound ${address.address}, not ${DASHBOARD_HOST}`);
    }
    port = address.port;
    let closing = null;
    return {
        url: `http://${DASHBOARD_HOST}:${port}/t/${token}/`,
        port,
        server,
        rev: () => (multi ? reposSummary.rev : views.get('').summary.rev),
        recomputes: () => recomputes,
        watchers: () => watcherCount,
        repoIds: () => [...views.keys()],
        close: () => {
            closing ??= new Promise((done) => {
                stopTimers();
                for (const s of streams)
                    s.end();
                streams.clear();
                server.close(() => done());
                server.closeAllConnections();
            });
            return closing;
        },
    };
}
/** Each watched and polled dir's signature, joined. */
function signature(v) {
    return [...v.source.watchDirs, ...v.source.pollDirs].map(dirSignature).join('\n');
}
const GROUP_RANK = new Map(['inspect', 'broken', 'decide', 'merge', 'fix', 'limits'].map((g, i) => [g, i]));
/** `api/v1/repos`: the repositories, most urgent first (then the oldest wait), each with its attention rows. */
export function reposSummaryOf(views, skipped, warnings, now, platform = process.platform) {
    const rows = views.map((v) => {
        const s = v.summary;
        const items = s.attention.items;
        const last = s.runs.reduce((m, r) => (typeof r.updatedAt === 'string' && (m === null || r.updatedAt > m) ? r.updatedAt : m), null);
        const rank = items.length ? Math.min(...items.map((i) => GROUP_RANK.get(i.group) ?? 99)) : 100;
        const oldest = Math.max(0, ...items.filter((i) => (GROUP_RANK.get(i.group) ?? 99) === rank).map((i) => i.ageMs ?? 0));
        return {
            id: v.source.id, name: text(basename(v.source.root), 120) || text(v.source.root, 120), root: text(v.source.root, 1_000), rootWord: rootWord(v.source.root, platform),
            forge: s.attention.forge, byGroup: s.attention.summary.byGroup, items: items.length, engines: s.live.engines, runs: s.runs.length, lastChange: last, attention: items, rank, oldest,
        };
    });
    rows.sort((a, b) => a.rank - b.rank || b.oldest - a.oldest || a.root.localeCompare(b.root));
    const repos = rows.map(({ rank: _r, oldest: _o, ...rest }) => rest);
    const byGroup = {};
    for (const g of GROUP_RANK.keys())
        byGroup[g] = repos.reduce((n, r) => n + (r.byGroup[g] ?? 0), 0);
    const stable = { repos: views.map((v) => [v.source.id, v.summary.rev]).sort(), skipped, warnings };
    return {
        schemaVersion: 1, allRepos: true, rev: createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32), generatedAt: new Date(now).toISOString(), repos,
        summary: { byGroup, repos: repos.length, items: repos.reduce((n, r) => n + r.items, 0), engines: repos.reduce((n, r) => n + r.engines, 0), skipped }, warnings,
    };
}
/**
 * One run's detail from the current summary, plus what only a fresh,
 * trust-checked read of its state adds (gate.detail, lanes, history). An
 * unverified run gets its summary row only (no free text). Null: no such run.
 */
export function runDetail(root, ledgerDir, s, key) {
    const label = runLabel(key);
    const run = s.runs.find((r) => r.key === label);
    if (!run)
        return null;
    const out = { schemaVersion: 2, rev: s.rev, run, attention: s.attention.items.filter((i) => i.key === label), gateDetail: null, lanes: [], history: [] };
    if (!run.verified)
        return out;
    const r = readRun(root, key, ledgerDir);
    if (r.trust !== 'ok' || !r.state)
        return out;
    const st = r.state;
    const detail = st.gate?.detail;
    if (typeof detail === 'string' && detail.length > 0)
        out.gateDetail = { label: 'Output of the PR\'s own code (untrusted)', text: plainLines(detail, GATE_DETAIL_MAX) };
    out.lanes = st.lanes.map((l) => ({
        id: text(l.id, 80), kind: text(l.role ?? l.kind, 40), status: text(l.status, 30), model: l.model ? text(l.model, 60) : null,
        credits: typeof l.usage?.credits === 'number' && Number.isFinite(l.usage.credits) ? l.usage.credits : null,
        premiumRequests: typeof l.usage?.premiumRequests === 'number' && Number.isFinite(l.usage.premiumRequests) ? l.usage.premiumRequests : null,
        startedAt: l.startedAt ? text(l.startedAt, 40) : null, endedAt: l.endedAt ? text(l.endedAt, 40) : null,
    }));
    out.history = st.history.slice(-HISTORY_MAX).map((h) => ({ at: text(h.at, 40), from: h.from === null ? null : text(h.from, 40), to: text(h.to, 40), note: text(h.note, 300) }));
    return out;
}
//# sourceMappingURL=serve.js.map