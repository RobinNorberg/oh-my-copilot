import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import {
  GLOBAL_STREAM,
  MISS_STATUS,
  ReplayMatcher,
  diffExcerpt,
  summarizeReplayState,
  type CassetteInteraction,
  type LiveRequest,
  type MatchMode,
  type MatcherCassette,
} from '../matcher.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omg-replay-matcher-'));
  dirs.push(dir);
  return dir;
}

const sse = (text: string) => ({ status: 200, kind: 'sse' as const, chunks: [`data: ${JSON.stringify({ text })}\n\n`, 'data: [DONE]\n\n'] });

function interaction(stream: string, seq: number, extra: Partial<CassetteInteraction['req']> = {}): CassetteInteraction {
  return {
    stream,
    seq,
    req: { method: 'POST', path: '/chat/completions', transport: 'http', model: 'gpt-5-mini', deltaDigest: `d${seq}`, toolNamesDigest: 'tools', ...extra },
    res: sse(`${stream}#${seq}`),
  };
}

/** Two root streams (one per session) plus one subagent stream, and a global `GET /models`. */
function cassette(): MatcherCassette {
  return {
    manifest: {
      streams: [
        { id: 's1', promptDigest: 'p-implement', session: 1, agent: 'root', interactions: 3 },
        { id: 's2', promptDigest: 'p-review', session: 2, agent: 'root', interactions: 1 },
        { id: 's3', promptDigest: 'p-sub', session: 1, agent: 'root/1', interactions: 1 },
      ],
    },
    interactions: [
      // Out of file order on purpose: serving follows seq.
      interaction('s1', 2, { expectsToolResults: ['call_a', 'call_b'], delta: 'tool results: a=1 b=2' }),
      interaction('s1', 1),
      interaction('s1', 3),
      interaction('s2', 1),
      interaction('s3', 1),
      { stream: GLOBAL_STREAM, seq: 1, req: { method: 'GET', path: '/models', transport: 'http' }, res: { status: 200, kind: 'json', body: { data: ['a'] } } },
      { stream: GLOBAL_STREAM, seq: 2, req: { method: 'GET', path: '/models', transport: 'http' }, res: { status: 200, kind: 'json', body: { data: ['b'] } } },
    ],
  };
}

function live(seq: number, extra: Partial<LiveRequest> = {}): LiveRequest {
  return {
    sessionId: 'sess-A',
    agentId: 'agent-root',
    method: 'POST',
    path: '/chat/completions',
    transport: 'http',
    model: 'gpt-5-mini',
    promptDigest: 'p-implement',
    deltaDigest: `d${seq}`,
    toolNamesDigest: 'tools',
    ...(seq === 2 ? { toolResultIds: ['call_a', 'call_b'] } : {}),
    ...extra,
  };
}

function matcher(mode: MatchMode = 'tolerant', dir = stateDir()): ReplayMatcher {
  return new ReplayMatcher({ cassette: cassette(), stateDir: dir, mode });
}

const jsonl = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

