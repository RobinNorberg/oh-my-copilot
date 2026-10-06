#!/usr/bin/env node
/**
 * Upstream drift: notice new upstream `dev` commits, apply the range diff with
 * the fork's exclusions and rename map, and report the outcome.
 * Contract: .omc/skills/port-upstream.md (range diff, rename map, DO-NOT-RENAME).
 *
 *   node scripts/port/upstream-drift.mjs --check  [--base <sha>] [--head <ref>] [--json]
 *   node scripts/port/upstream-drift.mjs --apply  [--base <sha>] [--head <ref>] [--date YYYY-MM-DD]
 *   node scripts/port/upstream-drift.mjs --report [--base <sha>] [--head <ref>] [--markdown]
 *
 * --base defaults to `upstream_sha` in .github/upstream-port.json; --head
 * defaults to `upstream/<upstream_branch>`. Exit codes: --check 0 = up to
 * date, 1 = new commits; --apply 0 = clean, 1 = conflicts; 2 = usage or git
 * error. --apply needs a clean tracked tree and leaves its result staged
 * (conflicts unmerged); it never commits.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER_PATH = '.github/upstream-port.json';
/** Never applied: release artifacts and fork-owned release metadata (port-upstream.md, Range-diff workflow). */
export const EXCLUDED_PATHS = [
  'dist', 'bridge', 'inventory', 'package-lock.json', 'package.json', 'CHANGELOG.md', 'README.md',
  '.github/release-body.md', '.github/generated-artifact-authorizations.json',
];
/** Upstream release markers: dropped, nothing in the fork reads them. */
export const DROPPED_PATHS = ['.github/RELEASE_SIGNOFF'];
/** Upstream CI is not ported by policy, and a GITHUB_TOKEN push cannot touch workflow files. */
export const SKIPPED_PATHS = ['.github/workflows'];
/** Directories whose new `oh-my-claudecode` mentions count as leaks. */
export const LEAK_DIRS = ['src', 'agents', 'skills', 'hooks'];
/** Fork-maintainer docs: they talk about upstream by name on purpose. */
export const RENAME_SKIP_PATHS = ['.omc'];
/** DO-NOT-RENAME: protected before the rules run, restored after. */
export const PROTECTED = [
  /Yeachan-Heo\/oh-my-claudecode/gi, // upstream issue/PR links stay pointed at upstream
  /platform\.claude\.com/g,
  /claudeAiOauth/g,
  /CLAUDE_PLUGIN_ROOT/g,
  /\.claude\/settings\.local\.json/g,
];
/** The mechanical part of the rename map; the rest (`omc` CLI prose, `.claude/` host dir, OMC_CLI_BINARY) needs judgement. */
export const RENAME_RULES = [
  { from: /oh-my-claudecode/g, to: 'oh-my-copilot' },
  {
    from: /\bCLAUDE_CONFIG_DIR\b/g, to: 'COPILOT_HOME',
    exceptFiles: ['src/hooks/permission-handler/index.ts', 'skills/omc-setup/phases/04-welcome.md'],
  },
  { from: /\bCLAUDE_FAMILY_DEFAULTS\b/g, to: 'COPILOT_FAMILY_DEFAULTS' },
  { from: /\bisNonClaudeProvider\b/g, to: 'isNonCopilotProvider' },
  { from: /\bskipClaudeCheck\b/g, to: 'skipCopilotCheck' },
  { from: /\bisClaudeInstalled\b/g, to: 'isCopilotInstalled' },
  { from: /\bisClaudeAvailable\b/g, to: 'isCopilotAvailable' },
  { from: /\bhasClaudeCode\b/g, to: 'hasCopilotCode' },
  { from: /\bgetClaudeConfigDir\b/g, to: 'getCopilotConfigDir' },
  { from: /\bgetClaude(\w*Permission\w*)/g, to: 'getCopilot$1' },
  { from: /\bclaude-native\b/g, to: 'copilot-native' },
  { from: /\btmux-claude\b/g, to: 'tmux-copilot' },
  { from: /\bomc-hud(?![\w-])/g, to: 'omg-hud' }, // the HUD name, not `omc-hud-<suffix>` temp prefixes
  { from: /\.claude\/omc\.jsonc/g, to: '.copilot/omg.jsonc' },
  { from: /(^|[^\w.-])\.omc\//g, to: '$1.omg/' },
  { from: /(['"`])\.omc\1/g, to: '$1.omg$1' },
];
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const NULL_SHA = '0'.repeat(40);

const under = (path, prefixes) => prefixes.some((p) => path === p || path.startsWith(`${p}/`));

/** Apply the mechanical rename map to one line (idempotent). */
export function renameLine(line, filePath = '') {
  const saved = [];
  let text = line;
  for (const re of PROTECTED) {
    text = text.replace(re, (m) => `\u0000${saved.push(m) - 1}\u0000`);
  }
  for (const rule of RENAME_RULES) {
    if (rule.exceptFiles?.includes(filePath)) continue;
    text = text.replace(rule.from, rule.to);
  }
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => saved[Number(i)]);
}

export function createGit(cwd) {
  const run = (args, opts = {}) => {
    const res = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd, encoding: opts.encoding ?? 'utf8', input: opts.input, maxBuffer: 512 * 1024 * 1024,
    });
    if (res.error) throw res.error;
    if (res.status !== 0 && !opts.allowFail) {
      const err = new Error(`git ${args.join(' ')} failed (${res.status}): ${String(res.stderr).trim()}`);
      err.status = res.status;
      throw err;
    }
    return res;
  };
  const out = (args, opts) => String(run(args, opts).stdout).trimEnd();
  const blob = (rev, path) => {
    const res = run(['rev-parse', '--verify', '--quiet', `${rev}:${path}`], { allowFail: true });
    return res.status === 0 ? String(res.stdout).trim() : null;
  };
  return { run, out, blob };
}

/** The committed marker: --apply rewrites the worktree copy, the base stays what HEAD says. */
export function readMarker(git) {
  const res = git.run(['show', `HEAD:${MARKER_PATH}`], { allowFail: true });
  return res.status === 0 ? JSON.parse(String(res.stdout)) : null;
}

function resolveRange(git, { base, head }) {
  const marker = readMarker(git);
  const baseRef = base ?? marker?.upstream_sha;
  if (!baseRef) throw usage(`no --base given and ${MARKER_PATH} has no upstream_sha`);
  const headRef = head ?? `upstream/${marker?.upstream_branch ?? 'dev'}`;
  const sha = (ref) => git.out(['rev-parse', '--verify', `${ref}^{commit}`]);
  return { base: sha(baseRef), head: sha(headRef), headRef, branch: marker?.upstream_branch ?? 'dev' };
}

function listCommits(git, base, head) {
  const raw = git.out(['log', '--reverse', '--format=%H%x1f%s', `${base}..${head}`]);
  return raw ? raw.split('\n').map((l) => { const [sha, subject] = l.split('\x1f'); return { sha, subject }; }) : [];
}

/** Every path the range touches, classified by what the port does with it. */
export function classifyRange(git, base, head) {
  const raw = git.out(['diff', '--name-status', '--no-renames', '-z', base, head]);
  const parts = raw ? raw.split('\0').filter((p, i, a) => !(i === a.length - 1 && p === '')) : [];
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i][0];
    const path = parts[i + 1];
    let action = 'apply';
    if (under(path, EXCLUDED_PATHS)) action = 'excluded';
    else if (under(path, DROPPED_PATHS)) action = 'dropped';
    else if (under(path, SKIPPED_PATHS)) action = 'skipped';
    files.push({ status, path, action });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Split a `git diff --no-renames` patch into per-path sections. */
function splitPatch(patch) {
  const sections = new Map();
  const starts = [...patch.matchAll(/^diff --git /gm)].map((m) => m.index);
  starts.forEach((start, i) => {
    const text = patch.slice(start, starts[i + 1] ?? patch.length);
    const header = text.slice(0, text.indexOf('\n'));
    const body = header.slice('diff --git '.length);
    if (body.startsWith('"')) throw new Error(`unsupported quoted path in patch: ${header}`);
    const len = (body.length - 5) / 2; // "a/P b/P"
    sections.set(body.slice(2, 2 + len), text);
  });
  return sections;
}

function setUnmerged(git, path, stages) {
  const lines = [`0 ${NULL_SHA}\t${path}`];
  for (const [stage, mode, sha] of stages) lines.push(`${mode} ${sha} ${stage}\t${path}`);
  git.run(['update-index', '--index-info'], { input: `${lines.join('\n')}\n` });
}

function modeOf(git, rev, path) {
  return git.out(['ls-tree', rev, '--', path]).split(/\s/)[0] || '100644';
}

/** Line numbers (1-based) the worktree file adds relative to `oldText`. */
function addedLines(oldText, newText, scratch) {
  const a = join(scratch, 'old');
  const b = join(scratch, 'new');
  writeFileSync(a, oldText.replace(/\r/g, ''));
  writeFileSync(b, newText.replace(/\r/g, ''));
  const res = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', '--no-ext-diff', '-U0', 'old', 'new'], {
    cwd: scratch, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  if (res.status !== 0 && res.status !== 1) throw new Error(`git diff --no-index failed: ${res.stderr}`);
  const added = new Set();
  for (const m of res.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let n = start; n < start + count; n++) added.add(n);
  }
  return added;
}

