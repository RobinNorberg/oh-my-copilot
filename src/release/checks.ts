/**
 * Pure checks behind `omg release`: version order, release prose, version
 * stamps, dist orphans, vitest report diffs, flake triage, smoke reports,
 * the smoke input hash, tag targets and the suite's Windows bash.
 * No I/O beyond the `exists` callback, so each rule is tested directly.
 */

import { createHash } from 'crypto';
import { win32 } from 'path';

export const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** `5.12.2` (a leading `v` is dropped); throws on anything but X.Y.Z. */
export function parseReleaseVersion(raw: string): string {
  const v = raw.trim().replace(/^v/, '');
  if (!VERSION_RE.test(v)) throw new Error(`version must be X.Y.Z, got ${JSON.stringify(raw)}`);
  return v;
}

/** Negative / 0 / positive like a sort comparator; both sides must be X.Y.Z. */
export function compareVersions(a: string, b: string): number {
  const pa = parseReleaseVersion(a).split('.').map(Number);
  const pb = parseReleaseVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** `s` as a literal regex source (also a literal `vitest -t` pattern). */
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Problems with the release prose humans or agents write before a release:
 * CHANGELOG.md needs the `## [X.Y.Z]` section AND the `# <name> vX.Y.Z` H1
 * the tag-run boundary greps for; `.github/release-body.md` (the GitHub
 * Release body) must mention the version.
 */
export function releaseProseProblems(version: string, changelog: string | null, releaseBody: string | null): string[] {
  const problems: string[] = [];
  const v = escapeRe(version);
  if (changelog === null) problems.push('CHANGELOG.md is missing');
  else {
    if (!new RegExp(`^## \\[${v}\\]`, 'm').test(changelog)) problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section`);
    if (!new RegExp(`^# .+ v${v}(?:[:\\s]|$)`, 'm').test(changelog)) problems.push(`CHANGELOG.md has no "# oh-my-copilot v${version}" heading (the release boundary greps for it)`);
  }
  if (releaseBody === null || releaseBody.trim() === '') problems.push('.github/release-body.md is missing or empty');
  else if (!releaseBody.includes(version)) problems.push(`.github/release-body.md does not mention ${version}`);
  return problems;
}

/**
 * Files and the version pattern each one carries; mirrors scripts/sync-version.sh plus the stamps it does not cover.
 * The plugin manifests carry one top-level "version" first, so only the first match is replaced (a nested one stays).
 */
export const VERSION_STAMPS: ReadonlyArray<{ file: string; pattern: RegExp; replace: (v: string) => string }> = [
  { file: '.claude-plugin/plugin.json', pattern: /"version": "[^"]*"/, replace: (v) => `"version": "${v}"` },
  { file: 'plugin.json', pattern: /"version": "[^"]*"/, replace: (v) => `"version": "${v}"` },
  { file: '.claude-plugin/marketplace.json', pattern: /"version": "[^"]*"/g, replace: (v) => `"version": "${v}"` },
  { file: 'docs/CLAUDE.md', pattern: /<!-- OMC:VERSION:[^ ]* -->/g, replace: (v) => `<!-- OMC:VERSION:${v} -->` },
  { file: 'CLAUDE.md', pattern: /<!-- OMC:VERSION:[^ ]* -->/g, replace: (v) => `<!-- OMC:VERSION:${v} -->` },
  { file: '.github/CLAUDE.md', pattern: /<!-- OMC:VERSION:[^ ]* -->/g, replace: (v) => `<!-- OMC:VERSION:${v} -->` },
  { file: 'tests/fixtures/prompt-projection/claude-managed-block.golden', pattern: /<!-- OMC:VERSION:[^ ]* -->/g, replace: (v) => `<!-- OMC:VERSION:${v} -->` },
  { file: '.github/upstream-port.json', pattern: /"fork_version": "[^"]*"/g, replace: (v) => `"fork_version": "${v}"` },
];

/** The stamped content, or null when the file carries no stamp (a silent no-op would ship a stale version). */
export function stampVersion(content: string, stamp: (typeof VERSION_STAMPS)[number], version: string): string | null {
  const pattern = new RegExp(stamp.pattern.source, stamp.pattern.flags);
  if (!pattern.test(content)) return null;
  return content.replace(new RegExp(stamp.pattern.source, stamp.pattern.flags), stamp.replace(version));
}

const DIST_OUTPUT = /^dist\/(.+?)\.(?:d\.ts\.map|d\.ts|js\.map|js)$/;
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx'];

/**
 * Tracked tsc outputs under dist/ whose source under src/ is gone (tsc never
 * deletes them, and the runtime-closure check fails on a stale module).
 * Other dist files (copied JSON, bundled .cjs) are not tsc outputs and are skipped.
 */
export function findDistOrphans(trackedDist: readonly string[], exists: (repoPath: string) => boolean): string[] {
  const orphans: string[] = [];
  for (const raw of trackedDist) {
    const file = raw.replace(/\\/g, '/');
    const m = DIST_OUTPUT.exec(file);
    if (!m) continue;
    if (!SOURCE_EXTS.some((ext) => exists(`src/${m[1]}${ext}`))) orphans.push(file);
  }
  return orphans;
}

const REPO_DIRS = /(?:^|\/)((?:src|tests|scripts|benchmark|bridge|skills|hooks)\/.+)$/;

/** Repo-relative forward-slash path of a test file from any checkout (`C:\x\src\a.test.ts` -> `src/a.test.ts`). */
export function repoRelativeTestPath(file: string): string {
  const norm = file.replace(/\\/g, '/');
  return REPO_DIRS.exec(norm)?.[1] ?? norm;
}

interface VitestJsonReport {
  testResults?: Array<{ name?: string; status?: string; message?: string; assertionResults?: Array<{ fullName?: string; title?: string; status?: string }> }>;
}

/**
 * `<file> > <full title>` for every failed test in a vitest JSON report; a
 * file that failed with no failed test (a collection error) is listed as the
 * file alone.
 */
export function failingTitlesFromVitestJson(text: string): string[] {
  const report = JSON.parse(text) as VitestJsonReport;
  if (!Array.isArray(report?.testResults)) throw new Error('not a vitest JSON report (no testResults)');
  const out = new Set<string>();
  for (const file of report.testResults) {
    const rel = repoRelativeTestPath(file.name ?? '');
    const failed = (file.assertionResults ?? []).filter((a) => a.status === 'failed');
    for (const a of failed) out.add(`${rel} > ${a.fullName ?? a.title ?? ''}`);
    if (failed.length === 0 && file.status === 'failed') out.add(rel);
  }
  return [...out].sort();
}

/** A baseline is a vitest JSON report or a text file with one `<file> > <title>` per line. */
export function parseBaselineTitles(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return failingTitlesFromVitestJson(trimmed);
  return trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [file, ...rest] = l.split(' > ');
      return rest.length > 0 ? `${repoRelativeTestPath(file)} > ${rest.join(' > ')}` : repoRelativeTestPath(file);
    });
}

