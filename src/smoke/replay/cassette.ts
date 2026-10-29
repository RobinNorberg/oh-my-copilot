/**
 * Copilot replay cassettes, format version 1 (design:
 * .omc/plans/2026-10-29-copilot-replay-design.md, sections 3 and 5).
 *
 * One cassette is one directory:
 *
 *   manifest.json        {@link CassetteManifest}
 *   interactions.jsonl   one {@link CassetteInteraction} per model request
 *   events/<stream>.jsonl  the scenario's SDK events, redacted (optional)
 *   report.json          the record run's smoke report, redacted (optional)
 *
 * Shared types for the matcher (matcher.ts) and the handlers live here.
 *
 * Writing is fail closed: {@link writeCassette} runs the redaction gate over
 * every serialized file first and writes nothing if anything secret-looking
 * survived. {@link verifyCassetteDir} is the same gate over a directory on
 * disk; a failing verify leaves a {@link REDACTION_FAILED_MARKER} that
 * {@link readCassette} (and so the importer) refuses.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { atomicWriteFileSync } from '../../lib/atomic-write.js';
import {
  isAllowedResponseHeader,
  REQUEST_HEADER_ALLOW,
  scanForSecrets,
  type RedactionIdentity,
  type SecretHit,
} from './redact.js';

export const CASSETTE_FORMAT = 'omg-copilot-cassette';
export const CASSETTE_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';
export const INTERACTIONS_FILE = 'interactions.jsonl';
export const EVENTS_DIR = 'events';
export const REPORT_FILE = 'report.json';
/** Written by a failing gate; a cassette dir that holds it is never read or imported. */
export const REDACTION_FAILED_MARKER = 'REDACTION-FAILED';
/** The `--record-full` sidecar (local debugging only); the gate rejects a cassette that contains it. */
export const RECORD_FULL_SIDECAR = 'full-requests';
/** Stream id of requests outside any agent thread (e.g. `GET /models`), keyed by method + path only. */
export const GLOBAL_STREAM = 'global';

export type CassetteTransport = 'http' | 'ws';

export interface CassetteStream {
  id: string;
  /** Digest of the normalized first user message of the stream's first request. */
  promptDigest: string;
  /** Order in which the stream's session first issued a request in the scenario (1-based). */
  session: number;
  /** `root`, or `root/2` for the second subagent spawned under root. */
  agent: string;
  /** Number of interactions recorded for this stream. */
  interactions: number;
  label?: string;
}

export interface CassetteManifest {
  format: typeof CASSETTE_FORMAT;
  version: typeof CASSETTE_VERSION;
  scenario: string;
  recordedAt: string;
  omg: { version: string; gitSha?: string; dirty?: boolean };
  sdk: { version: string };
  runtime?: { version?: string; protocolVersion?: number };
  platform: string;
  arch: string;
  node?: string;
  model?: string;
  maxCredits?: number;
  cost?: { credits?: number; premiumRequests?: number };
  redaction: { rules: number; hits: Record<string, number> };
  streams: CassetteStream[];
  selfVerify?: { ok: boolean; misses: number; drift: number };
}

export interface CassetteRequest {
  method: string;
  path: string;
  transport: CassetteTransport;
  interactionType?: string;
  model?: string;
  /** Allowlisted headers only (redact.ts rule 1). */
  headers: Record<string, string>;
  /** Digest of the normalized new messages since the stream's previous request. */
  deltaDigest: string;
  toolNamesDigest?: string;
  /** Tool-call ids of the previous recorded response that this request must answer. */
  expectsToolResults?: string[];
  /** Redacted, normalized delta, cut at DELTA_MAX_BYTES (drift reports only). */
  delta?: string;
}

export interface CassetteWsMessage {
  dir: 'in' | 'out';
  data: string;
}

interface CassetteResponseBase {
  status: number;
  /** Allowlisted headers only (redact.ts rule 2). */
  headers: Record<string, string>;
}
export type CassetteResponse =
  | CassetteResponseBase & { kind: 'sse'; chunks: string[] }
  | CassetteResponseBase & { kind: 'json'; body: unknown }
  | CassetteResponseBase & { kind: 'text'; body: string }
  | CassetteResponseBase & { kind: 'ws'; messages: CassetteWsMessage[] };
