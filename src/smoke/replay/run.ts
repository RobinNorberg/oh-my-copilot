/**
 * The smoke side of record/replay (design: .omc/plans/2026-10-29-copilot-replay-design.md,
 * sections 6 and 7): where a run's cassettes and state live, the cassette env
 * each scenario runs with, the merge of a recording's per-process parts into
 * one cassette, the replay summary behind `scn.<name>.replay`, and the
 * `omg smoke cassette verify|import` file work.
 */

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { CASSETTE_ENV } from '../copilot-session-env.js';
import {
  GLOBAL_STREAM,
  MANIFEST_FILE,
  findCassetteDirs,
  readCassette,
  verifyCassetteDir,
  writeCassette,
  formatGateHits,
  type Cassette,
  type CassetteManifest,
} from './cassette.js';
import { RECORD_FAILED_SUFFIX, RECORD_PARTS_DIR, RECORD_STARTED_SUFFIX, UNSCOPED_STATE_DIR, type CassetteMode } from './handler.js';
import { summarizeReplayState, type ReplayStateSummary } from './matcher.js';
import type { PlaceholderDirs } from './redact.js';

export interface CassetteRun {
  mode: CassetteMode;
  /** The `--record` or `--replay` root; a scenario's cassette is `<root>/<platform>-<arch>/<scenario>/`. */
  root: string;
  /** This run's temp state; each scenario gets `<stateRoot>/<scenario>` (claims, ordinals, logs, record parts). */
  stateRoot: string;
  /** `--replay-strict`. */
  strict: boolean;
  /** `--record-overwrite`. */
  overwrite: boolean;
}

/** `<platform>-<arch>` of this machine: the cassette subdir it records into and replays from. */
export function platformTag(): string {
  return `${process.platform}-${process.arch}`;
}

export function scenarioCassetteDir(run: Pick<CassetteRun, 'root'>, scenario: string): string {
  return join(resolve(run.root), platformTag(), scenario);
}

export function scenarioStateDir(run: Pick<CassetteRun, 'stateRoot'>, scenario: string): string {
  return join(run.stateRoot, scenario);
}

/**
 * The cassette env on top of `base`. With a scenario, the scenario's state
 * dir; without one (the smoke driver's shared client, switched per scenario
 * by `setCassetteScenario`), the unscoped state dir, whose requests both
 * modes answer with a 418 miss.
 */
export function cassetteEnv(base: NodeJS.ProcessEnv, run: CassetteRun, dirs: PlaceholderDirs, scenario?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    [CASSETTE_ENV.mode]: run.mode,
    [CASSETTE_ENV.dir]: run.mode === 'replay' ? join(resolve(run.root), platformTag()) : resolve(run.root),
    [CASSETTE_ENV.state]: scenario ? scenarioStateDir(run, scenario) : join(run.stateRoot, UNSCOPED_STATE_DIR),
    [CASSETTE_ENV.match]: run.strict ? 'strict' : 'tolerant',
    [CASSETTE_ENV.dirs]: JSON.stringify(dirs),
  };
  if (scenario) env[CASSETTE_ENV.scenario] = scenario;
  else delete env[CASSETTE_ENV.scenario];
  return env;
}

/**
 * One cassette from every part the scenario's clients wrote (one per client,
 * several processes for a team). Refuses when any part failed
 * (`<pid>-<n>.failed`), a stream id repeats, or the parts disagree on the
 * platform. Null when nothing was recorded. Global interactions are
 * renumbered in part order.
 */
