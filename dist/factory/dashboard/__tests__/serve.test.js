/**
 * `omg factory dashboard --serve`: the security suite (token, Host, Origin,
 * Sec-Fetch-Site, methods, CSP and headers, raw paths, run keys, header and
 * slow-request limits, connection and stream caps, loopback bind) and the
 * functional suite (summary = collector JSON, SSE on a state write and not on
 * an unrelated file, debounce, reconnect, no forge call and no write without
 * --forge, clean shutdown, hostile data, the CLI). Real HTTP on 127.0.0.1.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryDashboardCommand } from '../../../cli/commands/factory-dashboard.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../../run/budget.js';
import { EngineLedger } from '../../run/ledger.js';
import { createFactoryState, factoryStateDir, moveTo, runKeyOf, setGate, updateFactoryState } from '../../run/state.js';
import { collectDashboardV2 } from '../collect-v2.js';
import { contentSecurityPolicy, DASHBOARD_HOST, parseRunKey, servedSummary, startDashboardServer, summaryRev, tokenEquals } from '../serve.js';
const REPO = 'https://github.com/o/r';
const HEAD = 'c'.repeat(40);
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const OWNER = { pid: 1, hostname: 'this-host', isAlive: () => false };
const LS = String.fromCharCode(0x2028);
const HOSTILE = `<script>alert(1)</script><img src=x onerror=alert(2)>${LS}&`;
let dir;
let root;
let ledgerDir;
const servers = [];
beforeEach(() => {
    vi.stubEnv('OMC_STATE_DIR', '');
    dir = mkdtempSync(join(tmpdir(), 'omg-serve-'));
    root = join(dir, 'repo');
    mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    ledgerDir = join(dir, 'ledger');
});
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
});
function asEngine(s) {
    const key = runKeyOf(s);
    const l = EngineLedger.open(ledgerDir, root, key);
    updateFactoryState(root, key, () => s, { onWrite: (p, c) => l.record(p, c) });
    return s;
}
function parked(issue, title = `item ${issue}`, detail) {
    let s = { ...createFactoryState({ issue, repoUrl: REPO, base: 'main' }, iso(0)), forgeKind: 'github', issueTitle: title };
    s = moveTo(s, 'implement', 'plan ok', iso(10));
    s = moveTo(s, 'merge', 'gates green', iso(150));
    s = { ...setGate(s, 'merge', `merge is a human step ${title}`, iso(152), detail ? { detail } : {}), pr: issue + 100, head: HEAD };
    return { ...s, lanes: [{ id: `issue-${issue}-implement-1`, kind: 'implement', startSha: 'a', status: 'completed', maxCredits: 5, startedAt: iso(20), endedAt: iso(60), usage: { credits: 2, premiumRequests: 1, source: 'measured' } }] };
}
const collectFn = (now = T0 + 1_000_000) => () => collectDashboardV2(root, { ledgerDir, now: () => now, owner: OWNER, limits: DEFAULT_FACTORY_RUN_LIMITS });
async function start(extra = {}) {
    const s = await startDashboardServer({
        root, ledgerDir, collect: collectFn(), watchDirs: [factoryStateDir(root)], pollMs: 100, debounceMs: 30, minIntervalMs: 60, ...extra,
    });
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
/** One raw HTTP exchange: the exact bytes, no client-side normalisation. */
function raw(port, text, waitMs = 2_000) {
    return new Promise((done) => {
        const sock = connect(port, DASHBOARD_HOST);
        let out = '';
        sock.setEncoding('utf8');
        sock.on('data', (c) => { out += c; });
        const t = setTimeout(() => { sock.destroy(); done(out); }, waitMs);
        sock.on('close', () => { clearTimeout(t); done(out); });
        sock.on('error', () => { });
        sock.write(text);
    });
}
const statusOf = (rawText) => Number(/^HTTP\/1\.1 (\d{3})/.exec(rawText)?.[1] ?? 0);
function sse(s, headers = {}) {
    return new Promise((done, fail) => {
        const events = [];
        let buf = '';
        let all = '';
        const r = request({ host: DASHBOARD_HOST, port: s.port, path: `${base(s)}events`, headers, agent: false }, (res) => {
            res.setEncoding('utf8');
            res.on('data', (c) => {
                all += c;
                buf += c;
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    const ev = /^event: (.*)$/m.exec(block)?.[1];
                    const data = /^data: (.*)$/m.exec(block)?.[1];
                    if (ev)
                        events.push({ event: ev, data: data ?? '' });
                }
            });
            res.on('error', () => { });
            done({ events, text: () => all, close: () => r.destroy(), status: res.statusCode ?? 0 });
        });
        r.on('error', fail);
        r.end();
    });
}
const until = async (cond, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end)
            throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 20));
    }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function treeHash(d) {
    const h = createHash('sha256');
    const walk = (p) => {
        let names;
        try {
            names = readdirSync(p).sort();
        }
        catch {
            return;
        }
        for (const n of names) {
            const f = join(p, n);
            if (statSync(f).isDirectory())
                walk(f);
            else
                h.update(`${relative(d, f)}\0${statSync(f).mtimeMs}\0`).update(readFileSync(f));
        }
    };
    walk(d);
    return h.digest('hex');
}
describe('dashboard server: security', () => {
    it('wrong, missing or partial token: 404 with an empty body', async () => {
        asEngine(parked(1));
        const s = await start();
        const token = s.url.split('/t/')[1].slice(0, -1);
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        for (const p of ['/', '/t/', '/t//', `/t/${'0'.repeat(64)}/`, `/t/${token.slice(0, -1)}/`, `/t/${token}x/`, `/t/${token.toUpperCase()}/`, `/t/${token}`, '/api/v1/summary', `/api/v1/summary?t=${token}`]) {
            const r = await get(s, p);
            expect(r.status, p).toBe(404);
            expect(r.body, p).toBe('');
        }
        expect((await get(s, base(s))).status).toBe(200);
    });
    it('compares tokens in constant time, false for any other length', async () => {
        expect(tokenEquals('abc', 'abc')).toBe(true);
        expect(tokenEquals('abd', 'abc')).toBe(false);
        expect(tokenEquals('', 'abc')).toBe(false);
        expect(tokenEquals('abcd', 'abc')).toBe(false);
        expect(tokenEquals('ab', 'abc')).toBe(false);
        expect(tokenEquals('é', 'ab')).toBe(false); // same JS length 1 vs 2, different byte lengths
        const src = readFileSync(new URL('../serve.ts', import.meta.url), 'utf8');
        const body = src.slice(src.indexOf('export function tokenEquals'), src.indexOf('export function parseRunKey'));
        expect(body).toMatch(/timingSafeEqual\(b, b\)/);
        expect(body).toMatch(/timingSafeEqual\(a, b\)/);
        expect(body).not.toMatch(/===\s*expected|given\s*===/);
    });
    it('refuses a foreign Host (DNS rebinding) and another port on loopback', async () => {
        const s = await start();
        for (const host of ['evil.example', `evil.example:${s.port}`, `127.0.0.1:${s.port + 1}`, '127.0.0.1', `[::1]:${s.port}`, `0.0.0.0:${s.port}`, `127.0.0.1:${s.port}.evil.example`]) {
            const r = await get(s, base(s), { headers: { Host: host } });
            expect(r.status, host).toBe(421);
            expect(r.body).toBe('');
        }
        expect((await get(s, base(s), { headers: { Host: `localhost:${s.port}` } })).status).toBe(200);
        expect((await get(s, base(s), { headers: { Host: `127.0.0.1:${s.port}` } })).status).toBe(200);
    });
    it('refuses a foreign Origin, accepts the same origin and no Origin', async () => {
        const s = await start();
        for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${s.port + 1}`, `https://127.0.0.1:${s.port}`, `http://localhost.evil:${s.port}`]) {
            expect((await get(s, `${base(s)}api/v1/summary`, { headers: { Origin: origin } })).status, origin).toBe(403);
            expect((await get(s, base(s), { headers: { Origin: origin } })).status, origin).toBe(403);
        }
        expect((await get(s, `${base(s)}api/v1/summary`, { headers: { Origin: `http://127.0.0.1:${s.port}` } })).status).toBe(200);
        expect((await get(s, `${base(s)}api/v1/summary`, { headers: { Origin: `http://localhost:${s.port}`, Host: `localhost:${s.port}` } })).status).toBe(200);
        expect((await get(s, base(s))).status).toBe(200);
    });
    it('refuses Sec-Fetch-Site cross-site and same-site on the API and the event stream', async () => {
        asEngine(parked(1));
        const s = await start();
        for (const p of ['api/v1/summary', 'api/v1/run/1', 'events']) {
            for (const site of ['cross-site', 'same-site'])
                expect((await get(s, `${base(s)}${p}`, { method: p === 'events' ? 'HEAD' : 'GET', headers: { 'Sec-Fetch-Site': site } })).status, `${p} ${site}`).toBe(403);
            for (const site of ['same-origin', 'none'])
                expect((await get(s, `${base(s)}${p}`, { method: p === 'events' ? 'HEAD' : 'GET', headers: { 'Sec-Fetch-Site': site } })).status, `${p} ${site}`).toBe(200);
        }
    });
    it('GET and HEAD only: every other method is 405 with Allow, and no response ever carries Access-Control-*', async () => {
        asEngine(parked(1));
        const s = await start();
        const seen = [];
        for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'TRACE']) {
            for (const p of [base(s), `${base(s)}api/v1/summary`, `${base(s)}events`, '/nope']) {
                const r = await get(s, p, { method, headers: { Origin: `http://127.0.0.1:${s.port}`, 'Access-Control-Request-Method': 'POST' } });
                expect(r.status, `${method} ${p}`).toBe(405);
                expect(r.headers.allow).toBe('GET, HEAD');
                seen.push(r);
            }
        }
        const head = await get(s, `${base(s)}api/v1/summary`, { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(head.body).toBe('');
        seen.push(head, await get(s, base(s)), await get(s, `${base(s)}api/v1/summary`), await get(s, `${base(s)}api/v1/run/1`), await get(s, '/x'), await get(s, base(s), { headers: { Host: 'evil' } }));
        for (const r of seen)
            expect(Object.keys(r.headers).filter((k) => k.toLowerCase().startsWith('access-control-'))).toEqual([]);
    });
    it('a request body is refused', async () => {
        const s = await start();
        const out = await raw(s.port, `GET ${base(s)}api/v1/summary HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Length: 5\r\n\r\nhello`);
        expect(statusOf(out)).toBe(400);
        const chunked = await raw(s.port, `GET ${base(s)} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n`);
        expect(statusOf(chunked)).toBe(400);
    });
    it('every response carries the CSP with a fresh nonce and the other security headers', async () => {
        asEngine(parked(1));
        const s = await start();
        const responses = [
            await get(s, base(s)), await get(s, base(s)), await get(s, `${base(s)}api/v1/summary`), await get(s, `${base(s)}api/v1/run/1`),
            await get(s, '/x'), await get(s, base(s), { method: 'POST' }), await get(s, base(s), { headers: { Host: 'evil' } }), await get(s, `${base(s)}events`, { method: 'HEAD' }),
        ];
        const stream = await sse(s);
        stream.close();
        const nonces = [];
        for (const r of responses) {
            const csp = String(r.headers['content-security-policy']);
            const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
            expect(nonce).toBeTruthy();
            expect(csp).toBe(contentSecurityPolicy(nonce));
            nonces.push(nonce);
            expect(r.headers).toMatchObject({
                'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
                'cross-origin-resource-policy': 'same-origin', 'cross-origin-opener-policy': 'same-origin', 'x-frame-options': 'DENY',
            });
        }
        expect(new Set(nonces).size).toBe(nonces.length);
        // The page's script and style carry the response's nonce, and nothing else does.
        const page = responses[0];
        const n = /script-src 'nonce-([^']+)'/.exec(String(page.headers['content-security-policy']))[1];
        expect(page.body).toContain(`<script nonce="${n}">`);
        expect(page.body).toContain(`<style nonce="${n}">`);
        expect(page.body.match(/<script/g).length).toBe(1);
        // The one URL in the page is the SVG namespace name (never fetched).
        expect(page.body.replaceAll("'http://www.w3.org/2000/svg'", '')).not.toMatch(/<script[^>]* src=|<link|<iframe|<img|http:\/\/|https:\/\//);
    });
    it('raw paths: traversal, encodings, double slashes, backslashes and overlong URLs never match a route', async () => {
        asEngine(parked(1));
        const s = await start();
        const b = base(s);
        const paths = [
            `${b}../`, `${b}..%2f`, `${b}%2e%2e/`, `${b}%2e%2e%2f%2e%2e%2fetc%2fpasswd`, `${b}api/v1/../v1/summary`, `${b}api/v1/summary/`, `${b}api/v1/summary/..`,
            `${b}/`, `${b}//api/v1/summary`, `${b}api//v1/summary`, `${b}api\\v1\\summary`, `${b}..\\..\\package.json`, `${b}index.html`, `${b}package.json`, `${b}.omg/state/factory/run-1.json`,
            `${b}api/v1/run/1/../../summary`, `${b}api/v1/run/%31`, `${b}events/`, `${b}?x=1`, `${b}api/v1/summary?rev=<script>`, `${b}events?x`, `${b}api%2fv1%2fsummary`,
            `/t/../t/${b.slice(3)}`, `/T${b.slice(2)}`, `${b}%00`, `${b}api/v1/summary%00`,
        ];
        for (const p of paths) {
            const out = await raw(s.port, `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close\r\n\r\n`);
            expect([400, 404], p).toContain(statusOf(out));
            expect(out.split('\r\n\r\n')[1] ?? '', p).toBe('');
        }
        const long = await raw(s.port, `GET ${b}${'a'.repeat(600)} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close\r\n\r\n`);
        expect(statusOf(long)).toBe(414);
        // Absolute-form request targets are not a route either.
        const abs = await raw(s.port, `GET http://127.0.0.1:${s.port}${b} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close\r\n\r\n`);
        expect(statusOf(abs)).toBe(404);
    });
    it('run/<key>: a positive integer or heal-<8 hex>, known to the summary; anything else 404', async () => {
        asEngine(parked(1));
        const s = await start();
        expect((await get(s, `${base(s)}api/v1/run/1`)).status).toBe(200);
        for (const k of ['0', '01', '-1', '1.0', '1e3', '+1', ' 1', '2', '9999999999', 'heal-', 'heal-0123abc', 'heal-0123ABCD', 'heal-0123abcde', 'heal-0123abcd', '%231', '#1', 'run-1']) {
            expect((await get(s, `${base(s)}api/v1/run/${encodeURIComponent(k).replace(/%2B/g, '+')}`)).status, k).toBe(404);
        }
        expect(parseRunKey('12')).toBe(12);
        expect(parseRunKey('heal-0123abcd')).toBe('heal-0123abcd');
        for (const k of ['0', '012', '1234567890', 'heal-0123abcg', '12 ', ''])
            expect(parseRunKey(k), k).toBeNull();
    });
    it('cuts off an oversized header block and a slow request', async () => {
        const s = await start({ headersTimeoutMs: 400 });
        const big = await raw(s.port, `GET ${base(s)} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nX-Big: ${'a'.repeat(10_000)}\r\n\r\n`);
        expect(statusOf(big)).toBe(431);
        // Slowloris: a header line, then nothing.
        const t0 = Date.now();
        const slow = await raw(s.port, `GET ${base(s)} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n`, 5_000);
        expect(Date.now() - t0).toBeLessThan(4_500);
        expect([0, 408]).toContain(statusOf(slow));
        expect(slow).not.toContain('<!doctype');
    });
    it('caps concurrent connections and concurrent event streams', async () => {
        const s = await start({ maxConnections: 3, maxStreams: 2 });
        const a = await sse(s);
        const b = await sse(s);
        expect([a.status, b.status]).toEqual([200, 200]);
        const third = await get(s, `${base(s)}events`);
        expect(third.status).toBe(503);
        a.close();
        b.close();
        await sleep(100);
        const socks = [];
        for (let i = 0; i < 3; i++) {
            const k = connect(s.port, DASHBOARD_HOST);
            k.on('error', () => { });
            socks.push(k);
            await new Promise((r) => k.once('connect', r));
        }
        await sleep(100);
        const over = await raw(s.port, `GET ${base(s)} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`, 1_500);
        expect(over).toBe('');
        for (const k of socks)
            k.destroy();
        await sleep(100);
        expect(statusOf(await raw(s.port, `GET ${base(s)} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close\r\n\r\n`))).toBe(200);
    });
    it('listens on 127.0.0.1 only, and the URL is that address', async () => {
        const s = await start();
        expect(s.server.address().address).toBe('127.0.0.1');
        expect(s.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/t/[0-9a-f]{64}/$`));
        const src = readFileSync(new URL('../serve.ts', import.meta.url), 'utf8');
        expect(src).not.toMatch(/0\.0\.0\.0|'::'|host:\s*o\./);
    });
});
describe('dashboard server: functional', () => {
    it('serves the collector\'s JSON (plus the platform command lines and the rev), with an ETag', async () => {
        asEngine(parked(1, 'First'));
        asEngine(parked(2, 'Second'));
        const s = await start();
        const r = await get(s, `${base(s)}api/v1/summary`);
        expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
        const served = JSON.parse(r.body);
        const d = collectFn()();
        expect(served).toEqual(JSON.parse(JSON.stringify(servedSummary(d, summaryRev(d)))));
        const { rev, ...rest } = served;
        rest.attention.items.forEach((i) => i.next.forEach((n) => { delete n.line; delete n.inRoot; }));
        expect(rest).toEqual(JSON.parse(JSON.stringify(d)));
        expect(r.headers.etag).toBe(`"${rev}"`);
        expect((await get(s, `${base(s)}api/v1/summary`, { headers: { 'If-None-Match': `"${rev}"` } })).status).toBe(304);
        const merge = served.attention.items.find((i) => i.key === '#1').next[0];
        expect(merge.line).toBe(merge.argv.join(' ').length > 0 ? merge.line : '');
        const detail = JSON.parse((await get(s, `${base(s)}api/v1/run/1`)).body);
        expect(detail.run.key).toBe('#1');
        expect(detail.run.timeline.length).toBeGreaterThan(0);
        expect(detail.lanes[0]).toMatchObject({ id: 'issue-1-implement-1', kind: 'implement', credits: 2 });
    });
    it('SSE: `changed` after a run state is written, none for an unrelated file, debounced', async () => {
        asEngine(parked(1));
        let now = T0 + 1_000_000;
        const s = await start({ collect: () => collectDashboardV2(root, { ledgerDir, now: () => now, owner: OWNER, limits: DEFAULT_FACTORY_RUN_LIMITS }), debounceMs: 50, minIntervalMs: 200 });
        const stream = await sse(s);
        await until(() => stream.events.length === 1);
        expect(stream.events[0]).toEqual({ event: 'changed', data: s.rev() });
        const before = s.rev();
        // An unrelated file in the watched dir and a clock change: a recompute, no event.
        writeFileSync(join(factoryStateDir(root), 'notes.txt'), 'x');
        now += 60_000;
        const n0 = s.recomputes();
        await until(() => s.recomputes() > n0);
        await sleep(300);
        expect(stream.events.length).toBe(1);
        expect(s.rev()).toBe(before);
        // Three writes in a burst: one recompute window, one event.
        const n1 = s.recomputes();
        asEngine(parked(2, 'two'));
        asEngine(parked(3, 'three'));
        asEngine(parked(4, 'four'));
        await until(() => stream.events.length >= 2);
        await sleep(600);
        expect(s.recomputes() - n1).toBeLessThanOrEqual(3);
        expect(stream.events.length).toBe(2);
        expect(stream.events[1].data).toBe(s.rev());
        expect(s.rev()).not.toBe(before);
        const summary = JSON.parse((await get(s, `${base(s)}api/v1/summary`)).body);
        expect(summary.runs.map((r) => r.key).sort()).toEqual(['#1', '#2', '#3', '#4']);
        stream.close();
    });
    it('a state dir that does not exist yet starts updating when it appears; a reconnect gets the current rev', async () => {
        const s = await start();
        const a = await sse(s);
        await until(() => a.events.length === 1);
        a.close();
        asEngine(parked(7));
        await until(() => s.rev() !== a.events[0].data, 5_000);
        const b = await sse(s);
        await until(() => b.events.length === 1);
        expect(b.events[0].data).toBe(s.rev());
        expect(JSON.parse((await get(s, `${base(s)}api/v1/summary`)).body).runs[0].key).toBe('#7');
        b.close();
    });
    it('pings every pingMs as an SSE comment', async () => {
        const s = await start({ pingMs: 80 });
        const a = await sse(s);
        await until(() => a.text().includes(': ping\n\n'));
        a.close();
    });
    it('without --forge: no forge call and no write (state dir and ledger byte-identical after requests)', async () => {
        asEngine(parked(1, 'one', 'gate output'));
        asEngine(parked(2));
        const forgeRead = vi.fn(async () => ({ lines: [], board: null }));
        const before = [treeHash(join(root, '.omg')), treeHash(ledgerDir)];
        let url = '';
        let stop;
        const stopped = new Promise((r) => { stop = r; });
        const out = [];
        const err = [];
        const deps = {
            root: () => root, out: (l) => out.push(l), err: (l) => err.push(l), ledgerDir, owner: OWNER, forgeRead,
            serve: async (o) => {
                const s = await startDashboardServer({ ...o, pollMs: 100 });
                servers.push(s);
                url = s.url;
                return s;
            },
            waitForStop: () => stopped,
        };
        const run = factoryDashboardCommand(deps).parseAsync(['--serve'], { from: 'user' });
        await until(() => url !== '');
        const s = servers.at(-1);
        for (const p of ['', 'api/v1/summary', 'api/v1/run/1', 'api/v1/run/2'])
            expect((await get(s, `${base(s)}${p}`)).status).toBe(200);
        const st = await sse(s);
        await until(() => st.events.length === 1);
        st.close();
        stop();
        await run;
        expect(process.exitCode).toBe(0);
        expect(forgeRead).not.toHaveBeenCalled();
        expect([treeHash(join(root, '.omg')), treeHash(ledgerDir)]).toEqual(before);
        expect(out).toEqual([url]);
        const token = url.split('/t/')[1];
        expect(err.join('\n')).not.toContain(token.slice(0, 16));
        expect(s.server.listening).toBe(false);
    });
    it('with --forge: the forge is read at start and on the slow timer only, never per request', async () => {
        asEngine(parked(1));
        const forgeRefresh = vi.fn(async () => { });
        const s = await start({ forgeRefresh, forgeRefreshMs: 300 });
        expect(forgeRefresh).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 5; i++)
            await get(s, `${base(s)}api/v1/summary`);
        expect(forgeRefresh).toHaveBeenCalledTimes(1);
        await until(() => forgeRefresh.mock.calls.length >= 2, 3_000);
    });
    it('closes cleanly: the listener, the watchers, the timers and every event stream', async () => {
        const resources = () => process.getActiveResourcesInfo().filter((r) => /TCP|FSEvent|Timeout/.test(r)).sort();
        asEngine(parked(1));
        const before = resources();
        const s = await start({ forgeRefresh: async () => { }, forgeRefreshMs: 60_000 });
        const a = await sse(s);
        await until(() => a.events.length === 1);
        let ended = false;
        await new Promise((done) => {
            const r = request({ host: DASHBOARD_HOST, port: s.port, path: `${base(s)}events`, agent: false }, (res) => {
                res.on('end', () => { ended = true; });
                res.on('close', () => { ended = true; });
                res.resume();
                done();
            });
            r.on('error', () => { ended = true; });
            r.end();
        });
        await s.close();
        await until(() => ended);
        expect(s.server.listening).toBe(false);
        a.close();
        await sleep(50);
        expect(resources().filter((r) => r !== 'Timeout').length).toBeLessThanOrEqual(before.filter((r) => r !== 'Timeout').length);
    });
    it('hostile titles, reasons and gate output: valid JSON, escaped, and never in the page HTML', async () => {
        asEngine(parked(1, HOSTILE, `line one\n${HOSTILE}\n\u001b[31mred\u001b[0m`));
        const s = await start();
        const page = await get(s, base(s));
        expect(page.body).not.toContain('alert(');
        expect(page.body).not.toContain('onerror');
        const r = await get(s, `${base(s)}api/v1/summary`);
        expect(r.body).not.toMatch(new RegExp(`[<>${LS}]`));
        const d = JSON.parse(r.body);
        expect(d.runs[0].title).toBe(HOSTILE.replace(LS, ' ').trim());
        const det = await get(s, `${base(s)}api/v1/run/1`);
        expect(det.body).not.toMatch(/[<>]/);
        const detail = JSON.parse(det.body);
        expect(detail.gateDetail.label).toMatch(/PR's own code/);
        expect(detail.gateDetail.text.split('\n')).toHaveLength(3);
        expect(detail.gateDetail.text).not.toContain('\u001b');
        // gate.detail is never in the summary (a list).
        expect(r.body).not.toContain('line one');
    });
    it('an unverified run: its row without free text, and no detail from its state', async () => {
        asEngine(parked(1, 'SECRET-T', 'SECRET-D'));
        const p = join(factoryStateDir(root), 'run-1.json');
        writeFileSync(p, readFileSync(p, 'utf8').replace('SECRET-T', 'SECRET-X'));
        const s = await start();
        const sum = await get(s, `${base(s)}api/v1/summary`);
        expect(sum.body).not.toContain('SECRET');
        const det = await get(s, `${base(s)}api/v1/run/1`);
        expect(det.status).toBe(200);
        expect(det.body).not.toContain('SECRET');
        const j = JSON.parse(det.body);
        expect(j).toMatchObject({ gateDetail: null, lanes: [], history: [] });
        expect(j.attention[0].next.map((n) => n.argv.join(' '))).toEqual(['omg factory run status 1']);
    });
});
describe('omg factory dashboard --serve (CLI)', () => {
    const cli = async (args, extra = {}) => {
        const out = [];
        const err = [];
        process.exitCode = undefined;
        await factoryDashboardCommand({ root: () => root, out: (l) => out.push(l), err: (l) => err.push(l), ledgerDir, owner: OWNER, waitForStop: async () => { }, ...extra }).parseAsync(args, { from: 'user' });
        return { code: process.exitCode, out, err };
    };
    it('is mutually exclusive with --out, --watch, --json and --schema 1; --port and --open need --serve; --port is 1024-65535', async () => {
        for (const a of [['--serve', '--out', 'x.html'], ['--serve', '--watch'], ['--serve', '--json'], ['--serve', '--json', '--schema', '1'], ['--port', '5000'], ['--open'],
            ['--serve', '--port', '80'], ['--serve', '--port', '70000'], ['--serve', '--port', 'abc'], ['--serve', '--port', '5000.5']]) {
            const r = await cli(a, { serve: () => { throw new Error('must not start'); } });
            expect(r.code, a.join(' ')).toBe(2);
        }
    });
    it('a port in use: a clear message and exit 1', async () => {
        const blocker = createTcpServer();
        await new Promise((r) => blocker.listen(0, '127.0.0.1', () => r()));
        const port = blocker.address().port;
        try {
            if (port < 1024)
                return;
            const r = await cli(['--serve', '--port', String(port)]);
            expect(r.code).toBe(1);
            expect(r.err.join('\n')).toMatch(new RegExp(`port ${port} is already in use`));
            expect(r.err.join('\n')).toMatch(/--out <file> --watch/);
            expect(r.out).toEqual([]);
        }
        finally {
            await new Promise((r) => blocker.close(r));
        }
    });
    it('prints the URL once on stdout, --open hands exactly that URL to the opener, Ctrl-C stops it', async () => {
        const opened = [];
        let srv = null;
        const r = await cli(['--serve', '--open'], {
            openUrl: (u) => opened.push(u),
            serve: async (o) => { srv = await startDashboardServer(o); servers.push(srv); return srv; },
        });
        expect(r.code).toBe(0);
        expect(r.out).toHaveLength(1);
        expect(opened).toEqual(r.out);
        expect(r.out[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]{64}\/$/);
        expect(srv.server.listening).toBe(false);
    });
});
//# sourceMappingURL=serve.test.js.map