import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CASSETTE_FORMAT, CASSETTE_VERSION, CassetteFormatError, CassetteGateError, findCassetteDirs, gateFiles, INTERACTIONS_FILE, MANIFEST_FILE, readCassette, REDACTION_FAILED_MARKER, verifyCassetteDir, writeCassette, } from '../cassette.js';
import { Redactor } from '../redact.js';
const GHP = `ghp_${'Z9y8X7w6V5'.repeat(4)}`;
function sample() {
    return {
        manifest: {
            format: CASSETTE_FORMAT,
            version: CASSETTE_VERSION,
            scenario: 'factory-run',
            recordedAt: '2026-10-30T09:12:44Z',
            omg: { version: '5.19.0', gitSha: 'abc', dirty: false },
            sdk: { version: '1.0.16' },
            runtime: { version: '1.0.105', protocolVersion: 3 },
            platform: 'linux',
            arch: 'x64',
            node: '22.11.0',
            model: 'gpt-5-mini',
            redaction: { rules: 1, hits: { bearer: 2 } },
            streams: [{ id: 's1', promptDigest: 'sha256:aa', session: 1, agent: 'root', interactions: 2, label: 'implement' }],
        },
        interactions: [
            {
                stream: 's1', seq: 1,
                req: { method: 'POST', path: '/chat/completions', transport: 'http', headers: { 'content-type': 'application/json' }, deltaDigest: 'sha256:d1', delta: 'implement ${PROJECT}/a.ts' },
                res: { status: 200, headers: { 'content-type': 'text/event-stream' }, kind: 'sse', chunks: ['data: {"x":1}\n\n', 'data: [DONE]\n\n'] },
                ms: 2140,
            },
            {
                stream: 's1', seq: 2,
                req: { method: 'POST', path: '/chat/completions', transport: 'http', headers: {}, deltaDigest: 'sha256:d2', expectsToolResults: ['call_abc'] },
                res: { status: 200, headers: { 'x-ratelimit-remaining': '5' }, kind: 'json', body: { choices: [] } },
            },
            {
                stream: 'global', seq: 1,
                req: { method: 'GET', path: '/models', transport: 'http', headers: {}, deltaDigest: 'sha256:none' },
                res: { status: 200, headers: {}, kind: 'ws', messages: [{ dir: 'out', data: 'hi' }, { dir: 'in', data: 'there' }] },
            },
        ],
        events: { s1: [{ type: 'session.start' }, { type: 'assistant.message', data: { content: 'done' } }] },
        report: { ok: true },
    };
}
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omg-cassette-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
describe('writeCassette / readCassette', () => {
    it('round-trips every part', () => {
        const cassette = sample();
        writeCassette(join(dir, 'c'), cassette);
        expect(readCassette(join(dir, 'c'))).toEqual(cassette);
        expect(readFileSync(join(dir, 'c', INTERACTIONS_FILE), 'utf-8').split('\n')).toHaveLength(4);
        expect(existsSync(join(dir, 'c', 'events', 's1.jsonl'))).toBe(true);
    });
    it('refuses a non-empty dir unless overwrite', () => {
        writeCassette(dir, sample());
        expect(() => writeCassette(dir, sample())).toThrow(/not empty/);
        expect(() => writeCassette(dir, sample(), { overwrite: true })).not.toThrow();
    });
    it('refuses inconsistent cassettes before writing', () => {
        const bad = sample();
        bad.manifest.streams[0].interactions = 3;
        expect(() => writeCassette(dir, bad)).toThrow(/declares 3 interaction\(s\), found 2/);
        const unknownStream = sample();
        unknownStream.interactions[0].stream = 's9';
        expect(() => writeCassette(dir, unknownStream)).toThrow(/s9 is not in the manifest/);
        const order = sample();
        order.interactions[1].seq = 1;
        expect(() => writeCassette(dir, order)).toThrow(/does not follow/);
        const unsafe = sample();
        unsafe.events = { '../escape': [] };
        expect(() => writeCassette(dir, unsafe)).toThrow(/safe file name/);
    });
});
describe('version refusal', () => {
    const writeManifest = (patch) => {
        writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({ ...sample().manifest, streams: [], ...patch }));
    };
    it('refuses a newer version with an upgrade hint', () => {
        writeManifest({ version: 2 });
        expect(() => readCassette(dir)).toThrow(/cassette v2 needs a newer omg/);
    });
    it('refuses an unknown version and a foreign format', () => {
        writeManifest({ version: 0 });
        expect(() => readCassette(dir)).toThrow(/unsupported cassette version 0/);
        writeManifest({ format: 'vcr' });
        expect(() => readCassette(dir)).toThrow(CassetteFormatError);
    });
    it('refuses an unknown response kind', () => {
        writeCassette(dir, sample());
        const lines = readFileSync(join(dir, INTERACTIONS_FILE), 'utf-8').split('\n');
        lines[0] = lines[0].replace('"kind":"sse"', '"kind":"grpc"');
        writeFileSync(join(dir, INTERACTIONS_FILE), lines.join('\n'));
        expect(() => readCassette(dir)).toThrow(/interactions.jsonl:1: unknown res.kind "grpc"/);
    });
});
describe('the gate', () => {
    it('refuses to write a cassette with a planted ghp_ token, and writes nothing', () => {
        const leaky = sample();
        leaky.interactions[0].res = { status: 200, headers: {}, kind: 'sse', chunks: [`data: {"content":"GH_TOKEN=${GHP}"}\n\n`] };
        let error;
        try {
            writeCassette(join(dir, 'c'), leaky);
        }
        catch (err) {
            error = err;
        }
        expect(error).toBeInstanceOf(CassetteGateError);
        expect(error.hits).toEqual([expect.objectContaining({ file: INTERACTIONS_FILE, line: 1, rule: 'github-token', masked: 'ghp_****' })]);
        expect(error.message).not.toContain(GHP);
        expect(existsSync(join(dir, 'c'))).toBe(false);
    });
    it('refuses to write a deny-set literal, even an innocent-looking one in events', () => {
        const literal = 'credential-from-stdin-42';
        const leaky = sample();
        leaky.events = { s1: [{ type: 'tool.result', data: { out: `x ${literal}` } }] };
        expect(() => writeCassette(dir, leaky, { denyLiterals: [literal] })).toThrow(/events\/s1.jsonl:1: secret \*\*\*\*/);
        expect(() => writeCassette(dir, leaky)).not.toThrow(); // without the deny set it is just text
    });
    it('refuses headers outside the allowlists', () => {
        const leaky = sample();
        leaky.interactions[0].req.headers = { authorization: 'x' };
        leaky.interactions[1].res.headers = { 'set-cookie': 'y' };
        try {
            writeCassette(dir, leaky);
            expect.unreachable();
        }
        catch (err) {
            expect(err.hits.map((h) => `${h.rule}:${h.masked}`)).toEqual(['header.request:authorization', 'header.response:set-cookie']);
        }
    });
    it('writes a cassette the Redactor cleaned', () => {
        const redactor = new Redactor({ denyLiterals: ['deny-literal-xyz'], dirs: { PROJECT: '/tmp/p' } });
        const cassette = sample();
        cassette.interactions[0].res = redactor.redactValue({
            status: 200, headers: {}, kind: 'sse', chunks: [`data: {"c":"deny-literal-xyz ${GHP} /tmp/p/a.ts"}\n\n`],
        });
        expect(() => writeCassette(dir, cassette, { denyLiterals: ['deny-literal-xyz'] })).not.toThrow();
        expect(readCassette(dir).interactions[0].res).toMatchObject({ chunks: ['data: {"c":"<secret> <redacted:github-token> ${PROJECT}/a.ts"}\n\n'] });
    });
});
describe('verifyCassetteDir', () => {
    it('passes a clean cassette', () => {
        writeCassette(dir, sample());
        expect(verifyCassetteDir(dir)).toEqual({ ok: true, hits: [] });
    });
    it('finds a token planted on disk, writes the marker, and readCassette then refuses', () => {
        writeCassette(dir, sample());
        writeFileSync(join(dir, 'report.json'), JSON.stringify({ log: `push with ${GHP}` }, null, 2));
        const result = verifyCassetteDir(dir);
        expect(result.ok).toBe(false);
        expect(result.hits).toEqual([expect.objectContaining({ file: 'report.json', line: 2, rule: 'github-token' })]);
        const marker = readFileSync(join(dir, REDACTION_FAILED_MARKER), 'utf-8');
        expect(marker).toContain('report.json:2: github-token ghp_****');
        expect(marker).not.toContain(GHP);
        expect(() => readCassette(dir)).toThrow(/REDACTION-FAILED/);
        expect(verifyCassetteDir(dir).hits.map((h) => h.rule)).toContain('file.marker');
    });
    it('finds a deny-set literal at record time', () => {
        writeCassette(dir, sample());
        mkdirSync(join(dir, 'events'), { recursive: true });
        writeFileSync(join(dir, 'events', 's2.jsonl'), `${JSON.stringify({ t: 'the-deny-literal' })}\n`);
        const result = verifyCassetteDir(dir, { denyLiterals: ['the-deny-literal'], writeMarker: false });
        expect(result.hits).toEqual([expect.objectContaining({ file: 'events/s2.jsonl', line: 1, rule: 'secret', masked: '****' })]);
        expect(existsSync(join(dir, REDACTION_FAILED_MARKER))).toBe(false);
    });
    it('rejects unparsable files, a newer version, and the --record-full sidecar', () => {
        writeCassette(dir, sample());
        writeFileSync(join(dir, 'events', 'broken.jsonl'), '{not json\n');
        mkdirSync(join(dir, 'full-requests'));
        const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf-8'));
        writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({ ...manifest, version: 7 }));
        const rules = verifyCassetteDir(dir, { writeMarker: false }).hits.map((h) => h.rule);
        expect(rules).toEqual(expect.arrayContaining(['file.parse', 'file.record-full', 'file.invalid']));
    });
    it('rejects a symlink without following it', () => {
        writeCassette(dir, sample());
        const target = mkdtempSync(join(tmpdir(), 'omg-cassette-target-'));
        writeFileSync(join(target, 'secret.txt'), GHP);
        try {
            // A junction needs no privilege on Windows; elsewhere the type is ignored.
            symlinkSync(target, join(dir, 'link'), 'junction');
            const hits = verifyCassetteDir(dir, { writeMarker: false }).hits;
            expect(hits.map((h) => h.rule)).toEqual(['file.symlink']);
        }
        finally {
            // Unlink the link itself before anything recursive touches dir, so nothing is deleted through it.
            if (existsSync(join(dir, 'link')))
                unlinkSync(join(dir, 'link'));
            rmSync(target, { recursive: true, force: true });
        }
    });
});
describe('findCassetteDirs', () => {
    it('finds every dir holding a manifest', () => {
        writeCassette(join(dir, 'linux-x64', 'factory-run'), sample());
        writeCassette(join(dir, 'linux-x64', 'team'), sample());
        mkdirSync(join(dir, 'win32-x64'));
        expect(findCassetteDirs(dir)).toEqual([join(dir, 'linux-x64', 'factory-run'), join(dir, 'linux-x64', 'team')]);
    });
});
describe('review fixes (#349)', () => {
    // A tool call's arguments inside an SSE chunk inside interactions.jsonl: three JSON string levels deep on disk.
    const toolCallChunk = (args, raw) => {
        const payload = JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: 'edit', arguments: JSON.stringify(args) } }] } }] });
        return `data: ${raw ? raw(payload) : payload}\n\n`;
    };
    const withChunk = (chunk) => {
        const cassette = sample();
        cassette.interactions[0].res = { status: 200, headers: {}, kind: 'sse', chunks: [chunk] };
        return cassette;
    };
    it('the gate decodes SSE payloads and nested JSON: path, password and token in tool-call arguments', () => {
        const cassette = withChunk(toolCallChunk({ path: 'C:\\Users\\norbe\\proj\\a.ts', password: 'hunter2hunter2' }));
        let error;
        try {
            writeCassette(join(dir, 'c'), cassette);
        }
        catch (err) {
            error = err;
        }
        expect(error).toBeInstanceOf(CassetteGateError);
        expect(error.hits.map((h) => h.rule)).toEqual(expect.arrayContaining(['path.USERHOME', 'generic']));
        expect(existsSync(join(dir, 'c'))).toBe(false);
    });
    it('the gate finds a deny literal with quotes and backslashes three levels deep', () => {
        const literal = 'pa"ss\\word-123456';
        const cassette = withChunk(toolCallChunk({ cmd: `login ${literal}` }));
        expect(() => writeCassette(dir, cassette, { denyLiterals: [literal] })).toThrow(/interactions.jsonl:1: secret \*\*\*\*/);
    });
    it('the gate finds a token spelled with \\u escapes in an SSE payload', () => {
        const cassette = withChunk(toolCallChunk({ env: `GH_TOKEN=${GHP}` }, (json) => json.replace(/ghp_/g, '\\u0067hp_')));
        expect(() => writeCassette(dir, cassette)).toThrow(/github-token/);
    });
    it('verify rejects files outside the allowlist and non-UTF-8 encodings', () => {
        writeCassette(dir, sample());
        writeFileSync(join(dir, 'notes.txt'), 'hello');
        writeFileSync(join(dir, 'events', 's1.jsonl'), Buffer.from(`${JSON.stringify({ t: GHP })}\n`, 'utf16le'));
        const hits = verifyCassetteDir(dir, { writeMarker: false }).hits;
        expect(hits).toEqual(expect.arrayContaining([
            expect.objectContaining({ file: 'notes.txt', rule: 'file.unexpected' }),
            expect.objectContaining({ file: 'events/s1.jsonl', rule: 'file.encoding' }),
        ]));
        writeFileSync(join(dir, 'events', 's1.jsonl'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}\n')]));
        expect(verifyCassetteDir(dir, { writeMarker: false }).hits).toEqual(expect.arrayContaining([
            expect.objectContaining({ file: 'events/s1.jsonl', rule: 'file.encoding' }),
        ]));
    });
    it('overwrite refuses a dir holding files the new recording would not replace', () => {
        const first = sample();
        first.events = { s1: [], s2: [] };
        writeCassette(dir, first);
        expect(() => writeCassette(dir, sample(), { overwrite: true })).toThrow(/events\/s2.jsonl/);
        unlinkSync(join(dir, 'events', 's2.jsonl'));
        expect(() => writeCassette(dir, sample(), { overwrite: true })).not.toThrow();
    });
});
describe('review fixes round 3 (#349): the gate reassembles streams', () => {
    const PATH_ARGS = JSON.stringify({ path: 'C:\\Users\\norbe\\proj\\a.ts' });
    const PASSWORD_TEXT = 'set password=hunter2hunter2 now';
    const split = (text, cuts) => [0, ...cuts].map((at, i, all) => text.slice(at, all[i + 1]));
    const line = (res) => new Map([[INTERACTIONS_FILE, `${JSON.stringify({ stream: 's1', seq: 1, res })}\n`]]);
    const chatArgs = (part) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] } }] })}\n\n`;
    const chatContent = (part) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part } }] })}\n\n`;
    const responses = (type) => (part) => `event: ${type}\ndata: ${JSON.stringify({ type, item_id: 'it_1', output_index: 0, content_index: 0, delta: part })}\n\n`;
    it.each([
        ['chat arguments, path over 3', chatArgs, PATH_ARGS, [14, 22], 'path.USERHOME'],
        ['chat content, password over 2', chatContent, PASSWORD_TEXT, [19], 'generic'],
        ['responses arguments, path over 3', responses('response.function_call_arguments.delta'), PATH_ARGS, [14, 22], 'path.USERHOME'],
        ['responses output_text, password over 2', responses('response.output_text.delta'), PASSWORD_TEXT, [19], 'generic'],
    ])('finds a secret split across SSE chunks: %s', (_name, frame, text, cuts, rule) => {
        const chunks = split(text, cuts).map(frame);
        expect(gateFiles(line({ status: 200, headers: {}, kind: 'sse', chunks })).map((h) => h.rule)).toContain(rule);
    });
    it('finds a secret split mid-line across raw SSE chunks', () => {
        const event = chatContent(PASSWORD_TEXT);
        const at = event.indexOf('hunter2') + 3;
        const hits = gateFiles(line({ status: 200, headers: {}, kind: 'sse', chunks: [event.slice(0, at), event.slice(at)] }));
        expect(hits.map((h) => h.rule)).toContain('generic');
    });
    it('finds a secret split across WebSocket messages', () => {
        const messages = split(PASSWORD_TEXT, [19]).map((delta) => ({ dir: 'in', data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'm', delta }) }));
        expect(gateFiles(line({ status: 101, headers: {}, kind: 'ws', messages })).map((h) => h.rule)).toContain('generic');
    });
    it('passes the stream once the Redactor rewrote it', () => {
        const chunks = split(PATH_ARGS, [14, 22]).map(chatArgs);
        const res = new Redactor().redactResponse({ status: 200, headers: {}, kind: 'sse', chunks });
        expect(gateFiles(line(res))).toEqual([]);
    });
    it('reassembles chunks whatever res.kind says', () => {
        const chunks = split(PASSWORD_TEXT, [19]).map(chatContent);
        expect(gateFiles(line({ chunks })).map((h) => h.rule)).toContain('generic');
    });
});
//# sourceMappingURL=cassette.test.js.map