/**
 * Opt-in auto-merge by trust tier (night-4 goal 4). Merge stays a human step
 * by default (merge-policy.ts); a repository whose USER config turns on
 * `factory.merge.auto` lets the engine (trusted) merge a low-risk PR itself.
 *
 * Config, user config at its default location only (userConfigLayers
 * `trustedUser`), keyed by repository: the run's repository URL (GitHub; same
 * repoIdentity) or, on the local forge, the repository root path.
 *
 *   "factory": { "merge": { "auto": {
 *     "https://github.com/o/r": { "enabled": true, "tiers": ["docs", "tests"] },
 *     "C:/Code/my-repo": { "enabled": true, "tiers": ["small"], "maxChangedLines": 40, "maxFiles": 3 }
 *   } } }
 *
 * A committed `factory.merge` (the base's `.copilot/omg.jsonc`) is ignored with
 * a notice: lanes can write committed config, so it must never widen trust.
 *
 * Everything here is pure (no git, no spawn): the engine reads the diff, the
 * labels and the human review and hands them in; autoMergeVerdict says
 * whether every condition holds and lists each condition's evidence.
 */

import { normalize, resolve } from 'path';
import { repoIdentity, sameRepo } from '../../ship/config.js';
import { PROTECTED_PATHS, protectedChanges } from '../../ship/merge.js';
import { CI_TREE_PATHS, LANE_PROTECTED_PATHS } from './lane-commit.js';

export const AUTO_MERGE_TIERS = ['docs', 'tests', 'small'] as const;
export type AutoMergeTier = (typeof AUTO_MERGE_TIERS)[number];

/** A label on the issue or PR that keeps the merge human. */
export const MANUAL_MERGE_LABEL = 'factory:manual-merge';
export const DEFAULT_SMALL_MAX_CHANGED_LINES = 80;
export const DEFAULT_SMALL_MAX_FILES = 10;
const MAX_CAP = 100_000;

export interface AutoMergeConfig {
  enabled: boolean;
  tiers: AutoMergeTier[];
  /** Explicit caps apply to every tier; "small" falls back to the defaults above. */
  maxChangedLines?: number;
  maxFiles?: number;
}

/**
 * The repository's `factory.merge.auto` entry from the trusted user config.
 * `config` undefined = off (no entry, or `enabled` false); `error` = a
 * malformed value (auto-merge stays off and the engine says why).
 */
export function resolveAutoMergeConfig(user: unknown, repo: { url?: string; root: string; local: boolean }): { config?: AutoMergeConfig; key?: string; error?: string } {
  const auto = (user as { factory?: { merge?: { auto?: unknown } } } | null | undefined)?.factory?.merge?.auto;
  if (auto === undefined || auto === null) return {};
  if (typeof auto !== 'object' || Array.isArray(auto)) return { error: 'factory.merge.auto must be an object keyed by repository' };
  const samePath = (a: string, b: string) => {
    const norm = (p: string) => normalize(resolve(p)).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
  };
  const matches = Object.keys(auto).filter((key) => {
    if (repo.local) return /^(?:[A-Za-z]:[\\/]|\/)/.test(key) && samePath(key, repo.root);
    return repo.url !== undefined && !repoIdentity(key).startsWith('path:') && sameRepo(key, repo.url);
  });
  if (matches.length === 0) return {};
  if (matches.length > 1) return { error: `factory.merge.auto has ${matches.length} entries for this repository (${matches.join(', ')}); keep one` };
  const key = matches[0];
  const v = (auto as Record<string, unknown>)[key];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { key, error: `factory.merge.auto["${key}"] must be an object` };
  const o = v as Record<string, unknown>;
  const unknownKeys = Object.keys(o).filter((k) => !['enabled', 'tiers', 'maxChangedLines', 'maxFiles'].includes(k));
  if (unknownKeys.length > 0) return { key, error: `factory.merge.auto["${key}"] has unknown keys: ${unknownKeys.join(', ')}` };
  if (typeof o.enabled !== 'boolean') return { key, error: `factory.merge.auto["${key}"].enabled must be a boolean` };
  if (!Array.isArray(o.tiers) || o.tiers.length === 0 || !o.tiers.every((t) => (AUTO_MERGE_TIERS as readonly unknown[]).includes(t))) {
    return { key, error: `factory.merge.auto["${key}"].tiers must be a non-empty list of ${AUTO_MERGE_TIERS.map((t) => `"${t}"`).join(', ')}` };
  }
  const cap = (name: 'maxChangedLines' | 'maxFiles'): number | undefined | string => {
    const n = o[name];
    if (n === undefined) return undefined;
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_CAP ? n : `factory.merge.auto["${key}"].${name} must be an integer from 1 to ${MAX_CAP}`;
  };
  const lines = cap('maxChangedLines');
  const files = cap('maxFiles');
  if (typeof lines === 'string') return { key, error: lines };
  if (typeof files === 'string') return { key, error: files };
  if (!o.enabled) return { key };
  return {
    key,
    config: {
      enabled: true,
      tiers: [...new Set(o.tiers as AutoMergeTier[])],
      ...(lines !== undefined ? { maxChangedLines: lines } : {}),
      ...(files !== undefined ? { maxFiles: files } : {}),
    },
  };
}

