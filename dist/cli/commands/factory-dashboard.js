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
import { execFileSync } from 'child_process';
import { renameSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { collectDashboard } from '../../factory/dashboard/collect.js';
import { collectDashboardV2 } from '../../factory/dashboard/collect-v2.js';
import { renderDashboardHtml } from '../../factory/dashboard/render.js';
import { EXIT_CHECK_FAILED, EXIT_CHECK_USAGE } from '../../factory/check/cli.js';
import { plainText } from '../../factory/check/score.js';
import { defaultLedgerDir } from '../../factory/run/ledger.js';
export const WATCH_DEFAULT_SECONDS = 10;
export const WATCH_MIN_SECONDS = 2;
/** --watch --forge: the forge is read at most this often. */
export const FORGE_REFRESH_MS = 5 * 60_000;
const defaultRoot = () => execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
/** Temp file next to the target, then one rename over it. */
export function writeFileAtomic(file, content) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, content, 'utf8');
        renameSync(tmp, file);
    }
    catch (error) {
        rmSync(tmp, { force: true });
        throw error;
    }
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
    const n = Number(v.replace(/s$/, ''));
    if (!Number.isInteger(n) || n < WATCH_MIN_SECONDS)
        throw new UsageError(`--watch takes whole seconds, at least ${WATCH_MIN_SECONDS}; got ${JSON.stringify(v)}`);
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
        .action(async (o) => {
        let root;
        try {
            root = deps.root();
        }
        catch {
            deps.err(chalk.red('omg factory dashboard must run inside a git repository'));
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
    const sleep = deps.sleep ?? sleepUntilInterrupt;
    deps.err(`omg factory dashboard: writing ${file} every ${watch} s while it changes (Ctrl-C to stop)`);
    let last = null;
    for (;;) {
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
        if (!(await sleep(watch * 1000)))
            return 0;
    }
}
//# sourceMappingURL=factory-dashboard.js.map