export type CassetteResponseKind = CassetteResponse['kind'];

export interface CassetteInteraction {
  /** A {@link CassetteStream.id}, or {@link GLOBAL_STREAM}. */
  stream: string;
  /** Position in the stream; strictly increasing within a stream. */
  seq: number;
  req: CassetteRequest;
  res: CassetteResponse;
  /** Informational; replay does not sleep. */
  ms?: number;
}

export interface Cassette {
  manifest: CassetteManifest;
  interactions: CassetteInteraction[];
  /** SDK events per stream id. */
  events?: Record<string, unknown[]>;
  report?: unknown;
}

export class CassetteFormatError extends Error {
  override name = 'CassetteFormatError';
}

export interface GateHit extends SecretHit {
  /** Path relative to the cassette dir, `/`-separated. */
  file: string;
  /** 1-based line of the hit (0 for a file-level problem). */
  line: number;
}

export class CassetteGateError extends Error {
  override name = 'CassetteGateError';
  constructor(readonly hits: GateHit[]) {
    super(`cassette redaction gate failed: ${hits.length} hit(s)\n${formatGateHits(hits)}`);
  }
}

export function formatGateHits(hits: readonly GateHit[]): string {
  return hits.map((h) => `${h.file}:${h.line}: ${h.rule} ${h.masked}`).join('\n');
}

const RESPONSE_KINDS: readonly CassetteResponseKind[] = ['sse', 'json', 'text', 'ws'];
const SAFE_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringMap = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every((x) => typeof x === 'string');
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function fail(where: string, message: string): never {
  throw new CassetteFormatError(`${where}: ${message}`);
}

/**
 * Validate a parsed manifest. Refuses any other `format` and any `version`
 * this build does not know (a newer one first, with the hint to upgrade).
 */
export function parseManifest(value: unknown, where = MANIFEST_FILE): CassetteManifest {
  if (!isRecord(value)) fail(where, 'not a JSON object');
  if (value.format !== CASSETTE_FORMAT) fail(where, `not an omg cassette (format ${JSON.stringify(value.format)})`);
  if (typeof value.version === 'number' && Number.isInteger(value.version) && value.version > CASSETTE_VERSION) {
    fail(where, `cassette v${value.version} needs a newer omg (this build reads v${CASSETTE_VERSION})`);
  }
  if (value.version !== CASSETTE_VERSION) fail(where, `unsupported cassette version ${JSON.stringify(value.version)}`);
  for (const key of ['scenario', 'recordedAt', 'platform', 'arch'] as const) {
    if (typeof value[key] !== 'string' || !value[key]) fail(where, `${key} must be a non-empty string`);
  }
  if (!isRecord(value.omg) || typeof value.omg.version !== 'string') fail(where, 'omg.version must be a string');
  if (!isRecord(value.sdk) || typeof value.sdk.version !== 'string') fail(where, 'sdk.version must be a string');
  if (!isRecord(value.redaction) || !isCount(value.redaction.rules) || !isRecord(value.redaction.hits)
    || !Object.values(value.redaction.hits).every(isCount)) fail(where, 'redaction must be { rules, hits }');
  if (!Array.isArray(value.streams)) fail(where, 'streams must be an array');
  const ids = new Set<string>();
  value.streams.forEach((s: unknown, i: number) => {
    const at = `streams[${i}]`;
    if (!isRecord(s)) fail(where, `${at} is not an object`);
    if (typeof s.id !== 'string' || !SAFE_ID.test(s.id) || s.id === GLOBAL_STREAM) fail(where, `${at}.id must be a safe file name other than "${GLOBAL_STREAM}"`);
    if (ids.has(s.id)) fail(where, `duplicate stream id ${s.id}`);
    ids.add(s.id);
    if (typeof s.promptDigest !== 'string') fail(where, `${at}.promptDigest must be a string`);
    if (!isCount(s.session) || typeof s.agent !== 'string' || !isCount(s.interactions)) fail(where, `${at} needs session, agent, interactions`);
  });
  return value as unknown as CassetteManifest;
}

