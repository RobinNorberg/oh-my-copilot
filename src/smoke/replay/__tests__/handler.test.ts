import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LoadedSdk, SdkClientOptions, SdkSessionConfig } from '../../copilot-sdk-driver.js';
import { buildSessionEnv, CASSETTE_ENV, cassetteRuntimeEnv, REPLAY_HMAC_KEY } from '../../copilot-session-env.js';
import { scrubWorkerCredentials } from '../../../team/sdk-host.js';
import { readCassette, type Cassette } from '../cassette.js';
import {
  addRecordingDenyLiterals,
  CassetteRecorder,
  CassetteReplayer,
  createRecordingHandler,
  createReplayHandler,
  readCassetteConfig,
  RECORD_PARTS_DIR,
  REQUEST_HANDLER_MISSING,
  withCassette,
  type CopilotRequestContextLike,
  type CopilotRequestHandlerCtor,
  type CopilotRequestHandlerLike,
} from '../handler.js';
import { MISS_STATUS } from '../matcher.js';

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

// Nothing in these tests may reach the network.
const fetchSpy = vi.fn(async () => { throw new Error('fetch called'); });
beforeEach(() => { vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockClear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

const API = 'https://api.githubcopilot.com';
const BEARER = 'Bearer tid=abc123secretvalue;exp=1999999999;sku=x';
const HMAC = 'hmac-signature-0123456789';

/** The SDK base: its defaults are the upstream (here, spies). */
function fakeSdkBase(answers: Response[] = []) {
  const upstream = vi.fn(async (_request: Request, _ctx: CopilotRequestContextLike): Promise<Response> => {
    const next = answers.shift();
    if (!next) throw new Error('upstream: no answer left');
    return next;
  });
  const upstreamWs = vi.fn(async (_ctx: CopilotRequestContextLike): Promise<unknown> => ({ upstream: true }));
  class Base {
    async sendRequest(request: Request, ctx: CopilotRequestContextLike): Promise<Response> { return upstream(request, ctx); }
    async openWebSocket(ctx: CopilotRequestContextLike): Promise<unknown> { return upstreamWs(ctx); }
  }
  return { Base: Base as CopilotRequestHandlerCtor, upstream, upstreamWs };
}

interface Call { session: string; agentId?: string; parentAgentId?: string; path?: string; method?: string; body?: unknown }

/** What the runtime does: build a request with credentials, call the hook, read the whole response. */
async function drive(handler: CopilotRequestHandlerLike, call: Call): Promise<{ status: number; type: string | null; text: string }> {
  const method = call.method ?? 'POST';
  const url = `${API}${call.path ?? '/chat/completions'}`;
  const headers = { authorization: BEARER, 'request-hmac': HMAC, 'content-type': 'application/json', 'x-initiator': 'agent' };
  const request = new Request(url, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(call.body) }) });
  const ctx: CopilotRequestContextLike = {
    requestId: 'r1',
    sessionId: call.session,
    ...(call.agentId ? { agentId: call.agentId } : {}),
    ...(call.parentAgentId ? { parentAgentId: call.parentAgentId } : {}),
    interactionType: 'conversation-agent',
    transport: 'http',
    url,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]])),
  };
  const response = await handler.sendRequest(request, ctx);
  return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
}

