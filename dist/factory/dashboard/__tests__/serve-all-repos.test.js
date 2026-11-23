/**
 * `omg factory dashboard --serve --all-repos`: the repository list route,
 * repository ids (only the server's own; unknown, path-like and encoded ids
 * are 404), a repository's summary equals the single-repository summary, the
 * SSE event names the repository, the watcher cap, the rescan, the same
 * request checks as the single-repository server, and the CLI. Real HTTP on
 * 127.0.0.1; a temp ledger.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryDashboardCommand } from '../../../cli/commands/factory-dashboard.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../../run/budget.js';
import { EngineLedger, ledgerFilePath, ledgerRepoId } from '../../run/ledger.js';
import { createFactoryState, factoryStateDir, moveTo, runKeyOf, setGate, updateFactoryState } from '../../run/state.js';
import { collectDashboardV2 } from '../collect-v2.js';
import { DASHBOARD_HOST, startDashboardServer } from '../serve.js';
const REPO = 'https://github.com/o/r';
const HEAD = 'c'.repeat(40);
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const NOW = T0 + 1_000_000;
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const OWNER = { pid: 1, hostname: 'this-host', isAlive: () => false };
let dir;
let ledgerDir;
const servers = [];
beforeEach(() => {
    vi.stubEnv('OMC_STATE_DIR', '');
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'omg-serve-all-')));
    ledgerDir = join(dir, 'ledger');
});
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
});
function repo(name) {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', root]);
    return root;
}
function asEngine(root, s) {
    const key = runKeyOf(s);
    const l = EngineLedger.open(ledgerDir, root, key);
    updateFactoryState(root, key, () => s, { onWrite: (p, c) => l.record(p, c) });
}
function parked(issue, title = `item ${issue}`) {
    let s = { ...createFactoryState({ issue, repoUrl: REPO, base: 'main' }, iso(0)), forgeKind: 'github', issueTitle: title };
    s = moveTo(s, 'implement', 'plan ok', iso(10));
    s = moveTo(s, 'merge', 'gates green', iso(150));
    return { ...setGate(s, 'merge', 'merge is a human step', iso(152)), pr: issue + 100, head: HEAD };
}
const collectOf = (root) => () => collectDashboardV2(root, { ledgerDir, now: () => NOW, owner: OWNER, limits: DEFAULT_FACTORY_RUN_LIMITS });
const served = (root) => ({
    id: ledgerRepoId(root), root, collect: collectOf(root),
    watchDirs: [factoryStateDir(root), dirname(ledgerFilePath(ledgerDir, root, 1))], pollDirs: [],
});
async function start(list, extra = {}) {
    const s = await startDashboardServer({ ledgerDir, repos: { list }, pollMs: 100, debounceMs: 30, minIntervalMs: 60, ...extra });
    servers.push(s);
    return s;
}
function get(s, path, o = {}) {
    return new Promise((done, fail) => {
        const r = request({ host: DASHBOARD_HOST, port: s.port, path, method: o.method ?? 'GET', headers: o.headers, agent: false }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        r.on('error', fail);
        r.end();
    });
}
const base = (s) => new URL(s.url).pathname;
const until = async (cond, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end)
            throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 20));
    }
};
function sse(s) {
    return new Promise((done, fail) => {
        const events = [];
        let buf = '';
        const r = request({ host: DASHBOARD_HOST, port: s.port, path: `${base(s)}events`, agent: false }, (res) => {
            res.setEncoding('utf8');
            res.on('data', (c) => {
                buf += c;
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    const ev = /^event: (.*)$/m.exec(block)?.[1];
                    if (ev)
                        events.push({ event: ev, data: /^data: (.*)$/m.exec(block)?.[1] ?? '' });
                }
            });
            res.on('error', () => { });
            done({ events, close: () => r.destroy() });
        });
        r.on('error', fail);
        r.end();
    });
}
function twoRepos() {
    const a = repo('alpha');
    const b = repo('beta');
    asEngine(a, parked(1));
    asEngine(b, parked(2));
    asEngine(b, parked(3));
    return { a, b, list: () => ({ repos: [served(a), served(b)], skipped: 3, warnings: [] }) };
}
describe('dashboard --serve --all-repos', () => {
    it('serves the repository list: name, path as text, counts, engines, last change, the attention rows, ids only from the server', async () => {
        const { a, b, list } = twoRepos();
        const s = await start(list);
        const r = await get(s, `${base(s)}api/v1/repos`);
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
        expect(r.headers['access-control-allow-origin']).toBeUndefined();
        const j = JSON.parse(r.body);
        expect(j.schemaVersion).toBe(1);
        expect(j.allRepos).toBe(true);
        expect(j.summary).toEqual({ byGroup: { inspect: 0, broken: 0, decide: 0, merge: 3, fix: 0, limits: 0 }, repos: 2, items: 3, engines: 0, skipped: 3 });
        expect(j.repos.map((x) => [x.id, x.name, x.root, x.items, x.runs])).toEqual([
            [ledgerRepoId(a), 'alpha', a, 1, 1], [ledgerRepoId(b), 'beta', b, 2, 2],
        ]);
        for (const x of j.repos) {
            expect(x.lastChange).toBe(iso(152));
            expect(x.attention.every((i) => i.next.every((n) => typeof n.line === 'string'))).toBe(true);
        }
        // The single-repository routes do not exist in this mode.
        expect((await get(s, `${base(s)}api/v1/summary`)).status).toBe(404);
        expect((await get(s, `${base(s)}api/v1/run/1`)).status).toBe(404);
        // The page carries the Repositories section and no data.
        const page = await get(s, base(s));
        expect(page.body).toContain('id="b-repos"');
        expect(page.body).not.toContain(a);
    });
    it('a repository is selected only by an id the server issued: unknown, path-like and encoded ids are 404', async () => {
        const { a, list } = twoRepos();
        const s = await start(list);
        const id = ledgerRepoId(a);
        expect((await get(s, `${base(s)}api/v1/repo/${id}/summary`)).status).toBe(200);
        for (const bad of [
            'ffffffffffffffff', id.toUpperCase(), `${id}0`, id.slice(1), '..', '..%2F..%2F', '%2e%2e', encodeURIComponent(a), 'C:', `${id}%2Fsummary`, `${id}/../${id}`,
        ]) {
            expect((await get(s, `${base(s)}api/v1/repo/${bad}/summary`)).status, bad).toBe(404);
        }
        for (const bad of [`${id}/run/01`, `${id}/run/..`, `${id}/run/1/x`, `${id}/summary/x`, `${id}/summary?x=1`, `${id}/run/1?rev=1`, `${id}`, `${id}/`]) {
            expect((await get(s, `${base(s)}api/v1/repo/${bad}`)).status, bad).toBe(404);
        }
        expect((await get(s, `${base(s)}api/v1/repo/${id}/run/1`)).status).toBe(200);
        expect((await get(s, `${base(s)}api/v1/repo/${id}/run/99`)).status).toBe(404);
    });
    it('a repository\'s summary is byte-identical to the single-repository server\'s summary of that root', async () => {
        const { b, list } = twoRepos();
        const multi = await start(list);
        const single = await startDashboardServer({ root: b, ledgerDir, collect: collectOf(b), watchDirs: [factoryStateDir(b)], pollMs: 100 });
        servers.push(single);
        const m = await get(multi, `${base(multi)}api/v1/repo/${ledgerRepoId(b)}/summary`);
        const one = await get(single, `${base(single)}api/v1/summary`);
        expect(m.body).toBe(one.body);
        expect(m.headers.etag).toBe(one.headers.etag);
        const d1 = await get(multi, `${base(multi)}api/v1/repo/${ledgerRepoId(b)}/run/2`);
        const d2 = await get(single, `${base(single)}api/v1/run/2`);
        expect(d1.body).toBe(d2.body);
        // The single-repository server has no repository routes.
        expect((await get(single, `${base(single)}api/v1/repos`)).status).toBe(404);
        expect((await get(single, `${base(single)}api/v1/repo/${ledgerRepoId(b)}/summary`)).status).toBe(404);
    });
    it('a state write in one repository sends `changed` naming that repository, then the list', async () => {
        const { b, list } = twoRepos();
        const s = await start(list);
        const ev = await sse(s);
        await until(() => ev.events.length >= 1);
        expect(ev.events[0]).toEqual({ event: 'changed', data: `repos ${s.rev()}` });
        asEngine(b, parked(4));
        await until(() => ev.events.some((e) => e.data.startsWith(`${ledgerRepoId(b)} `)));
        await until(() => ev.events.some((e, i) => i > 0 && e.data.startsWith('repos ')));
        const named = ev.events.find((e) => e.data.startsWith(`${ledgerRepoId(b)} `));
        expect(named.data).toMatch(/^[0-9a-f]{16} [0-9a-f]{32}$/);
        ev.close();
    });
    it('caps fs.watch handles across repositories (the rest are polled) and still sees a change in a polled one', async () => {
        const roots = ['r1', 'r2', 'r3'].map((n) => { const r = repo(n); asEngine(r, parked(1)); return r; });
        const s = await start(() => ({ repos: roots.map(served), skipped: 0, warnings: [] }), { repos: { list: () => ({ repos: roots.map(served), skipped: 0, warnings: [] }), maxWatchers: 2 } });
        expect(s.watchers()).toBeLessThanOrEqual(2);
        const ev = await sse(s);
        asEngine(roots[2], parked(2));
        await until(() => ev.events.some((e) => e.data.startsWith(`${ledgerRepoId(roots[2])} `)));
        ev.close();
    });
    it('re-reads the repository set: a new repository appears, a gone one is dropped (its id is then 404)', async () => {
        const { a, b } = twoRepos();
        let set = [a];
        const s = await start(() => ({ repos: set.map(served), skipped: 0, warnings: [] }), { repos: { list: () => ({ repos: set.map(served), skipped: 0, warnings: [] }), rescanMs: 80 } });
        expect(s.repoIds()).toEqual([ledgerRepoId(a)]);
        set = [b];
        await until(() => s.repoIds().join() === ledgerRepoId(b));
        expect((await get(s, `${base(s)}api/v1/repo/${ledgerRepoId(a)}/summary`)).status).toBe(404);
        expect((await get(s, `${base(s)}api/v1/repo/${ledgerRepoId(b)}/summary`)).status).toBe(200);
    });
    it('keeps the request checks of the single-repository server on every new route', async () => {
        const { a, list } = twoRepos();
        const s = await start(list);
        const host = `127.0.0.1:${s.port}`;
        const routes = [`${base(s)}api/v1/repos`, `${base(s)}api/v1/repo/${ledgerRepoId(a)}/summary`, `${base(s)}api/v1/repo/${ledgerRepoId(a)}/run/1`];
        for (const p of routes) {
            expect((await get(s, p.replace(/\/t\/[0-9a-f]+\//, `/t/${'0'.repeat(64)}/`))).status).toBe(404);
            expect((await get(s, p, { headers: { Host: 'evil.example:80' } })).status).toBe(421);
            expect((await get(s, p, { headers: { Host: host, Origin: 'http://evil.example' } })).status).toBe(403);
            expect((await get(s, p, { headers: { Host: host, 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
            expect((await get(s, p, { method: 'POST' })).status).toBe(405);
            const ok = await get(s, p);
            expect(ok.status).toBe(200);
            expect(ok.headers['content-security-policy']).toMatch(/^default-src 'none'/);
            expect(ok.headers['x-content-type-options']).toBe('nosniff');
            expect(ok.headers['cache-control']).toBe('no-store');
            expect(Object.keys(ok.headers).some((k) => k.startsWith('access-control-'))).toBe(false);
        }
    });
    it('the CLI: --all-repos needs --serve and takes no --forge; with --serve it discovers the ledger\'s repositories', async () => {
        const { a, b } = twoRepos();
        const out = [];
        const err = [];
        let opts = null;
        let server = null;
        const deps = {
            root: () => { throw new Error('not a repository'); }, out: (l) => out.push(l), err: (l) => err.push(l), ledgerDir, owner: OWNER,
            serve: async (o) => { opts = o; server = await startDashboardServer({ ...o, pollMs: 100 }); servers.push(server); return server; },
            waitForStop: async () => {
                const r = await get(server, `${base(server)}api/v1/repos`);
                out.push(r.body);
            },
        };
        const run = async (args) => {
            process.exitCode = 0;
            try {
                await factoryDashboardCommand(deps).parseAsync(args, { from: 'user' });
            }
            catch (error) {
                if (error.exitCode !== undefined)
                    return error.exitCode;
                throw error;
            }
            return Number(process.exitCode ?? 0);
        };
        expect(await run(['--all-repos'])).toBe(2);
        expect(await run(['--all-repos', '--serve', '--forge'])).toBe(2);
        expect(await run(['--repo', a, '--serve'])).toBe(2);
        expect(await run(['--serve', '--all-repos', '--repo', join(a, '.git')])).toBe(2);
        expect(opts).toBeNull();
        expect(await run(['--serve', '--all-repos'])).toBe(0);
        expect(opts.repos).toBeDefined();
        expect(opts.root).toBeUndefined();
        const j = JSON.parse(out.at(-1));
        expect(j.repos.map((r) => r.root).sort()).toEqual([a, b].sort());
        expect(out.some((l) => l.startsWith('http://127.0.0.1:'))).toBe(true);
        expect(err.join('\n')).not.toContain('/t/');
        expect(await run(['--serve', '--all-repos', '--repo', b])).toBe(0);
        expect(JSON.parse(out.at(-1)).repos.map((r) => r.root)).toEqual([b]);
    });
});
//# sourceMappingURL=serve-all-repos.test.js.map