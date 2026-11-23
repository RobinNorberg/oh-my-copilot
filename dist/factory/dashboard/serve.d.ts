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
import { type Server } from 'http';
import { type FSWatcher } from 'fs';
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
/** --all-repos: fs.watch handles across every repository (the rest are polled only). */
export declare const MAX_WATCHERS = 64;
/** --all-repos: the repository set is re-read this often. */
export declare const RESCAN_MS = 60000;
/** --all-repos: at most this many repositories are served. */
export declare const MAX_REPOS = 200;
/** A repository id the server issues: the ledger id (16 hex). */
export declare const SERVED_REPO_ID: RegExp;
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
/** One repository the server serves: its id (issued by the server's own list, never taken from a request), root, collector and dirs. */
export interface ServedRepo {
    id: string;
    root: string;
    collect: (now: number) => DashboardDataV2;
    watchDirs: readonly string[];
    pollDirs: readonly string[];
}
/** The --all-repos set: the repositories, and how many ledger records were skipped (count only). */
export interface ServedRepoList {
    repos: ServedRepo[];
    skipped: number;
    warnings: string[];
}
/** A served repository and what it last produced. */
export interface View {
    source: ServedRepo;
    summary: ServedSummary;
    body: string;
    sig: string;
    watchers: Map<string, FSWatcher>;
}
export interface DashboardServerOptions {
    /** The single-repository mode (without `repos`): its root, collector and dirs. */
    root?: string;
    ledgerDir: string;
    /** The collector, as the CLI composes it (limits, --since, --bench-dir, the --forge board). */
    collect?: (now: number) => DashboardDataV2;
    port?: number;
    now?: () => number;
    /** Watched (fs.watch) and polled. */
    watchDirs?: readonly string[];
    /** Polled only (bench result dirs). */
    pollDirs?: readonly string[];
    /**
     * `--all-repos`: the repository list, read at start and every rescanMs.
     * The routes are then `api/v1/repos` and `api/v1/repo/<id>/...`; the
     * single-repository `api/v1/summary` and `api/v1/run/<key>` are 404.
     */
    repos?: {
        list: () => ServedRepoList | Promise<ServedRepoList>;
        rescanMs?: number;
        maxWatchers?: number;
    };
    /** `--forge` only (single-repository mode): the forge read, at start and every forgeRefreshMs. Never called otherwise. */
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
    /** fs.watch handles open now (the global cap). */
    watchers: () => number;
    /** The repository ids served now (--all-repos; [''] in the single-repository mode). */
    repoIds: () => string[];
    close: () => Promise<void>;
}
export declare function startDashboardServer(o: DashboardServerOptions): Promise<DashboardServer>;
/** One repository's row of `api/v1/repos`: counts, engines, last change, and its attention rows. */
export interface ServedRepoRow {
    id: string;
    /** The root's last path segment (plain text). */
    name: string;
    /** The full root, plain text: shown as text only, never in a URL or an attribute. */
    root: string;
    /** The root as one word a command line can carry here (rootWord), or null: name the repository in prose. */
    rootWord: string | null;
    forge: string | null;
    byGroup: ServedSummary['attention']['summary']['byGroup'];
    items: number;
    engines: number;
    runs: number;
    /** The latest run update (ISO), or null. */
    lastChange: string | null;
    attention: ServedSummary['attention']['items'];
}
export interface ReposSummary {
    schemaVersion: 1;
    allRepos: true;
    rev: string;
    generatedAt: string;
    repos: ServedRepoRow[];
    summary: {
        byGroup: Record<string, number>;
        repos: number;
        items: number;
        engines: number;
        skipped: number;
    };
    warnings: string[];
}
/** `api/v1/repos`: the repositories, most urgent first (then the oldest wait), each with its attention rows. */
export declare function reposSummaryOf(views: readonly View[], skipped: number, warnings: string[], now: number, platform?: NodeJS.Platform): ReposSummary;
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