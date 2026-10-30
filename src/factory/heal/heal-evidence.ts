/**
 * The heal evidence bundle (design §4): what the debugger lane gets to read,
 * built by the engine from a classified signature. Files:
 *
 * - `classification.json`: the classifier verdict (failing titles per job).
 * - `env-diff.json`: last green vs first red environment per job.
 * - `setup.log`: runner, image and tool-version lines of the red and the green job.
 * - `commits.txt`: `git log --oneline` of lastGreen..firstRed and the changed files.
 * - `test-source.txt`: the failing test file paths (the lane reads the source itself).
 * - `failures/<n>.log`: per failing test, its FAIL line to the next FAIL line, at most 200 lines.
 * - `tails/<n>.log`: per failed step, the last 120 lines of that step's log.
 *
 * Every file is log- or commit-derived, so every file is untrusted
 * (sanitize.ts): lines cleaned and capped at 400 characters, delimiter-
 * carrying lines dropped, each file capped at 64 KiB and the bundle at
 * MAX_BUNDLE_BYTES (later files are omitted first and the omission is
 * recorded). The bundle is written to `.omg/state/factory/heal/<sig8>/evidence/`
 * with a sha256 per file; the caller seals those hashes outside the repository.
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { atomicWriteFileSync } from '../../lib/atomic-write.js';
import { parseFailingTests, type FailingTest } from '../../ship/gates.js';
import type { Exec } from '../../ship/exec.js';
import { githubCi } from '../../forge/github/ci.js';
import type { ForgeCi } from '../../forge/types.js';
import type { HealClassification } from './classify.js';
import type { HealJob } from './history.js';
import { cleanLine, ENV_FIELDS, type JobEnv } from './logs.js';
import { capBytes, MAX_EVIDENCE_LINE_CHARS, sanitizeJson, sanitizeLines } from './sanitize.js';
import { healStateDir } from './state.js';

export const EVIDENCE_LIMITS = Object.freeze({
  failureLines: 200,
  failureFiles: 10,
  tailLines: 120,
  tailFiles: 6,
  setupLinesPerJob: 80,
  commits: 50,
  testsPerJob: 10,
  fileBytes: 64 * 1024,
  bundleBytes: 160 * 1024,
});

export interface EvidenceFile {
  /** Lines as written (and as the prompt numbers them). */
  lines: string[];
  /** For a JSON file: every object key at any depth (citation anchors). */
  jsonKeys?: string[];
  /** What the file holds, engine-authored (job and step names are capped log text). */
  label: string;
}

export interface EvidenceBundle {
  sig8: string;
  /** File name -> content, in prompt order. */
  files: Record<string, EvidenceFile>;
  /** Files left out by the bundle cap. */
  omitted: string[];
  /** Lines dropped because they carried the fence delimiter prefix. */
  droppedLines: number;
}

export interface RedJobLog {
  job: Pick<HealJob, 'name' | 'failedSteps'>;
  log: string;
}

export interface EvidenceInput {
  classification: HealClassification;
  /** The first red run's failed (counted) jobs with their logs. */
  red: readonly RedJobLog[];
  /** The last green run's same-named jobs with their logs. */
  green: readonly { name: string; log: string }[];
  /** `git log --oneline` lines of lastGreen..firstRed (empty when not available). */
  commits: readonly string[];
}

const testKey = (t: FailingTest) => `${t.file}\u0000${t.title ?? ''}`;

function jsonFile(value: unknown, label: string): EvidenceFile {
  const clean = sanitizeJson(value);
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
  };
  walk(clean);
  // The same caps as a text file: each line at MAX_EVIDENCE_LINE_CHARS, the file at fileBytes.
  const all = JSON.stringify(clean, null, 2).split('\n').map((l) => l.slice(0, MAX_EVIDENCE_LINE_CHARS));
  const capped = capBytes(all, EVIDENCE_LIMITS.fileBytes);
  const lines = capped.cut ? [...capped.lines.slice(0, -1), '[engine: file cut at its size cap]'] : capped.lines;
  // A key is a citation anchor only while its line is still in the file.
  const present = capped.cut ? [...keys].filter((k) => lines.some((l) => l.includes(`${JSON.stringify(k)}:`))) : [...keys];
  return { lines, jsonKeys: present.sort(), label };
}

