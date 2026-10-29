/**
 * Replay matcher: maps each model request the runtime routes through the
 * request handler to a recorded interaction (design
 * .omc/plans/2026-10-29-copilot-replay-design.md, sections 3 and 4).
 *
 * A live stream is one `(sessionId, agentId)` of the handler context. It is
 * bound to a recorded stream on its first request, by `promptDigest` or, in
 * tolerant mode only, by `(session ordinal, agent path)`. Binding claims the
 * recorded stream with an exclusive file under `<state>/claims/`, so matchers
 * in separate processes (team sdk hosts) never replay the same recording.
 * Interactions are then served strictly in order per stream. Requests with no
 * prompt (for example `GET /models`) are served from the `global` stream by
 * method + path.
 *
 * The matcher works on digests the caller already computed (normalization
 * and redaction live in the cassette library); it never sees a full request
 * body and never forwards anything.
 */

import { closeSync, mkdirSync, readFileSync, writeSync } from 'fs';
import { join } from 'path';
import { appendFileNoFollow, openAppendExclusive } from '../../lib/append-no-follow.js';

// Matcher-side view of the cassette (design section 3). Unified with the
// types in cassette.ts once both land.

export interface CassetteStream {
  id: string;
  promptDigest: string;
  /** 1-based order in which the stream's session first issued a request. */
  session: number;
  /** `root`, or `root/2` for the second subagent spawned under root. */
  agent: string;
  interactions: number;
  label?: string;
}

export interface CassetteRequest {
  method: string;
  path: string;
  transport: string;
  interactionType?: string;
  model?: string;
  headers?: Record<string, string>;
  deltaDigest?: string;
  toolNamesDigest?: string;
  /** Tool-call ids the previous recorded response issued; the request must carry a result for each. */
  expectsToolResults?: string[];
  delta?: string;
}

export interface CassetteResponse {
  status: number;
  headers?: Record<string, string>;
  kind: 'sse' | 'json' | 'ws';
  chunks?: string[];
  body?: unknown;
  messages?: Array<{ dir: 'in' | 'out'; data: string }>;
}

export interface CassetteInteraction {
  /** A stream id from the manifest, or `global`. */
  stream: string;
  seq: number;
  req: CassetteRequest;
  res: CassetteResponse;
  ms?: number;
}

export interface MatcherCassette {
  manifest: { streams: CassetteStream[] };
  interactions: CassetteInteraction[];
}

/** One request as the replay handler sees it, digests already computed. */
export interface LiveRequest {
  sessionId: string;
  agentId?: string;
  parentAgentId?: string;
  method: string;
  path: string;
  transport: string;
  model?: string;
  /** Digest of the normalized first user message; absent for non-conversation requests (served from `global`). */
  promptDigest?: string;
  deltaDigest?: string;
  toolNamesDigest?: string;
  /** Tool-call ids the request's delta carries results for. */
  toolResultIds?: string[];
  /** Normalized delta, for the drift excerpt. */
  delta?: string;
}

export type MatchMode = 'strict' | 'tolerant';

export type DriftKind = 'fallback' | 'delta' | 'model';

export interface DriftEntry {
  stream: string;
  seq: number;
  kind: DriftKind;
  detail: string;
}

export interface MissEntry {
  stream: string;
  seq: number;
  reason: string;
  method: string;
  path: string;
}

export type MatchResult =
  | { kind: 'hit'; stream: string; seq: number; interaction: CassetteInteraction; drift: DriftEntry[] }
  | { kind: 'miss'; stream: string; seq: number; reason: string; status: 599; body: string };

export const GLOBAL_STREAM = 'global';
export const MISS_STATUS = 599;
const EXCERPT_CHARS = 400;

const CLAIMS_DIR = 'claims';
const MISSES_FILE = 'misses.jsonl';
const DRIFT_FILE = 'drift.jsonl';
const SERVED_FILE = 'served.jsonl';

interface Bound {
  stream: CassetteStream;
  queue: CassetteInteraction[];
  cursor: number;
}

export interface ReplayMatcherOptions {
  cassette: MatcherCassette;
  /** `OMG_COPILOT_CASSETTE_STATE`: shared by every process of one replay run. */
  stateDir: string;
  mode: MatchMode;
}

export class ReplayMatcher {
  private readonly cassette: MatcherCassette;
  private readonly stateDir: string;
  private readonly mode: MatchMode;
  private readonly byStream = new Map<string, CassetteInteraction[]>();
  private readonly bound = new Map<string, Bound>();
  private readonly sessionOrdinals = new Map<string, number>();
  private readonly agentPaths = new Map<string, string>();
  private readonly childCounts = new Map<string, number>();
  private readonly globalCursors = new Map<string, number>();

