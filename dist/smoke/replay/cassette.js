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
import { isAllowedResponseHeader, reassembledDeltas, REQUEST_HEADER_ALLOW, scanForSecrets, sseBlocks, sseData, wsData, } from './redact.js';
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
export class CassetteFormatError extends Error {
    name = 'CassetteFormatError';
}
export class CassetteGateError extends Error {
    hits;
    name = 'CassetteGateError';
    constructor(hits) {
        super(`cassette redaction gate failed: ${hits.length} hit(s)\n${formatGateHits(hits)}`);
        this.hits = hits;
    }
}
export function formatGateHits(hits) {
    return hits.map((h) => `${h.file}:${h.line}: ${h.rule} ${h.masked}`).join('\n');
}
const RESPONSE_KINDS = ['sse', 'json', 'text', 'ws'];
const SAFE_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
/** The only files a cassette dir may hold (relative, `/`-separated). */
const CASSETTE_FILE = /^(?:manifest\.json|interactions\.jsonl|report\.json|events\/[A-Za-z0-9._-]{1,128}\.jsonl)$/;
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringMap = (v) => isRecord(v) && Object.values(v).every((x) => typeof x === 'string');
const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
function fail(where, message) {
    throw new CassetteFormatError(`${where}: ${message}`);
}
/**
 * Validate a parsed manifest. Refuses any other `format` and any `version`
 * this build does not know (a newer one first, with the hint to upgrade).
 */
export function parseManifest(value, where = MANIFEST_FILE) {
    if (!isRecord(value))
        fail(where, 'not a JSON object');
    if (value.format !== CASSETTE_FORMAT)
        fail(where, `not an omg cassette (format ${JSON.stringify(value.format)})`);
    if (typeof value.version === 'number' && Number.isInteger(value.version) && value.version > CASSETTE_VERSION) {
        fail(where, `cassette v${value.version} needs a newer omg (this build reads v${CASSETTE_VERSION})`);
    }
    if (value.version !== CASSETTE_VERSION)
        fail(where, `unsupported cassette version ${JSON.stringify(value.version)}`);
    for (const key of ['scenario', 'recordedAt', 'platform', 'arch']) {
        if (typeof value[key] !== 'string' || !value[key])
            fail(where, `${key} must be a non-empty string`);
    }
    if (!isRecord(value.omg) || typeof value.omg.version !== 'string')
        fail(where, 'omg.version must be a string');
    if (!isRecord(value.sdk) || typeof value.sdk.version !== 'string')
        fail(where, 'sdk.version must be a string');
    if (!isRecord(value.redaction) || !isCount(value.redaction.rules) || !isRecord(value.redaction.hits)
        || !Object.values(value.redaction.hits).every(isCount))
        fail(where, 'redaction must be { rules, hits }');
    if (!Array.isArray(value.streams))
        fail(where, 'streams must be an array');
    const ids = new Set();
    value.streams.forEach((s, i) => {
        const at = `streams[${i}]`;
        if (!isRecord(s))
            fail(where, `${at} is not an object`);
        if (typeof s.id !== 'string' || !SAFE_ID.test(s.id) || s.id === GLOBAL_STREAM)
            fail(where, `${at}.id must be a safe file name other than "${GLOBAL_STREAM}"`);
        if (ids.has(s.id))
            fail(where, `duplicate stream id ${s.id}`);
        ids.add(s.id);
        if (typeof s.promptDigest !== 'string')
            fail(where, `${at}.promptDigest must be a string`);
        if (!isCount(s.session) || typeof s.agent !== 'string' || !isCount(s.interactions))
            fail(where, `${at} needs session, agent, interactions`);
    });
    return value;
}
/** Validate one parsed interaction. */
export function parseInteraction(value, where) {
    if (!isRecord(value))
        fail(where, 'not a JSON object');
    if (typeof value.stream !== 'string' || !value.stream)
        fail(where, 'stream must be a non-empty string');
    if (!isCount(value.seq))
        fail(where, 'seq must be a non-negative integer');
    const req = value.req;
    if (!isRecord(req))
        fail(where, 'req must be an object');
    if (typeof req.method !== 'string' || typeof req.path !== 'string')
        fail(where, 'req.method and req.path must be strings');
    if (req.transport !== 'http' && req.transport !== 'ws')
        fail(where, `req.transport must be http or ws`);
    if (!isStringMap(req.headers))
        fail(where, 'req.headers must map strings to strings');
    if (typeof req.deltaDigest !== 'string')
        fail(where, 'req.deltaDigest must be a string');
    if (req.expectsToolResults !== undefined && !(Array.isArray(req.expectsToolResults) && req.expectsToolResults.every((x) => typeof x === 'string'))) {
        fail(where, 'req.expectsToolResults must be a string array');
    }
    for (const key of ['interactionType', 'model', 'toolNamesDigest', 'delta']) {
        if (req[key] !== undefined && typeof req[key] !== 'string')
            fail(where, `req.${key} must be a string`);
    }
    const res = value.res;
    if (!isRecord(res))
        fail(where, 'res must be an object');
    if (!isCount(res.status) || res.status > 999)
        fail(where, 'res.status must be an HTTP status');
    if (!isStringMap(res.headers))
        fail(where, 'res.headers must map strings to strings');
    if (!RESPONSE_KINDS.includes(res.kind))
        fail(where, `unknown res.kind ${JSON.stringify(res.kind)}`);
    if (res.kind === 'sse' && !(Array.isArray(res.chunks) && res.chunks.every((c) => typeof c === 'string')))
        fail(where, 'res.chunks must be a string array');
    if (res.kind === 'json' && !('body' in res))
        fail(where, 'res.body is missing');
    if (res.kind === 'text' && typeof res.body !== 'string')
        fail(where, 'res.body must be a string');
    if (res.kind === 'ws' && !(Array.isArray(res.messages)
        && res.messages.every((m) => isRecord(m) && (m.dir === 'in' || m.dir === 'out') && typeof m.data === 'string'))) {
        fail(where, 'res.messages must be [{ dir: in|out, data }]');
    }
    if (value.ms !== undefined && typeof value.ms !== 'number')
        fail(where, 'ms must be a number');
    return value;
}
/**
 * Cross-checks between the manifest and the interactions: every interaction
 * names a declared stream (or the global one), seqs increase within a stream,
 * and each stream holds exactly the count the manifest declares.
 */