export function mergeRecordedParts(stateDir: string, scenario: string): Cassette | null {
  const partsDir = join(stateDir, RECORD_PARTS_DIR);
  if (!existsSync(partsDir)) return null;
  const names = readdirSync(partsDir).sort();
  const unfinished = names.filter((n) => n.endsWith(RECORD_STARTED_SUFFIX)).map((n) => n.slice(0, -RECORD_STARTED_SUFFIX.length));
  if (unfinished.length > 0) {
    throw new Error(`recording part(s) ${unfinished.join(', ')} never finished (the client was not stopped, or its process was killed), refusing to merge`);
  }
  const failed = names.filter((n) => n.endsWith(RECORD_FAILED_SUFFIX));
  if (failed.length > 0) {
    const why = failed.map((n) => `${n}: ${readFileSync(join(partsDir, n), 'utf-8').trim().slice(0, 300)}`);
    throw new Error(`${failed.length} recording part(s) failed, refusing to merge: ${why.join('; ')}`);
  }
  const parts = names.filter((n) => statSync(join(partsDir, n)).isDirectory()).map((n) => readCassette(join(partsDir, n)));
  if (parts.length === 0) return null;
  const first = parts[0].manifest;
  const streams: CassetteManifest['streams'] = [];
  const hits: Record<string, number> = {};
  const interactions: Cassette['interactions'] = [];
  let globalSeq = 0;
  for (const part of parts) {
    const m = part.manifest;
    if (m.platform !== first.platform || m.arch !== first.arch) throw new Error(`recording parts disagree on the platform (${first.platform}-${first.arch} vs ${m.platform}-${m.arch})`);
    for (const s of m.streams) {
      if (streams.some((t) => t.id === s.id)) throw new Error(`stream ${s.id} was recorded by two clients`);
      streams.push(s);
    }
    for (const [rule, n] of Object.entries(m.redaction.hits)) hits[rule] = (hits[rule] ?? 0) + n;
    // A part lists its interactions in recording order, so its global seqs are already ascending.
    for (const it of part.interactions) interactions.push(it.stream === GLOBAL_STREAM ? { ...it, seq: ++globalSeq } : it);
  }
  return {
    manifest: { ...first, scenario, recordedAt: new Date().toISOString(), redaction: { rules: first.redaction.rules, hits }, streams },
    interactions,
  };
}

export interface RecordMeta {
  model?: string;
  maxCredits?: number;
  cost?: { credits?: number; premiumRequests?: number };
  /** The scenarios of the recording run, in the order they ran; a replay runs them in this order. */
  runOrder?: string[];
}

/** The global GET and HEAD interactions of a scenario's finished parts, in recording order (a global POST is never borrowed). */
function recordedGlobals(stateDir: string): Cassette['interactions'] {
  const partsDir = join(stateDir, RECORD_PARTS_DIR);
  if (!existsSync(partsDir)) return [];
  return readdirSync(partsDir).sort()
    .filter((n) => statSync(join(partsDir, n)).isDirectory())
    .flatMap((n) => readCassette(join(partsDir, n)).interactions.filter((it) => it.stream === GLOBAL_STREAM && (it.req.method === 'GET' || it.req.method === 'HEAD')));
}

/**
 * Merge the scenario's parts and write the cassette to
 * `<root>/<platform>-<arch>/<scenario>/` through the gate. Returns the
 * cassette dir and the stream count; throws when nothing was recorded or the
 * merge or write refuses.
 *
 * `globalsFrom`: the run's other scenarios. A runtime caches global GETs
 * across the scenarios of one client, so only the first scenario to need one
 * records it; each global key this scenario lacks is copied from them, and a
 * replay of any subset, in any order, finds it (an unserved global is not a
 * replay failure).
 */
export function finalizeRecording(
  run: CassetteRun,
  scenario: string,
  meta: RecordMeta,
  opts: { globalsFrom?: string[] } = {},
): { dir: string; streams: number; interactions: number } {
  const merged = mergeRecordedParts(scenarioStateDir(run, scenario), scenario);
  if (!merged || merged.interactions.length === 0) throw new Error('no model request was recorded');
  const key = (it: Cassette['interactions'][number]) => `${it.req.method} ${it.req.path}`;
  const own = new Set(merged.interactions.filter((it) => it.stream === GLOBAL_STREAM).map(key));
  let globalSeq = own.size === 0 ? 0 : Math.max(...merged.interactions.filter((it) => it.stream === GLOBAL_STREAM).map((it) => it.seq));
  const borrowed: Cassette['interactions'] = [];
  for (const other of opts.globalsFrom ?? []) {
    if (other === scenario) continue;
    for (const it of recordedGlobals(scenarioStateDir(run, other))) {
      if (own.has(key(it)) || borrowed.some((b) => key(b) === key(it))) continue;
      borrowed.push({ ...it, seq: ++globalSeq });
    }
  }
  const interactions = [...merged.interactions, ...borrowed];
  const manifest: CassetteManifest = {
    ...merged.manifest,
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.maxCredits !== undefined ? { maxCredits: meta.maxCredits } : {}),
    ...(meta.cost ? { cost: meta.cost } : {}),
    ...(meta.runOrder ? { runOrder: meta.runOrder } : {}),
  };
  const dir = scenarioCassetteDir(run, scenario);
  writeCassette(dir, { ...merged, interactions, manifest }, { overwrite: run.overwrite });
  return { dir, streams: manifest.streams.length, interactions: interactions.length };
}