/** Validate one parsed interaction. */
export function parseInteraction(value: unknown, where: string): CassetteInteraction {
  if (!isRecord(value)) fail(where, 'not a JSON object');
  if (typeof value.stream !== 'string' || !value.stream) fail(where, 'stream must be a non-empty string');
  if (!isCount(value.seq)) fail(where, 'seq must be a non-negative integer');
  const req = value.req;
  if (!isRecord(req)) fail(where, 'req must be an object');
  if (typeof req.method !== 'string' || typeof req.path !== 'string') fail(where, 'req.method and req.path must be strings');
  if (req.transport !== 'http' && req.transport !== 'ws') fail(where, `req.transport must be http or ws`);
  if (!isStringMap(req.headers)) fail(where, 'req.headers must map strings to strings');
  if (typeof req.deltaDigest !== 'string') fail(where, 'req.deltaDigest must be a string');
  if (req.expectsToolResults !== undefined && !(Array.isArray(req.expectsToolResults) && req.expectsToolResults.every((x) => typeof x === 'string'))) {
    fail(where, 'req.expectsToolResults must be a string array');
  }
  for (const key of ['interactionType', 'model', 'toolNamesDigest', 'delta'] as const) {
    if (req[key] !== undefined && typeof req[key] !== 'string') fail(where, `req.${key} must be a string`);
  }
  const res = value.res;
  if (!isRecord(res)) fail(where, 'res must be an object');
  if (!isCount(res.status) || res.status > 999) fail(where, 'res.status must be an HTTP status');
  if (!isStringMap(res.headers)) fail(where, 'res.headers must map strings to strings');
  if (!RESPONSE_KINDS.includes(res.kind as CassetteResponseKind)) fail(where, `unknown res.kind ${JSON.stringify(res.kind)}`);
  if (res.kind === 'sse' && !(Array.isArray(res.chunks) && res.chunks.every((c) => typeof c === 'string'))) fail(where, 'res.chunks must be a string array');
  if (res.kind === 'json' && !('body' in res)) fail(where, 'res.body is missing');
  if (res.kind === 'text' && typeof res.body !== 'string') fail(where, 'res.body must be a string');
  if (res.kind === 'ws' && !(Array.isArray(res.messages)
    && res.messages.every((m) => isRecord(m) && (m.dir === 'in' || m.dir === 'out') && typeof m.data === 'string'))) {
    fail(where, 'res.messages must be [{ dir: in|out, data }]');
  }
  if (value.ms !== undefined && typeof value.ms !== 'number') fail(where, 'ms must be a number');
  return value as unknown as CassetteInteraction;
}

/**
 * Cross-checks between the manifest and the interactions: every interaction
 * names a declared stream (or the global one), seqs increase within a stream,
 * and each stream holds exactly the count the manifest declares.
 */
function checkConsistency(manifest: CassetteManifest, interactions: readonly CassetteInteraction[]): void {
  const declared = new Map(manifest.streams.map((s) => [s.id, s]));
  const counts = new Map<string, number>();
  const lastSeq = new Map<string, number>();
  interactions.forEach((it, i) => {
    const where = `${INTERACTIONS_FILE}:${i + 1}`;
    if (it.stream !== GLOBAL_STREAM && !declared.has(it.stream)) fail(where, `stream ${it.stream} is not in the manifest`);
    const prev = lastSeq.get(it.stream);
    if (prev !== undefined && it.seq <= prev) fail(where, `seq ${it.seq} does not follow ${prev} in stream ${it.stream}`);
    lastSeq.set(it.stream, it.seq);
    counts.set(it.stream, (counts.get(it.stream) ?? 0) + 1);
  });
  for (const s of manifest.streams) {
    const n = counts.get(s.id) ?? 0;
    if (n !== s.interactions) fail(MANIFEST_FILE, `stream ${s.id} declares ${s.interactions} interaction(s), found ${n}`);
  }
}

function parseJsonl(text: string, file: string): unknown[] {
  const out: unknown[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      fail(`${file}:${i + 1}`, `invalid JSON (${(err as Error).message})`);
    }
  });
  return out;
}

function readJsonFile(path: string, where: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    fail(where, `invalid JSON (${(err as Error).message})`);
  }
}

