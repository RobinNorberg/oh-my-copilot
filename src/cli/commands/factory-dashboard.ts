/**
 * `omg factory dashboard`: one static HTML page (or --json) of what needs
 * you, the engines running, every factory run of this repository with its
 * timeline, tasks, cost, throughput and bench results. Logic in
 * src/factory/dashboard/ (collect-v2.ts: collect -> JSON; render.ts:
 * JSON -> HTML).
 *
 * LOCAL and READ-ONLY by default: no forge or network read and no write
 * except the --out file. `--forge` opts in to what the dashboard did before:
 * it reads the tracker (the board's read, for the tracker columns) and
 * records the stopped runs whose PR a human merged (human-merged.ts), which
 * writes those runs' states.
 *
 * `--watch [seconds]` (with --out) rewrites the file on an interval, only
 * when the page changed and atomically (temp file + rename), until Ctrl-C;
 * the page then reloads itself (meta refresh). With --forge the forge is
 * read on a slow timer (FORGE_REFRESH_MS), never per tick.
 */

import { execFileSync, spawn } from 'child_process';
import { renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import type { BoardJson } from '../../factory/board/collect.js';
import { collectDashboard } from '../../factory/dashboard/collect.js';
import { collectDashboardV2, type DashboardDataV2 } from '../../factory/dashboard/collect-v2.js';
import { renderDashboardHtml } from '../../factory/dashboard/render.js';
import { EXIT_CHECK_FAILED, EXIT_CHECK_USAGE } from '../../factory/check/cli.js';
import { plainText } from '../../factory/check/score.js';
import type { LoadedFactoryRunLimits } from '../../factory/run/budget.js';
import { defaultLedgerDir, ledgerFilePath } from '../../factory/run/ledger.js';
import { factorySlotsDir, factoryStateDir, type OwnerDeps } from '../../factory/run/state.js';
import { healStateDir } from '../../factory/heal/state.js';
import { startDashboardServer, type DashboardServer, type DashboardServerOptions, type ServedRepoList } from '../../factory/dashboard/serve.js';
import { checkPinnedRoot, discoverLedgerRoots } from '../../factory/run/ledger-roots.js';

export const WATCH_DEFAULT_SECONDS = 10;
export const WATCH_MIN_SECONDS = 2;
/** --watch --forge: the forge is read at most this often. */
export const FORGE_REFRESH_MS = 5 * 60_000;

export interface ForgeRead {
  /** Lines for stderr (human merges recorded, PRs not checked). */
  lines: string[];
  /** The board's JSON (tracker columns); null when the tracker could not be read. */
  board: BoardJson | null;
}

export interface FactoryDashboardDeps {
  root: () => string;
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => Date;
  ledgerDir?: string;
  /** The run limits as the engine resolves them (cost caps); a throw is a warning and no cap. */
  limits?: (root: string) => LoadedFactoryRunLimits;
  owner?: OwnerDeps;
  /** `--forge` only: read the tracker and record human merges. Never called without --forge. */
  forgeRead?: (root: string) => Promise<ForgeRead>;
  /** --watch: wait `ms`; resolves false when interrupted (Ctrl-C). */
  sleep?: (ms: number) => Promise<boolean>;
  /** Write `content` to `file` so a reader never sees a half-written file. */
  writeFile?: (file: string, content: string) => void;
  /** --serve: start the server (tests pass options through or wrap it). */
  serve?: (o: DashboardServerOptions) => Promise<DashboardServer>;
  /** --serve: resolves at Ctrl-C (SIGINT or SIGTERM). */
  waitForStop?: () => Promise<void>;
  /** --open: hand the URL to the platform's browser opener; failures are ignored. */
  openUrl?: (url: string) => void;
}

/** Resolves at the first SIGINT or SIGTERM. */
export function waitForStopSignal(): Promise<void> {
  return new Promise((done) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      done();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * The platform's URL opener with the URL as ONE argument and no shell
 * (Windows: rundll32's FileProtocolHandler; macOS: open; else xdg-open).
 * Any failure is silent: the URL is printed anyway.
 */
export function openUrlInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]+\/$/.test(url)) return;
  const [cmd, args] = platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No opener: the printed URL is enough.
  }
}