/**
 * The selected scenarios in the order their recording ran (the manifests'
 * `runOrder`), or null when no selected cassette stores one. Scenarios the
 * stored order does not name keep their relative order, after the others.
 */
export function storedRunOrder<T extends string>(run: Pick<CassetteRun, 'root'>, scenarios: readonly T[]): T[] | null {
  for (const scenario of scenarios) {
    if (!hasCassette(run, scenario)) continue;
    const order = readCassette(scenarioCassetteDir(run, scenario)).manifest.runOrder;
    if (!order) continue;
    const rank = (s: T) => (order.includes(s) ? order.indexOf(s) : order.length);
    return [...scenarios].sort((a, b) => rank(a) - rank(b));
  }
  return null;
}

/** Where a scenario's parts go when its recording is not written: `<root>/_failed/<scenario>/` (never read as a cassette). */
export const FAILED_RECORDINGS_DIR = '_failed';

/**
 * Keep a scenario's recorded parts (each already through the gate) under
 * `<root>/_failed/<scenario>/` for diagnosis, replacing an earlier copy.
 * Returns that dir, or null when the scenario recorded nothing.
 */
export function keepFailedParts(run: CassetteRun, scenario: string): string | null {
  const parts = join(scenarioStateDir(run, scenario), RECORD_PARTS_DIR);
  if (!existsSync(parts) || readdirSync(parts).length === 0) return null;
  const dest = join(resolve(run.root), FAILED_RECORDINGS_DIR, scenario);
  rmSync(dest, { recursive: true, force: true });
  cpSync(parts, join(dest, RECORD_PARTS_DIR), { recursive: true, filter: (src) => !src.endsWith(RECORD_STARTED_SUFFIX) });
  return dest;
}

/** The cassettes under `root`, leaving out the kept parts of failed recordings. */
function cassetteDirsUnder(root: string): string[] {
  return findCassetteDirs(root).filter((dir) => relative(root, dir).split(/[\\/]/)[0] !== FAILED_RECORDINGS_DIR);
}

/** Why recording `scenario` would be refused before any credit is spent (an existing cassette), or null. */
export function recordTargetRefusal(run: CassetteRun, scenario: string): string | null {
  const dir = scenarioCassetteDir(run, scenario);
  if (run.overwrite || !existsSync(dir) || readdirSync(dir).length === 0) return null;
  return `${dir} already holds a recording; pass --record-overwrite to replace it`;
}

export type ReplayOutcome = ReplayStateSummary & { streams: number };

/** What the scenario's replay served, from its state dir; a string when the cassette cannot be read. */
export function replayOutcome(run: CassetteRun, scenario: string): ReplayOutcome | string {
  let cassette: Cassette;
  try {
    cassette = readCassette(scenarioCassetteDir(run, scenario));
  } catch (err) {
    return (err as Error).message;
  }
  return { ...summarizeReplayState(scenarioStateDir(run, scenario), cassette), streams: cassette.manifest.streams.length };
}

/** The model a replay pins: the one every selected cassette was recorded with. */
export function replayModel(run: CassetteRun, scenarios: readonly string[]): string | undefined {
  const models = new Set<string>();
  for (const scenario of scenarios) {
    const manifest = join(scenarioCassetteDir(run, scenario), MANIFEST_FILE);
    if (!existsSync(manifest)) continue;
    const model = readCassette(scenarioCassetteDir(run, scenario)).manifest.model;
    if (!model) throw new Error(`${scenario}: the cassette names no model, so replay cannot pin one; re-record it with --model`);
    models.add(model);
  }
  if (models.size > 1) throw new Error(`the selected cassettes were recorded on different models (${[...models].join(', ')}); replay them in separate runs`);
  return [...models][0];
}