/** Read and validate a cassette directory. Refuses a gate-failed cassette and unknown formats or versions. */
export function readCassette(dir: string): Cassette {
  if (existsSync(join(dir, REDACTION_FAILED_MARKER))) {
    throw new CassetteFormatError(`${dir}: redaction gate failed for this cassette (${REDACTION_FAILED_MARKER} marker); re-record or fix it and re-run verify`);
  }
  const manifestPath = join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) throw new CassetteFormatError(`${dir}: no ${MANIFEST_FILE}`);
  const manifest = parseManifest(readJsonFile(manifestPath, MANIFEST_FILE));
  const interactionsPath = join(dir, INTERACTIONS_FILE);
  const interactions = existsSync(interactionsPath)
    ? parseJsonl(readFileSync(interactionsPath, 'utf-8'), INTERACTIONS_FILE).map((v, i) => parseInteraction(v, `${INTERACTIONS_FILE}:${i + 1}`))
    : [];
  checkConsistency(manifest, interactions);
  const cassette: Cassette = { manifest, interactions };
  const eventsDir = join(dir, EVENTS_DIR);
  if (existsSync(eventsDir)) {
    cassette.events = {};
    for (const name of readdirSync(eventsDir).sort()) {
      if (!name.endsWith('.jsonl')) continue;
      cassette.events[name.slice(0, -'.jsonl'.length)] = parseJsonl(readFileSync(join(eventsDir, name), 'utf-8'), `${EVENTS_DIR}/${name}`);
    }
  }
  const reportPath = join(dir, REPORT_FILE);
  if (existsSync(reportPath)) cassette.report = readJsonFile(reportPath, REPORT_FILE);
  return cassette;
}