const defaultRoot = (): string => execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();

/** Temp file next to the target, then one rename over it. */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** Resolves true after `ms`, false at the first Ctrl-C (SIGINT) before that. */
export function sleepUntilInterrupt(ms: number): Promise<boolean> {
  return new Promise((done) => {
    const onInt = (): void => { clearTimeout(t); done(false); };
    const t = setTimeout(() => { process.off('SIGINT', onInt); done(true); }, ms);
    process.once('SIGINT', onInt);
  });
}

export const defaultDashboardDeps: FactoryDashboardDeps = { root: defaultRoot, out: (l) => console.log(l), err: (l) => console.error(l) };

class UsageError extends Error {}

function watchSeconds(v: string | boolean | undefined): number | null {
  if (v === undefined || v === false) return null;
  if (v === true) return WATCH_DEFAULT_SECONDS;
  const n = Number(v.replace(/s$/, ''));
  if (!Number.isInteger(n) || n < WATCH_MIN_SECONDS) throw new UsageError(`--watch takes whole seconds, at least ${WATCH_MIN_SECONDS}; got ${JSON.stringify(v)}`);
  return n;
}

interface DashboardOptions {
  out?: string;
  json?: boolean;
  since?: string;
  schema?: string;
  forge?: boolean;
  benchDir?: string[];
  watch?: string | boolean;
  serve?: boolean;
  port?: string;
  open?: boolean;
  allRepos?: boolean;
  repo?: string[];
}

function servePort(v: string | undefined): number {
  if (v === undefined) return 0;
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isInteger(n) || n < 1024 || n > 65535) throw new UsageError(`--port takes a port from 1024 to 65535, got ${JSON.stringify(v)}`);
  return n;
}

export function factoryDashboardCommand(deps: FactoryDashboardDeps = defaultDashboardDeps): Command {
  return new Command('dashboard')
    .description('One static HTML page: what needs you, engines running, runs with engine and waiting time, tasks, cost, throughput and bench results (local state only and no write unless --forge)')
    .option('--out <file>', 'write the page to this file (default: print it)')
    .option('--json', 'emit the data as JSON (schemaVersion 2)')
    .option('--schema <n>', 'with --json: 1 emits the old schemaVersion 1 shape (kept for one release)', '2')
    .option('--since <date>', 'only runs, lanes, days and bench results on or after this date (2026-11-01 means local midnight; days are in local time)')
    .option('--forge', 'also read the tracker (bucket and live stage per task) and record runs whose PR a human merged: forge reads and state writes')
    .option('--bench-dir <dir>', 'also read bench result files (*.json) from this directory (repeatable; a bench fixture keeps them in <fixture>/results)', (v: string, prev: string[] = []) => [...prev, v])
    .option('--watch [seconds]', `with --out: rewrite the file every N seconds (default ${WATCH_DEFAULT_SECONDS}, at least ${WATCH_MIN_SECONDS}) when it changed, until Ctrl-C; the page reloads itself`)
    .option('--serve', 'serve a live, read-only page on 127.0.0.1 (a random token in the URL) until Ctrl-C; not with --out, --watch or --json')
    .option('--port <n>', 'with --serve: listen on this port (1024-65535; default: a random free port)')
    .option('--open', 'with --serve: open the page in the default browser')
    .option('--all-repos', 'with --serve: every repository the engine ledger of this host records, with a Repositories section (runs from any directory; not with --forge or --bench-dir)')
    .option('--repo <path>', 'with --serve --all-repos: only this repository top level (repeatable)', (v: string, prev: string[] = []) => [...prev, v])
    .action(async (o: DashboardOptions) => {
      if (o.allRepos || o.repo) {
        try {
          process.exitCode = await serveAllRepos(o, deps);
        } catch (error) {
          deps.err(chalk.red(plainText(error instanceof Error ? error.message : String(error))));
          process.exitCode = error instanceof UsageError ? EXIT_CHECK_USAGE : EXIT_CHECK_FAILED;
        }
        return;
      }
      let root: string;
      try {
        root = deps.root();
      } catch {
        deps.err(chalk.red('omg factory dashboard must run inside a git repository (or pass --serve --all-repos)'));
        process.exitCode = EXIT_CHECK_USAGE;
        return;
      }
      try {
        process.exitCode = await runDashboard(root, o, deps);
      } catch (error) {
        const message = plainText(error instanceof Error ? error.message : String(error));
        deps.err(chalk.red(message));
        process.exitCode = error instanceof UsageError || error instanceof InvalidArgumentError || message.startsWith('--since') ? EXIT_CHECK_USAGE : EXIT_CHECK_FAILED;
      }
    });
}