const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req-1', ...headers } });
const sseText = (events: unknown[]) => `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
const sse = (text: string) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

const usage = { copilot_usage: { total_nano_aiu: 4_242_000_000 } };
const prompt = { role: 'user', content: 'Implement the feature' };
const toolCall = { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } };
const firstBody = { model: 'gpt-5-mini', messages: [{ role: 'system', content: 'sys' }, prompt], tools: [{ type: 'function', function: { name: 'shell' } }] };
const secondBody = {
  ...firstBody,
  messages: [...firstBody.messages, { role: 'assistant', content: null, tool_calls: [toolCall] }, { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' }],
};
const firstAnswer = { id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }], ...usage };
const secondAnswer = { id: 'c2', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], ...usage };

function fakeSdk(Base: CopilotRequestHandlerCtor | undefined): { loaded: LoadedSdk; clients: FakeClient[]; forStdio: ReturnType<typeof vi.fn> } {
  const clients: FakeClient[] = [];
  const forStdio = vi.fn((opts: unknown) => opts);
  class Client extends FakeClient {
    constructor(opts: SdkClientOptions) { super(opts); clients.push(this); }
  }
  return {
    loaded: { module: { CopilotClient: Client as never, RuntimeConnection: { forStdio }, ...(Base ? { CopilotRequestHandler: Base } : {}) }, version: '1.0.16', from: 'test' },
    clients,
    forStdio,
  };
}

class FakeClient {
  sessions: SdkSessionConfig[] = [];
  constructor(readonly opts: SdkClientOptions) {}
  get handler(): CopilotRequestHandlerLike { return this.opts.requestHandler as CopilotRequestHandlerLike; }
  async start(): Promise<void> {}
  async stop(): Promise<Error[]> { return []; }
  async getStatus() { return {}; }
  async listModels() { return []; }
  async createSession(config: SdkSessionConfig) { this.sessions.push(config); return { sessionId: 'x' } as never; }
  async deleteSession(): Promise<void> {}
}

function cassetteEnv(mode: string, dir: string, state: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { [CASSETTE_ENV.mode]: mode, [CASSETTE_ENV.dir]: dir, [CASSETTE_ENV.state]: state, ...extra };
}

/** Record `calls` through withCassette with the given upstream answers; returns the written part. */
async function record(calls: Call[], answers: Response[]): Promise<{ part: string; cassette: Cassette; upstream: ReturnType<typeof vi.fn>; outputs: string[] }> {
  const state = tempDir('omg-rec-state-');
  const { Base, upstream } = fakeSdkBase(answers);
  const { loaded, clients } = fakeSdk(Base);
  const sdk = withCassette(loaded, cassetteEnv('record', tempDir('omg-rec-out-'), state));
  const client = new sdk.module.CopilotClient({ connection: {}, baseDirectory: 'b', workingDirectory: 'w' });
  const outputs: string[] = [];
  for (const call of calls) outputs.push((await drive(clients[0].handler, call)).text);
  expect(await client.stop()).toEqual([]);
  const parts = readdirSync(join(state, RECORD_PARTS_DIR));
  expect(parts).toHaveLength(1);
  const part = join(state, RECORD_PARTS_DIR, parts[0]);
  return { part, cassette: readCassette(part), upstream, outputs };
}

function replayClient(cassetteDir: string, state = tempDir('omg-replay-state-')) {
  const { Base, upstream, upstreamWs } = fakeSdkBase();
  const { loaded, clients, forStdio } = fakeSdk(Base);
  const sdk = withCassette(loaded, cassetteEnv('replay', cassetteDir, state));
  const client = new sdk.module.CopilotClient({ connection: {}, baseDirectory: 'b', workingDirectory: 'w' });
  return { sdk, client, fake: clients[0], upstream, upstreamWs, forStdio, state };
}

const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

describe('record then replay', () => {
  it('buffered JSON: records a pass-through, replays it without the upstream', async () => {
    const { cassette, upstream, outputs } = await record(
      [{ session: 'sA', body: firstBody }, { session: 'sA', body: secondBody }],
      [json(firstAnswer), json(secondAnswer)],
    );
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(JSON.parse(outputs[0])).toEqual(firstAnswer);
    expect(cassette.manifest.streams).toEqual([expect.objectContaining({ id: 's1-root', session: 1, agent: 'root', interactions: 2 })]);
    const [first, second] = cassette.interactions;
    expect(first.req).toMatchObject({ method: 'POST', path: '/chat/completions', transport: 'http', model: 'gpt-5-mini', headers: { 'content-type': 'application/json', 'x-initiator': 'agent' } });
    expect(first.res).toMatchObject({ kind: 'json', status: 200, headers: { 'content-type': 'application/json' } });
    // Credit accounting comes from the body: kept.
    expect((first.res as { body: typeof firstAnswer }).body.copilot_usage.total_nano_aiu).toBe(4_242_000_000);
    expect(second.req.expectsToolResults).toEqual(['call_1']);

    const { client, fake, upstream: replayUpstream } = await replayFrom(cassette);
    expect(JSON.parse((await drive(fake.handler, { session: 'live-1', body: firstBody })).text)).toEqual(firstAnswer);
    const served = await drive(fake.handler, { session: 'live-1', body: secondBody });
    expect(served).toMatchObject({ status: 200, type: 'application/json' });
    expect(JSON.parse(served.text)).toEqual(secondAnswer);
    // Exhausted stream: a miss, still never forwarded.
    const miss = await drive(fake.handler, { session: 'live-1', body: secondBody });
    expect(miss.status).toBe(MISS_STATUS);
    expect(miss.text).toContain('stream exhausted');
    expect(replayUpstream).not.toHaveBeenCalled();
    expect(await client.stop()).toEqual([]);
  });

  it('SSE: records the stream and serves it as SSE', async () => {
    const events = [
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'hello ' },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'world' },
      { type: 'response.completed', response: { id: 'resp_1', output: [], usage: {}, ...usage } },
    ];
    const text = sseText(events);
    const body = { model: 'gpt-5-mini', input: [prompt], tools: [] };
    const { cassette, outputs } = await record([{ session: 'sA', path: '/responses', body }], [sse(text)]);
    expect(outputs[0]).toBe(text);
    expect(cassette.interactions[0].res.kind).toBe('sse');

    const { fake, upstream } = await replayFrom(cassette);
    const served = await drive(fake.handler, { session: 'live', path: '/responses', body });
    expect(served).toMatchObject({ status: 200, type: 'text/event-stream', text });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('a request that skips a recorded tool result misses with 418', async () => {
    const { cassette } = await record([{ session: 'sA', body: firstBody }, { session: 'sA', body: secondBody }], [json(firstAnswer), json(secondAnswer)]);
    const { fake, upstream, state } = await replayFrom(cassette);
    await drive(fake.handler, { session: 'live', body: firstBody });
    const denied = { ...firstBody, messages: [...firstBody.messages, { role: 'assistant', content: 'permission denied' }] };
    const miss = await drive(fake.handler, { session: 'live', body: denied });
    expect(miss).toMatchObject({ status: 418 });
    expect(miss.text).toContain('no tool result for call_1');
    expect(readFileSync(join(state, 'misses.jsonl'), 'utf8')).toContain('call_1');
    expect(upstream).not.toHaveBeenCalled();
  });

  async function replayFrom(cassette: Cassette) {
    // The written part is itself a cassette: replay it in place.
    const dir = tempDir('omg-replay-cassette-');
    const { writeCassette } = await import('../cassette.js');
    writeCassette(dir, cassette, { overwrite: true });
    return replayClient(dir);
  }
});

describe('replay lockout', () => {
  async function cassetteDir(): Promise<string> {
    const { part } = await record([{ session: 'sA', body: firstBody }], [json(firstAnswer)]);
    return part;
  }

  it('never calls the upstream, for hits, misses and unknown paths', async () => {
    const { fake, upstream } = replayClient(await cassetteDir());
    expect((await drive(fake.handler, { session: 'x', body: firstBody })).status).toBe(200);
    expect((await drive(fake.handler, { session: 'y', body: { ...firstBody, messages: [{ role: 'user', content: 'other' }] } })).status).toBe(418);
    expect((await drive(fake.handler, { session: 'z', method: 'GET', path: '/models' })).status).toBe(418);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses WebSocket without opening the upstream', async () => {
    const { fake, upstreamWs } = replayClient(await cassetteDir());
    await expect(fake.handler.openWebSocket({ transport: 'websocket', url: 'wss://x' })).rejects.toThrow(/COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES=1/);
    expect(upstreamWs).not.toHaveBeenCalled();
  });

  it('the handler holds no reference to the upstream', () => {
    const { Base, upstream } = fakeSdkBase();
    const replayer = {} as CassetteReplayer;
    const source = Object.getPrototypeOf(createReplayHandler(Base, replayer)).constructor.toString() as string;
    expect(source).not.toMatch(/\bsuper\b|\bfetch\b|new WebSocket/);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('strips credentials from the runtime env and session, pins the model', async () => {
    const { sdk, fake, forStdio } = replayClient(await cassetteDir());
    sdk.module.RuntimeConnection.forStdio({ path: 'copilot', env: { PATH: '/bin', GH_TOKEN: 'ghp_x', COPILOT_GITHUB_TOKEN: 't', COPILOT_HMAC_KEY: 'real' } });
    const env = (forStdio.mock.calls[0][0] as { env: NodeJS.ProcessEnv }).env;
    expect(env).toEqual({ PATH: '/bin', COPILOT_HMAC_KEY: REPLAY_HMAC_KEY, COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES: '1' });
    expect(fake.opts.useLoggedInUser).toBe(false);
    const client = fake as unknown as { createSession(c: SdkSessionConfig): Promise<unknown> };
    const base = { onPermissionRequest: () => ({ kind: 'approve-once' as const }), pluginDirectories: [], workingDirectory: 'w', disabledMcpServers: [], excludedTools: [] };
    await expect(client.createSession(base)).rejects.toThrow(/pinned model/);
    await client.createSession({ ...base, model: 'gpt-5-mini', gitHubToken: 'secret-token' });
    expect(fake.sessions.at(-1)).toEqual({ ...base, model: 'gpt-5-mini' });
  });
});

describe('withCassette config', () => {
  it('returns the SDK unchanged without the cassette env', () => {
    const { loaded } = fakeSdk(fakeSdkBase().Base);
    expect(withCassette(loaded, {})).toBe(loaded);
  });

  it('throws, never degrades, when the SDK has no CopilotRequestHandler', () => {
    const { loaded } = fakeSdk(undefined);
    expect(() => withCassette(loaded, cassetteEnv('replay', tempDir('c-'), tempDir('s-')))).toThrow(REQUEST_HANDLER_MISSING);
    expect(() => withCassette(loaded, cassetteEnv('record', tempDir('c-'), tempDir('s-')))).toThrow(REQUEST_HANDLER_MISSING);
  });

  it('checks the mode strictly and refuses recording under CI or into fixtures', () => {
    expect(() => readCassetteConfig(cassetteEnv('Replay', 'd', 's'))).toThrow(/exactly "record" or "replay"/);
    expect(() => readCassetteConfig({ [CASSETTE_ENV.dir]: 'd' })).toThrow(/exactly/);
    expect(() => readCassetteConfig({ [CASSETTE_ENV.mode]: 'replay', [CASSETTE_ENV.dir]: 'd' })).toThrow(/OMG_COPILOT_CASSETTE_STATE/);
    expect(() => readCassetteConfig(cassetteEnv('record', 'd', 's', { CI: 'true' }))).toThrow(/CI/);
    expect(() => readCassetteConfig(cassetteEnv('record', join('src', 'smoke', '__tests__', 'fixtures', 'cassettes'), 's'))).toThrow(/fixtures/);
    expect(readCassetteConfig(cassetteEnv('replay', 'd', 's', { CI: 'true' }))?.mode).toBe('replay');
  });

  it('refuses a cassette recorded on another platform', async () => {
    const { cassette } = await record([{ session: 'sA', body: firstBody }], [json(firstAnswer)]);
    const dir = tempDir('omg-foreign-');
    const { writeCassette } = await import('../cassette.js');
    writeCassette(dir, { ...cassette, manifest: { ...cassette.manifest, platform: process.platform === 'win32' ? 'linux' : 'win32' } }, { overwrite: true });
    expect(() => replayClient(dir)).toThrow(/cannot replay on/);
  });
});

describe('env scrub', () => {
  const base = {
    PATH: '/bin', GH_TOKEN: 'ghp_x', COPILOT_GITHUB_TOKEN: 'tok', COPILOT_HMAC_KEY: 'hmac',
    [CASSETTE_ENV.dir]: '/c', [CASSETTE_ENV.scenario]: 'team', [CASSETTE_ENV.state]: '/s',
    [CASSETTE_ENV.match]: 'strict', [CASSETTE_ENV.dirs]: '{"PROJECT":"/p"}',
  };

  it('buildSessionEnv drops credentials in replay and keeps the cassette vars', () => {
    const env = buildSessionEnv({ ...base, [CASSETTE_ENV.mode]: 'replay' }, '/home');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(env.COPILOT_HMAC_KEY).toBeUndefined();
    for (const name of Object.values(CASSETTE_ENV)) expect(env[name]).toBeDefined();
  });

  it('buildSessionEnv keeps credentials when recording', () => {
    const env = buildSessionEnv({ ...base, [CASSETTE_ENV.mode]: 'record' }, '/home');
    expect(env.COPILOT_GITHUB_TOKEN).toBe('tok');
    expect(env[CASSETTE_ENV.mode]).toBe('record');
  });

  it('the sdk host worker scrub keeps the cassette vars', () => {
    const env: NodeJS.ProcessEnv = { ...base, [CASSETTE_ENV.mode]: 'replay' };
    scrubWorkerCredentials(env, join(tempDir('omg-scrub-'), 'empty'), tempDir('omg-cwd-'));
    expect(env.GH_TOKEN).toBeUndefined();
    for (const name of Object.values(CASSETTE_ENV)) expect(env[name]).toBe(({ ...base, [CASSETTE_ENV.mode]: 'replay' } as Record<string, string>)[name]);
  });

  it('cassetteRuntimeEnv: replay sets the dummy HMAC key, record keeps credentials; both disable WebSocket', () => {
    expect(cassetteRuntimeEnv(base, 'replay')).toMatchObject({ COPILOT_HMAC_KEY: REPLAY_HMAC_KEY, COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES: '1' });
    expect(cassetteRuntimeEnv(base, 'record')).toMatchObject({ COPILOT_HMAC_KEY: 'hmac', GH_TOKEN: 'ghp_x', COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES: '1' });
  });
});

describe('redaction on record', () => {
  it('a token in a header or body never reaches disk', async () => {
    const stdinCredential = 'stdin-credential-value-42';
    addRecordingDenyLiterals([stdinCredential]);
    const ghToken = `ghp_${'a'.repeat(36)}`;
    const leaky = {
      id: 'c1',
      choices: [{ index: 0, message: { role: 'assistant', content: `token ${ghToken} auth ${BEARER} cred ${stdinCredential}` }, finish_reason: 'stop' }],
    };
    const state = tempDir('omg-rec-state-');
    const { Base } = fakeSdkBase([json(leaky, { 'set-cookie': 'session=abcdef123456', authorization: BEARER })]);
    const { loaded, clients } = fakeSdk(Base);
    const sdk = withCassette(loaded, cassetteEnv('record', tempDir('omg-out-'), state));
    const client = new sdk.module.CopilotClient({ connection: {}, baseDirectory: 'b', workingDirectory: 'w' });
    const leakyPrompt = { ...firstBody, messages: [{ role: 'user', content: `use ${ghToken} and ${stdinCredential}` }] };
    // The runtime still gets the real answer.
    expect((await drive(clients[0].handler, { session: 's', body: leakyPrompt })).text).toContain(ghToken);
    expect(await client.stop()).toEqual([]);
    const files = filesUnder(join(state, RECORD_PARTS_DIR));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const secret of [ghToken, 'abc123secretvalue', HMAC, stdinCredential, 'abcdef123456']) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/request-hmac|authorization|set-cookie/i);
    }
  });

  it('fails closed: a gate hit writes nothing', async () => {
    const late = 'late-handoff-literal-7781';
    const { Base } = fakeSdkBase([json({ ...secondAnswer, choices: [{ index: 0, message: { role: 'assistant', content: `x ${late}` } }] })]);
    const recorder = new CassetteRecorder({ stateDir: tempDir('omg-rec-state-'), dirs: {}, env: {} });
    await drive(createRecordingHandler(Base, recorder), { session: 's', body: firstBody });
    await recorder.cassette(); // every response redacted
    // A literal learned after redaction (as a late stdin handoff would be): only the gate sees it.
    addRecordingDenyLiterals([late]);
    const out = join(tempDir('omg-out-'), 'part');
    await expect(recorder.finish(out)).rejects.toMatchObject({ name: 'CassetteGateError' });
    expect(() => readdirSync(out)).toThrow();
  });

  it('a failed write is reported by client.stop()', async () => {
    const state = tempDir('omg-rec-state-');
    writeFileSync(join(state, RECORD_PARTS_DIR), 'not a dir');
    const { Base } = fakeSdkBase([json(firstAnswer)]);
    const { loaded, clients } = fakeSdk(Base);
    const sdk = withCassette(loaded, cassetteEnv('record', tempDir('omg-out-'), state));
    const client = new sdk.module.CopilotClient({ connection: {}, baseDirectory: 'b', workingDirectory: 'w' });
    await drive(clients[0].handler, { session: 's', body: firstBody });
    expect(await client.stop()).toHaveLength(1);
  });
});

describe('stream positions', () => {
  it('ordinals are allocated across processes the way the matcher allocates them', async () => {
    // Two recorders on one state dir stand for two sdk host processes.
    const state = tempDir('omg-rec-state-');
    const { Base } = fakeSdkBase([json(firstAnswer), json(secondAnswer), json(secondAnswer)]);
    const options = { stateDir: state, dirs: {}, env: {} };
    const [hostA, hostB] = [new CassetteRecorder(options), new CassetteRecorder(options)];
    await drive(createRecordingHandler(Base, hostA), { session: 'a', body: { ...firstBody, messages: [{ role: 'user', content: 'task alpha' }] } });
    await drive(createRecordingHandler(Base, hostB), { session: 'b', body: { ...firstBody, messages: [{ role: 'user', content: 'task beta' }] } });
    await drive(createRecordingHandler(Base, hostB), { session: 'b', agentId: 'sub', parentAgentId: 'main-b', body: { ...firstBody, messages: [{ role: 'user', content: 'sub task' }] } });
    const [a, b] = [await hostA.cassette(), await hostB.cassette()];
    expect(a.manifest.streams.map((s) => [s.id, s.session, s.agent])).toEqual([['s1-root', 1, 'root']]);
    expect(b.manifest.streams.map((s) => [s.id, s.session, s.agent])).toEqual([['s2-root', 2, 'root'], ['s2-root.1', 2, 'root/1']]);
    expect(readdirSync(join(state, 'sessions')).sort()).toEqual(['1', '2']);

    // Merged (as the smoke will), replayed by two processes with drifted prompts: bound by position, in the same order.
    const merged: Cassette = {
      manifest: { ...a.manifest, streams: [...a.manifest.streams, ...b.manifest.streams] },
      interactions: [...a.interactions, ...b.interactions],
    };
    const replayState = tempDir('omg-replay-state-');
    const [replayA, replayB] = [new CassetteReplayer(merged, replayState, 'tolerant', {}), new CassetteReplayer(merged, replayState, 'tolerant', {})];
    const servedA = await replayA.respond('POST', JSON.stringify({ ...firstBody, messages: [{ role: 'user', content: 'task alpha, reworded' }] }), ctx('x'));
    const servedB = await replayB.respond('POST', JSON.stringify({ ...firstBody, messages: [{ role: 'user', content: 'task beta, reworded' }] }), ctx('y'));
    expect(JSON.parse(await servedA.text()).id).toBe('c1');
    expect(JSON.parse(await servedB.text()).id).toBe('c2');
    expect(readFileSync(join(replayState, 'drift.jsonl'), 'utf8')).toContain('"kind":"fallback"');
  });

  function ctx(sessionId: string): CopilotRequestContextLike {
    return { sessionId, transport: 'http', url: `${API}/chat/completions`, headers: {} };
  }
});