/** A committed config (the base's `.copilot/omg.jsonc`) that sets `factory.merge`: the engine ignores it and says so. */
export function committedMergeConfig(base: unknown): boolean {
  const merge = (base as { factory?: { merge?: unknown } } | null | undefined)?.factory?.merge;
  return merge !== undefined;
}

/** One changed path of `git diff --raw` + `--numstat` (no renames): modes and line counts. */
export interface ChangedEntry {
  path: string;
  oldMode: string;
  newMode: string;
  /** null: binary (numstat `-`). */
  added: number | null;
  deleted: number | null;
}

/**
 * `git diff --raw -z --no-renames --no-abbrev` and `git diff --numstat -z
 * --no-renames` of the same range, joined by path; null when either is
 * malformed or they disagree (the caller fails closed).
 */
export function parseChangedEntries(rawZ: string, numstatZ: string): ChangedEntry[] | null {
  const raw = rawZ.split('\0');
  const modes = new Map<string, { oldMode: string; newMode: string }>();
  for (let i = 0; i < raw.length; i++) {
    const head = raw[i];
    if (head === '') continue;
    const m = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} ([ADMT])$/.exec(head);
    const path = raw[i + 1];
    if (!m || path === undefined || path === '' || modes.has(path)) return null;
    modes.set(path, { oldMode: m[1], newMode: m[2] });
    i++;
  }
  const out: ChangedEntry[] = [];
  for (const rec of numstatZ.split('\0')) {
    if (rec === '') continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
    if (!m) return null;
    const mode = modes.get(m[3]);
    if (!mode || out.some((e) => e.path === m[3])) return null;
    out.push({ path: m[3], ...mode, added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) });
  }
  // A mode-only change has a raw line and a 0/0 numstat line; any raw path missing from numstat is a disagreement.
  return out.length === modes.size ? out : null;
}

const fold = (s: string): string => s.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').toUpperCase().toLowerCase().normalize('NFKC');
/** The path's folded segments (trailing dots and spaces dropped, `.` segments dropped), as Windows would open them. */
const segments = (path: string): string[] => fold(path.replace(/\\/g, '/').trim()).split('/').map((s) => s.replace(/[. ]+$/, '')).filter((s) => s.length > 0);

/** Directories that steer agents, editors, hooks, CI or the factory: a path with any such segment, anywhere, never auto-merges. */
const DENIED_DIRS = new Set(['.github', '.copilot', '.omg', '.omc', '.claude', '.vscode', '.husky', '.devcontainer', '.circleci', '.buildkite', '.woodpecker', '.azure-pipelines', '.azuredevops', '.pipelines', '.gitlab', '.idea', '.cargo', '.yarn', 'node_modules']);

/** File names (folded) that are package manifests, lockfiles, tool or agent config: denied in every directory. */
const DENIED_NAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lock', 'bun.lockb',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', '.nvmrc', '.node-version', '.tool-versions',
  'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'go.work', 'go.work.sum', 'pyproject.toml', 'poetry.lock', 'pipfile', 'pipfile.lock', 'uv.lock',
  'setup.py', 'setup.cfg', 'tox.ini', 'noxfile.py', 'conftest.py', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'gradlew', 'gradlew.bat',
  'directory.packages.props', 'directory.build.props', 'directory.build.targets', 'nuget.config', 'packages.lock.json', 'global.json',
  'jsconfig.json', '.babelrc', '.editorconfig', '.gitattributes', '.gitmodules', '.gitignore', '.mailmap',
  'dockerfile', 'compose.yaml', 'compose.yml', 'makefile', 'justfile', 'taskfile.yml', 'codeowners',
  'agents.md', 'claude.md', 'gemini.md', 'copilot-instructions.md', 'omg.jsonc', 'omc.jsonc', 'config.jsonc', '.mcp.json',
  'renovate.json', 'dependabot.yml', 'lefthook.yml', '.pre-commit-config.yaml', 'jenkinsfile',
  '.gitlab-ci.yml', '.travis.yml', 'appveyor.yml', '.appveyor.yml', '.drone.yml', 'bitbucket-pipelines.yml', '.woodpecker.yml',
  'azure-pipelines.yml', 'azure-pipelines.yaml',
]);