async function runDashboard(root: string, o: DashboardOptions, deps: FactoryDashboardDeps): Promise<number> {
  const schema = o.schema ?? '2';
  if (schema !== '1' && schema !== '2') throw new UsageError(`--schema must be 1 or 2, got ${JSON.stringify(schema)}`);
  const watch = watchSeconds(o.watch);
  if (schema === '1' && (!o.json || o.forge || o.benchDir || watch !== null)) throw new UsageError('--schema 1 is the old --json shape only: it takes --json (and --out, --since), not --forge, --bench-dir or --watch');
  if (watch !== null && !o.out) throw new UsageError('--watch needs --out <file>');
  if (o.serve && (o.out || watch !== null || o.json || schema !== '2')) throw new UsageError('--serve is a live page on its own: it does not take --out, --watch, --json or --schema (where a listener is not allowed, use --out <file> --watch)');
  if (!o.serve && (o.port !== undefined || o.open)) throw new UsageError('--port and --open need --serve');
  const port = o.serve ? servePort(o.port) : 0;
  const clock = (): number => (deps.now?.() ?? new Date()).getTime();
  const write = deps.writeFile ?? writeFileAtomic;
  const emit = (body: string, file: string | null): void => {
    const content = body.endsWith('\n') ? body : `${body}\n`;
    if (file) write(file, content);
    else deps.out(body);
  };

  if (schema === '1') {
    const data = collectDashboard(root, { since: o.since, now: deps.now });
    emit(JSON.stringify(data, null, 2), o.out ? resolve(o.out) : null);
    if (o.out) deps.err(`wrote ${resolve(o.out)} (${data.totals.runs} runs, schemaVersion 1)`);
    return 0;
  }

  const warnings: string[] = [];
  let limits = null;
  try {
    const loaded = deps.limits?.(root);
    if (loaded) {
      limits = loaded.limits;
      warnings.push(...loaded.warnings);
    }
  } catch (error) {
    warnings.push(`the run limits could not be resolved, so no credit cap is shown: ${error instanceof Error ? error.message : String(error)}`);
  }
  let board: { json: BoardJson; at: string } | null = null;
  let forgeAt: number | null = null;
  const readForge = async (now: number): Promise<void> => {
    forgeAt = now;
    if (!deps.forgeRead) {
      warnings.push('--forge: no forge reader is wired here; the tracker was not read');
      return;
    }
    try {
      const r = await deps.forgeRead(root);
      for (const line of r.lines) deps.err(plainText(line));
      if (r.board) board = { json: r.board, at: new Date(now).toISOString() };
    } catch (error) {
      deps.err(chalk.yellow(`--forge: the forge could not be read: ${plainText(error instanceof Error ? error.message : String(error))}`));
    }
  };
  const collect = (now: number): DashboardDataV2 => {
    const data = collectDashboardV2(root, {
      ledgerDir: deps.ledgerDir ?? defaultLedgerDir(), now: () => now, limits, ...(deps.owner ? { owner: deps.owner } : {}),
      ...(o.since !== undefined ? { since: o.since } : {}), benchDirs: (o.benchDir ?? []).map((d) => resolve(d)), board,
    });
    data.warnings.unshift(...warnings.map((w) => plainText(w)));
    return data;
  };
  const page = (d: DashboardDataV2): string => (o.json ? JSON.stringify(d, null, 2) : renderDashboardHtml(d, watch !== null ? { refreshSeconds: watch } : {}));

  if (o.serve) return serveDashboard(root, o, deps, port, collect, o.forge ? () => readForge(clock()) : undefined);

  if (watch === null) {
    const now = clock();
    if (o.forge) await readForge(now);
    const data = collect(now);
    emit(page(data), o.out ? resolve(o.out) : null);
    if (o.out) deps.err(`wrote ${resolve(o.out)} (${data.runs.length} runs, ${data.attention.items.length} need you)`);
    return 0;
  }

  // --watch: a tick rewrites the file only when the page differs from the last one written at that one's clock,
  // so a tick with nothing new writes nothing (the page's ages are as of its "Generated" time).
  const file = resolve(o.out!);
  const sleep = deps.sleep ?? sleepUntilInterrupt;
  deps.err(`omg factory dashboard: writing ${file} every ${watch} s while it changes (Ctrl-C to stop)`);
  let last: { now: number; body: string } | null = null;
  for (;;) {
    const now = clock();
    if (o.forge && (forgeAt === null || now - forgeAt >= FORGE_REFRESH_MS)) await readForge(now);
    const changed = last === null || page(collect(last.now)) !== last.body;
    if (changed) {
      const body = page(collect(now));
      try {
        emit(body, file);
        last = { now, body };
      } catch (error) {
        deps.err(chalk.yellow(`could not write ${file}: ${plainText(error instanceof Error ? error.message : String(error))}; retrying next tick`));
      }
    }
    if (!(await sleep(watch * 1000))) return 0;
  }
}

