#!/usr/bin/env node
/**
 * Spike (PR 0 of .omc/plans/2026-10-29-copilot-replay-design.md, not shipped):
 * what does the SDK's experimental `requestHandler` see?
 *
 * Starts the real copilot runtime with a CopilotRequestHandler that FABRICATES
 * every model-layer response and never forwards one upstream, creates a
 * session, sends one prompt, and logs every intercepted request plus the
 * session events (notably `assistant.usage`).
 *
 * Zero credits by construction:
 * - the handler overrides both hooks (`sendRequest`, `openWebSocket`) and
 *   never calls `super`, so the SDK's forwarding defaults never run;
 * - `globalThis.fetch` and `globalThis.WebSocket` are replaced with tripwires
 *   that kill the process, so nothing in this process can reach the network;
 * - a request the probe cannot fabricate (unknown URL) kills the process
 *   (fail closed) instead of being answered or forwarded.
 *
 * Usage:
 *   node scripts/spikes/request-handler-probe.mjs [--auth none|login] [--model <id>]
 *     [--cli <copilot.exe>] [--out <dir>] [--usage-field <name>] [--set NAME=VALUE]... [--streaming]
 *
 * --auth none (default): every GitHub credential is stripped from the runtime
 *   env, COPILOT_HOME and GH_CONFIG_DIR point at empty temp dirs, and
 *   useLoggedInUser is false. --auth login keeps the machine's normal login.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const auth = opt('auth', 'none');
const model = opt('model', 'gpt-5-mini');
const out = opt('out', mkdtempSync(join(tmpdir(), 'rh-probe-')));
const usageField = opt('usage-field', 'copilot_usage');
const FAKE_NANO_AIU = 4_242_000_000; // distinctive: 4.242 credits if it surfaces in assistant.usage
mkdirSync(out, { recursive: true });
const logFile = join(out, 'probe.jsonl');
const log = (kind, data) => {
  appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), kind, ...data }) + '\n');
  console.log(`[${kind}]`, JSON.stringify(data).slice(0, 600));
};
const die = (why) => { log('abort', { why }); process.exit(3); };

// Tripwires: nothing in this process may open a network connection.
globalThis.fetch = () => die('fetch() called in the probe process');
globalThis.WebSocket = class { constructor(url) { die(`WebSocket(${url}) opened in the probe process`); } };

const sdkDir = opt('sdk', join(spawnSync('npm root -g', { encoding: 'utf8', shell: true }).stdout.trim(), '@github', 'copilot-sdk'));
const sdk = await import(pathToFileURL(join(sdkDir, 'dist', 'index.js')).href);
const { CopilotClient, RuntimeConnection, CopilotRequestHandler, CopilotWebSocketHandler, CopilotWebSocketCloseStatus } = sdk;

// --- Fabricated answers, one per wire format ---------------------------------
const TEXT = 'probe ok';
const usageBlock = { [usageField]: { total_nano_aiu: FAKE_NANO_AIU, model } };
const sse = (events) => events.map((e) => (e.event ? `event: ${e.event}\n` : '') + `data: ${JSON.stringify(e.data ?? e)}\n\n`).join('');
const chatSse = () => sse([
  { id: 'probe-1', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { role: 'assistant', content: TEXT }, finish_reason: null }] },
  { id: 'probe-1', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, ...usageBlock },
]) + 'data: [DONE]\n\n';
const responsesEvents = () => {
  const item = { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: TEXT, annotations: [] }] };
  const response = { id: 'resp_probe', object: 'response', status: 'completed', model, output: [item],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, ...usageBlock };
  return [
    { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', sequence_number: 2, output_index: 0, content_index: 0, item_id: item.id, delta: TEXT },
    { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item },
    { type: 'response.completed', sequence_number: 4, response },
  ];
};
const anthropicSse = () => sse([
  { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_probe', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 }, ...usageBlock } },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

function fabricate(url, body) {
  const path = new URL(url).pathname;
  const stream = body?.stream === true; // the runtime omits `stream` for a buffered call
  const headers = { 'content-type': stream ? 'text/event-stream' : 'application/json', 'x-request-id': 'probe' };
  if (path.endsWith('/chat/completions')) {
    if (stream) return new Response(chatSse(), { status: 200, headers });
    return new Response(JSON.stringify({ id: 'probe-1', object: 'chat.completion', created: 0, model,
      choices: [{ index: 0, message: { role: 'assistant', content: TEXT }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, ...usageBlock }), { status: 200, headers });
  }
  if (path.endsWith('/responses')) return new Response(stream ? sse(responsesEvents().map((e) => ({ event: e.type, data: e }))) : JSON.stringify(responsesEvents().at(-1).response), { status: 200, headers });
  if (path.endsWith('/messages')) return new Response(anthropicSse(), { status: 200, headers });
  return null;
}

class FabricatingHandler extends CopilotRequestHandler {
  async sendRequest(request, ctx) {
    const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    let body; try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    log('http', {
      url: ctx.url, method: request.method, transport: ctx.transport, interactionType: ctx.interactionType,
      sessionId: ctx.sessionId, agentId: ctx.agentId, headerNames: Object.keys(ctx.headers ?? {}).sort(),
      bodyModel: body?.model, stream: body?.stream, bodyKeys: body ? Object.keys(body).sort() : undefined, bodyBytes: text.length,
    });
    return fabricate(ctx.url, body) ?? die(`no fabrication for ${request.method} ${ctx.url}`);
  }

  async openWebSocket(ctx) {
    log('ws.open', { url: ctx.url, transport: ctx.transport, interactionType: ctx.interactionType, sessionId: ctx.sessionId, headerNames: Object.keys(ctx.headers ?? {}).sort() });
    return new FabricatingSocket(ctx);
  }
}

// No upstream: the base class only relays what we send back to the runtime.
class FabricatingSocket extends CopilotWebSocketHandler {
  constructor(ctx) { super(ctx); }
  async sendRequestMessage(data) {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    let msg; try { msg = JSON.parse(text); } catch { msg = undefined; }
    log('ws.message', { type: msg?.type, model: msg?.model ?? msg?.response?.model, keys: msg ? Object.keys(msg).sort() : undefined, bytes: text.length });
    if (msg?.type !== 'response.create') die(`no WS fabrication for message type ${msg?.type}`);
    for (const e of responsesEvents()) await this.sendResponseMessage(JSON.stringify(e));
  }
  async close(status = CopilotWebSocketCloseStatus.normalClosure) { log('ws.close', { description: status.description }); await super.close(status); }
}

// --- Runtime env --------------------------------------------------------------
const env = { ...process.env, COPILOT_AUTO_UPDATE: 'false', NO_COLOR: '1' };
for (const k of ['COPILOT_PROVIDER_BASE_URL', 'COPILOT_MODEL', 'NODE_OPTIONS']) delete env[k];
if (auth === 'none') {
  for (const k of Object.keys(env)) {
    if (/^(GH|GITHUB|COPILOT)_.*TOKEN$|^GH_ENTERPRISE|^GITHUB_ENTERPRISE|^COPILOT_PROVIDER_|^COPILOT_HOME$/i.test(k)) delete env[k];
  }
  env.COPILOT_HOME = mkdtempSync(join(tmpdir(), 'rh-probe-home-'));
  env.GH_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'rh-probe-gh-'));
}
// --set NAME=VALUE (repeatable): dummy credentials, e.g. COPILOT_HMAC_KEY=fake.
args.forEach((a, i) => { if (a === '--set') { const [k, ...v] = args[i + 1].split('='); env[k] = v.join('='); } });
const cli = opt('cli', spawnSync('where copilot', { encoding: 'utf8', shell: true }).stdout.split(/\r?\n/).find((l) => /\.exe$/i.test(l.trim()))?.trim());
const workDir = mkdtempSync(join(tmpdir(), 'rh-probe-work-'));
log('start', { auth, model, cli, sdk: sdkDir, out, workDir, credentialEnv: Object.keys(env).filter((k) => /TOKEN|HMAC|KEY$/i.test(k)) });

const client = new CopilotClient({
  connection: RuntimeConnection.forStdio({ path: cli, args: ['--log-level', 'debug'], env }),
  baseDirectory: join(out, 'base'),
  workingDirectory: workDir,
  requestHandler: new FabricatingHandler(),
  ...(auth === 'none' ? { useLoggedInUser: false } : {}),
});

const step = async (name, fn) => {
  try { const v = await fn(); log(`ok.${name}`, { value: v }); return v; }
  catch (err) { log(`fail.${name}`, { error: String(err?.message ?? err).slice(0, 500) }); return undefined; }
};
const timer = setTimeout(() => die('probe timed out after 180 s'), 180_000);
try {
  if (await step('start', () => client.start().then(() => true))) {
    await step('getStatus', () => client.getStatus());
    await step('getAuthStatus', () => client.getAuthStatus?.());
    await step('listModels', async () => (await client.listModels()).map((m) => m.id));
    const session = await step('createSession', () => client.createSession({
      model,
      ...(args.includes('--streaming') ? { streaming: true } : {}),
      workingDirectory: workDir,
      onPermissionRequest: () => ({ kind: 'denied-by-rules', rules: [] }),
    }));
    if (session) {
      log('session', { sessionId: session.sessionId });
      session.on((e) => {
        if (/delta$/.test(e.type)) return;
        log(`event.${e.type}`, e.type === 'assistant.usage' || /error|message$|shutdown/.test(e.type) ? { data: e.data } : {});
      });
      await step('sendAndWait', async () => (await session.sendAndWait({ prompt: 'Reply with the two words: probe ok' }, 90_000))?.data?.content);
      await step('disconnect', () => session.disconnect().then(() => true));
    }
  }
} finally {
  clearTimeout(timer);
  await step('stop', () => client.stop().then(() => true));
  log('done', { logFile, runtimeLogs: join(out, 'base', 'logs') });
}