function checkConsistency(manifest, interactions) {
    const declared = new Map(manifest.streams.map((s) => [s.id, s]));
    const counts = new Map();
    const lastSeq = new Map();
    interactions.forEach((it, i) => {
        const where = `${INTERACTIONS_FILE}:${i + 1}`;
        if (it.stream !== GLOBAL_STREAM && !declared.has(it.stream))
            fail(where, `stream ${it.stream} is not in the manifest`);
        const prev = lastSeq.get(it.stream);
        if (prev !== undefined && it.seq <= prev)
            fail(where, `seq ${it.seq} does not follow ${prev} in stream ${it.stream}`);
        lastSeq.set(it.stream, it.seq);
        counts.set(it.stream, (counts.get(it.stream) ?? 0) + 1);
    });
    for (const s of manifest.streams) {
        const n = counts.get(s.id) ?? 0;
        if (n !== s.interactions)
            fail(MANIFEST_FILE, `stream ${s.id} declares ${s.interactions} interaction(s), found ${n}`);
    }
}
function parseJsonl(text, file) {
    const out = [];
    text.split('\n').forEach((line, i) => {
        if (!line.trim())
            return;
        try {
            out.push(JSON.parse(line));
        }
        catch (err) {
            fail(`${file}:${i + 1}`, `invalid JSON (${err.message})`);
        }
    });
    return out;
}
function readJsonFile(path, where) {
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch (err) {
        fail(where, `invalid JSON (${err.message})`);
    }
}
/** Read and validate a cassette directory. Refuses a gate-failed cassette and unknown formats or versions. */
export function readCassette(dir) {
    if (existsSync(join(dir, REDACTION_FAILED_MARKER))) {
        throw new CassetteFormatError(`${dir}: redaction gate failed for this cassette (${REDACTION_FAILED_MARKER} marker); re-record or fix it and re-run verify`);
    }
    const manifestPath = join(dir, MANIFEST_FILE);
    if (!existsSync(manifestPath))
        throw new CassetteFormatError(`${dir}: no ${MANIFEST_FILE}`);
    const manifest = parseManifest(readJsonFile(manifestPath, MANIFEST_FILE));
    const interactionsPath = join(dir, INTERACTIONS_FILE);
    const interactions = existsSync(interactionsPath)
        ? parseJsonl(readFileSync(interactionsPath, 'utf-8'), INTERACTIONS_FILE).map((v, i) => parseInteraction(v, `${INTERACTIONS_FILE}:${i + 1}`))
        : [];
    checkConsistency(manifest, interactions);
    const cassette = { manifest, interactions };
    const eventsDir = join(dir, EVENTS_DIR);
    if (existsSync(eventsDir)) {
        cassette.events = {};
        for (const name of readdirSync(eventsDir).sort()) {
            if (!name.endsWith('.jsonl'))
                continue;
            cassette.events[name.slice(0, -'.jsonl'.length)] = parseJsonl(readFileSync(join(eventsDir, name), 'utf-8'), `${EVENTS_DIR}/${name}`);
        }
    }
    const reportPath = join(dir, REPORT_FILE);
    if (existsSync(reportPath))
        cassette.report = readJsonFile(reportPath, REPORT_FILE);
    return cassette;
}
const toJsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
/** The files of a cassette as `relative path -> content`, in write order (manifest last). */
export function serializeCassette(cassette) {
    const manifest = parseManifest(cassette.manifest);
    const interactions = cassette.interactions.map((it, i) => parseInteraction(it, `interactions[${i}]`));
    checkConsistency(manifest, interactions);
    const files = new Map();
    files.set(INTERACTIONS_FILE, toJsonl(interactions));
    for (const [stream, events] of Object.entries(cassette.events ?? {})) {
        if (!SAFE_ID.test(stream))
            fail(`events.${stream}`, 'stream id must be a safe file name');
        files.set(`${EVENTS_DIR}/${stream}.jsonl`, toJsonl(events));
    }
    if (cassette.report !== undefined)
        files.set(REPORT_FILE, `${JSON.stringify(cassette.report, null, 2)}\n`);
    files.set(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
    return files;
}
/** Header names outside the allowlists, as gate hits. */
function headerHits(interactions) {
    const hits = [];
    interactions.forEach((it, i) => {
        for (const key of Object.keys(it.req.headers)) {
            if (!REQUEST_HEADER_ALLOW.includes(key))
                hits.push({ file: INTERACTIONS_FILE, line: i + 1, rule: 'header.request', index: 0, masked: key });
        }
        for (const key of Object.keys(it.res.headers)) {
            if (!isAllowedResponseHeader(key) || key !== key.toLowerCase())
                hits.push({ file: INTERACTIONS_FILE, line: i + 1, rule: 'header.response', index: 0, masked: key });
        }
    });
    return hits;
}
function lineOf(text, index) {
    let line = 1;
    for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1))
        line++;
    return line;
}
// Bounds the decoding recursion; real cassettes nest three JSON string levels.
const MAX_DECODE_DEPTH = 8;
/** The JSON values a string embeds: the whole string when it is JSON, and each SSE `data:` payload. */
function embeddedJson(text) {
    const candidates = [text];
    for (const m of text.matchAll(/^data: ?(.*)$/gm))
        candidates.push(m[1]);
    const out = [];
    for (const candidate of candidates) {
        const t = candidate.trim();
        if (!/^[[{"]/.test(t))
            continue;
        try {
            out.push(JSON.parse(t));
        }
        catch { /* not JSON */ }
    }
    return out;
}
/** Every string (keys too) a parsed value holds, plus the strings of every JSON value decoded from them. */
function decodedStrings(value, out, depth = 0) {
    if (typeof value === 'string') {
        out.push(value);
        if (depth < MAX_DECODE_DEPTH)
            for (const inner of embeddedJson(value))
                decodedStrings(inner, out, depth + 1);
    }
    else if (Array.isArray(value)) {
        for (const v of value)
            decodedStrings(v, out, depth);
    }
    else if (isRecord(value)) {
        for (const [k, v] of Object.entries(value)) {
            decodedStrings(k, out, depth);
            decodedStrings(v, out, depth);
        }
    }
}
/**
 * The texts only a whole streamed response shows (an interaction's `res`):
 * an SSE response's chunks joined, and each streamed field joined from its
 * deltas (SSE events or WebSocket messages), so a secret split across chunks
 * is found. Keyed on the shape, not on `res.kind`: a mislabeled response is scanned too.
 */
function streamTexts(value) {
    const res = isRecord(value) ? value.res : undefined;
    if (!isRecord(res))
        return [];
    if (Array.isArray(res.chunks)) {
        const raw = res.chunks.filter((c) => typeof c === 'string').join('');
        return [raw, ...reassembledDeltas(sseBlocks(raw).map(sseData))];
    }
    if (Array.isArray(res.messages)) {
        return reassembledDeltas(wsData(res.messages.filter((m) => isRecord(m) && typeof m.data === 'string')));
    }
    return [];
}
/**
 * The gate over in-memory file contents (relative path -> text). Scans the
 * serialized text, then every decoded string level of each JSON document
 * (a .json file, or a .jsonl line) and of each reassembled stream, so a
 * secret is found however deeply escaped it sits or however it was split.
 * A decoded hit repeating a text hit is reported once.
 */
export function gateFiles(files, options = {}) {
    const scan = { denyLiterals: [...options.denyLiterals ?? []], identity: options.identity };
    const hits = [];
    for (const [file, text] of files) {
        const seen = new Set();
        for (const hit of scanForSecrets(text, scan)) {
            const line = lineOf(text, hit.index);
            seen.add(`${line}\0${hit.rule}\0${hit.masked}`);
            hits.push({ ...hit, file, line });
        }
        // .jsonl: one document per line; .json: the whole file (line 0, the decoded value has no line of its own).
        const documents = file.endsWith('.jsonl') ? text.split('\n').map((t, i) => [t, i + 1])
            : file.endsWith('.json') ? [[text, 0]] : [];
        for (const [doc, line] of documents) {
            let value;
            try {
                value = JSON.parse(doc);
            }
            catch {
                continue;
            }
            const strings = [];
            decodedStrings(value, strings);
            for (const text of streamTexts(value))
                decodedStrings(text, strings);
            for (const s of strings) {
                for (const hit of scanForSecrets(s, scan)) {
                    const key = `\0${hit.rule}\0${hit.masked}`;
                    if (seen.has(`${line}${key}`) || (line === 0 && [...seen].some((k) => k.endsWith(key))))
                        continue;
                    seen.add(`${line}${key}`);
                    hits.push({ ...hit, index: 0, file, line });
                }
            }
        }
    }
    return hits;
}
/** Files under `root`, relative and `/`-separated. A symlink counts as a file and is not followed. */
function relativeFiles(root, current = root) {
    return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
        const path = join(current, entry.name);
        return entry.isDirectory() ? relativeFiles(root, path) : [relative(root, path).split('\\').join('/')];
    });
}
/**
 * Validate, gate, then write a cassette. Fail closed: if the gate finds
 * anything, a {@link CassetteGateError} is thrown and no file is written.
 */
export function writeCassette(dir, cassette, options = {}) {
    const files = serializeCassette(cassette);
    const hits = [...headerHits(cassette.interactions), ...gateFiles(files, options)];
    if (hits.length > 0)
        throw new CassetteGateError(hits);
    if (existsSync(dir) && readdirSync(dir).length > 0 && !options.overwrite) {
        throw new CassetteFormatError(`${dir}: not empty (pass overwrite to replace the recording)`);
    }
    if (existsSync(join(dir, REDACTION_FAILED_MARKER))) {
        throw new CassetteFormatError(`${dir}: holds a ${REDACTION_FAILED_MARKER} marker; remove it after fixing the cassette`);
    }
    // A file the new recording does not replace would be stale (an old stream's events) and mixed into the cassette.
    const stale = existsSync(dir) ? relativeFiles(dir).filter((rel) => !files.has(rel)) : [];
    if (stale.length > 0)
        throw new CassetteFormatError(`${dir}: holds file(s) this recording does not replace: ${stale.join(', ')}; remove them first`);
    const written = [];
    for (const [rel, content] of files) {
        const path = join(dir, ...rel.split('/'));
        mkdirSync(join(path, '..'), { recursive: true });
        atomicWriteFileSync(path, content);
        written.push(path);
    }
    return written;
}
/**
 * The gate over a cassette directory on disk (`omg smoke cassette verify`):
 * only the cassette's own files, each BOM-less UTF-8 that parses, the
 * cassette must validate, no symlink, no `--record-full` sidecar, no header outside the allowlists, and no secret
 * pattern (plus the deny set when given). On failure it deletes nothing and
 * writes {@link REDACTION_FAILED_MARKER} listing the masked hits, unless
 * `writeMarker` is false.
 */
export function verifyCassetteDir(dir, options = {}) {
    const hits = [];
    const problem = (file, rule, masked, line = 0) => hits.push({ file, line, rule, index: 0, masked });
    const files = new Map();
    const walk = (current) => {
        for (const name of readdirSync(current).sort()) {
            const path = join(current, name);
            const rel = relative(dir, path).split('\\').join('/');
            const stat = lstatSync(path);
            if (stat.isSymbolicLink()) {
                problem(rel, 'file.symlink', 'symlink');
                continue;
            }
            if (rel === REDACTION_FAILED_MARKER) {
                problem(rel, 'file.marker', 'previous gate failure');
                continue;
            }
            if (rel === RECORD_FULL_SIDECAR) {
                problem(rel, 'file.record-full', '--record-full sidecar');
                continue;
            }
            if (stat.isDirectory()) {
                walk(path);
                continue;
            }
            if (!CASSETTE_FILE.test(rel)) {
                problem(rel, 'file.unexpected', 'not a cassette file');
                continue;
            }
            // The gate's patterns only see UTF-8: refuse a BOM, NUL bytes (UTF-16/32) and invalid sequences.
            const bytes = readFileSync(path);
            let text;
            try {
                if (bytes.includes(0) || /^(?:\xef\xbb\xbf|\xff\xfe|\xfe\xff)/.test(bytes.subarray(0, 3).toString('latin1')))
                    throw new Error('BOM or NUL bytes');
                text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            }
            catch (err) {
                problem(rel, 'file.encoding', `not BOM-less UTF-8 (${err.message.slice(0, 60)})`);
                continue;
            }
            files.set(rel, text);
            try {
                if (rel.endsWith('.jsonl'))
                    parseJsonl(text, rel);
                else if (rel.endsWith('.json'))
                    JSON.parse(text);
            }
            catch (err) {
                problem(rel, 'file.parse', err.message.slice(0, 120));
            }
        }
    };
    walk(dir);
    if (!files.has(MANIFEST_FILE))
        problem(MANIFEST_FILE, 'file.missing', MANIFEST_FILE);
    else {
        try {
            const manifest = parseManifest(JSON.parse(files.get(MANIFEST_FILE)));
            const interactions = parseJsonl(files.get(INTERACTIONS_FILE) ?? '', INTERACTIONS_FILE)
                .map((v, i) => parseInteraction(v, `${INTERACTIONS_FILE}:${i + 1}`));
            checkConsistency(manifest, interactions);
            hits.push(...headerHits(interactions));
        }
        catch (err) {
            problem(MANIFEST_FILE, 'file.invalid', err.message.slice(0, 200));
        }
    }
    hits.push(...gateFiles(files, options));
    if (hits.length === 0)
        return { ok: true, hits };
    if (options.writeMarker === false)
        return { ok: false, hits };
    const marker = join(dir, REDACTION_FAILED_MARKER);
    atomicWriteFileSync(marker, `${formatGateHits(hits)}\n`);
    return { ok: false, hits, marker };
}
/** Every cassette dir (a dir holding manifest.json) under `root`, the root itself included. Does not follow symlinks. */
export function findCassetteDirs(root) {
    const out = [];
    const walk = (dir) => {
        const names = readdirSync(dir);
        if (names.includes(MANIFEST_FILE)) {
            out.push(dir);
            return;
        }
        for (const name of names.sort()) {
            const path = join(dir, name);
            if (lstatSync(path).isDirectory())
                walk(path);
        }
    };
    walk(root);
    return out;
}
//# sourceMappingURL=cassette.js.map