/** Whether `scenario` has a cassette for this machine under the run root. */
export function hasCassette(run: Pick<CassetteRun, 'root'>, scenario: string): boolean {
  return existsSync(join(scenarioCassetteDir(run, scenario), MANIFEST_FILE));
}

export interface GateResult {
  dir: string;
  ok: boolean;
  /** The masked hits (file:line, rule), one per line. */
  detail: string;
}

/** The redaction gate over every cassette under `root` (writes a REDACTION-FAILED marker into each that fails). */
export function gateCassettes(root: string): GateResult[] {
  if (!existsSync(root)) throw new Error(`${root} does not exist`);
  return cassetteDirsUnder(resolve(root)).map((dir) => {
    const result = verifyCassetteDir(dir);
    return { dir, ok: result.ok, detail: result.ok ? 'clean' : formatGateHits(result.hits) };
  });
}

/** Record the self-verify replay's result in the cassette's manifest. */
export function writeSelfVerify(dir: string, selfVerify: NonNullable<CassetteManifest['selfVerify']>): void {
  const cassette = readCassette(dir);
  writeCassette(dir, { ...cassette, manifest: { ...cassette.manifest, selfVerify } }, { overwrite: true });
}

/** Files under `dir`, relative and `/`-separated. */
function filesUnder(dir: string, current = dir): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? filesUnder(dir, path) : [relative(dir, path).split('\\').join('/')];
  });
}

export interface ImportResult {
  /** `<platform>-<arch>/<scenario>` per imported cassette. */
  imported: string[];
  dest: string;
}

/**
 * Copy every cassette under `source` into `<dest>/<platform>-<arch>/<scenario>/`
 * after the gate (no marker written into the source) and a format check.
 * All or nothing: any refusal (a gate hit, an unknown version, a cassette
 * outside its `<platform>-<arch>` dir, an existing target without
 * `overwrite`) copies nothing.
 */
export function importCassettes(source: string, dest: string, overwrite = false): ImportResult {
  const root = resolve(source);
  if (!existsSync(root)) throw new Error(`${source} does not exist`);
  const dirs = cassetteDirsUnder(root);
  if (dirs.length === 0) throw new Error(`no cassette (a dir with ${MANIFEST_FILE}) under ${source}`);
  const plan: Array<{ from: string; to: string; label: string }> = [];
  const problems: string[] = [];
  for (const dir of dirs) {
    const rel = relative(root, dir).split('\\').join('/') || '.';
    const gate = verifyCassetteDir(dir, { writeMarker: false });
    if (!gate.ok) { problems.push(`${rel}: redaction gate failed\n${formatGateHits(gate.hits)}`); continue; }
    let manifest: CassetteManifest;
    try { manifest = readCassette(dir).manifest; } catch (err) { problems.push(`${rel}: ${(err as Error).message}`); continue; }
    const label = `${manifest.platform}-${manifest.arch}/${manifest.scenario}`;
    if (!rel.endsWith(label) && rel !== manifest.scenario) {
      problems.push(`${rel}: the manifest says ${label}; keep each cassette at <platform>-<arch>/<scenario>`);
      continue;
    }
    const to = join(resolve(dest), manifest.platform + '-' + manifest.arch, manifest.scenario);
    if (plan.some((p) => p.to === to)) { problems.push(`${rel}: a second cassette for ${label}`); continue; }
    if (existsSync(to) && readdirSync(to).length > 0) {
      if (!overwrite) { problems.push(`${label}: ${to} exists; pass --overwrite to replace it`); continue; }
      // A file the new cassette does not replace would be mixed into it (an old stream's events).
      const incoming = new Set(filesUnder(dir));
      const stale = filesUnder(to).filter((f) => !incoming.has(f));
      if (stale.length > 0) { problems.push(`${label}: ${to} holds file(s) the import does not replace (${stale.join(', ')}); remove them first`); continue; }
    }
    plan.push({ from: dir, to, label });
  }
  if (problems.length > 0) throw new Error(`nothing imported:\n${problems.join('\n')}`);
  for (const { from, to } of plan) cpSync(from, to, { recursive: true, force: true });
  return { imported: plan.map((p) => p.label), dest: resolve(dest) };
}