describe('ReplayMatcher: in-order serving', () => {
  it('serves a stream in seq order and misses once it is exhausted', () => {
    const dir = stateDir();
    const m = matcher('strict', dir);
    const seqs = [1, 2, 3].map((seq) => {
      const r = m.match(live(seq));
      expect(r.kind).toBe('hit');
      return r.kind === 'hit' ? `${r.stream}/${r.seq}:${(r.interaction.res.chunks ?? [])[0]}` : '';
    });
    expect(seqs).toEqual([1, 2, 3].map((seq) => `s1/${seq}:data: {"text":"s1#${seq}"}\n\n`));
    const extra = m.match(live(4));
    expect(extra).toMatchObject({ kind: 'miss', stream: 's1', status: MISS_STATUS, reason: 'stream exhausted' });
    expect(extra.kind === 'miss' && extra.body).toBe('omg replay: cassette miss (s1/3: stream exhausted)');
    expect(summarizeReplayState(dir, cassette())).toMatchObject({ unclaimed: ['s2', 's3'], unconsumed: [] });
  });

  it('keeps one cursor per live stream: interleaved sessions do not disturb each other', () => {
    const dir = stateDir();
    const m = matcher('strict', dir);
    expect(m.match(live(1))).toMatchObject({ kind: 'hit', stream: 's1', seq: 1 });
    expect(m.match(live(1, { sessionId: 'sess-B', promptDigest: 'p-review' }))).toMatchObject({ kind: 'hit', stream: 's2', seq: 1 });
    expect(m.match(live(1, { agentId: 'agent-sub', parentAgentId: 'agent-root', promptDigest: 'p-sub' }))).toMatchObject({ kind: 'hit', stream: 's3', seq: 1 });
    expect(m.match(live(2))).toMatchObject({ kind: 'hit', stream: 's1', seq: 2 });
    const summary = summarizeReplayState(dir, cassette());
    expect(summary).toMatchObject({ unclaimed: [], unconsumed: ['s1'], misses: [], drift: [] });
  });

  it('does not advance the cursor on a miss', () => {
    const m = matcher('tolerant');
    m.match(live(1));
    expect(m.match(live(2, { path: '/responses' })).kind).toBe('miss');
    expect(m.match(live(2))).toMatchObject({ kind: 'hit', seq: 2 });
  });
});

describe('ReplayMatcher: strict vs tolerant (design section 4)', () => {
  const cases: Array<{ name: string; req: Partial<LiveRequest>; strict: string | null; tolerant: string | null; drift?: string }> = [
    { name: 'method differs', req: { method: 'PUT' }, strict: 'expected POST', tolerant: 'expected POST' },
    { name: 'path differs', req: { path: '/responses' }, strict: 'expected POST /chat/completions', tolerant: 'expected POST /chat/completions' },
    { name: 'transport differs', req: { transport: 'ws' }, strict: '(http), got', tolerant: '(http), got' },
    { name: 'deltaDigest differs', req: { deltaDigest: 'other', delta: 'changed' }, strict: 'deltaDigest differs', tolerant: null, drift: 'delta' },
    { name: 'toolNamesDigest differs', req: { toolNamesDigest: 'more-tools' }, strict: 'toolNamesDigest differs', tolerant: null },
    { name: 'model differs', req: { model: 'gpt-5' }, strict: 'model gpt-5 differs', tolerant: null, drift: 'model' },
  ];
  for (const c of cases) {
    for (const mode of ['strict', 'tolerant'] as const) {
      const expected = c[mode];
      it(`${c.name}: ${mode} ${expected === null ? 'serves' : 'misses'}`, () => {
        const m = matcher(mode);
        const r = m.match(live(1, c.req));
        if (expected === null) {
          expect(r.kind).toBe('hit');
          const kinds = r.kind === 'hit' ? r.drift.map((d) => d.kind) : [];
          expect(kinds).toEqual(c.drift ? [c.drift] : []);
        } else {
          expect(r.kind).toBe('miss');
          expect(r.kind === 'miss' && r.reason).toContain(expected);
        }
      });
    }
  }

  it('tolerant: an unknown prompt binds by session ordinal and agent path, logged as drift', () => {
    const dir = stateDir();
    const m = matcher('tolerant', dir);
    // Second session's root, prompt changed since the recording.
    expect(m.match(live(1, { promptDigest: 'p-implement' }))).toMatchObject({ kind: 'hit', stream: 's1' });
    const r = m.match(live(1, { sessionId: 'sess-B', promptDigest: 'p-review-v2' }));
    expect(r).toMatchObject({ kind: 'hit', stream: 's2', seq: 1 });
    expect(r.kind === 'hit' && r.drift.map((d) => d.kind)).toEqual(['fallback']);
    // A subagent of session 1 falls back to root/1.
    expect(m.match(live(1, { agentId: 'agent-sub', parentAgentId: 'agent-root', promptDigest: 'p-sub-v2' }))).toMatchObject({ kind: 'hit', stream: 's3' });
    expect(jsonl(join(dir, 'drift.jsonl')).map((d) => `${d.stream}:${d.kind}`)).toEqual(['s2:fallback', 's3:fallback']);
  });

  it('strict: an unknown prompt is a miss, no fallback', () => {
    const r = matcher('strict').match(live(1, { promptDigest: 'p-implement-v2' }));
    expect(r).toMatchObject({ kind: 'miss', stream: '-', reason: 'no stream with promptDigest p-implement-v2' });
  });

  it('tolerant drift carries a bounded diff excerpt', () => {
    const m = matcher('tolerant');
    m.match(live(1));
    const r = m.match(live(2, { deltaDigest: 'x', delta: 'tool results: a=1 b=3' }));
    expect(r.kind === 'hit' && r.drift[0].detail).toBe('@20 recorded: "tool results: a=1 b=2" live: "tool results: a=1 b=3"');
    const long = diffExcerpt('x'.repeat(5000), `${'x'.repeat(2500)}y${'x'.repeat(2500)}`);
    expect(long.length).toBeLessThan(450);
    expect(long.startsWith('@2500 ')).toBe(true);
  });
});