/** File-name patterns (folded) of the same kinds: requirements files, project files, tool configs, env files. */
const DENIED_NAME_PATTERNS: readonly RegExp[] = [
  /^requirements.*\.(?:txt|in)$/, /\.(?:csproj|fsproj|vbproj|sln|props|targets)$/, /^tsconfig.*\.json$/,
  /^\.eslintrc/, /^eslint\.config\./, /^\.prettierrc/, /^prettier\.config\./, /^\.stylelintrc/,
  /\.config\.[cm]?[jt]s$/, /^\.env(?:\..*)?$/, /^docker-compose.*\.ya?ml$/, /^\.?dockerfile\./,
];

/**
 * The changed paths no tier may auto-merge: the factory's and ship's
 * protected paths, every CI definition, `extra` (the configured protected
 * paths and known-flaky file), the denied directories anywhere in the path,
 * manifests, lockfiles and config by file name, and any path Windows could
 * resolve elsewhere (protectedChanges' raw `:`/`~`/`..` rule).
 */
export function deniedPaths(paths: readonly string[], extra: readonly string[] = []): string[] {
  const anchored = new Set(protectedChanges(paths, [...LANE_PROTECTED_PATHS, ...CI_TREE_PATHS, ...PROTECTED_PATHS, '.omg/', '.omc/', ...extra]));
  return paths.filter((p) => {
    if (anchored.has(p)) return true;
    const segs = segments(p);
    if (segs.length === 0) return true;
    if (segs.slice(0, -1).some((s) => DENIED_DIRS.has(s))) return true;
    const name = segs[segs.length - 1];
    return DENIED_DIRS.has(name) || DENIED_NAMES.has(name) || DENIED_NAME_PATTERNS.some((r) => r.test(name));
  });
}

/** docs: Markdown anywhere, or anything under the root `docs/` (manifests and config there are still denied). */
export function isDocsPath(path: string): boolean {
  const segs = segments(path);
  return segs.length > 0 && (segs[segs.length - 1].endsWith('.md') || (segs[0] === 'docs' && segs.length > 1));
}

const TEST_NAME = [/\.(?:test|spec)\.[cm]?[jt]sx?$/, /_test\.go$/, /^test_[^/]+\.py$/, /_test\.py$/, /(?:test|spec)\.rb$/];
const TEST_DIRS = new Set(['__tests__', '__snapshots__', 'test', 'tests', 'spec']);
const TEST_DIR_FILE = /\.(?:[cm]?[jt]sx?|py|go|rb|snap|json|txt|md)$/;

/** tests: a test file by name, or a source / snapshot / fixture-data file under a test directory. */
export function isTestPath(path: string): boolean {
  const segs = segments(path);
  if (segs.length === 0) return false;
  const name = segs[segs.length - 1];
  if (TEST_NAME.some((r) => r.test(name))) return true;
  return segs.slice(0, -1).some((s) => TEST_DIRS.has(s)) && TEST_DIR_FILE.test(name);
}

/** Only a plain, non-executable file may change (added, modified or deleted): no symlink, gitlink or mode flip. */
const plainMode = (mode: string): boolean => mode === '100644' || mode === '000000';

export interface TierResult {
  tier?: AutoMergeTier;
  reasons: string[];
  evidence: string[];
}

/**
 * The first enabled tier (docs, tests, small, in that order) every changed
 * file fits, after the checks every tier shares: at least one change, plain
 * file modes, no binary, no denied path, and the caps.
 */