function isRegularFile(abs) {
  try { return lstatSync(abs).isFile(); } catch { return false; }
}

/** Rename only the lines the port introduced, so fork-retained upstream text stays. */
function renameTouched(git, cwd, paths, scratch) {
  const renamed = [];
  for (const path of paths) {
    if (under(path, RENAME_SKIP_PATHS)) continue;
    const abs = join(cwd, path);
    if (!isRegularFile(abs)) continue; // symlinks, gitlinks
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue; // binary
    const text = buf.toString('utf8');
    if (!buf.equals(Buffer.from(text, 'utf8'))) continue; // not UTF-8: rewriting would re-encode it
    const old = git.blob('HEAD', path) ? String(git.run(['cat-file', 'blob', `HEAD:${path}`]).stdout) : '';
    const added = addedLines(old, text, scratch);
    if (added.size === 0) continue;
    let changes = 0;
    const lines = text.split('\n').map((line, i) => {
      if (!added.has(i + 1)) return line;
      const next = renameLine(line, path);
      if (next !== line) changes++;
      return next;
    });
    if (changes > 0) {
      writeFileSync(abs, lines.join('\n'));
      renamed.push({ path, lines: changes });
    }
  }
  return renamed;
}

function conflicts(git) {
  const raw = git.out(['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  return raw.split('\0').filter(Boolean)
    .map((e) => ({ status: e.slice(0, 2), path: e.slice(3) }))
    .filter((e) => UNMERGED.has(e.status))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function applyRange(cwd, opts) {
  const git = createGit(cwd);
  const range = resolveRange(git, opts);
  const dirty = git.out(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw usage(`working tree has tracked changes; --apply needs a clean checkout:\n${dirty}`);
  const files = classifyRange(git, range.base, range.head);
  const applied = files.filter((f) => f.action === 'apply');
  const notes = [];
  const scratch = mkdtempSync(join(tmpdir(), 'upstream-drift-'));
  try {
    // Whole-range diff when the pathspec would overflow a Windows command line;
    // splitPatch() then picks only the applied sections either way.
    const paths = applied.map((f) => f.path);
    const pathspec = paths.join(' ').length > 24000 ? [] : ['--', ...paths];
    const patch = paths.length
      ? String(git.run(['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', 'diff', '--binary', '--no-renames', '--full-index',
        '--no-ext-diff', '--no-textconv', '--no-color', range.base, range.head, ...pathspec]).stdout)
      : '';
    const sections = splitPatch(patch);
    const keep = [];
    const late = []; // unmerged entries to record after the atomic apply
    for (const f of applied) {
      const section = sections.get(f.path);
      if (!section) continue;
      const ours = git.blob('HEAD', f.path);
      if (f.status === 'D') {
        if (!ours) { notes.push(`${f.path}: deleted upstream, already absent in the fork`); continue; }
        if (ours === git.blob(range.base, f.path)) { keep.push(section); continue; }
        late.push({ path: f.path, kind: 'UD', ours });
      } else if (f.status === 'A') {
        if (!ours) { keep.push(section); continue; }
        if (ours === git.blob(range.head, f.path)) { notes.push(`${f.path}: added upstream, already identical in the fork`); continue; }
        late.push({ path: f.path, kind: 'AA', ours });
      } else if (!ours) {
        late.push({ path: f.path, kind: 'DU' });
      } else {
        keep.push(section);
      }
    }
    if (keep.length) {
      const patchFile = join(scratch, 'range.patch');
      writeFileSync(patchFile, keep.join(''));
      const res = git.run(['apply', '--3way', '--whitespace=nowarn', patchFile], { allowFail: true });
      if (res.status !== 0 && conflicts(git).length === 0) {
        throw new Error(`git apply --3way failed without leaving conflicts:\n${String(res.stderr).trim()}`);
      }
    }
    for (const c of late) {
      if (c.kind === 'UD') {
        setUnmerged(git, c.path, [[1, modeOf(git, range.base, c.path), git.blob(range.base, c.path)], [2, modeOf(git, 'HEAD', c.path), c.ours]]);
      } else if (c.kind === 'DU') {
        // Like a merge: leave upstream's version in the worktree for the reviewer.
        mkdirSync(dirname(join(cwd, c.path)), { recursive: true });
        writeFileSync(join(cwd, c.path), git.run(['cat-file', 'blob', git.blob(range.head, c.path)], { encoding: 'buffer' }).stdout);
        setUnmerged(git, c.path, [[1, modeOf(git, range.base, c.path), git.blob(range.base, c.path)], [3, modeOf(git, range.head, c.path), git.blob(range.head, c.path)]]);
      } else {
        const theirs = git.blob(range.head, c.path);
        const oursFile = join(scratch, 'ours'); const emptyFile = join(scratch, 'empty'); const theirsFile = join(scratch, 'theirs');
        writeFileSync(oursFile, git.run(['cat-file', 'blob', c.ours], { encoding: 'buffer' }).stdout);
        writeFileSync(emptyFile, '');
        writeFileSync(theirsFile, git.run(['cat-file', 'blob', theirs], { encoding: 'buffer' }).stdout);
        const merged = spawnSync('git', ['merge-file', '-p', '-L', 'HEAD', '-L', 'base', '-L', range.head.slice(0, 9), oursFile, emptyFile, theirsFile], { maxBuffer: 512 * 1024 * 1024 });
        writeFileSync(join(cwd, c.path), merged.stdout);
        setUnmerged(git, c.path, [[2, modeOf(git, 'HEAD', c.path), c.ours], [3, modeOf(git, range.head, c.path), theirs]]);
      }
    }
    const touched = applied.filter((f) => f.status !== 'D').map((f) => f.path);
    const renamed = renameTouched(git, cwd, touched, scratch);
    const unmerged = new Set(conflicts(git).map((c) => c.path));
    const stage = renamed.map((r) => r.path).filter((p) => !unmerged.has(p));
    writeMarker(cwd, range, opts.date);
    stage.push(MARKER_PATH);
    git.run(['add', '--', ...stage]);
    return { range, renamed, notes, report: buildReport(cwd, { base: range.base, head: range.head }) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function writeMarker(cwd, range, date) {
  const marker = {
    upstream_sha: range.head,
    upstream_branch: range.branch,
    ported_at: date ?? new Date().toISOString().slice(0, 10),
    fork_version: 'unreleased',
  };
  writeFileSync(join(cwd, MARKER_PATH), `${JSON.stringify(marker, null, 2)}\n`);
}

/** Lines mentioning oh-my-claudecode outside the protected forms. */
function leakLines(text) {
  return text.replace(/\r/g, '').split('\n').filter((line) => {
    let t = line;
    for (const re of PROTECTED) t = t.replace(re, '');
    return /oh-my-claudecode/i.test(t);
  });
}

export function buildReport(cwd, opts = {}) {
  const git = createGit(cwd);
  const range = resolveRange(git, opts);
  const files = classifyRange(git, range.base, range.head);
  const conflictList = conflicts(git);
  const leaks = [];
  const scanned = new Set([...files.filter((f) => f.action === 'apply').map((f) => f.path), ...conflictList.map((c) => c.path)]);
  for (const path of [...scanned].sort()) {
    if (!under(path, LEAK_DIRS)) continue;
    const abs = join(cwd, path);
    if (!isRegularFile(abs)) continue;
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue;
    const before = git.blob('HEAD', path) ? new Set(leakLines(String(git.run(['cat-file', 'blob', `HEAD:${path}`]).stdout))) : new Set();
    buf.toString('utf8').replace(/\r/g, '').split('\n').forEach((line, i) => {
      if (leakLines(line).length && !before.has(line)) leaks.push({ path, line: i + 1, text: line.trim() });
    });
  }
  const pkg = git.out(['diff', '--no-color', range.base, range.head, '--', 'package.json']);
  const report = {
    base: range.base,
    head: range.head,
    upstream_ref: range.headRef,
    commits: listCommits(git, range.base, range.head),
    files,
    conflicts: conflictList,
    clean: conflictList.length === 0,
    leaks,
    package_json_delta: pkg,
  };
  report.titles = { pr: prTitle(report), issue: issueTitle(report) };
  return report;
}

const short = (sha) => sha.slice(0, 9);
// GitHub caps issue/PR bodies at 65536 characters.
const MAX_ROWS = 150;
const MAX_BODY = 60000;

/** Upstream text in a code span: `#123` would link fork issues and `@user` would ping people. */
const codeSpan = (text) => `\`${text.replace(/`/g, "'")}\``;

function capped(rows, render) {
  const shown = rows.slice(0, MAX_ROWS).map(render);
  if (rows.length > MAX_ROWS) shown.push(`- ... and ${rows.length - MAX_ROWS} more`);
  return shown.join('\n');
}

export function prTitle(report) {
  return `port: upstream ${short(report.base)}..${short(report.head)} (bot)`;
}

export function issueTitle(report) {
  return `Upstream drift: ${report.commits.length} commits since ${short(report.base)}, conflicts in ${report.conflicts.length} files`;
}

export function renderMarkdown(report) {
  const applied = report.files.filter((f) => f.action === 'apply');
  const other = report.files.filter((f) => f.action !== 'apply');
  const out = [
    `<!-- upstream-drift-head: ${report.head} -->`,
    `<!-- upstream-drift-base: ${report.base} -->`,
    `Upstream \`${report.upstream_ref}\` moved \`${short(report.base)}..${short(report.head)}\`: ${report.commits.length} commits, ${applied.length} files to port.`,
    report.clean
      ? 'The range applied cleanly with the rename map. Still to do by hand (`.omc/skills/port-and-release-cycle.md`): package.json delta, generators, build, inventory, tests, smoke.'
      : `The range does not apply cleanly: ${report.conflicts.length} files need reconciliation per \`.omc/skills/port-upstream.md\`.`,
    '',
  ];
  if (!report.clean) {
    out.push('### Conflicts', '', capped(report.conflicts, (c) => `- \`${c.status}\` ${c.path}`), '');
  }
  out.push('### Commits', '', capped(report.commits, (c) => `- ${short(c.sha)} ${codeSpan(c.subject)}`), '');
  out.push('### Files', '', applied.length ? capped(applied, (f) => `- \`${f.status}\` ${f.path}`) : '- none', '');
  if (other.length) {
    out.push('### Not applied', '', capped(other, (f) => `- \`${f.status}\` ${f.path} (${f.action})`), '');
  }
  out.push('### package.json delta', '');
  out.push(report.package_json_delta ? ['```diff', report.package_json_delta.slice(0, 10000), '```'].join('\n') : 'none');
  out.push('', '### Leak scan (`oh-my-claudecode` in src/ agents/ skills/ hooks/)', '');
  out.push(report.leaks.length ? capped(report.leaks, (l) => `- ${l.path}:${l.line} ${codeSpan(l.text.slice(0, 160))}`) : 'clean');
  const body = `${out.join('\n')}\n`;
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n_(truncated; run \`--report\` locally for the full list)_\n` : body;
}

function usage(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

function parseArgs(argv) {
  const opts = { mode: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw usage(`${a} needs a value`);
      return v;
    };
    if (a === '--check' || a === '--apply' || a === '--report') {
      if (opts.mode) throw usage('pick one of --check, --apply, --report');
      opts.mode = a.slice(2);
    } else if (a === '--base') opts.base = value();
    else if (a === '--head') opts.head = value();
    else if (a === '--repo') opts.repo = value();
    else if (a === '--date') opts.date = value();
    else if (a === '--json') opts.json = true;
    else if (a === '--markdown') opts.markdown = true;
    else throw usage(`unknown argument: ${a}`);
  }
  if (!opts.mode) throw usage('pick one of --check, --apply, --report');
  return opts;
}

export function main(argv, cwd = process.cwd()) {
  const opts = parseArgs(argv);
  const repo = resolve(opts.repo ?? cwd);
  const git = createGit(repo);
  if (opts.mode === 'check') {
    const range = resolveRange(git, opts);
    const commits = listCommits(git, range.base, range.head);
    const ancestor = git.run(['merge-base', '--is-ancestor', range.base, range.head], { allowFail: true }).status === 0;
    if (!ancestor) console.error(`warning: ${short(range.base)} is not an ancestor of ${range.headRef}`);
    if (opts.json) {
      console.log(JSON.stringify({ base: range.base, head: range.head, upstream_ref: range.headRef, count: commits.length, commits }, null, 2));
    } else {
      console.log(`${commits.length} new upstream commits since ${short(range.base)} (${range.headRef} at ${short(range.head)})`);
      for (const c of commits) console.log(`  ${short(c.sha)} ${c.subject}`);
    }
    return commits.length > 0 ? 1 : 0;
  }
  if (opts.mode === 'apply') {
    const { range, renamed, notes, report } = applyRange(repo, opts);
    console.log(`applied ${short(range.base)}..${short(range.head)}: ${report.files.filter((f) => f.action === 'apply').length} files, ${report.conflicts.length} conflicts`);
    for (const r of renamed) console.log(`  renamed ${r.lines} line(s) in ${r.path}`);
    for (const n of notes) console.log(`  note: ${n}`);
    for (const c of report.conflicts) console.log(`  ${c.status} ${c.path}`);
    if (report.package_json_delta) console.log('package.json delta (port by hand):\n' + report.package_json_delta);
    return report.clean ? 0 : 1;
  }
  const report = buildReport(repo, opts);
  process.stdout.write(opts.markdown ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`upstream-drift: ${err.message}`);
    process.exitCode = 2;
  }
}
