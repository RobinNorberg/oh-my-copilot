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
import { type Server } from 'http';
import { type FactoryRunKey } from '../run/state.js';
import type { DashboardDataV2 } from './collect-v2.js';
/** The only address the server listens on. */
export declare const DASHBOARD_HOST = "127.0.0.1";
export declare const TOKEN_BYTES = 32;
export declare const MAX_URL_LENGTH = 512;
export declare const MAX_HEADER_BYTES: number;
export declare const MAX_CONNECTIONS = 32;
export declare const MAX_STREAMS = 16;
export declare const POLL_MS = 5000;
export declare const DEBOUNCE_MS = 250;
export declare const MIN_RECOMPUTE_INTERVAL_MS = 1000;
export declare const PING_MS = 15000;
/** A recompute this often even without a file change: time-based notes ("possibly hung") appear. */
export declare const TICK_MS = 60000;
export declare const FORGE_REFRESH_MS: number;
export declare const GATE_DETAIL_MAX = 20000;
/** Constant-time token comparison; a different length still costs one compare and is false. */
export declare function tokenEquals(given: string, expected: string): boolean;
/** A `/api/v1/run/<key>` key: a positive integer (no leading zero) or `heal-<8 hex>`; null for anything else. */
export declare function parseRunKey(s: string): FactoryRunKey | null;
export declare function contentSecurityPolicy(nonce: string): string;
/** Served attention commands carry the line the CLI prints for this platform (commandText), so the page copies exactly that. */
export type ServedNext = DashboardDataV2['attention']['items'][number]['next'][number] & {
    line: string;
    inRoot: boolean;
};
export type ServedSummary = DashboardDataV2 & {
    rev: string;
};
export declare function servedSummary(d: DashboardDataV2, rev: string, platform?: NodeJS.Platform): ServedSummary;
/** The rev: a hash of the summary without its clock-derived fields, so only a change of state changes it. */
export declare function summaryRev(d: DashboardDataV2): string;
/** One cheap signature of a directory: names, sizes and mtimes (a missing dir is its own value). */
export declare function dirSignature(dir: string): string;
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
export declare function startDashboardServer(o: DashboardServerOptions): Promise<DashboardServer>;
export interface RunDetail {
    schemaVersion: 2;
    rev: string;
    run: DashboardDataV2['runs'][number];
    attention: ServedSummary['attention']['items'];
    /** Verified runs only: gate.detail, which is OUTPUT OF THE PR'S OWN CODE (never shown in a list). */
    gateDetail: {
        label: string;
        text: string;
    } | null;
    lanes: {
        id: string;
        kind: string;
        status: string;
        model: string | null;
        credits: number | null;
        premiumRequests: number | null;
        startedAt: string | null;
        endedAt: string | null;
    }[];
    history: {
        at: string;
        from: string | null;
        to: string;
        note: string;
    }[];
}
/**
 * One run's detail from the current summary, plus what only a fresh,
 * trust-checked read of its state adds (gate.detail, lanes, history). An
 * unverified run gets its summary row only (no free text). Null: no such run.
 */
export declare function runDetail(root: string, ledgerDir: string, s: ServedSummary, key: FactoryRunKey): RunDetail | null;
//# sourceMappingURL=serve.d.ts.map