/** Failing titles absent from the baseline (the suite gate fails only on these). */
export function newFailures(failing: readonly string[], baseline: readonly string[]): string[] {
  const known = new Set(baseline);
  return failing.filter((t) => !known.has(t));
}

/**
 * More new failing titles than this are not triaged title by title: their
 * files are rerun once each as a whole (pooled), and only the titles still
 * failing there are triaged, again at most this many.
 */
export const TRIAGE_CAP = 20;

/** Triage reruns running at once (never two of one file: a file's tests share fixtures). */
export const TRIAGE_POOL = 3;

/** A process-listing line: `<pid> <ppid> <command line>`. */
const PROCESS_LINE = /^\s*(\d+)\s+(\d+)\s*(.*)$/;
/** A node command line: `node ...`, `/usr/bin/node ...`, `"C:\Program Files\nodejs\node.exe" ...` (or a bare `node.exe` name). */
const NODE_COMMAND = /^(?:"[^"]*[\\/]node(?:\.exe)?"|(?:\S*[\\/])?node(?:\.exe)?)(?:\s|$)/i;

/**
 * Node processes outside the release's own process tree (itself, its
 * ancestors and its descendants), and how many of those run vitest, from
 * `<pid> <ppid> <command line>` lines. Null for an empty listing (unknown).
 */
export function outsideNodeLoad(listing: string, selfPid: number): { node: number; vitest: number } | null {
  const procs = new Map<number, { ppid: number; args: string }>();
  for (const line of listing.split(/\r?\n/)) {
    const m = PROCESS_LINE.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), args: m[3].trim() });
  }
  if (procs.size === 0) return null;
  const ancestors = new Set<number>();
  for (let pid = procs.get(selfPid)?.ppid; pid !== undefined && pid !== selfPid && procs.has(pid) && !ancestors.has(pid); pid = procs.get(pid)!.ppid) ancestors.add(pid);
  const mine = new Set<number>([selfPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, p] of procs) {
      if (!mine.has(pid) && mine.has(p.ppid)) {
        mine.add(pid);
        grew = true;
      }
    }
  }
  let node = 0;
  let vitest = 0;
  for (const [pid, p] of procs) {
    if (ancestors.has(pid) || mine.has(pid) || !NODE_COMMAND.test(p.args)) continue;
    node++;
    if (/vitest/i.test(p.args)) vitest++;
  }
  return { node, vitest };
}