/** Per failing test: its FAIL line through the next FAIL line, at most `failureLines` lines. */
export function failureWindows(log: string, tests: readonly FailingTest[]): { test: FailingTest; lines: string[] }[] {
  const raw = log.split(/\r?\n/);
  const failAt: { i: number; keys: Set<string> }[] = [];
  raw.forEach((line, i) => {
    if (!line.includes('FAIL')) return;
    const parsed = parseFailingTests(line);
    if (parsed.length > 0) failAt.push({ i, keys: new Set(parsed.map(testKey)) });
  });
  const out: { test: FailingTest; lines: string[] }[] = [];
  for (const test of tests) {
    const k = failAt.findIndex((f) => f.keys.has(testKey(test)));
    if (k < 0) continue;
    const start = failAt[k].i;
    const end = Math.min(failAt[k + 1]?.i ?? raw.length, start + EVIDENCE_LIMITS.failureLines);
    out.push({ test, lines: raw.slice(start, end) });
  }
  return out;
}

/** The last `tailLines` lines of each failed step (the whole log when no line names a step). */
export function stepTails(log: string, failedSteps: readonly string[]): { step: string; lines: string[] }[] {
  const raw = log.split(/\r?\n/).filter((l) => l.trim());
  const out: { step: string; lines: string[] }[] = [];
  for (const step of failedSteps) {
    const lines = raw.filter((l) => l.split('\t')[1] === step);
    if (lines.length > 0) out.push({ step, lines: lines.slice(-EVIDENCE_LIMITS.tailLines) });
  }
  if (out.length === 0) out.push({ step: failedSteps[0] ?? '(unknown step)', lines: raw.slice(-EVIDENCE_LIMITS.tailLines) });
  return out;
}

const SETUP_GROUPS = new Set(['Runner Image', 'Runner Image Provisioner', 'Operating System']);
const SETUP_LINE = /^(?:Current runner version:|Image:|Version:|git version \d|node: v?\d|npm: \d|Runner name:|Machine name:)/;

/** Runner, image and tool-version lines of one job log. */
export function setupLines(log: string): string[] {
  const out: string[] = [];
  let group = '';
  for (const raw of log.split(/\r?\n/)) {
    const line = cleanLine(raw).trim();
    const g = /^##\[group\](.*)$/.exec(line);
    if (g) { group = g[1].trim(); if (SETUP_GROUPS.has(group)) out.push(raw); continue; }
    if (line === '##[endgroup]') { group = ''; continue; }
    if (SETUP_GROUPS.has(group) || SETUP_LINE.test(line)) out.push(raw);
    if (out.length >= EVIDENCE_LIMITS.setupLinesPerJob) break;
  }
  return out;
}

function textFile(raw: readonly string[], label: string, counter: { dropped: number }): EvidenceFile {
  const { lines, dropped } = sanitizeLines(raw);
  counter.dropped += dropped;
  const capped = capBytes(lines, EVIDENCE_LIMITS.fileBytes);
  return { lines: capped.cut ? [...capped.lines.slice(0, -1), '[engine: file cut at its size cap]'] : capped.lines, label };
}

function envRecord(env: JobEnv | undefined): Record<string, string | null> | null {
  return env ? Object.fromEntries(ENV_FIELDS.map((f) => [f, env[f] ?? null])) : null;
}

/** The bundle, pure: no I/O. */
export function buildEvidence(input: EvidenceInput): EvidenceBundle {
  const c = input.classification;
  const counter = { dropped: 0 };
  const files: [string, EvidenceFile][] = [];
  const trimmed = { ...c, jobs: c.jobs.map((j) => ({ ...j, failingTests: j.failingTests.slice(0, EVIDENCE_LIMITS.testsPerJob), blockers: j.blockers.slice(0, 10) })) };
  files.push(['classification.json', jsonFile(trimmed, 'the deterministic classifier verdict')]);
  files.push(['env-diff.json', jsonFile({
    jobs: c.jobs.map((j) => ({
      job: j.job,
      red: envRecord(j.env.red),
      green: envRecord(j.env.green),
      changed: Object.fromEntries(j.env.changed.map((ch) => [ch.field, { green: ch.green ?? null, red: ch.red ?? null }])),
      ...(j.sameShaImages ? { sameShaImages: j.sameShaImages } : {}),
    })),
  }, 'last green vs first red runner environment per job')]);

  const setup: string[] = [];
  for (const r of input.red) {
    setup.push(`# red job ${r.job.name} (run ${c.firstRed.runId})`, ...setupLines(r.log));
    const g = input.green.find((x) => x.name === r.job.name);
    if (g) setup.push(`# green job ${g.name} (run ${c.lastGreen?.runId ?? '?'})`, ...setupLines(g.log));
  }
  files.push(['setup.log', textFile(setup, 'runner, image and tool-version lines of the red and green jobs', counter)]);

  const range = c.range;
  const commits = [
    `# commits ${c.lastGreen?.sha.slice(0, 12) ?? '?'}..${c.firstRed.sha.slice(0, 12)}`,
    ...(input.commits.length > 0 ? input.commits.slice(0, EVIDENCE_LIMITS.commits) : ['(not available locally)']),
    `# changed files (${range ? `${range.commits} commit(s), ${range.codeFiles} code file(s)` : 'range not available'})`,
    ...(range?.files ?? []),
  ];
  files.push(['commits.txt', textFile(commits, 'commit subjects and changed files of the sha range', counter)]);

  const tests = c.jobs.flatMap((j) => j.failingTests.slice(0, EVIDENCE_LIMITS.testsPerJob));
  files.push(['test-source.txt', textFile([...new Set(tests.map((t) => t.file))], 'failing test file paths at the red sha', counter)]);

  let n = 0;
  for (const r of input.red) {
    const job = c.jobs.find((j) => j.job === r.job.name);
    for (const w of failureWindows(r.log, job?.failingTests ?? [])) {
      if (n >= EVIDENCE_LIMITS.failureFiles) break;
      n += 1;
      files.push([`failures/${n}.log`, textFile(w.lines, `job ${r.job.name}: FAIL window of one failing test`, counter)]);
    }
  }
  let t = 0;
  for (const r of input.red) {
    for (const tail of stepTails(r.log, r.job.failedSteps)) {
      if (t >= EVIDENCE_LIMITS.tailFiles) break;
      t += 1;
      files.push([`tails/${t}.log`, textFile(tail.lines, `job ${r.job.name}: last lines of a failed step`, counter)]);
    }
  }

  const kept: Record<string, EvidenceFile> = {};
  const omitted: string[] = [];
  let size = 0;
  for (const [name, file] of files) {
    const bytes = Buffer.byteLength(file.lines.join('\n'), 'utf8') + 1;
    if (size + bytes > EVIDENCE_LIMITS.bundleBytes) { omitted.push(name); continue; }
    size += bytes;
    kept[name] = file;
  }
  return { sig8: c.sig8, files: kept, omitted, droppedLines: counter.dropped };
}