/** The limits of `root` (null: no cap) and their warnings. */
function limitsOf(deps: FactoryDashboardDeps, root: string, warnings: string[]): LoadedFactoryRunLimits['limits'] | null {
  try {
    const loaded = deps.limits?.(root);
    if (!loaded) return null;
    warnings.push(...loaded.warnings);
    return loaded.limits;
  } catch (error) {
    warnings.push(`the run limits could not be resolved, so no credit cap is shown: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * `--serve --all-repos [--repo <path>...]`: one server for every repository
 * the engine ledger records (run/ledger-roots.ts), the set re-read on the
 * server's slow rescan. Each repository is collected as the single-repository
 * page collects it (local reads only); no forge read in this mode.
 */
async function serveAllRepos(o: DashboardOptions, deps: FactoryDashboardDeps): Promise<number> {
  if (!o.serve || !o.allRepos) throw new UsageError(o.allRepos ? '--all-repos needs --serve (the static page and --json show one repository)' : '--repo needs --serve --all-repos');
  if (o.forge || o.benchDir || o.out || o.watch !== undefined || o.json || (o.schema ?? '2') !== '2') throw new UsageError('--serve --all-repos takes no --forge, --bench-dir, --out, --watch, --json or --schema');
  const port = servePort(o.port);
  const ledgerDir = deps.ledgerDir ?? defaultLedgerDir();
  const pinned: string[] = [];
  for (const p of o.repo ?? []) {
    const got = await checkPinnedRoot(p);
    if ('error' in got) throw new UsageError(got.error);
    pinned.push(got.root);
  }
  const limits = new Map<string, { limits: LoadedFactoryRunLimits['limits'] | null; warnings: string[] }>();
  const limitsFor = (root: string): { limits: LoadedFactoryRunLimits['limits'] | null; warnings: string[] } => {
    let got = limits.get(root);
    if (!got) {
      const warnings: string[] = [];
      got = { limits: limitsOf(deps, root, warnings), warnings };
      limits.set(root, got);
    }
    return got;
  };
  const list = async (): Promise<ServedRepoList> => {
    const found = await discoverLedgerRoots({ ledgerDir, ...(pinned.length ? { pinned } : {}) });
    return {
      skipped: found.skipped.length, warnings: found.warnings,
      repos: found.roots.map((r) => ({
        id: r.id, root: r.root,
        collect: (now: number): DashboardDataV2 => {
          const l = limitsFor(r.root);
          const data = collectDashboardV2(r.root, { ledgerDir, now: () => now, limits: l.limits, ...(deps.owner ? { owner: deps.owner } : {}), ...(o.since !== undefined ? { since: o.since } : {}) });
          data.warnings.unshift(...l.warnings.map((w) => plainText(w)));
          return data;
        },
        watchDirs: [factoryStateDir(r.root), healStateDir(r.root), factorySlotsDir(r.root), dirname(ledgerFilePath(ledgerDir, r.root, 1))],
        pollDirs: [join(r.root, 'bench-results')],
      })),
    };
  };
  return startAndWait(o, deps, port, { ledgerDir, repos: { list } }, 'every repository the engine ledger of this host records');
}

/**
 * `--serve`: the live page until Ctrl-C. The URL (with its token) goes to
 * stdout once and nowhere else. Watched: the run state, heal, slot and
 * engine-ledger dirs; polled too: the bench result dirs.
 */
async function serveDashboard(
  root: string, o: DashboardOptions, deps: FactoryDashboardDeps, port: number,
  collect: (now: number) => DashboardDataV2, forgeRefresh: (() => Promise<void>) | undefined,
): Promise<number> {
  const ledgerDir = deps.ledgerDir ?? defaultLedgerDir();
  return startAndWait(o, deps, port, {
    root, ledgerDir, collect,
    watchDirs: [factoryStateDir(root), healStateDir(root), factorySlotsDir(root), dirname(ledgerFilePath(ledgerDir, root, 1))],
    pollDirs: [join(root, 'bench-results'), ...(o.benchDir ?? []).map((d) => resolve(d))],
    ...(forgeRefresh ? { forgeRefresh } : {}),
  }, null);
}

async function startAndWait(o: DashboardOptions, deps: FactoryDashboardDeps, port: number, opts: Omit<DashboardServerOptions, 'port' | 'now' | 'log'>, what: string | null): Promise<number> {
  const start = deps.serve ?? startDashboardServer;
  let server: DashboardServer;
  try {
    server = await start({ ...opts, port, now: deps.now ? () => deps.now!().getTime() : undefined, log: (line) => deps.err(chalk.yellow(plainText(line))) });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    const why = code === 'EADDRINUSE' ? `port ${port} is already in use (omit --port for a free one)`
      : code === 'EACCES' || code === 'EPERM' ? `listening on 127.0.0.1${port ? `:${port}` : ''} was refused (${code})`
        : plainText(error instanceof Error ? error.message : String(error));
    deps.err(chalk.red(`omg factory dashboard --serve: ${why}. Where a local listener is not allowed, use --out <file> --watch.`));
    return EXIT_CHECK_FAILED;
  }
  deps.err(`omg factory dashboard: serving a live, read-only page${what ? ` of ${what}` : ''} on 127.0.0.1 only (Ctrl-C to stop). Do not share or paste this URL:`);
  deps.out(server.url);
  if (o.open) (deps.openUrl ?? openUrlInBrowser)(server.url);
  await (deps.waitForStop ?? waitForStopSignal)();
  await server.close();
  deps.err('omg factory dashboard: stopped');
  return 0;
}