/**
 * `real`: failed every isolated rerun;
 * `load-flaky`: passed every isolated rerun (fails only under suite load, does not block);
 * `mixed`: failed some isolated reruns (may be a real race, blocks).
 * A file-level failure (setup or collection error, no failing title) reruns as the whole file.
 */
export type TriageClass = 'real' | 'load-flaky' | 'mixed';

export interface TriageResult {
  /** `<file> > <full title>` as listed by failingTitlesFromVitestJson. */
  title: string;
  file: string;
  runs: number;
  passes: number;
  class: TriageClass;
}

/** The test file and full title of a failing-title line; `name` is null for a file-level failure (setup or collection error). */
export function splitFailingTitle(line: string): { file: string; name: string | null } {
  const at = line.indexOf(' > ');
  return at < 0 ? { file: line, name: null } : { file: line.slice(0, at), name: line.slice(at + 3) };
}

/** Throws without a rerun: no evidence is no verdict ("passed 0/0" is never real). */
export function classifyTriage(runs: number, passes: number): TriageClass {
  if (!Number.isInteger(runs) || runs < 1) throw new RangeError(`flake triage needs at least one isolated rerun, got ${runs}`);
  if (passes === 0) return 'real';
  return passes === runs ? 'load-flaky' : 'mixed';
}

/** Whether a vitest JSON report has the test `name` in `file`, and it passed. */
export function testPassedInReport(text: string, file: string, name: string): boolean {
  let report: VitestJsonReport;
  try {
    report = JSON.parse(text) as VitestJsonReport;
  } catch {
    return false;
  }
  const entry = (report?.testResults ?? []).find((f) => repoRelativeTestPath(f.name ?? '') === file);
  const matches = (entry?.assertionResults ?? []).filter((a) => (a.fullName ?? a.title) === name);
  return matches.length > 0 && matches.every((a) => a.status === 'passed');
}

/** Whether a vitest JSON report has `file`, passed as a whole: at least one test passed and none failed. */
export function filePassedInReport(text: string, file: string): boolean {
  let report: VitestJsonReport;
  try {
    report = JSON.parse(text) as VitestJsonReport;
  } catch {
    return false;
  }
  const entry = (report?.testResults ?? []).find((f) => repoRelativeTestPath(f.name ?? '') === file);
  const results = entry?.assertionResults ?? [];
  return entry?.status === 'passed' && results.some((a) => a.status === 'passed') && !results.some((a) => a.status === 'failed');
}

/**
 * `.github/known-flaky-tests.json` entries (file, title, note) plus the
 * triage evidence, for the owner to approve by hand: the engine never edits
 * that file.
 */
export function flakyCandidates(version: string, triage: readonly TriageResult[]): Array<{ file: string; title: string; note: string; evidence: { class: TriageClass; runs: number; passes: number; release: string } }> {
  // A known-flaky entry needs a title: a file-level failure is never one (ship never excuses it), the baseline covers it.
  return triage.filter((t) => t.class !== 'real' && splitFailingTitle(t.title).name !== null).map((t) => ({
    file: t.file,
    title: splitFailingTitle(t.title).name!,
    note: `${t.class === 'load-flaky' ? 'load-sensitive: failed in the full suite, passed' : 'mixed: failed in the full suite, passed'} ${t.passes}/${t.runs} isolated reruns (v${version} release suite)`,
    evidence: { class: t.class, runs: t.runs, passes: t.passes, release: version },
  }));
}

/**
 * What `bridge/cli.cjs smoke copilot --tier 2` loads: a smoke is reused only while every one of these is unchanged.
 * Over-inclusion only costs a re-run; a missed input would reuse a stale green. Each is a shipped path (package.json
 * `files`): the plugin manifests (plugin.json, .claude-plugin), the dirs and .mcp.json the plugin points Copilot at,
 * scripts/ (copilot/hooks.json runs them; the smoke runs scripts/copilot/build-*.mjs --verify), templates, and
 * package-lock.json (the SDK version the scenarios load).
 */
export const SMOKE_INPUTS = [
  'dist', 'bridge', 'hooks', 'agents', 'skills', 'commands', 'copilot', 'scripts', 'templates',
  '.claude-plugin', '.mcp.json', 'plugin.json', 'package.json', 'package-lock.json',
] as const;

/** sha256 over `<path> <object id>` lines (`-` for an absent path), in SMOKE_INPUTS order. */
export function smokeInputHash(ids: ReadonlyArray<readonly [string, string | null]>): string {
  return createHash('sha256').update(ids.map(([path, id]) => `${path} ${id ?? '-'}\n`).join('')).digest('hex');
}

interface SmokeReportLike {
  ok?: unknown;
  skipped?: unknown;
  checks?: Array<{ id?: unknown; ok?: unknown; detail?: unknown }>;
}

