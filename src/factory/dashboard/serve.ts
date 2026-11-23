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
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { readdirSync, statSync, watch, type FSWatcher } from 'fs';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { plainText } from '../check/score.js';
import { commandText } from '../attention/actions.js';
import { readRun } from '../attention/collect.js';
import { runLabel, type FactoryRunKey } from '../run/state.js';
import type { DashboardDataV2 } from './collect-v2.js';
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
const HISTORY_MAX = 100;

const RUN_KEY = /^(?:([1-9][0-9]{0,8})|(heal-[0-9a-f]{8}))$/;

/** Constant-time token comparison; a different length still costs one compare and is false. */
export function tokenEquals(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** A `/api/v1/run/<key>` key: a positive integer (no leading zero) or `heal-<8 hex>`; null for anything else. */
export function parseRunKey(s: string): FactoryRunKey | null {
  const m = RUN_KEY.exec(s);
  if (!m) return null;
  return m[1] !== undefined ? Number(m[1]) : (m[2] as `heal-${string}`);
}

export function contentSecurityPolicy(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/** Served attention commands carry the line the CLI prints for this platform (commandText), so the page copies exactly that. */
export type ServedNext = DashboardDataV2['attention']['items'][number]['next'][number] & { line: string; inRoot: boolean };
export type ServedSummary = DashboardDataV2 & { rev: string };

export function servedSummary(d: DashboardDataV2, rev: string, platform: NodeJS.Platform = process.platform): ServedSummary {
  // An untrusted row keeps no title here (the attention collector keeps it, cut and plain): no free text from such a state leaves the server.
  const items = d.attention.items.map((i) => ({ ...i, title: i.trust === 'ok' ? i.title : '', next: i.next.map((n): ServedNext => ({ ...n, ...commandText(n.argv, platform) })) }));
  return { ...d, attention: { ...d.attention, items }, rev };
}

/** The rev: a hash of the summary without its clock-derived fields, so only a change of state changes it. */
export function summaryRev(d: DashboardDataV2): string {
  const stable = JSON.stringify(d, (k, v: unknown) => (k === 'generatedAt' || /Ms$/.test(k) ? undefined : v));
  return createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

/** JSON that is also safe if a browser ever sniffed it as HTML. */
const jsonText = (v: unknown): string => JSON.stringify(v).replace(/[<>&\p{Zl}\p{Zp}]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Multi-line plain text: each line through plainText (which turns newlines into spaces), joined back. */
const plainLines = (v: string, max: number): string => v.slice(0, max).split(/\r?\n/).map((l) => plainText(l)).join('\n');
const text = (v: unknown, max = 300): string => plainText(String(v ?? '')).replace(/\s+/g, ' ').trim().slice(0, max);

/** One cheap signature of a directory: names, sizes and mtimes (a missing dir is its own value). */
export function dirSignature(dir: string): string {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return `${dir}:none`;
  }
  const parts = [dir];
  for (const n of names) {
    try {
      const st = statSync(join(dir, n));
      parts.push(`${n}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${n}:gone`);
    }
  }
  return parts.join('|');
}

export interface DashboardServerOptions {
  root: string;
  ledgerDir: string;
  /** The collector, as the CLI composes it (limits, --since, --bench-dir, the --forge board). */
  collect: (now: number) => DashboardDataV2;
  port?: number;
  now?: () => number;
  /** Watched (fs.watch) and polled. */
  watchDirs: readonly string[];
  /** Polled only (bench result dirs). */
  pollDirs?: readonly string[];
  /** `--forge` only: the forge read, at start and every forgeRefreshMs. Never called otherwise. */
  forgeRefresh?: () => Promise<void>;
  forgeRefreshMs?: number;
  pollMs?: number;
  debounceMs?: number;
  minIntervalMs?: number;
  pingMs?: number;
  tickMs?: number;
  headersTimeoutMs?: number;
  maxConnections?: number;
  maxStreams?: number;
  platform?: NodeJS.Platform;
  /** Warnings for the terminal (never the token or URL). */
  log?: (line: string) => void;
}

export interface DashboardServer {
  /** The full URL with the token: print it once, never log or store it. */
  url: string;
  port: number;
  server: Server;
  rev: () => string;
  /** Recomputes done (tests and timings). */
  recomputes: () => number;
  close: () => Promise<void>;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
});

export async function startDashboardServer(o: DashboardServerOptions): Promise<DashboardServer> {
  const clock = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const platform = o.platform ?? process.platform;
  const maxStreams = o.maxStreams ?? MAX_STREAMS;
  const debounceMs = o.debounceMs ?? DEBOUNCE_MS;
  const minIntervalMs = o.minIntervalMs ?? MIN_RECOMPUTE_INTERVAL_MS;
  const headersTimeout = o.headersTimeoutMs ?? 5_000;

  // --- the summary and its rev -------------------------------------------------
  let forgeBusy = false;
  if (o.forgeRefresh) await o.forgeRefresh().catch((e: unknown) => log(`--forge: ${text(e instanceof Error ? e.message : e)}`));
  let summary: ServedSummary;
  let body: string;
  let recomputes = 0;
  const compute = (): ServedSummary => {
    const d = o.collect(clock());
    recomputes++;
    return servedSummary(d, summaryRev(d), platform);
  };
  summary = compute();
  body = jsonText(summary);

  const streams = new Set<ServerResponse>();
  const broadcast = (chunk: string): void => {
    for (const s of streams) s.write(chunk);
  };
  const recompute = (): void => {
    let next: ServedSummary;
    try {
      next = compute();
    } catch (error) {
      log(`dashboard: the state could not be read: ${text(error instanceof Error ? error.message : error)}`);
      return;
    }
    if (next.rev === summary.rev) return;
    summary = next;
    body = jsonText(summary);
    broadcast(`event: changed\ndata: ${summary.rev}\n\n`);
  };

  // At most one recompute per minIntervalMs, the first `debounceMs` after a change; later changes in the window join it.
  let timer: NodeJS.Timeout | null = null;
  let lastRun = 0;
  let closed = false;
  const schedule = (): void => {
    if (timer || closed) return;
    const delay = Math.max(debounceMs, lastRun + minIntervalMs - Date.now());
    timer = setTimeout(() => {
      timer = null;
      lastRun = Date.now();
      recompute();
    }, delay);
    timer.unref();
  };

  // --- watching ----------------------------------------------------------------------
  const watchers = new Map<string, FSWatcher>();
  const ensureWatchers = (): void => {
    for (const dir of o.watchDirs) {
      if (watchers.has(dir)) continue;
      try {
        const w = watch(dir, { persistent: false }, () => schedule());
        w.on('error', () => {
          w.close();
          watchers.delete(dir);
          schedule();
        });
        watchers.set(dir, w);
      } catch {
        // Not there yet (no factory run): the poll picks it up when it appears.
      }
    }
  };
  ensureWatchers();
  const allDirs = [...o.watchDirs, ...(o.pollDirs ?? [])];
  const signature = (): string => allDirs.map(dirSignature).join('\n');
  let sig = signature();
  const poll = setInterval(() => {
    ensureWatchers();
    const s = signature();
    if (s !== sig) {
      sig = s;
      schedule();
    }
  }, o.pollMs ?? POLL_MS);
  poll.unref();
  const tick = setInterval(schedule, o.tickMs ?? TICK_MS);
  tick.unref();
  const ping = setInterval(() => broadcast(': ping\n\n'), o.pingMs ?? PING_MS);
  ping.unref();
  let forgeTimer: NodeJS.Timeout | null = null;
  if (o.forgeRefresh) {
    const refresh = o.forgeRefresh;
    forgeTimer = setInterval(() => {
      if (forgeBusy) return;
      forgeBusy = true;
      refresh().catch((e: unknown) => log(`--forge: ${text(e instanceof Error ? e.message : e)}`)).finally(() => {
        forgeBusy = false;
        schedule();
      });
    }, o.forgeRefreshMs ?? FORGE_REFRESH_MS);
    forgeTimer.unref();
  }

  // --- HTTP ------------------------------------------------------------------------------
  let port = 0;
  const allowedHosts = (): string[] => [`127.0.0.1:${port}`, `localhost:${port}`];
  const allowedOrigins = (): string[] => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];

  const newNonce = (): string => randomBytes(16).toString('base64');
  const send = (req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string> = {}, payload = '', nonce = newNonce()): void => {
    res.statusCode = status;
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce));
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.setHeader('Content-Length', Buffer.byteLength(payload));
    res.end(req.method === 'HEAD' ? undefined : payload);
  };
  const refuse = (req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string> = {}): void => {
    send(req, res, status, { Connection: 'close', ...headers });
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const h = req.headers;
    if (typeof h.host !== 'string' || !allowedHosts().includes(h.host)) return refuse(req, res, 421);
    if (h.origin !== undefined && !allowedOrigins().includes(String(h.origin))) return refuse(req, res, 403);
    if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(req, res, 405, { Allow: 'GET, HEAD' });
    if (h['transfer-encoding'] !== undefined || (h['content-length'] !== undefined && h['content-length'] !== '0')) return refuse(req, res, 400);
    const url = req.url ?? '';
    if (url.length > MAX_URL_LENGTH) return refuse(req, res, 414);
    // The raw path, never decoded: only exact route strings match, so no encoding reaches anything.
    if (!url.startsWith('/t/')) return refuse(req, res, 404);
    const slash = url.indexOf('/', 3);
    if (slash < 0 || !tokenEquals(url.slice(3, slash), token)) return refuse(req, res, 404);
    const rest = url.slice(slash + 1);
    const q = rest.indexOf('?');
    const path = q < 0 ? rest : rest.slice(0, q);
    const query = q < 0 ? null : rest.slice(q + 1);
    const site = h['sec-fetch-site'];
    const sameSite = site === undefined || site === 'same-origin' || site === 'none';

    if (path === '' && query === null) {
      const nonce = newNonce();
      return send(req, res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, dashboardPageHtml(nonce), nonce);
    }
    if (path === 'api/v1/summary' && (query === null || /^rev=[0-9a-f]{0,64}$/.test(query))) {
      if (!sameSite) return refuse(req, res, 403);
      const etag = `"${summary.rev}"`;
      if (h['if-none-match'] === etag) return send(req, res, 304, { ETag: etag });
      return send(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag }, body);
    }
    if (path.startsWith('api/v1/run/') && query === null) {
      if (!sameSite) return refuse(req, res, 403);
      const key = parseRunKey(path.slice('api/v1/run/'.length));
      const detail = key === null ? null : runDetail(o.root, o.ledgerDir, summary, key);
      if (!detail) return refuse(req, res, 404);
      return send(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, jsonText(detail));
    }
    if (path === 'events' && query === null) {
      if (!sameSite) return refuse(req, res, 403);
      if (req.method === 'HEAD') return send(req, res, 200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      if (streams.size >= maxStreams) return refuse(req, res, 503, { 'Retry-After': '10' });
      res.writeHead(200, {
        ...SECURITY_HEADERS, 'Content-Security-Policy': contentSecurityPolicy(newNonce()),
        'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no',
      });
      req.socket.setTimeout(0);
      streams.add(res);
      res.on('close', () => streams.delete(res));
      res.write(`retry: 3000\n\nevent: changed\ndata: ${summary.rev}\n\n`);
      return;
    }
    return refuse(req, res, 404);
  };

  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES, headersTimeout: headersTimeout, requestTimeout: headersTimeout * 2, keepAliveTimeout: 5_000, connectionsCheckingInterval: Math.min(1_000, headersTimeout) }, (req, res) => {
    // A request body is never read: one that arrives is refused above and the socket closed.
    try {
      handle(req, res);
    } catch (error) {
      log(`dashboard: request failed: ${text(error instanceof Error ? error.message : error)}`);
      if (!res.headersSent) refuse(req, res, 500);
      else res.destroy();
    }
  });
  server.maxConnections = o.maxConnections ?? MAX_CONNECTIONS;
  server.maxRequestsPerSocket = 100;

  const stopTimers = (): void => {
    closed = true;
    clearInterval(poll);
    clearInterval(tick);
    clearInterval(ping);
    if (forgeTimer) clearInterval(forgeTimer);
    if (timer) clearTimeout(timer);
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen({ host: DASHBOARD_HOST, port: o.port ?? 0, exclusive: true }, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    stopTimers();
    throw error;
  }
  const address = server.address() as AddressInfo;
  if (address.address !== DASHBOARD_HOST) {
    stopTimers();
    server.close();
    throw new Error(`refusing to serve: bound ${address.address}, not ${DASHBOARD_HOST}`);
  }
  port = address.port;

  let closing: Promise<void> | null = null;
  return {
    url: `http://${DASHBOARD_HOST}:${port}/t/${token}/`,
    port,
    server,
    rev: () => summary.rev,
    recomputes: () => recomputes,
    close: () => {
      closing ??= new Promise<void>((done) => {
        stopTimers();
        for (const s of streams) s.end();
        streams.clear();
        server.close(() => done());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

export interface RunDetail {
  schemaVersion: 2;
  rev: string;
  run: DashboardDataV2['runs'][number];
  attention: ServedSummary['attention']['items'];
  /** Verified runs only: gate.detail, which is OUTPUT OF THE PR'S OWN CODE (never shown in a list). */
  gateDetail: { label: string; text: string } | null;
  lanes: { id: string; kind: string; status: string; model: string | null; credits: number | null; premiumRequests: number | null; startedAt: string | null; endedAt: string | null }[];
  history: { at: string; from: string | null; to: string; note: string }[];
}

/**
 * One run's detail from the current summary, plus what only a fresh,
 * trust-checked read of its state adds (gate.detail, lanes, history). An
 * unverified run gets its summary row only (no free text). Null: no such run.
 */
export function runDetail(root: string, ledgerDir: string, s: ServedSummary, key: FactoryRunKey): RunDetail | null {
  const label = runLabel(key);
  const run = s.runs.find((r) => r.key === label);
  if (!run) return null;
  const out: RunDetail = { schemaVersion: 2, rev: s.rev, run, attention: s.attention.items.filter((i) => i.key === label), gateDetail: null, lanes: [], history: [] };
  if (!run.verified) return out;
  const r = readRun(root, key, ledgerDir);
  if (r.trust !== 'ok' || !r.state) return out;
  const st = r.state;
  const detail = st.gate?.detail;
  if (typeof detail === 'string' && detail.length > 0) out.gateDetail = { label: 'Output of the PR\'s own code (untrusted)', text: plainLines(detail, GATE_DETAIL_MAX) };
  out.lanes = st.lanes.map((l) => ({
    id: text(l.id, 80), kind: text(l.role ?? l.kind, 40), status: text(l.status, 30), model: l.model ? text(l.model, 60) : null,
    credits: typeof l.usage?.credits === 'number' && Number.isFinite(l.usage.credits) ? l.usage.credits : null,
    premiumRequests: typeof l.usage?.premiumRequests === 'number' && Number.isFinite(l.usage.premiumRequests) ? l.usage.premiumRequests : null,
    startedAt: l.startedAt ? text(l.startedAt, 40) : null, endedAt: l.endedAt ? text(l.endedAt, 40) : null,
  }));
  out.history = st.history.slice(-HISTORY_MAX).map((h) => ({ at: text(h.at, 40), from: h.from === null ? null : text(h.from, 40), to: text(h.to, 40), note: text(h.note, 300) }));
  return out;
}