describe('ReplayMatcher: expectsToolResults', () => {
  for (const mode of ['strict', 'tolerant'] as const) {
    it(`${mode}: a request without a result for every recorded tool call misses`, () => {
      const dir = stateDir();
      const m = matcher(mode, dir);
      m.match(live(1));
      // The permission for call_b was denied on our side: only call_a has a result.
      const r = m.match(live(2, { toolResultIds: ['call_a'] }));
      expect(r).toMatchObject({ kind: 'miss', stream: 's1', seq: 2, reason: 'no tool result for call_b' });
      expect(m.match(live(2, { toolResultIds: ['call_b', 'call_a', 'call_extra'] }))).toMatchObject({ kind: 'hit', seq: 2 });
    });
  }
});

describe('ReplayMatcher: global stream', () => {
  it('serves non-conversation requests by method + path, repeating the last answer', () => {
    const dir = stateDir();
    const m = matcher('strict', dir);
    const models = (r: ReturnType<ReplayMatcher['match']>) => (r.kind === 'hit' ? r.interaction.res.body : r.reason);
    const req = { sessionId: 'sess-A', method: 'GET', path: '/models', transport: 'http' };
    expect([1, 2, 3].map(() => models(m.match(req)))).toEqual([{ data: ['a'] }, { data: ['b'] }, { data: ['b'] }]);
    // A global request neither binds nor claims a stream.
    expect(readdirSync(join(dir, 'claims'))).toEqual([]);
    expect(m.match({ ...req, path: '/user' })).toMatchObject({ kind: 'miss', stream: GLOBAL_STREAM, reason: 'no global interaction for GET /user' });
  });
});