/** Why a `smoke copilot --json` report is not a pass; empty = all checks passed. */
export function smokeProblems(stdout: string): string[] {
  const start = stdout.indexOf('{');
  let report: SmokeReportLike;
  try {
    report = JSON.parse(start >= 0 ? stdout.slice(start) : stdout) as SmokeReportLike;
  } catch {
    return ['smoke did not print a JSON report'];
  }
  const problems: string[] = [];
  if (typeof report.skipped === 'string' && report.skipped) problems.push(`smoke skipped: ${report.skipped}`);
  const checks = Array.isArray(report.checks) ? report.checks : [];
  if (checks.length === 0) problems.push('smoke reported no checks');
  for (const c of checks) if (c.ok !== true) problems.push(`${String(c.id)}: ${String(c.detail ?? 'failed')}`);
  if (report.ok !== true && problems.length === 0) problems.push('smoke report ok=false');
  return problems;
}

/**
 * The commit an annotated tag points at on the remote, from
 * `git ls-remote --tags <remote> refs/tags/<tag> 'refs/tags/<tag>^{}'`:
 * the peeled `^{}` line for an annotated tag, else the plain line
 * (lightweight). Null when the tag is absent.
 */
export function remoteTagTarget(lsRemote: string, tag: string): { object: string; commit: string; annotated: boolean } | null {
  let object: string | undefined;
  let peeled: string | undefined;
  for (const line of lsRemote.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === `refs/tags/${tag}`) object = sha;
    else if (ref === `refs/tags/${tag}^{}`) peeled = sha;
  }
  if (!object) return null;
  return { object, commit: peeled ?? object, annotated: peeled !== undefined };
}

/** Why a tag is not an annotated tag on `expected` (null = it is). */
export function tagTargetProblem(tag: string, objectType: string, peeled: string, expected: string): string | null {
  if (objectType.trim() !== 'tag') return `${tag} is a ${objectType.trim() || 'missing'} object, not an annotated tag`;
  if (peeled.trim() !== expected) return `${tag}^{} is ${peeled.trim().slice(0, 12) || 'unresolved'}, not the main merge commit ${expected.slice(0, 12)}`;
  return null;
}

/** Env overrides for the suite's children, or why the suite must not start. */
export type SuiteShell = { env: Record<string, string>; note?: string } | { problem: string };

/** A bash.exe that is the WSL launcher (System32, or the WindowsApps alias), not a POSIX shell for the tests. */
function isWslBash(path: string, env: Record<string, string | undefined>): boolean {
  const slashed = (s: string) => s.toLowerCase().replace(/\\/g, '/');
  const p = slashed(path);
  const system = `${slashed(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:/Windows').replace(/\/$/, '')}/`;
  return p.startsWith(`${system}system32/`) || p.startsWith(`${system}sysnative/`) || p.includes('/windowsapps/');
}

/**
 * Windows: the suite's tests spawn `bash`, and a PowerShell PATH resolves it
 * to the WSL launcher (System32\bash.exe), which fails them with exit 127.
 * When the first bash.exe on PATH is WSL's (or there is none), Git for
 * Windows' bin directory (next to `git --exec-path`'s root, else the default
 * install dirs) is put first on the PATH key the env already uses; `usr\bin`
 * only when no `bin` holds a bash.exe (with a note saying so); no Git
 * bash found is a problem. Elsewhere, and with a non-WSL bash first, no change.
 */
export function suiteShellFor(
  platform: string,
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
  gitExecPath: string | null,
): SuiteShell {
  if (platform !== 'win32') return { env: {} };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const path = env[key] ?? '';
  const first = path.split(';').filter(Boolean).map((dir) => win32.join(dir, 'bash.exe')).find(exists);
  if (first && !isWslBash(first, env)) return { env: {} };
  const roots = [
    ...(gitExecPath ? [win32.resolve(gitExecPath.trim(), '..', '..', '..')] : []),
    ...[env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter((d): d is string => !!d).map((d) => win32.join(d, 'Git')),
    ...(env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, 'Programs', 'Git')] : []),
  ];
  const hasBash = (dir: string) => exists(win32.join(dir, 'bash.exe'));
  const top = roots.map((r) => win32.join(r, 'bin')).find(hasBash);
  const bin = top ?? roots.map((r) => win32.join(r, 'usr', 'bin')).find(hasBash);
  if (!bin) {
    return { problem: `the suite needs Git for Windows bash, but ${first ? `the first bash on PATH is WSL's (${first})` : 'no bash.exe is on PATH'} and none was found under ${roots.join(', ') || '(no Git install dir)'}; install Git for Windows or put its bin directory first on PATH` };
  }
  const shell = { env: { [key]: `${bin};${path}` } };
  return top ? shell : { ...shell, note: `no bash.exe in Git for Windows' bin directory; the suite uses ${win32.join(bin, 'bash.exe')}` };
}