export function classifyChanges(entries: readonly ChangedEntry[] | null, config: AutoMergeConfig, extraDenied: readonly string[] = []): TierResult {
  if (entries === null) return { reasons: ['the changed files could not be read (git diff --raw/--numstat base...head); auto-merge fails closed'], evidence: [] };
  if (entries.length === 0) return { reasons: ['the PR changes no file'], evidence: [] };
  const reasons: string[] = [];
  const list = (ps: string[]) => `${ps.slice(0, 5).join(', ')}${ps.length > 5 ? `, and ${ps.length - 5} more` : ''}`;
  const odd = entries.filter((e) => !plainMode(e.oldMode) || !plainMode(e.newMode) || (e.oldMode === '000000' && e.newMode === '000000'));
  if (odd.length > 0) reasons.push(`non-plain file modes (symlink, gitlink, executable or mode change): ${list(odd.map((e) => `${e.path} ${e.oldMode}->${e.newMode}`))}`);
  const binary = entries.filter((e) => e.added === null || e.deleted === null);
  if (binary.length > 0) reasons.push(`binary changes: ${list(binary.map((e) => e.path))}`);
  const denied = deniedPaths(entries.map((e) => e.path), extraDenied);
  if (denied.length > 0) reasons.push(`touches paths that always need a human (CI, config, manifests, lockfiles, agent or factory files): ${list(denied)}`);
  const lines = entries.reduce((n, e) => n + (e.added ?? 0) + (e.deleted ?? 0), 0);
  const files = entries.length;
  const evidence = [`${files} file(s), ${lines} changed line(s), plain file modes, no binary, no denied path`];
  if (reasons.length > 0) return { reasons, evidence: [] };
  const misses: string[] = [];
  for (const tier of AUTO_MERGE_TIERS) {
    if (!config.tiers.includes(tier)) continue;
    const maxLines = config.maxChangedLines ?? (tier === 'small' ? DEFAULT_SMALL_MAX_CHANGED_LINES : undefined);
    const maxFiles = config.maxFiles ?? (tier === 'small' ? DEFAULT_SMALL_MAX_FILES : undefined);
    const outside = tier === 'docs' ? entries.filter((e) => !isDocsPath(e.path)) : tier === 'tests' ? entries.filter((e) => !isTestPath(e.path)) : [];
    if (outside.length > 0) { misses.push(`${tier}: ${list(outside.map((e) => e.path))} ${outside.length === 1 ? 'is' : 'are'} not ${tier === 'docs' ? 'docs' : 'test files'}`); continue; }
    if (maxLines !== undefined && lines > maxLines) { misses.push(`${tier}: ${lines} changed lines > maxChangedLines ${maxLines}`); continue; }
    if (maxFiles !== undefined && files > maxFiles) { misses.push(`${tier}: ${files} files > maxFiles ${maxFiles}`); continue; }
    return { tier, reasons: [], evidence: [...evidence, `every file fits tier ${tier}${maxLines !== undefined ? ` (lines ${lines}/${maxLines}` : ''}${maxFiles !== undefined ? `${maxLines !== undefined ? ', ' : ' ('}files ${files}/${maxFiles}` : ''}${maxLines !== undefined || maxFiles !== undefined ? ')' : ''}`] };
  }
  return { reasons: [`no enabled tier fits (${misses.join('; ')})`], evidence: [] };
}

/** Park names whose presence in the run's history keeps the merge human (tamper, secrets, sandbox, protected paths, allow-* flags). */
const HISTORY_DENY = /^awaiting-human: (lane-tampered|review-tampered|state-tampered|sandbox-escaped|secret-shaped-content|gates-unsandboxed|gate-definition-changed|gate-definition-unknown|protected-paths|decisions-rewritten|review-identity|lane-unconfirmed|head-moved-externally|repo-guard-changed|import-refused):/;

export interface AutoMergeRunFacts {
  /** The run is a ci-heal run (no issue): never auto-merged. */
  ciHeal: boolean;
  forgeKind: 'github' | 'local' | 'azure-devops';
  history: readonly { note: string }[];
  unsandboxedAck?: string;
  unsandboxedGatesAck?: string;
  gateChangeApproved?: string;
  secretAck?: readonly unknown[];
}

export interface AutoMergeInput {
  head: string;
  config: AutoMergeConfig;
  run: AutoMergeRunFacts;
  /** decideMerge (+ forge policies) on this head. */
  decision: { ok: boolean; reasons: readonly string[]; noChecks?: true; checks?: readonly string[] };
  /** ship's latest verifier verdict. */
  verdict?: { sha: string; verdict: string; reviewer: string };
  /** The human review read on this head: undefined = not read (factory.review.human "off"). */
  human?: { commentOnly: number };
  /** Issue and PR labels; null = unreadable. */
  labels: readonly string[] | null;
  changes: TierResult;
}

export interface AutoMergeVerdict {
  ok: boolean;
  tier?: AutoMergeTier;
  reasons: string[];
  /** One line per condition that held, for the run history and the PR comment. */
  evidence: string[];
}

/** Every auto-merge condition on the exact head; all must hold. */
export function autoMergeVerdict(i: AutoMergeInput): AutoMergeVerdict {
  const reasons: string[] = [];
  const evidence: string[] = [];
  const at = i.head.slice(0, 12);
  const check = (ok: boolean, good: string, bad: string) => (ok ? evidence.push(good) : reasons.push(bad));

  check(i.run.forgeKind !== 'azure-devops', `forge ${i.run.forgeKind}`, 'Azure DevOps PRs always merge by a human (no head-pinned engine merge there)');
  check(!i.run.ciHeal, 'issue run', 'ci-heal runs always merge by a human');
  check(i.decision.ok && i.decision.reasons.length === 0, 'ship\'s merge rule allows this head with no reason', `ship's merge rule has reasons: ${i.decision.reasons.join('; ')}`);
  const v = i.verdict;
  check(!!v && v.verdict === 'approve' && v.sha === i.head, `factory review approved ${at}${v ? ` (${v.reviewer})` : ''}`, `the factory review did not approve this exact head (latest: ${v ? `${v.verdict} at ${v.sha.slice(0, 12)}` : 'none'})`);
  const checks = i.decision.checks ?? [];
  check(!i.decision.noChecks && checks.length > 0, `CI green at ${at}: ${checks.slice(0, 8).join(', ')}${checks.length > 8 ? ', ...' : ''}`, 'no CI check reported for this head (a green gate with no checks never auto-merges)');
  check(i.human !== undefined, 'human review read: no open thread or change request', 'factory.review.human is "off", so human review threads are not read');
  if (i.human) check(i.human.commentOnly === 0, 'no comment-only human review at this head', `${i.human.commentOnly} comment-only human review(s) at this head`);
  check(i.labels !== null && !i.labels.some((l) => l.toLowerCase() === MANUAL_MERGE_LABEL), `no ${MANUAL_MERGE_LABEL} label`, i.labels === null ? 'the issue or PR labels could not be read' : `the issue or PR carries ${MANUAL_MERGE_LABEL}`);

  const flagged = i.run.history.map((h) => HISTORY_DENY.exec(h.note)?.[1]).filter((n): n is string => !!n);
  const tamper = i.run.history.some((h) => /tamper|quarantin/i.test(h.note));
  const acks = [
    ...(i.run.unsandboxedAck ? ['--allow-unsandboxed-lanes'] : []),
    ...(i.run.unsandboxedGatesAck ? ['--allow-unsandboxed-gates'] : []),
    ...(i.run.gateChangeApproved ? ['--allow-gate-change'] : []),
    ...(i.run.secretAck && i.run.secretAck.length > 0 ? ['--allow-secret-shapes'] : []),
    ...(i.run.history.some((h) => /--allow-[a-z-]+/.test(h.note)) ? ['an --allow-* flag (run history)'] : []),
  ];
  check(flagged.length === 0 && !tamper, 'no secret-scan, tamper or sandbox park in this run', `this run parked at ${[...new Set(flagged)].join(', ') || 'a tamper or quarantine hold'}`);
  check(acks.length === 0, 'no --allow-* acknowledgement in this run', `this run used ${[...new Set(acks)].join(', ')}`);

  if (i.changes.tier) evidence.push(...i.changes.evidence);
  else reasons.push(...i.changes.reasons);
  return reasons.length === 0 ? { ok: true, tier: i.changes.tier, reasons, evidence } : { ok: false, reasons, evidence };
}

/** The PR comment after the engine merged: the tier and every condition's evidence. */
export function autoMergeComment(label: string, tier: AutoMergeTier, head: string, evidence: readonly string[], by: string): string {
  return [
    `Factory run for ${label}: auto-merged by tier ${tier} at ${head.slice(0, 12)} (${by}).`,
    '',
    'Every auto-merge condition held on this exact head:',
    '',
    ...evidence.map((e) => `- ${e}`),
    '',
    `factory.merge.auto in your user config turns this on per repository; add the ${MANUAL_MERGE_LABEL} label to keep a PR's merge human.`,
    '',
  ].join('\n');
}