  constructor(opts: ReplayMatcherOptions) {
    this.cassette = opts.cassette;
    this.stateDir = opts.stateDir;
    this.mode = opts.mode;
    for (const it of opts.cassette.interactions) {
      const list = this.byStream.get(it.stream) ?? [];
      list.push(it);
      this.byStream.set(it.stream, list);
    }
    for (const list of this.byStream.values()) list.sort((a, b) => a.seq - b.seq);
    mkdirSync(join(this.stateDir, CLAIMS_DIR), { recursive: true });
    // Created up front: on Windows two processes creating a log at the same
    // moment makes appendFileNoFollow refuse the loser's first line.
    for (const file of [MISSES_FILE, DRIFT_FILE, SERVED_FILE]) {
      try {
        closeSync(openAppendExclusive(join(this.stateDir, file)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  }

  match(req: LiveRequest): MatchResult {
    if (req.promptDigest === undefined) return this.matchGlobal(req);
    const key = liveKey(req.sessionId, req.agentId);
    const path = this.trackAgent(req);
    let bound = this.bound.get(key);
    const drift: DriftEntry[] = [];
    if (!bound) {
      const bind = this.bind(req, path);
      if ('reason' in bind) return this.miss(req, '-', 0, bind.reason);
      bound = bind.bound;
      this.bound.set(key, bound);
      if (bind.fallback) {
        drift.push({ stream: bound.stream.id, seq: 0, kind: 'fallback', detail: `promptDigest ${req.promptDigest} matched no free stream; bound by session ${bound.stream.session} agent ${path}` });
      }
    }
    const id = bound.stream.id;
    const it = bound.queue[bound.cursor];
    if (!it) return this.miss(req, id, bound.cursor, 'stream exhausted', drift);
    const r = it.req;
    if (r.method !== req.method || r.path !== req.path || r.transport !== req.transport) {
      return this.miss(req, id, it.seq, `expected ${r.method} ${r.path} (${r.transport}), got ${req.method} ${req.path} (${req.transport})`, drift);
    }
    const carried = new Set(req.toolResultIds ?? []);
    const missing = (r.expectsToolResults ?? []).filter((callId) => !carried.has(callId));
    if (missing.length > 0) return this.miss(req, id, it.seq, `no tool result for ${missing.join(', ')}`, drift);
    if (r.deltaDigest !== req.deltaDigest) {
      if (this.mode === 'strict') return this.miss(req, id, it.seq, 'deltaDigest differs', drift);
      drift.push({ stream: id, seq: it.seq, kind: 'delta', detail: diffExcerpt(r.delta ?? '', req.delta ?? '') });
    }
    if (this.mode === 'strict' && r.toolNamesDigest !== req.toolNamesDigest) {
      return this.miss(req, id, it.seq, 'toolNamesDigest differs', drift);
    }
    if (r.model !== req.model) {
      if (this.mode === 'strict') return this.miss(req, id, it.seq, `model ${req.model ?? '-'} differs from recorded ${r.model ?? '-'}`, drift);
      drift.push({ stream: id, seq: it.seq, kind: 'model', detail: `recorded ${r.model ?? '-'}, live ${req.model ?? '-'}` });
    }
    bound.cursor += 1;
    this.served(id, it.seq);
    this.logDrift(drift);
    return { kind: 'hit', stream: id, seq: it.seq, interaction: it, drift };
  }

  /** Non-conversation requests: in recorded order per method + path; the last answer repeats once they run out. */
  private matchGlobal(req: LiveRequest): MatchResult {
    const key = `${req.method} ${req.path}`;
    const list = (this.byStream.get(GLOBAL_STREAM) ?? []).filter((it) => it.req.method === req.method && it.req.path === req.path);
    if (list.length === 0) return this.miss(req, GLOBAL_STREAM, 0, `no global interaction for ${key}`);
    const cursor = this.globalCursors.get(key) ?? 0;
    const it = list[Math.min(cursor, list.length - 1)];
    this.globalCursors.set(key, cursor + 1);
    this.served(GLOBAL_STREAM, it.seq);
    return { kind: 'hit', stream: GLOBAL_STREAM, seq: it.seq, interaction: it, drift: [] };
  }

  private bind(req: LiveRequest, path: string): { bound: Bound; fallback: boolean } | { reason: string } {
    const streams = this.cassette.manifest.streams;
    const byPrompt = streams.filter((s) => s.promptDigest === req.promptDigest);
    for (const s of byPrompt) {
      if (this.claim(s, req)) return { bound: this.boundFor(s), fallback: false };
    }
    if (this.mode === 'strict') {
      return { reason: byPrompt.length > 0 ? `every stream with promptDigest ${req.promptDigest} is claimed` : `no stream with promptDigest ${req.promptDigest}` };
    }
    const ordinal = this.sessionOrdinals.get(req.sessionId);
    const byPosition = streams.filter((s) => s.session === ordinal && s.agent === path);
    for (const s of byPosition) {
      if (this.claim(s, req)) return { bound: this.boundFor(s), fallback: true };
    }
    return { reason: `no free stream for promptDigest ${req.promptDigest} or session ${ordinal} agent ${path}` };
  }

  private boundFor(stream: CassetteStream): Bound {
    return { stream, queue: this.byStream.get(stream.id) ?? [], cursor: 0 };
  }

  /** O_EXCL claim file; false when another matcher (any process) holds the stream. */
  private claim(stream: CassetteStream, req: LiveRequest): boolean {
    let fd: number;
    try {
      fd = openAppendExclusive(join(this.stateDir, CLAIMS_DIR, stream.id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    try {
      writeSync(fd, `${JSON.stringify({ pid: process.pid, sessionId: req.sessionId, agentId: req.agentId ?? null })}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  }

  /** Records the session ordinal and agent path of the request's live stream; returns the agent path. */
  private trackAgent(req: LiveRequest): string {
    if (!this.sessionOrdinals.has(req.sessionId)) this.sessionOrdinals.set(req.sessionId, this.sessionOrdinals.size + 1);
    const key = liveKey(req.sessionId, req.agentId);
    const known = this.agentPaths.get(key);
    if (known) return known;
    let path = 'root';
    if (req.parentAgentId !== undefined) {
      const parentKey = liveKey(req.sessionId, req.parentAgentId);
      const n = (this.childCounts.get(parentKey) ?? 0) + 1;
      this.childCounts.set(parentKey, n);
      path = `${this.agentPaths.get(parentKey) ?? 'root'}/${n}`;
    }
    this.agentPaths.set(key, path);
    return path;
  }

  private miss(req: LiveRequest, stream: string, seq: number, reason: string, drift: DriftEntry[] = []): MatchResult {
    const entry: MissEntry = { stream, seq, reason, method: req.method, path: req.path };
    this.append(MISSES_FILE, entry);
    this.logDrift(drift);
    return { kind: 'miss', stream, seq, reason, status: MISS_STATUS, body: `omg replay: cassette miss (${stream}/${seq}: ${reason})` };
  }

  private served(stream: string, seq: number): void {
    this.append(SERVED_FILE, { stream, seq });
  }

  private logDrift(drift: DriftEntry[]): void {
    for (const d of drift) this.append(DRIFT_FILE, d);
  }

  private append(file: string, value: unknown): void {
    if (!appendFileNoFollow(join(this.stateDir, file), `${JSON.stringify(value)}\n`)) {
      throw new Error(`replay state ${file}: not a regular file`);
    }
  }
}

export interface ReplayStateSummary {
  misses: MissEntry[];
  drift: DriftEntry[];
  /** Recorded streams no matcher claimed. */
  unclaimed: string[];
  /** Claimed streams with interactions left unserved. */
  unconsumed: string[];
}

/** Merges what every matcher of one replay run wrote to the state dir (for the `scn.<name>.replay` check). */
export function summarizeReplayState(stateDir: string, cassette: MatcherCassette): ReplayStateSummary {
  const served = readJsonl<{ stream: string; seq: number }>(join(stateDir, SERVED_FILE));
  const servedCount = new Map<string, Set<number>>();
  for (const s of served) {
    const set = servedCount.get(s.stream) ?? new Set<number>();
    set.add(s.seq);
    servedCount.set(s.stream, set);
  }
  const unclaimed: string[] = [];
  const unconsumed: string[] = [];
  for (const stream of cassette.manifest.streams) {
    let claimed = true;
    try {
      readFileSync(join(stateDir, CLAIMS_DIR, stream.id));
    } catch {
      claimed = false;
    }
    if (!claimed) {
      unclaimed.push(stream.id);
      continue;
    }
    const total = cassette.interactions.filter((it) => it.stream === stream.id).length;
    if ((servedCount.get(stream.id)?.size ?? 0) < total) unconsumed.push(stream.id);
  }
  return {
    misses: readJsonl<MissEntry>(join(stateDir, MISSES_FILE)),
    drift: readJsonl<DriftEntry>(join(stateDir, DRIFT_FILE)),
    unclaimed,
    unconsumed,
  };
}

/** Excerpt of both texts from shortly before their first difference, at most 400 chars of each side together. */
export function diffExcerpt(recorded: string, live: string): string {
  let i = 0;
  while (i < recorded.length && i < live.length && recorded[i] === live[i]) i += 1;
  const start = Math.max(0, i - 40);
  const half = EXCERPT_CHARS / 2;
  return `@${i} recorded: ${JSON.stringify(recorded.slice(start, start + half))} live: ${JSON.stringify(live.slice(start, start + half))}`;
}

function liveKey(sessionId: string, agentId: string | undefined): string {
  return `${sessionId}\u0000${agentId ?? ''}`;
}

function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as T);
}