const toJsonl = (rows: readonly unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');

/** The files of a cassette as `relative path -> content`, in write order (manifest last). */
export function serializeCassette(cassette: Cassette): Map<string, string> {
  const manifest = parseManifest(cassette.manifest);
  const interactions = cassette.interactions.map((it, i) => parseInteraction(it, `interactions[${i}]`));
  checkConsistency(manifest, interactions);
  const files = new Map<string, string>();
  files.set(INTERACTIONS_FILE, toJsonl(interactions));
  for (const [stream, events] of Object.entries(cassette.events ?? {})) {
    if (!SAFE_ID.test(stream)) fail(`events.${stream}`, 'stream id must be a safe file name');
    files.set(`${EVENTS_DIR}/${stream}.jsonl`, toJsonl(events));
  }
  if (cassette.report !== undefined) files.set(REPORT_FILE, `${JSON.stringify(cassette.report, null, 2)}\n`);
  files.set(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}

export interface GateOptions {
  /** Deny-set literals (record time only; never written anywhere). */
  denyLiterals?: Iterable<string>;
  /** Identity strings to look for (record time only). */
  identity?: RedactionIdentity;
}

/** Header names outside the allowlists, as gate hits. */
function headerHits(interactions: readonly CassetteInteraction[]): GateHit[] {
  const hits: GateHit[] = [];
  interactions.forEach((it, i) => {
    for (const key of Object.keys(it.req.headers)) {
      if (!(REQUEST_HEADER_ALLOW as readonly string[]).includes(key)) hits.push({ file: INTERACTIONS_FILE, line: i + 1, rule: 'header.request', index: 0, masked: key });
    }
    for (const key of Object.keys(it.res.headers)) {
      if (!isAllowedResponseHeader(key) || key !== key.toLowerCase()) hits.push({ file: INTERACTIONS_FILE, line: i + 1, rule: 'header.response', index: 0, masked: key });
    }
  });
  return hits;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** The gate over in-memory file contents (relative path -> text). */
export function gateFiles(files: ReadonlyMap<string, string>, options: GateOptions = {}): GateHit[] {
  const literals = [...options.denyLiterals ?? []];
  const hits: GateHit[] = [];
  for (const [file, text] of files) {
    for (const hit of scanForSecrets(text, { denyLiterals: literals, identity: options.identity })) {
      hits.push({ ...hit, file, line: lineOf(text, hit.index) });
    }
  }
  return hits;
}

export interface WriteCassetteOptions extends GateOptions {
  /** Allow writing into a non-empty directory (files this write produces are replaced). */
  overwrite?: boolean;
}

/**
 * Validate, gate, then write a cassette. Fail closed: if the gate finds
 * anything, a {@link CassetteGateError} is thrown and no file is written.
 */
export function writeCassette(dir: string, cassette: Cassette, options: WriteCassetteOptions = {}): string[] {
  const files = serializeCassette(cassette);
  const hits = [...headerHits(cassette.interactions), ...gateFiles(files, options)];
  if (hits.length > 0) throw new CassetteGateError(hits);
  if (existsSync(dir) && readdirSync(dir).length > 0 && !options.overwrite) {
    throw new CassetteFormatError(`${dir}: not empty (pass overwrite to replace the recording)`);
  }
  if (existsSync(join(dir, REDACTION_FAILED_MARKER))) {
    throw new CassetteFormatError(`${dir}: holds a ${REDACTION_FAILED_MARKER} marker; remove it after fixing the cassette`);
  }
  const written: string[] = [];
  for (const [rel, content] of files) {
    const path = join(dir, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    atomicWriteFileSync(path, content);
    written.push(path);
  }
  return written;
}

export interface VerifyResult {
  ok: boolean;
  hits: GateHit[];
  /** Set when the gate wrote the marker. */
  marker?: string;
}

/**
 * The gate over a cassette directory on disk (`omg smoke cassette verify`):
 * every file must parse, the cassette must validate, no symlink, no
 * `--record-full` sidecar, no header outside the allowlists, and no secret
 * pattern (plus the deny set when given). On failure it deletes nothing and
 * writes {@link REDACTION_FAILED_MARKER} listing the masked hits, unless
 * `writeMarker` is false.
 */
export function verifyCassetteDir(dir: string, options: GateOptions & { writeMarker?: boolean } = {}): VerifyResult {
  const hits: GateHit[] = [];
  const problem = (file: string, rule: string, masked: string, line = 0) => hits.push({ file, line, rule, index: 0, masked });
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const rel = relative(dir, path).split('\\').join('/');
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) { problem(rel, 'file.symlink', 'symlink'); continue; }
      if (rel === REDACTION_FAILED_MARKER) { problem(rel, 'file.marker', 'previous gate failure'); continue; }
      if (rel === RECORD_FULL_SIDECAR) { problem(rel, 'file.record-full', '--record-full sidecar'); continue; }
      if (stat.isDirectory()) { walk(path); continue; }
      const text = readFileSync(path, 'utf-8');
      files.set(rel, text);
      try {
        if (rel.endsWith('.jsonl')) parseJsonl(text, rel);
        else if (rel.endsWith('.json')) JSON.parse(text);
      } catch (err) {
        problem(rel, 'file.parse', (err as Error).message.slice(0, 120));
      }
    }
  };
  walk(dir);
  if (!files.has(MANIFEST_FILE)) problem(MANIFEST_FILE, 'file.missing', MANIFEST_FILE);
  else {
    try {
      const manifest = parseManifest(JSON.parse(files.get(MANIFEST_FILE)!));
      const interactions = parseJsonl(files.get(INTERACTIONS_FILE) ?? '', INTERACTIONS_FILE)
        .map((v, i) => parseInteraction(v, `${INTERACTIONS_FILE}:${i + 1}`));
      checkConsistency(manifest, interactions);
      hits.push(...headerHits(interactions));
    } catch (err) {
      problem(MANIFEST_FILE, 'file.invalid', (err as Error).message.slice(0, 200));
    }
  }
  hits.push(...gateFiles(files, options));
  if (hits.length === 0) return { ok: true, hits };
  if (options.writeMarker === false) return { ok: false, hits };
  const marker = join(dir, REDACTION_FAILED_MARKER);
  atomicWriteFileSync(marker, `${formatGateHits(hits)}\n`);
  return { ok: false, hits, marker };
}

/** Every cassette dir (a dir holding manifest.json) under `root`, the root itself included. Does not follow symlinks. */
export function findCassetteDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    const names = readdirSync(dir);
    if (names.includes(MANIFEST_FILE)) { out.push(dir); return; }
    for (const name of names.sort()) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}