export function bundleBytes(bundle: EvidenceBundle): number {
  return Object.values(bundle.files).reduce((sum, f) => sum + Buffer.byteLength(f.lines.join('\n'), 'utf8') + 1, 0);
}

export const evidenceDir = (root: string, sig8: string): string => join(healStateDir(root), sig8, 'evidence');

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const content = (f: EvidenceFile) => `${f.lines.join('\n')}\n`;

/** Write the bundle fresh (old files removed) and return each file's sha256. */
export function writeEvidence(root: string, bundle: EvidenceBundle): { dir: string; hashes: Record<string, string> } {
  const dir = evidenceDir(root, bundle.sig8);
  rmSync(dir, { recursive: true, force: true });
  const hashes: Record<string, string> = {};
  for (const [name, file] of Object.entries(bundle.files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, content(file));
    hashes[name] = sha256(content(file));
  }
  return { dir, hashes };
}

/** Files whose content no longer matches its recorded hash (a lane or another process changed the bundle). */
export function changedEvidence(root: string, sig8: string, hashes: Readonly<Record<string, string>>): string[] {
  const dir = evidenceDir(root, sig8);
  return Object.entries(hashes).filter(([name, hash]) => {
    try {
      return sha256(readFileSync(join(dir, name))) !== hash;
    } catch {
      return true;
    }
  }).map(([name]) => name);
}

/**
 * Re-read the red run's failed jobs and logs (and the green run's same-named
 * jobs) through the heal exec guard, plus the commit subjects of the range.
 * `ci` builds the forge's CI reads over that guarded exec (default GitHub).
 */
export function collectEvidence(exec: Exec, root: string, classification: HealClassification, ignoreJobs: readonly string[], ci: (exec: Exec, root: string) => ForgeCi = githubCi): EvidenceInput {
  const c = classification;
  const forgeCi = ci(exec, root);
  const red = forgeCi.runJobs(c.firstRed.runId)
    .filter((j) => j.conclusion === 'failure' && !ignoreJobs.includes(j.name))
    .map((job) => ({ job, log: forgeCi.jobLog(job.jobId) }));
  const green: { name: string; log: string }[] = [];
  if (c.lastGreen) {
    const names = new Set(red.map((r) => r.job.name));
    for (const j of forgeCi.runJobs(c.lastGreen.runId)) {
      if (names.has(j.name) && j.conclusion === 'success') green.push({ name: j.name, log: forgeCi.jobLog(j.jobId) });
    }
  }
  let commits: string[] = [];
  if (c.lastGreen && c.range) {
    const r = exec('git', ['log', '--oneline', '--no-decorate', '--no-color', '-n', String(EVIDENCE_LIMITS.commits), `${c.lastGreen.sha}..${c.firstRed.sha}`], { cwd: root });
    if (r.status === 0) commits = r.stdout.split(/\r?\n/).filter(Boolean);
  }
  return { classification: c, red, green, commits };
}
