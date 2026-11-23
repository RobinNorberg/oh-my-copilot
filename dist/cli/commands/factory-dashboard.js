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
 * when the page changed and atomically (writeFileAtomic), until Ctrl-C or
 * SIGTERM (one handler for the whole loop: the tick under way finishes); the
 * page then reloads itself (meta refresh). With --forge the forge is read on
 * a slow timer (FORGE_REFRESH_MS), never per tick. `--out` into the
 * repository's .git or .omg is refused (outPathProblem). A temp file left by
 * a killed process is not cleaned up: its random name cannot be told apart
 * from someone else's file in that directory.
 */
import { execFileSync, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { closeSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { collectDashboard } from '../../factory/dashboard/collect.js';
import { collectDashboardV2 } from '../../factory/dashboard/collect-v2.js';
import { renderDashboardHtml } from '../../factory/dashboard/render.js';
import { EXIT_CHECK_FAILED, EXIT_CHECK_USAGE } from '../../factory/check/cli.js';
import { plainText } from '../../factory/check/score.js';
import { defaultLedgerDir, ledgerFilePath } from '../../factory/run/ledger.js';
import { factorySlotsDir, factoryStateDir } from '../../factory/run/state.js';
import { healStateDir } from '../../factory/heal/state.js';
import { startDashboardServer } from '../../factory/dashboard/serve.js';
import { checkPinnedRoot, discoverLedgerRoots } from '../../factory/run/ledger-roots.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
export const WATCH_DEFAULT_SECONDS = 10;
export const WATCH_MIN_SECONDS = 2;
export const WATCH_MAX_SECONDS = 86_400;
/** --watch --forge: the forge is read at most this often. */
export const FORGE_REFRESH_MS = 5 * 60_000;
/** Resolves at the first SIGINT or SIGTERM. */
export function waitForStopSignal() {
    return new Promise((done) => {
        const stop = () => {
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
export function openUrlInBrowser(url, platform = process.platform) {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]+\/$/.test(url))
        return;
    const [cmd, args] = platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try {
        const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
        child.on('error', () => { });
        child.unref();
    }
    catch {
        // No opener: the printed URL is enough.
    }
}
const defaultRoot = () => execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
const TEMP_ATTEMPTS = 5;
/**
 * Temp file next to the target, then one rename over it. The temp name has a
 * random suffix and is created exclusively (`wx`: an existing file or link at
 * that name is refused, never followed or overwritten), so a file planted at
 * a predictable name cannot redirect the write; on EEXIST a new name is
 * tried. The temp file is removed on any failure after it was created.
 */
export function writeFileAtomic(file, content) {
    for (let attempt = 1;; attempt++) {
        const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
        let fd;
        try {
            fd = openSync(tmp, 'wx');
        }
        catch (error) {
            // Not created by this call: nothing of ours to remove.
            if (error.code === 'EEXIST' && attempt < TEMP_ATTEMPTS)
                continue;
            throw error;
        }
        try {
            writeFileSync(fd, content, 'utf8');
            closeSync(fd);
            fd = null;
            renameSync(tmp, file);
            return;
        }
        catch (error) {
            if (fd !== null)
                closeSync(fd);
            rmSync(tmp, { force: true });
            throw error;
        }
    }
}
/** `p` with its nearest existing ancestor resolved through links (the rest, not created yet, appended as is). */
function realPath(p) {
    let dir = resolve(p);
    let rest = '';
    for (;;) {
        try {
            return rest ? join(realpathSync(dir), rest) : realpathSync(dir);
        }
        catch {
            const up = dirname(dir);
            if (up === dir)
                return resolve(p);
            rest = rest ? join(basename(dir), rest) : basename(dir);
            dir = up;
        }
    }
}
const inside = (child, parent) => {
    const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const rel = relative(fold(parent), fold(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
/**
 * --out must not land in the repository's `.git` or `.omg`, or the state
 * root OMC_STATE_DIR moves `.omg` to (lanes can write `.omg`, and both hold
 * the engine's state): a usage error. Paths are compared through links, so a
 * link into them is caught too.
 */
export function outPathProblem(root, file) {
    const real = realPath(file);
    const hit = [join(root, '.git'), join(root, '.omg'), getOmcRoot(root)].map(realPath).find((p) => inside(real, p));
    return hit ? `--out ${file} is inside ${hit}: lanes can write there and it holds the factory's state; write the page outside the repository's .git and .omg` : null;
}
/** Resolves true after `ms`, false at the first Ctrl-C (SIGINT) before that. */
export function sleepUntilInterrupt(ms) {
    return new Promise((done) => {
        const onInt = () => { clearTimeout(t); done(false); };
        const t = setTimeout(() => { process.off('SIGINT', onInt); done(true); }, ms);
        process.once('SIGINT', onInt);
    });
}
export const defaultDashboardDeps = { root: defaultRoot, out: (l) => console.log(l), err: (l) => console.error(l) };
class UsageError extends Error {
}
function watchSeconds(v) {
    if (v === undefined || v === false)
        return null;
    if (v === true)
        return WATCH_DEFAULT_SECONDS;
    const n = /^\d{1,6}s?$/.test(v) ? Number(v.replace(/s$/, '')) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < WATCH_MIN_SECONDS || n > WATCH_MAX_SECONDS)
        throw new UsageError(`--watch takes whole seconds from ${WATCH_MIN_SECONDS} to ${WATCH_MAX_SECONDS}; got ${JSON.stringify(v)}`);
    return n;
}
function servePort(v) {
    if (v === undefined)
        return 0;
    const n = Number(v);
    if (!/^\d+$/.test(v) || !Number.isInteger(n) || n < 1024 || n > 65535)
        throw new UsageError(`--port takes a port from 1024 to 65535, got ${JSON.stringify(v)}`);
    return n;
}
export function factoryDashboardCommand(deps = defaultDashboardDeps) {
    return new Command('dashboard')
        .description('One static HTML page: what needs you, engines running, runs with engine and waiting time, tasks, cost, throughput and bench results (local state only and no write unless --forge)')
        .option('--out <file>', 'write the page to this file (default: print it)')
        .option('--json', 'emit the data as JSON (schemaVersion 2)')
        .option('--schema <n>', 'with --json: 1 emits the old schemaVersion 1 shape (kept for one release)', '2')
        .option('--since <date>', 'only runs, lanes, days and bench results on or after this date (2026-11-01 means local midnight; days are in local time)')
        .option('--forge', 'also read the tracker (bucket and live stage per task) and record runs whose PR a human merged: forge reads and state writes')
        .option('--bench-dir <dir>', 'also read bench result files (*.json) from this directory (repeatable; a bench fixture keeps them in <fixture>/results)', (v, prev = []) => [...prev, v])
        .option('--watch [seconds]', `with --out: rewrite the file every N seconds (default ${WATCH_DEFAULT_SECONDS}, at least ${WATCH_MIN_SECONDS}) when it changed, until Ctrl-C; the page reloads itself`)
        .option('--serve', 'serve a live, read-only page on 127.0.0.1 (a random token in the URL) until Ctrl-C; not with --out, --watch or --json')
        .option('--port <n>', 'with --serve: listen on this port (1024-65535; default: a random free port)')
        .option('--open', 'with --serve: open the page in the default browser')
        .option('--all-repos', 'with --serve: every repository the engine ledger of this host records, with a Repositories section (runs from any directory; not with --forge or --bench-dir)')
        .option('--repo <path>', 'with --serve --all-repos: only this repository top level (repeatable)', (v, prev = []) => [...prev, v])
        .action(async (o) => {
        if (o.allRepos || o.repo) {
            try {
                process.exitCode = await serveAllRepos(o, deps);
            }
            catch (error) {
                deps.err(chalk.red(plainText(error instanceof Error ? error.message : String(error))));
                process.exitCode = error instanceof UsageError ? EXIT_CHECK_USAGE : EXIT_CHECK_FAILED;
            }
            return;
        }
        let root;
        try {
            root = deps.root();
        }
        catch {
            deps.err(chalk.red('omg factory dashboard must run inside a git repository (or pass --serve --all-repos)'));
            process.exitCode = EXIT_CHECK_USAGE;
            return;
        }
        try {
            process.exitCode = await runDashboard(root, o, deps);
        }
        catch (error) {
            const message = plainText(error instanceof Error ? error.message : String(error));
            deps.err(chalk.red(message));
            process.exitCode = error instanceof UsageError || error instanceof InvalidArgumentError || message.startsWith('--since') ? EXIT_CHECK_USAGE : EXIT_CHECK_FAILED;
        }
    });
}
async function runDashboard(root, o, deps) {
    const schema = o.schema ?? '2';
    if (schema !== '1' && schema !== '2')
        throw new UsageError(`--schema must be 1 or 2, got ${JSON.stringify(schema)}`);
    const watch = watchSeconds(o.watch);
    if (schema === '1' && (!o.json || o.forge || o.benchDir || watch !== null))
        throw new UsageError('--schema 1 is the old --json shape only: it takes --json (and --out, --since), not --forge, --bench-dir or --watch');
    if (watch !== null && !o.out)
        throw new UsageError('--watch needs --out <file>');
    if (o.serve && (o.out || watch !== null || o.json || schema !== '2'))
        throw new UsageError('--serve is a live page on its own: it does not take --out, --watch, --json or --schema (where a listener is not allowed, use --out <file> --watch)');
    if (!o.serve && (o.port !== undefined || o.open))
        throw new UsageError('--port and --open need --serve');
    const port = o.serve ? servePort(o.port) : 0;
    const outProblem = o.out ? outPathProblem(root, resolve(o.out)) : null;
    if (outProblem)
        throw new UsageError(outProblem);
    const clock = () => (deps.now?.() ?? new Date()).getTime();
    const write = deps.writeFile ?? writeFileAtomic;
    const emit = (body, file) => {
        const content = body.endsWith('\n') ? body : `${body}\n`;
        if (file)
            write(file, content);
        else
            deps.out(body);
    };
    if (schema === '1') {
        const data = collectDashboard(root, { since: o.since, now: deps.now });
        emit(JSON.stringify(data, null, 2), o.out ? resolve(o.out) : null);
        if (o.out)
            deps.err(`wrote ${resolve(o.out)} (${data.totals.runs} runs, schemaVersion 1)`);
        return 0;
    }
    const warnings = [];
    let limits = null;
    try {
        const loaded = deps.limits?.(root);
        if (loaded) {
            limits = loaded.limits;
            warnings.push(...loaded.warnings);
        }
    }
    catch (error) {
        warnings.push(`the run limits could not be resolved, so no credit cap is shown: ${error instanceof Error ? error.message : String(error)}`);
    }
    let board = null;
    let forgeAt = null;
    const readForge = async (now) => {
        forgeAt = now;
        if (!deps.forgeRead) {
            warnings.push('--forge: no forge reader is wired here; the tracker was not read');
            return;
        }
        try {
            const r = await deps.forgeRead(root);
            for (const line of r.lines)
                deps.err(plainText(line));
            if (r.board)
                board = { json: r.board, at: new Date(now).toISOString() };
        }
        catch (error) {
            deps.err(chalk.yellow(`--forge: the forge could not be read: ${plainText(error instanceof Error ? error.message : String(error))}`));
        }
    };
    const collect = (now) => {
        const data = collectDashboardV2(root, {
            ledgerDir: deps.ledgerDir ?? defaultLedgerDir(), now: () => now, limits, ...(deps.owner ? { owner: deps.owner } : {}),
            ...(o.since !== undefined ? { since: o.since } : {}), benchDirs: (o.benchDir ?? []).map((d) => resolve(d)), board,
        });
        data.warnings.unshift(...warnings.map((w) => plainText(w)));
        return data;
    };
    const page = (d) => (o.json ? JSON.stringify(d, null, 2) : renderDashboardHtml(d, watch !== null ? { refreshSeconds: watch } : {}));
    if (o.serve)
        return serveDashboard(root, o, deps, port, collect, o.forge ? () => readForge(clock()) : undefined);
    if (watch === null) {
        const now = clock();
        if (o.forge)
            await readForge(now);
        const data = collect(now);
        emit(page(data), o.out ? resolve(o.out) : null);
        if (o.out)
            deps.err(`wrote ${resolve(o.out)} (${data.runs.length} runs, ${data.attention.items.length} need you)`);
        return 0;
    }
    // --watch: a tick rewrites the file only when the page differs from the last one written at that one's clock,
    // so a tick with nothing new writes nothing (the page's ages are as of its "Generated" time).
    const file = resolve(o.out);
    // One SIGINT/SIGTERM handler for the whole loop: a signal sets the stop flag and wakes the sleep, and a tick
    // under way (temp write, rename) finishes first, so no temp file is left behind.
    let stop = false;
    let wake = null;
    const onSignal = () => {
        stop = true;
        wake?.();
    };
    const sleep = deps.sleep ?? ((ms) => new Promise((done) => {
        const t = setTimeout(() => { wake = null; done(true); }, ms);
        wake = () => { clearTimeout(t); wake = null; done(false); };
    }));
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
        deps.err(`omg factory dashboard: writing ${file} every ${watch} s while it changes (Ctrl-C to stop)`);
        let last = null;
        while (!stop) {
            const now = clock();
            if (o.forge && (forgeAt === null || now - forgeAt >= FORGE_REFRESH_MS))
                await readForge(now);
            const changed = last === null || page(collect(last.now)) !== last.body;
            if (changed) {
                const body = page(collect(now));
                try {
                    emit(body, file);
                    last = { now, body };
                }
                catch (error) {
                    deps.err(chalk.yellow(`could not write ${file}: ${plainText(error instanceof Error ? error.message : String(error))}; retrying next tick`));
                }
            }
            if (stop || !(await sleep(watch * 1000)))
                break;
        }
        return 0;
    }
    finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
    }
}
/** The limits of `root` (null: no cap) and their warnings. */
function limitsOf(deps, root, warnings) {
    try {
        const loaded = deps.limits?.(root);
        if (!loaded)
            return null;
        warnings.push(...loaded.warnings);
        return loaded.limits;
    }
    catch (error) {
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
async function serveAllRepos(o, deps) {
    if (!o.serve || !o.allRepos)
        throw new UsageError(o.allRepos ? '--all-repos needs --serve (the static page and --json show one repository)' : '--repo needs --serve --all-repos');
    if (o.forge || o.benchDir || o.out || o.watch !== undefined || o.json || (o.schema ?? '2') !== '2')
        throw new UsageError('--serve --all-repos takes no --forge, --bench-dir, --out, --watch, --json or --schema');
    const port = servePort(o.port);
    const ledgerDir = deps.ledgerDir ?? defaultLedgerDir();
    const pinned = [];
    for (const p of o.repo ?? []) {
        const got = await checkPinnedRoot(p);
        if ('error' in got)
            throw new UsageError(got.error);
        pinned.push(got.root);
    }
    const limits = new Map();
    const limitsFor = (root) => {
        let got = limits.get(root);
        if (!got) {
            const warnings = [];
            got = { limits: limitsOf(deps, root, warnings), warnings };
            limits.set(root, got);
        }
        return got;
    };
    const list = async () => {
        const found = await discoverLedgerRoots({ ledgerDir, ...(pinned.length ? { pinned } : {}) });
        return {
            skipped: found.skipped.length, warnings: found.warnings,
            repos: found.roots.map((r) => ({
                id: r.id, root: r.root,
                collect: (now) => {
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
async function serveDashboard(root, o, deps, port, collect, forgeRefresh) {
    const ledgerDir = deps.ledgerDir ?? defaultLedgerDir();
    return startAndWait(o, deps, port, {
        root, ledgerDir, collect,
        watchDirs: [factoryStateDir(root), healStateDir(root), factorySlotsDir(root), dirname(ledgerFilePath(ledgerDir, root, 1))],
        pollDirs: [join(root, 'bench-results'), ...(o.benchDir ?? []).map((d) => resolve(d))],
        ...(forgeRefresh ? { forgeRefresh } : {}),
    }, null);
}
async function startAndWait(o, deps, port, opts, what) {
    const start = deps.serve ?? startDashboardServer;
    let server;
    try {
        server = await start({ ...opts, port, now: deps.now ? () => deps.now().getTime() : undefined, log: (line) => deps.err(chalk.yellow(plainText(line))) });
    }
    catch (error) {
        const code = error?.code;
        const why = code === 'EADDRINUSE' ? `port ${port} is already in use (omit --port for a free one)`
            : code === 'EACCES' || code === 'EPERM' ? `listening on 127.0.0.1${port ? `:${port}` : ''} was refused (${code})`
                : plainText(error instanceof Error ? error.message : String(error));
        deps.err(chalk.red(`omg factory dashboard --serve: ${why}. Where a local listener is not allowed, use --out <file> --watch.`));
        return EXIT_CHECK_FAILED;
    }
    deps.err(`omg factory dashboard: serving a live, read-only page${what ? ` of ${what}` : ''} on 127.0.0.1 only (Ctrl-C to stop). Do not share or paste this URL:`);
    deps.out(server.url);
    if (o.open)
        (deps.openUrl ?? openUrlInBrowser)(server.url);
    await (deps.waitForStop ?? waitForStopSignal)();
    await server.close();
    deps.err('omg factory dashboard: stopped');
    return 0;
}
//# sourceMappingURL=factory-dashboard.js.map