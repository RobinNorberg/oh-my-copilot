import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CASSETTE_ENV } from '../../copilot-session-env.js';
import { GLOBAL_STREAM, readCassette, REDACTION_FAILED_MARKER } from '../cassette.js';
import { addRecordingDenyLiterals, RECORD_FAILED_SUFFIX, RECORD_PARTS_DIR, RECORD_STARTED_SUFFIX, withCassette, } from '../handler.js';
import { cassetteEnv, finalizeRecording, gateCassettes, keepFailedParts, importCassettes, mergeRecordedParts, platformTag, recordTargetRefusal, replayModel, replayOutcome, scenarioCassetteDir, scenarioStateDir, } from '../run.js';
const dirs = [];
const tempDir = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
};
const fetchSpy = vi.fn(async () => { throw new Error('fetch called'); });
beforeEach(() => { vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const dir of dirs)
        rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
});
const API = 'https://api.githubcopilot.com';
function fakeSdkBase(answer = () => ({ id: 'c', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] })) {
    const upstream = vi.fn(async (request) => {
        const text = request.method === 'GET' ? '' : await request.text();
        return new Response(JSON.stringify(answer(text ? JSON.parse(text) : null)), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    class Base {
        async sendRequest(request, _ctx) { return upstream(request); }
        async openWebSocket() { throw new Error('no ws'); }
    }
    return { Base: Base, upstream };
}
class FakeClient {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    get handler() { return this.opts.requestHandler; }
    async start() { }
    async stop() { return []; }
    async getStatus() { return {}; }
    async listModels() { return []; }
    async createSession(config) { return { sessionId: 'x', config }; }
    async deleteSession() { }
}
function fakeSdk(Base) {
    return { module: { CopilotClient: FakeClient, RuntimeConnection: { forStdio: (o) => o }, CopilotRequestHandler: Base }, version: '1.0.16', from: 'test' };
}
const newClient = (sdk) => new sdk.module.CopilotClient({ connection: {}, baseDirectory: 'b', workingDirectory: 'w' });
async function drive(client, session, prompt, method = 'POST') {
    const url = `${API}${method === 'GET' ? '/models' : '/chat/completions'}`;
    const body = { model: 'gpt-5-mini', messages: [{ role: 'user', content: prompt }] };
    const request = new Request(url, { method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return client.handler.sendRequest(request, { sessionId: session, transport: 'http', url, headers: { 'content-type': ['application/json'] } });
}
function newRun(mode, root = tempDir('omg-cassettes-'), over = {}) {
    return { mode, root, stateRoot: tempDir('omg-cassette-state-'), strict: false, overwrite: false, ...over };
}
/** Record `prompts` for `scenario`, one client (one "process") per prompt group; returns the run. */
async function recordScenario(run, scenario, groups) {
    for (const prompts of groups) {
        const { Base } = fakeSdkBase();
        const client = newClient(withCassette(fakeSdk(Base), cassetteEnv({}, run, {}, scenario)));
        for (const [i, prompt] of prompts.entries()) {
            await drive(client, `${prompt}-session`, prompt);
            if (i === 0)
                await drive(client, `${prompt}-session`, '', 'GET');
        }
        expect(await client.stop()).toEqual([]);
    }
}
describe('cassette run: record parts, merge, finalize', () => {
    it('merges the parts of several clients into one cassette with distinct streams and renumbered global interactions', async () => {
        const run = newRun('record');
        await recordScenario(run, 'team', [['task alpha'], ['task beta']]);
        const parts = readdirSync(join(scenarioStateDir(run, 'team'), RECORD_PARTS_DIR));
        expect(parts).toHaveLength(2);
        const merged = mergeRecordedParts(scenarioStateDir(run, 'team'), 'team');
        expect(merged.manifest.scenario).toBe('team');
        expect(merged.manifest.streams.map((s) => s.id).sort()).toEqual(['s1-root', 's2-root']);
        expect(merged.interactions.filter((it) => it.stream === GLOBAL_STREAM).map((it) => it.seq)).toEqual([1, 2]);
        const written = finalizeRecording(run, 'team', { model: 'gpt-5-mini', maxCredits: 30, cost: { credits: 1.2, premiumRequests: 2 } });
        expect(written).toMatchObject({ dir: scenarioCassetteDir(run, 'team'), streams: 2, interactions: 4 });
        expect(written.dir).toBe(join(run.root, platformTag(), 'team'));
        const cassette = readCassette(written.dir);
        expect(cassette.manifest).toMatchObject({ scenario: 'team', model: 'gpt-5-mini', maxCredits: 30, cost: { credits: 1.2, premiumRequests: 2 } });
        expect(replayModel({ ...run, mode: 'replay' }, ['team'])).toBe('gpt-5-mini');
    });
    it('refuses to merge when any part failed, and a gate refusal at stop() leaves that marker', async () => {
        const run = newRun('record');
        const secret = `late-literal-${Date.now()}-9931`;
        const { Base } = fakeSdkBase(() => ({ id: 'c', choices: [{ index: 0, message: { role: 'assistant', content: `x ${secret}` } }] }));
        const client = newClient(withCassette(fakeSdk(Base), cassetteEnv({}, run, {}, 'smoke')));
        await (await drive(client, 's', 'hello')).text();
        await new Promise((r) => { setTimeout(r, 50); }); // the tapped response is redacted in the background
        addRecordingDenyLiterals([secret]); // learned after redaction: only the gate at stop() sees it
        const errors = await client.stop();
        expect(errors).toHaveLength(1);
        const partsDir = join(scenarioStateDir(run, 'smoke'), RECORD_PARTS_DIR);
        const markers = readdirSync(partsDir).filter((n) => n.endsWith(RECORD_FAILED_SUFFIX));
        expect(markers).toHaveLength(1);
        expect(readFileSync(join(partsDir, markers[0]), 'utf-8')).not.toContain(secret);
        expect(() => mergeRecordedParts(scenarioStateDir(run, 'smoke'), 'smoke')).toThrow(/part\(s\) failed, refusing to merge/);
        expect(() => finalizeRecording(run, 'smoke', {})).toThrow(/refusing to merge/);
        expect(existsSync(scenarioCassetteDir(run, 'smoke'))).toBe(false);
    });
    it('a scenario with no request finalizes to nothing; an existing cassette is refused before recording unless overwritten', async () => {
        const run = newRun('record');
        expect(() => finalizeRecording(run, 'smoke', {})).toThrow(/no model request was recorded/);
        await recordScenario(run, 'smoke', [['hi']]);
        finalizeRecording(run, 'smoke', { model: 'm' });
        expect(recordTargetRefusal(run, 'smoke')).toMatch(/already holds a recording; pass --record-overwrite/);
        expect(recordTargetRefusal({ ...run, overwrite: true }, 'smoke')).toBeNull();
        expect(recordTargetRefusal(run, 'guardrail')).toBeNull();
    });
    it('one client switched between scenarios records each into its own state dir', async () => {
        const run = newRun('record');
        const { Base } = fakeSdkBase();
        const client = newClient(withCassette(fakeSdk(Base), cassetteEnv({}, run, {})));
        expect(client.cassette).toBe('record');
        client.setCassetteScenario('smoke', scenarioStateDir(run, 'smoke'));
        await drive(client, 'a', 'smoke prompt');
        client.setCassetteScenario('guardrail', scenarioStateDir(run, 'guardrail'));
        await drive(client, 'b', 'guardrail prompt');
        expect(await client.stop()).toEqual([]);
        for (const name of ['smoke', 'guardrail']) {
            const merged = mergeRecordedParts(scenarioStateDir(run, name), name);
            expect(merged.manifest.streams.map((s) => [s.id, s.session])).toEqual([['s1-root', 1]]);
        }
    });
    it('before its first scenario a switched client answers 418 without forwarding; a late request of scenario A after the switch stays in A', async () => {
        const run = newRun('record');
        const { Base, upstream } = fakeSdkBase();
        const client = newClient(withCassette(fakeSdk(Base), cassetteEnv({}, run, {})));
        expect((await drive(client, 'static', 'static prompt')).status).toBe(418);
        expect((await drive(client, 'static', '', 'GET')).status).toBe(418);
        expect(upstream).not.toHaveBeenCalled();
        client.setCassetteScenario('smoke', scenarioStateDir(run, 'smoke'));
        await drive(client, 'a', 'smoke prompt');
        client.setCassetteScenario('guardrail', scenarioStateDir(run, 'guardrail'));
        await drive(client, 'a', 'smoke follow-up'); // session a spoke in smoke first
        await drive(client, 'b', 'guardrail prompt');
        expect(await client.stop()).toEqual([]);
        expect(mergeRecordedParts(scenarioStateDir(run, 'smoke'), 'smoke').interactions).toHaveLength(2);
        expect(mergeRecordedParts(scenarioStateDir(run, 'guardrail'), 'guardrail').interactions).toHaveLength(1);
        expect(existsSync(join(run.stateRoot, '_client', RECORD_PARTS_DIR))).toBe(false);
    });
    it('a client that recorded and was never stopped (a killed process) leaves a marker the merge refuses', async () => {
        const run = newRun('record');
        const { Base } = fakeSdkBase();
        const killed = newClient(withCassette(fakeSdk(Base), cassetteEnv({}, run, {}, 'team')));
        await drive(killed, 'k', 'task alpha');
        await recordScenario(run, 'team', [['task beta']]);
        const partsDir = join(scenarioStateDir(run, 'team'), RECORD_PARTS_DIR);
        expect(readdirSync(partsDir).filter((n) => n.endsWith(RECORD_STARTED_SUFFIX))).toHaveLength(1);
        expect(() => mergeRecordedParts(scenarioStateDir(run, 'team'), 'team')).toThrow(/never finished .*refusing to merge/);
        expect(await killed.stop()).toEqual([]);
        expect(readdirSync(partsDir).filter((n) => n.endsWith(RECORD_STARTED_SUFFIX))).toEqual([]);
        expect(mergeRecordedParts(scenarioStateDir(run, 'team'), 'team').manifest.streams).toHaveLength(2);
    });
    it('borrows a global GET from another scenario but not a global POST', async () => {
        const run = newRun('record');
        await recordScenario(run, 'smoke', [['task alpha']]);
        const { Base } = fakeSdkBase();
        const client = newClient(withCassette(fakeSdk(Base), cassetteEnv({}, run, {}, 'smoke')));
        const url = `${API}/chat/completions`;
        await client.handler.sendRequest(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), { sessionId: 'g', transport: 'http', url, headers: { 'content-type': ['application/json'] } });
        expect(await client.stop()).toEqual([]);
        const own = mergeRecordedParts(scenarioStateDir(run, 'smoke'), 'smoke');
        expect(own.interactions.filter((it) => it.stream === GLOBAL_STREAM).map((it) => it.req.method).sort()).toEqual(['GET', 'POST']);
        await recordScenario(run, 'guardrail', [['task beta']]);
        finalizeRecording(run, 'guardrail', {}, { globalsFrom: ['smoke', 'guardrail'] });
        const globals = readCassette(scenarioCassetteDir(run, 'guardrail')).interactions.filter((it) => it.stream === GLOBAL_STREAM);
        expect(globals.map((it) => it.req.method)).toEqual(['GET']);
    });
    it('keepFailedParts copies parts and .failed markers but not .started markers', async () => {
        const run = newRun('record');
        await recordScenario(run, 'team', [['task alpha']]);
        const partsDir = join(scenarioStateDir(run, 'team'), RECORD_PARTS_DIR);
        writeFileSync(join(partsDir, `9-1${RECORD_STARTED_SUFFIX}`), '9');
        writeFileSync(join(partsDir, `9-2${RECORD_FAILED_SUFFIX}`), 'boom');
        const kept = join(keepFailedParts(run, 'team'), RECORD_PARTS_DIR);
        const names = readdirSync(kept);
        expect(names).toContain(`9-2${RECORD_FAILED_SUFFIX}`);
        expect(names.some((n) => n.endsWith(RECORD_STARTED_SUFFIX))).toBe(false);
        expect(names.length).toBeGreaterThan(1);
    });
});
describe('cassette run: replay outcome', () => {
    async function recorded() {
        const run = newRun('record');
        await recordScenario(run, 'smoke', [['hi']]);
        finalizeRecording(run, 'smoke', { model: 'gpt-5-mini' });
        return newRun('replay', run.root);
    }
    it('a full replay serves every stream; the SDK and its clients carry the replay marker', async () => {
        const run = await recorded();
        const { Base, upstream } = fakeSdkBase();
        const sdk = withCassette(fakeSdk(Base), cassetteEnv({}, run, {}, 'smoke'));
        expect(sdk.cassette).toBe('replay');
        const client = newClient(sdk);
        expect(client.cassette).toBe('replay');
        expect((await drive(client, 'live', 'hi')).status).toBe(200);
        expect((await drive(client, 'live', '', 'GET')).status).toBe(200);
        expect(upstream).not.toHaveBeenCalled();
        const outcome = replayOutcome(run, 'smoke');
        expect(outcome).toMatchObject({ streams: 1, misses: [], unclaimed: [], unconsumed: [] });
    });
    it('a miss and an unclaimed stream are reported', async () => {
        const run = await recorded();
        const { Base } = fakeSdkBase();
        const client = newClient(withCassette(fakeSdk(Base), cassetteEnv({}, run, {}, 'smoke')));
        expect((await drive(client, 'live', 'hi')).status).toBe(200);
        expect((await drive(client, 'live', 'hi again')).status).toBe(418); // the stream is exhausted
        expect(replayOutcome(run, 'smoke')).toMatchObject({ misses: [expect.objectContaining({ reason: 'stream exhausted' })] });
        const idle = await recorded();
        expect(replayOutcome(idle, 'smoke')).toMatchObject({ unclaimed: ['s1-root'] });
        expect(replayOutcome(idle, 'team')).toMatch(/no manifest\.json/);
    });
    it('a client with no scenario selected answers 418 and logs nothing', async () => {
        const run = await recorded();
        const { Base } = fakeSdkBase();
        const client = newClient(withCassette(fakeSdk(Base), cassetteEnv({}, run, {})));
        expect((await drive(client, 'live', 'hi')).status).toBe(418);
        client.setCassetteScenario('smoke', scenarioStateDir(run, 'smoke'));
        expect((await drive(client, 'live2', 'hi')).status).toBe(200);
        expect(replayOutcome(run, 'smoke')).toMatchObject({ misses: [] });
    });
});
describe('cassette env', () => {
    it('carries the mode, the platform dir for replay, a per-scenario state, the match mode and the placeholder dirs', () => {
        const run = newRun('replay', tempDir('root-'), { strict: true });
        const env = cassetteEnv({ PATH: '/bin', [CASSETTE_ENV.scenario]: 'stale' }, run, { PROJECT: '/p' }, 'team');
        expect(env).toMatchObject({
            PATH: '/bin',
            [CASSETTE_ENV.mode]: 'replay',
            [CASSETTE_ENV.dir]: join(run.root, platformTag()),
            [CASSETTE_ENV.state]: join(run.stateRoot, 'team'),
            [CASSETTE_ENV.scenario]: 'team',
            [CASSETTE_ENV.match]: 'strict',
            [CASSETTE_ENV.dirs]: '{"PROJECT":"/p"}',
        });
        expect(cassetteEnv({ [CASSETTE_ENV.scenario]: 'stale' }, run, {})[CASSETTE_ENV.scenario]).toBeUndefined();
    });
    it('a bad match mode or placeholder map fails the SDK load', () => {
        const { Base } = fakeSdkBase();
        const run = newRun('record');
        expect(() => withCassette(fakeSdk(Base), { ...cassetteEnv({}, run, {}), [CASSETTE_ENV.match]: 'loose' })).toThrow(/"strict" or "tolerant"/);
        expect(() => withCassette(fakeSdk(Base), { ...cassetteEnv({}, run, {}), [CASSETTE_ENV.dirs]: '{"NOPE":"/x"}' })).toThrow(/not a path placeholder/);
    });
    it('record mode says so on stderr, once per state dir', () => {
        const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const { Base } = fakeSdkBase();
        const run = newRun('record');
        withCassette(fakeSdk(Base), cassetteEnv({}, run, {}, 'smoke'));
        withCassette(fakeSdk(Base), cassetteEnv({}, run, {}, 'smoke'));
        const notices = write.mock.calls.map((c) => String(c[0])).filter((t) => t.includes('omg cassette: RECORD mode'));
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain(scenarioStateDir(run, 'smoke'));
        write.mockClear();
        withCassette(fakeSdk(Base), cassetteEnv({}, newRun('replay', run.root), {}));
        expect(write.mock.calls.map((c) => String(c[0])).filter((t) => t.includes('RECORD mode'))).toEqual([]);
    });
});
describe('cassette verify and import', () => {
    async function capture() {
        const run = newRun('record');
        await recordScenario(run, 'smoke', [['hi']]);
        finalizeRecording(run, 'smoke', { model: 'gpt-5-mini' });
        return run.root;
    }
    it('the gate passes a clean capture and marks one with a planted token', async () => {
        const root = await capture();
        expect(gateCassettes(root)).toEqual([expect.objectContaining({ ok: true })]);
        const dir = join(root, platformTag(), 'smoke');
        const interactions = join(dir, 'interactions.jsonl');
        writeFileSync(interactions, readFileSync(interactions, 'utf-8').replace('"ok"', `"ghp_${'a'.repeat(36)}"`));
        const [result] = gateCassettes(root);
        expect(result.ok).toBe(false);
        expect(existsSync(join(dir, REDACTION_FAILED_MARKER))).toBe(true);
    });
    it('imports into <dest>/<platform>-<arch>/<scenario>, all or nothing, refusing an existing target without overwrite', async () => {
        const root = await capture();
        const dest = tempDir('fixtures-');
        expect(importCassettes(root, dest).imported).toEqual([`${platformTag()}/smoke`]);
        expect(readCassette(join(dest, platformTag(), 'smoke')).manifest.model).toBe('gpt-5-mini');
        expect(() => importCassettes(root, dest)).toThrow(/exists; pass --overwrite/);
        expect(importCassettes(root, dest, true).imported).toHaveLength(1);
        // A stray file in the target would be mixed into the cassette.
        writeFileSync(join(dest, platformTag(), 'smoke', 'report.json'), '{}');
        expect(() => importCassettes(root, dest, true)).toThrow(/does not replace \(report\.json\)/);
    });
    it('refuses a cassette with a gate failure or outside its platform dir, copying nothing', async () => {
        const root = await capture();
        const dest = tempDir('fixtures-');
        const misplaced = join(root, 'elsewhere', 'smoke');
        mkdirSync(join(misplaced, '..'), { recursive: true });
        cpSync(join(root, platformTag(), 'smoke'), misplaced, { recursive: true });
        expect(() => importCassettes(root, dest)).toThrow(/keep each cassette at <platform>-<arch>\/<scenario>/);
        expect(readdirSync(dest)).toEqual([]);
        rmSync(join(root, 'elsewhere'), { recursive: true });
        writeFileSync(join(root, platformTag(), 'smoke', REDACTION_FAILED_MARKER), 'x\n');
        expect(() => importCassettes(root, dest)).toThrow(/redaction gate failed/);
        expect(readdirSync(dest)).toEqual([]);
    });
});
//# sourceMappingURL=run.test.js.map