describe('ReplayMatcher: stream claims', () => {
  it('two matchers on one state dir never bind the same recorded stream', () => {
    const dir = stateDir();
    const doubled: MatcherCassette = {
      manifest: { streams: [
        { id: 'w1', promptDigest: 'p-worker', session: 1, agent: 'root', interactions: 1 },
        { id: 'w2', promptDigest: 'p-worker', session: 1, agent: 'root', interactions: 1 },
      ] },
      interactions: [interaction('w1', 1), interaction('w2', 1)],
    };
    const a = new ReplayMatcher({ cassette: doubled, stateDir: dir, mode: 'strict' });
    const b = new ReplayMatcher({ cassette: doubled, stateDir: dir, mode: 'strict' });
    const c = new ReplayMatcher({ cassette: doubled, stateDir: dir, mode: 'strict' });
    const req = live(1, { promptDigest: 'p-worker' });
    expect(a.match(req)).toMatchObject({ kind: 'hit', stream: 'w1' });
    expect(b.match(req)).toMatchObject({ kind: 'hit', stream: 'w2' });
    expect(c.match(req)).toMatchObject({ kind: 'miss', reason: 'every stream with promptDigest p-worker is claimed' });
    expect(readdirSync(join(dir, 'claims')).sort()).toEqual(['w1', 'w2']);
    expect(summarizeReplayState(dir, doubled)).toMatchObject({ unclaimed: [], unconsumed: [] });
  });

  it('separate processes racing for one prompt each claim a different stream', async () => {
    const dir = stateDir();
    const streams = Array.from({ length: 4 }, (_, i) => ({ id: `w${i + 1}`, promptDigest: 'p-worker', session: 1, agent: 'root', interactions: 1 }));
    const raced: MatcherCassette = { manifest: { streams }, interactions: streams.map((s) => interaction(s.id, 1)) };
    const cassetteFile = join(dir, 'cassette.json');
    writeFileSync(cassetteFile, JSON.stringify(raced));
    const script = join(dir, 'race.mts');
    const matcherUrl = pathToFileURL(join(__dirname, '..', 'matcher.ts')).href;
    writeFileSync(script, [
      `import { readFileSync } from 'fs';`,
      `import { ReplayMatcher } from ${JSON.stringify(matcherUrl)};`,
      `const [cassetteFile, state, release] = process.argv.slice(2);`,
      `const cassette = JSON.parse(readFileSync(cassetteFile, 'utf8'));`,
      `const m = new ReplayMatcher({ cassette, stateDir: state, mode: 'strict' });`,
      // Start together: every process waits for the release time before matching.
      `while (Date.now() < Number(release)) {}`,
      `const r = m.match({ sessionId: 'sess-' + process.pid, method: 'POST', path: '/chat/completions', transport: 'http', model: 'gpt-5-mini', promptDigest: 'p-worker', deltaDigest: 'd1', toolNamesDigest: 'tools' });`,
      `process.stdout.write(r.kind === 'hit' ? r.stream : 'miss');`,
    ].join('\n'));
    const release = String(Date.now() + 4000);
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script, cassetteFile, dir, release], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`race child exited ${code}: ${err}`))));
    });
    const results = await Promise.all(Array.from({ length: 6 }, run));
    const hits = results.filter((r) => r !== 'miss');
    expect(hits.sort()).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(results.filter((r) => r === 'miss')).toHaveLength(2);
    const claimants = readdirSync(join(dir, 'claims')).map((id) => JSON.parse(readFileSync(join(dir, 'claims', id), 'utf8')).pid);
    expect(new Set(claimants).size).toBe(4);
  }, 60_000);
});

describe('ReplayMatcher: miss log', () => {
  it('appends every miss to <state>/misses.jsonl and summarizes it with served progress', () => {
    const dir = stateDir();
    const m = matcher('strict', dir);
    expect(readFileSync(join(dir, 'misses.jsonl'), 'utf8')).toBe('');
    m.match(live(1, { promptDigest: 'p-unknown' }));
    m.match(live(1));
    m.match(live(2, { toolResultIds: [] }));
    expect(jsonl(join(dir, 'misses.jsonl'))).toEqual([
      { stream: '-', seq: 0, reason: 'no stream with promptDigest p-unknown', method: 'POST', path: '/chat/completions' },
      { stream: 's1', seq: 2, reason: 'no tool result for call_a, call_b', method: 'POST', path: '/chat/completions' },
    ]);
    // The first request's live stream never bound; the second (same key) did, after the miss.
    const summary = summarizeReplayState(dir, cassette());
    expect(summary.misses).toHaveLength(2);
    expect(summary).toMatchObject({ unclaimed: ['s2', 's3'], unconsumed: ['s1'] });
  });

  it('refuses to append through a non-file at the log path', () => {
    const dir = stateDir();
    // A directory planted at the miss log path.
    mkdirSync(join(dir, 'misses.jsonl'));
    const m = matcher('strict', dir);
    expect(() => m.match(live(1, { promptDigest: 'p-unknown' }))).toThrow();
  });
});
