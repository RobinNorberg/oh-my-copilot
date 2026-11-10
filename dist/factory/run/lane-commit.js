/**
 * Engine-side commits for `omg factory run` write lanes
 * (.omc/plans/2026-10-27-sandboxed-lanes-design.md §4.3).
 *
 * A write lane's sandbox keeps the common git dir read-only, so the lane only
 * edits its worktree. The engine commits for it, after the lane confirmed its
 * end and passed the tamper check, with host git hardened by runHostGit: no
 * hook, fsmonitor, filter or diff driver, GIT_ATTR_SOURCE the empty tree,
 * and the git dir, work tree and common dir pinned to the links recorded when
 * the worktree was created (a changed link refuses before any git runs).
 *
 * The commit is built from objects: the engine reads every changed file
 * itself and writes the bytes as blobs into a temporary index seeded from the
 * start tree (stageEngineRead: git never reads the worktree, so a link swapped
 * in after the checks cannot make git read a file outside it), then
 * `write-tree` and `commit-tree` with engine-chosen parents and the
 * engine-owned identity, so no commit hook and no signing program runs and
 * nothing the lane wrote picks the author. The lane's branch and its
 * worktree's HEAD move to the commit only from the value they started at.
 * The caller first proves the lane's process tree gone (lane-procs.ts).
 *
 * Refused before any commit: a lane that moved its HEAD, a new or changed
 * gitlink (host git never enters a nested repository, so its content is
 * unreviewed), a link host git could follow out of the worktree, a
 * merge-rule or lane-protected path, secret-shaped content (heal/sanitize.ts
 * SECRET_SHAPES: a key or token the lane could have copied in from outside
 * its sandbox) unless acknowledged or allow-listed, and an empty change.
 *
 * Links: Git for Windows follows a directory junction in `add -A`, and the
 * engine's git runs outside the sandbox with the user's read rights, so a
 * junction to `~/.ssh` would be committed and pushed by the engine. Before
 * staging, the worktree (minus what git ignores) is walked with lstat: a
 * directory link, or on win32 any link, refuses. After staging, a new or
 * changed symlink entry (120000) refuses, and so does a staged path whose
 * real directory is outside the worktree's; those refusals reset the index
 * to the start tree.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { jobRefProblem } from '../../copilot-run/job.js';
import { secretShapeKinds } from '../heal/sanitize.js';
import { OmcPaths } from '../../lib/worktree-paths.js';
import { protectedChanges } from '../../ship/merge.js';
import { EMPTY_TREE, runHostGit, runHostGitBuffer, worktreeGitDirArgs } from '../../team/git-worktree.js';
/** Author and committer of every engine-made lane commit (fixed: nothing a lane wrote chooses it). */
export const ENGINE_COMMIT_IDENTITY = Object.freeze({ name: 'omg factory', email: 'omg-factory@oh-my-copilot.invalid' });
const GIT_TIMEOUT_MS = 60_000;
/** A commit message is cut at this many characters. */
const MAX_MESSAGE_CHARS = 4_000;
const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Untracked runtime state a lane's plugin hooks write in its worktree; never committed. */
const RUNTIME_STATE_DIRS = ['state', 'sessions'].map((d) => `${OmcPaths.ROOT}/${d}`);
/** The link walk gives up (and the lane parks) past this many entries or this depth. */
const MAX_WALK_ENTRIES = 200_000;
const MAX_WALK_DEPTH = 64;
/**
 * Where Azure Pipelines definitions conventionally live: the CI that gates an
 * ADO PR. A lane may not change them (a red build could turn green), and on
 * Azure DevOps a PR touching them needs the owner (merge-policy.ts).
 */
export const ADO_PIPELINE_PATHS = ['azure-pipelines.yml', 'azure-pipelines.yaml', '.azure-pipelines/', '.azuredevops/', '.pipelines/'];
/**
 * Paths a write lane may not change, on top of ship's PROTECTED_PATHS (which
 * `omg ship` keeps as it is): agent instructions, hooks, skills and CI.
 * `.github/` covers `.github/copilot-instructions.md` and the workflows;
 * `.claude/`, `.mcp.json` and `.vscode/` hold the hooks, MCP servers and
 * tasks other agents and editors run from a checkout, `.husky/` the git hooks
 * husky installs.
 */
export const LANE_PROTECTED_PATHS = ['.github/', '.copilot/', '.claude/', '.vscode/', '.mcp.json', '.husky/', '.omg/skills/', '.omc/skills/', 'AGENTS.md', 'CLAUDE.md', ...ADO_PIPELINE_PATHS];
const errText = (err) => (err instanceof Error ? err.message : String(err));
/** The engine's env with the commit identity fixed, and no variable that redirects the index or object store. */
function engineGitEnv(extra = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^GIT_(?:INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|AUTHOR_|COMMITTER_)/i.test(key))
            delete env[key];
    }
    return {
        ...env,
        GIT_AUTHOR_NAME: ENGINE_COMMIT_IDENTITY.name,
        GIT_AUTHOR_EMAIL: ENGINE_COMMIT_IDENTITY.email,
        GIT_COMMITTER_NAME: ENGINE_COMMIT_IDENTITY.name,
        GIT_COMMITTER_EMAIL: ENGINE_COMMIT_IDENTITY.email,
        ...extra,
    };
}
/** GitHub's skip-CI markers (`[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`). */
const CI_SKIP = /\[\s*(?:(?:skip|no)[\s-]+(?:ci|actions)|(?:ci|actions)[\s-]+skip)\s*\]/gi;
/** A trailer-shaped line (`Key: value`), dropped from the body's last paragraph. */
const TRAILER = /^[A-Za-z0-9-]+\s*:(?:\s|$)/;
/** Trailers dropped from any line of the body: they credit an author, sign off or skip checks. */
const ANY_LINE_TRAILER = /^\s*(?:co-authored-by|signed-off-by|skip-checks)\s*:/i;
/** `body` without trailer-shaped lines (and their continuation lines) in its last paragraph, repeated while one goes. */
function dropTrailers(body) {
    let lines = body.split('\n').filter((l) => !ANY_LINE_TRAILER.test(l));
    for (;;) {
        while (lines.length > 0 && !lines[lines.length - 1].trim())
            lines.pop();
        let start = lines.length;
        while (start > 0 && lines[start - 1].trim())
            start--;
        const kept = [];
        let dropping = false;
        for (const l of lines.slice(start)) {
            dropping = TRAILER.test(l) || (dropping && /^\s/.test(l));
            if (!dropping)
                kept.push(l);
        }
        if (kept.length === lines.length - start)
            return lines.join('\n');
        lines = [...lines.slice(0, start), ...kept];
    }
}
/**
 * A commit message from untrusted lane text: no control, format or bidi
 * characters except newlines, no skip-CI marker, no trailer the lane wrote,
 * bounded.
 */
export function laneCommitMessage(title, body) {
    const unskip = (t) => {
        let prev;
        do {
            prev = t;
            t = t.replace(CI_SKIP, '');
        } while (t !== prev);
        return t;
    };
    const clean = (t) => unskip(t.replace(/\r\n?/g, '\n').replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (c) => (c === '\n' ? c : ' ')));
    const text = `${clean(title).replace(/\n/g, ' ').trim()}\n\n${dropTrailers(clean(body ?? '')).trim()}`.trim();
    return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n...` : text;
}
/**
 * The first link host git could follow out of `worktree`, or a walk past its
 * limits (fail closed); null when there is none. lstat only, so no link is
 * followed; `.git` entries and the paths in `ignored` (git skips both) are
 * not entered. On win32 every link counts (Git for Windows follows a
 * junction); elsewhere a link to a directory does, and a file symlink is
 * left to the 120000 check after staging.
 */
function linkEscape(worktree, ignored) {
    let entries = 0;
    const walk = (dir, rel, depth) => {
        if (depth > MAX_WALK_DEPTH)
            return `the worktree is nested deeper than ${MAX_WALK_DEPTH} directories at ${rel}, so it was not checked for links`;
        for (const d of readdirSync(dir, { withFileTypes: true })) {
            if (++entries > MAX_WALK_ENTRIES)
                return `the worktree holds more than ${MAX_WALK_ENTRIES} entries git does not ignore, so it was not checked for links`;
            const path = rel ? `${rel}/${d.name}` : d.name;
            if (d.isFile() || d.name === '.git' || ignored.has(path))
                continue;
            const abs = join(dir, d.name);
            const st = lstatSync(abs);
            if (st.isSymbolicLink()) {
                let toDir = false;
                try {
                    toDir = statSync(abs).isDirectory();
                }
                catch { /* a dangling link: a file symlink to git */ }
                if (process.platform === 'win32' || toDir)
                    return `the lane left a link at ${path} (a symlink or junction); host git could read through it outside the worktree`;
            }
            else if (st.isDirectory()) {
                const hit = walk(abs, path, depth + 1);
                if (hit)
                    return hit;
            }
        }
        return null;
    };
    return walk(worktree, '', 0);
}
/** The staged paths whose real directory is outside the worktree's (a link git followed). */
export function outsideWorktree(worktree, files) {
    const root = realpathSync.native(worktree);
    return files.filter((f) => {
        let dir;
        try {
            dir = realpathSync.native(dirname(join(worktree, f)));
        }
        catch (err) {
            // A deleted path's directory may be gone: nothing is read there. Any other failure counts as outside.
            const code = err.code;
            return code !== 'ENOENT' && code !== 'ENOTDIR';
        }
        const r = relative(root, dir);
        return r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r);
    });
}
const findingKey = (f) => `${f.kind}\0${f.path}`;
/** `**` any path segments, `*` and `?` within one segment; matched against the whole repo-relative path. */
export function pathGlobMatches(glob, path) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            i++;
            if (glob[i + 1] === '/') {
                i++;
                re += '(?:.*/)?';
            }
            else
                re += '.*';
        }
        else if (c === '*')
            re += '[^/]*';
        else if (c === '?')
            re += '[^/]';
        else
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`).test(path);
}
const gone = (err) => ['ENOENT', 'ENOTDIR'].includes(err.code ?? '');
/**
 * Read `rel` under `worktree` without following any link: every parent
 * component lstat'ed (a link there is `swapped`; a missing or non-directory
 * one means the path is gone), the file itself lstat'ed, opened (O_NOFOLLOW
 * where the platform has it), its fstat dev/ino compared with the lstat, read
 * whole, then lstat'ed again (same file, same size). Anything that changed
 * between the steps is `swapped`.
 */
export function engineRead(worktree, rel) {
    const segs = rel.split('/');
    let dir = worktree;
    for (let i = 0; i < segs.length - 1; i++) {
        dir = join(dir, segs[i]);
        let st;
        try {
            st = lstatSync(dir);
        }
        catch (err) {
            if (gone(err))
                return { kind: 'deleted' };
            throw err;
        }
        if (st.isSymbolicLink())
            return { kind: 'swapped', why: `${segs.slice(0, i + 1).join('/')} is a symlink or junction` };
        if (!st.isDirectory())
            return { kind: 'deleted' };
    }
    const abs = join(worktree, ...segs);
    let first;
    try {
        first = lstatSync(abs, { bigint: true });
    }
    catch (err) {
        if (gone(err))
            return { kind: 'deleted' };
        throw err;
    }
    if (first.isSymbolicLink())
        return { kind: 'link' };
    if (first.isDirectory())
        return { kind: 'dir' };
    if (!first.isFile())
        return { kind: 'other' };
    const fd = openSync(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.dev !== first.dev || opened.ino !== first.ino)
            return { kind: 'swapped', why: `${rel} was replaced between its lstat and its open` };
        bytes = readFileSync(fd);
    }
    finally {
        closeSync(fd);
    }
    let again;
    try {
        again = lstatSync(abs, { bigint: true });
    }
    catch {
        return { kind: 'swapped', why: `${rel} disappeared while the engine read it` };
    }
    if (!again.isFile() || again.dev !== first.dev || again.ino !== first.ino || again.size !== BigInt(bytes.length)) {
        return { kind: 'swapped', why: `${rel} changed while the engine read it` };
    }
    return { kind: 'file', bytes, exec: (Number(first.mode) & 0o100) !== 0, nlink: Number(first.nlink) };
}
/** git's gather_stats (convert.c): CRLF pairs, lone CR, NUL, printable and non-printable bytes. */
export function textStats(buf) {
    const s = { crlf: 0, lonecr: 0, nul: 0, printable: 0, nonprintable: 0 };
    for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c === 13) {
            if (buf[i + 1] === 10) {
                s.crlf++;
                i++;
            }
            else
                s.lonecr++;
            continue;
        }
        if (c === 10)
            continue;
        if (c === 127)
            s.nonprintable++;
        else if (c < 32) {
            // BS, HT, ESC and FF count as printable.
            if (c === 8 || c === 9 || c === 27 || c === 12)
                s.printable++;
            else {
                if (c === 0)
                    s.nul++;
                s.nonprintable++;
            }
        }
        else
            s.printable++;
    }
    // A trailing ^Z (EOF) is not counted as non-printable.
    if (buf.length > 0 && buf[buf.length - 1] === 26)
        s.nonprintable--;
    return s;
}
/** git's convert_is_binary. */
export function isBinaryText(s) {
    return s.lonecr > 0 || s.nul > 0 || (s.printable >> 7) < s.nonprintable;
}
/** git's has_crlf_in_index on the index (start) blob: it holds a CR, is text, and has a CRLF. */
function hasCrlfInIndex(blob) {
    if (!blob.includes(13))
        return false;
    const s = textStats(blob);
    return !isBinaryText(s) && s.crlf > 0;
}
/**
 * git's crlf_to_git for core.autocrlf true or input with no text/eol
 * attribute (CRLF_AUTO_*), after the caller checked that the bytes are text
 * with a CRLF and that the start blob has none (has_crlf_in_index): every CR
 * goes (a text file has no lone CR).
 */
export function autoCrlfToGit(buf) {
    return Buffer.from(buf.filter((c) => c !== 13));
}
/** Blob bytes by sha, one `cat-file --batch` for all of them (hardened host git). */
function readBlobs(worktree, shas) {
    const out = new Map();
    const wanted = [...new Set(shas)];
    if (wanted.length === 0)
        return out;
    const buf = runHostGitBuffer(worktree, [...worktreeGitDirArgs(worktree), 'cat-file', '--batch'], GIT_TIMEOUT_MS, process.env, `${wanted.join('\n')}\n`);
    let at = 0;
    while (at < buf.length) {
        const nl = buf.indexOf(10, at);
        if (nl < 0)
            break;
        const m = /^([0-9a-f]+) blob (\d+)$/.exec(buf.subarray(at, nl).toString('latin1'));
        if (!m)
            throw new Error(`git cat-file --batch printed ${JSON.stringify(buf.subarray(at, Math.min(nl, at + 80)).toString('latin1'))}`);
        const size = Number(m[2]);
        out.set(m[1], buf.subarray(nl + 1, nl + 1 + size));
        at = nl + 1 + size + 1;
    }
    return out;
}
/** `mode type sha\tpath` entries of `ls-tree -r -z` output by path. */
function treeEntries(out) {
    const map = new Map();
    for (const entry of out.split('\0')) {
        const tab = entry.indexOf('\t');
        if (tab < 0)
            continue;
        const [mode, , sha] = entry.slice(0, tab).split(' ');
        map.set(entry.slice(tab + 1), { mode, sha });
    }
    return map;
}
/** The paths `status --porcelain=v1 -z` lists (`--no-renames`: one path per entry). */
function statusPaths(out) {
    return [...new Set(out.split('\0').filter((e) => e.length > 3).map((e) => e.slice(3)))];
}
/**
 * Engine-read staging (audit H3, layer 2): the lane's change as a tree,
 * built without git reading the worktree. Git lists what changed (`status`,
 * which only compares); the engine reads each listed path itself
 * (engineRead) and writes the bytes as blobs: one `fast-import` for all of
 * them, so 1 000 files cost one process. The blobs go into a temporary
 * index seeded from the start tree (`update-index --index-info`, objects
 * only) and `write-tree` makes the tree. A link anywhere on a path, a hard
 * link, a nested repository or a file swapped while it was read refuses.
 *
 * Line endings, as `add -A` under runHostGit did: GIT_ATTR_SOURCE is the
 * empty tree, so a `.gitattributes` in the worktree or the tree never
 * applies (no text/eol/filter from the lane), and every filter driver is
 * blanked; what still converts is `core.autocrlf` (Git for Windows' system
 * config sets it true) and the repository's own `info/attributes`. Bytes
 * without a CR convert under neither, so they are written as read (as
 * `hash-object --no-filters` would). With autocrlf true or input, a text
 * file (git's own binary heuristic) with a CRLF loses its CRs unless the
 * start's blob at that path is text with a CRLF (has_crlf_in_index): git's
 * convert.c rules for CRLF_AUTO_*, reimplemented (textStats, autoCrlfToGit)
 * so 1 000 CRLF files do not cost 1 000 git processes. When
 * `info/attributes` has content (any attribute may apply), or core.safecrlf
 * is strict (git refuses an irreversible conversion), each such file is
 * hashed by `git hash-object -w --stdin --path=<path>` instead: git applies
 * its own conversion to the bytes the engine read, from stdin.
 * The executable bit: from the file on POSIX when core.fileMode is on,
 * else the start's mode (git keeps the index mode).
 *
 * The secret scan (audit L3) reads the same bytes: every changed blob whose
 * sha is not already in the start tree and whose path no allowPaths glob
 * matches.
 */
function stageEngineRead(input, git, ignored) {
    const refuse = (refusal, reason) => ({ ok: false, refusal, reason });
    const runtime = RUNTIME_STATE_DIRS.map((d) => `${d}/`);
    // Untrimmed: the first entry's status code may start with a space.
    const listed = statusPaths(runHostGit(input.worktree, [...worktreeGitDirArgs(input.worktree), '--no-optional-locks', '-c', 'core.untrackedCache=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], GIT_TIMEOUT_MS))
        .filter((p) => !runtime.some((d) => p.startsWith(d)) && !ignored.has(p.replace(/\/$/, '')))
        .sort();
    const start = treeEntries(git(['ls-tree', '-r', '-z', '--full-tree', input.start]));
    const nested = listed.filter((p) => p.endsWith('/'));
    if (nested.length > 0) {
        return refuse('gitlink', `the lane added or changed nested repositories (gitlinks): ${nested.slice(0, 5).map((p) => p.slice(0, -1)).join(', ')}; host git does not enter them, so their content is not reviewed`);
    }
    const common = resolve(input.worktree, git(['rev-parse', '--path-format=absolute', '--git-common-dir']));
    let infoAttributes = false;
    try {
        infoAttributes = readFileSync(join(common, 'info', 'attributes'), 'utf8').trim() !== '';
    }
    catch { /* none */ }
    const configValue = (key) => {
        try {
            return git(['config', '--get', key]).toLowerCase();
        }
        catch {
            return '';
        }
    };
    const autocrlf = configValue('core.autocrlf');
    const crlfAuto = autocrlf === 'input' || ['true', 'yes', 'on', '1'].includes(autocrlf);
    const fileMode = process.platform !== 'win32' && !['false', 'no', 'off', '0'].includes(configValue('core.fileMode'));
    const files = [];
    const deleted = [];
    const symlinks = [];
    const hardLinked = [];
    for (const path of listed) {
        const read = engineRead(input.worktree, path);
        const was = start.get(path);
        if (read.kind === 'swapped')
            return refuse('escaped', `a path of the lane's change cannot be read safely: ${read.why}; host git could read through it outside the worktree`);
        if (read.kind === 'link') {
            symlinks.push(path);
            continue;
        }
        if (read.kind === 'other')
            return refuse('error', `${path} is not a regular file, directory or link`);
        if (read.kind === 'deleted' || read.kind === 'dir') {
            // A tracked file replaced by a directory: the file goes; the directory's files are listed on their own.
            if (was && was.mode !== '160000')
                deleted.push(path);
            continue;
        }
        // A hard link to a file outside the worktree passes the link checks, but shares its inode.
        if (read.nlink > 1) {
            hardLinked.push(path);
            continue;
        }
        const mode = fileMode ? (read.exec ? '100755' : '100644') : was?.mode === '100755' ? '100755' : '100644';
        files.push({ path, mode, bytes: read.bytes });
    }
    if (symlinks.length > 0)
        return refuse('escaped', `the lane added or changed symlinks: ${symlinks.slice(0, 5).join(', ')}`);
    if (hardLinked.length > 0)
        return refuse('escaped', `the lane staged hard-linked files (their content may come from outside the worktree): ${hardLinked.slice(0, 5).join(', ')}`);
    const tmp = mkdtempSync(join(tmpdir(), 'omg-lane-commit-'));
    try {
        const env = engineGitEnv({ GIT_INDEX_FILE: join(tmp, 'index') });
        git(['read-tree', input.start], env);
        // core.autocrlf without attributes (autoCrlfToGit); info/attributes or a strict core.safecrlf: git converts (or dies) itself.
        const viaGitSet = new Set(infoAttributes ? files.map((f) => f.path) : []);
        if (crlfAuto && !infoAttributes) {
            const strictSafe = ['true', 'yes', 'on', '1'].includes(configValue('core.safecrlf'));
            const candidates = files.filter((f) => { const s = textStats(f.bytes); return s.crlf > 0 && !isBinaryText(s); });
            const indexBlobs = readBlobs(input.worktree, candidates.map((f) => start.get(f.path)).filter((e) => e?.mode.startsWith('100')).map((e) => e.sha));
            for (const f of candidates) {
                const was = start.get(f.path);
                const blob = was?.mode.startsWith('100') ? indexBlobs.get(was.sha) : undefined;
                if (blob && hasCrlfInIndex(blob))
                    continue;
                if (strictSafe)
                    viaGitSet.add(f.path);
                else
                    f.bytes = autoCrlfToGit(f.bytes);
            }
        }
        const viaGit = (f) => viaGitSet.has(f.path);
        const shas = new Map();
        const raw = files.filter((f) => !viaGit(f));
        for (const f of files.filter(viaGit)) {
            const sha = git(['hash-object', '-w', '--stdin', `--path=${f.path}`], env, f.bytes);
            if (!HEX.test(sha))
                throw new Error(`git hash-object printed ${JSON.stringify(sha.slice(0, 80))}`);
            shas.set(f.path, sha);
        }
        if (raw.length > 0) {
            const marks = join(tmp, 'marks');
            const stream = Buffer.concat([...raw.flatMap((f, i) => [Buffer.from(`blob\nmark :${i + 1}\ndata ${f.bytes.length}\n`), f.bytes, Buffer.from('\n')]), Buffer.from('done\n')]);
            git(['fast-import', '--quiet', '--done', `--export-marks=${marks}`], env, stream);
            const byMark = new Map(readFileSync(marks, 'utf8').split('\n').map((l) => /^:(\d+) ([0-9a-f]+)$/.exec(l.trim())).filter((m) => m !== null).map((m) => [Number(m[1]), m[2]]));
            raw.forEach((f, i) => {
                const sha = byMark.get(i + 1);
                if (!sha || !HEX.test(sha))
                    throw new Error(`git fast-import wrote no blob for ${f.path}`);
                shas.set(f.path, sha);
            });
        }
        const zero = '0'.repeat(input.start.length);
        // Deletions first, so a file replaced by a directory (or the reverse) never collides in the index.
        const info = [...deleted.map((p) => `0 ${zero}\t${p}\0`), ...files.map((f) => `${f.mode} ${shas.get(f.path)}\t${f.path}\0`)].join('');
        if (info)
            git(['update-index', '-z', '--index-info'], env, info);
        const tree = git(['write-tree'], env);
        if (!HEX.test(tree))
            return refuse('error', `git write-tree printed ${JSON.stringify(tree.slice(0, 80))}`);
        const changed = git(['diff-tree', '-r', '-z', '--no-renames', '--name-only', input.start, tree]).split('\0').filter(Boolean);
        const changedSet = new Set(changed);
        const known = new Set([...start.values()].map((e) => e.sha));
        const findings = [];
        for (const f of files) {
            if (!changedSet.has(f.path) || known.has(shas.get(f.path)) || (input.secretAllowPaths ?? []).some((g) => pathGlobMatches(g, f.path)))
                continue;
            for (const kind of secretShapeKinds(f.bytes.toString('latin1')))
                findings.push({ path: f.path, kind });
        }
        return { ok: true, tree, files: changed, findings, notes: [] };
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}
/**
 * Commit a write lane's worktree changes for it (see the module comment).
 * Call only after the lane confirmed its end and its tamper check passed.
 * Never throws: a git failure is `error`.
 */
export function commitLaneWork(input) {
    try {
        if (!HEX.test(input.start) || input.parents.length === 0 || !input.parents.every((p) => HEX.test(p))) {
            return { ok: false, refusal: 'error', reason: 'the start and parent commits must be full shas' };
        }
        // Throws when no links were recorded for the worktree; runHostGit re-checks them before every command.
        const dirs = worktreeGitDirArgs(input.worktree);
        const git = (args, env, stdin) => runHostGit(input.worktree, [...dirs, ...args], GIT_TIMEOUT_MS, env, stdin).trim();
        const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
        if (head !== input.start) {
            return { ok: false, refusal: 'moved', reason: `the lane moved its worktree's HEAD to ${head.slice(0, 12) || '(none)'} (it started at ${input.start.slice(0, 12)}); a write lane leaves its changes uncommitted and the engine commits them` };
        }
        // What git ignores it never enters in `add -A`, so the link walk skips it (directories come as `dir/`).
        const ignored = new Set(git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']).split('\0').filter(Boolean).map((p) => p.replace(/\/$/, '')));
        const link = linkEscape(input.worktree, ignored);
        if (link)
            return { ok: false, refusal: 'escaped', reason: link };
        const staged = stageEngineRead(input, git, ignored);
        if (!staged.ok)
            return staged;
        const { tree, files, notes } = staged;
        const refuse = (refusal, reason) => ({ ok: false, refusal, reason });
        const outside = outsideWorktree(input.worktree, files);
        if (outside.length > 0)
            return refuse('escaped', `staged paths resolve outside the worktree (through a link): ${outside.slice(0, 5).join(', ')}`);
        const hit = protectedChanges(files, [...LANE_PROTECTED_PATHS, ...(input.extraProtected ?? [])]);
        if (hit.length > 0)
            return refuse('protected', `the lane changed merge-rule or lane-protected paths: ${hit.join(', ')}`);
        const acked = new Set((input.secretAck ?? []).map(findingKey));
        const secrets = staged.findings.filter((f) => !acked.has(findingKey(f)));
        if (secrets.length > 0) {
            return { ok: false, refusal: 'secret', findings: secrets, reason: `the lane's change holds secret-shaped content (the values are not shown): ${secrets.slice(0, 10).map((f) => `${f.path} (${f.kind})`).join(', ')}${secrets.length > 10 ? `, and ${secrets.length - 10} more` : ''}` };
        }
        if (input.branch) {
            // The job has ended, but a loose ref rewritten since as `ref: refs/heads/main` (or a link) would make update-ref move main.
            const common = resolve(input.repoRoot, runHostGit(input.repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], GIT_TIMEOUT_MS).trim());
            const problem = jobRefProblem(common, input.repoRoot, `refs/heads/${input.branch}`);
            if (problem)
                return refuse('escaped', `the lane branch ${input.branch} is not a plain commit ref (${problem}); nothing was committed`);
        }
        if (tree === git(['rev-parse', '--verify', '--quiet', `${input.start}^{tree}`])) {
            return { ok: false, refusal: 'empty', reason: 'the lane left no changes in its worktree' };
        }
        const sha = git(['commit-tree', '--no-gpg-sign', ...input.parents.flatMap((p) => ['-p', p]), '-m', input.message, tree], engineGitEnv());
        if (!HEX.test(sha))
            return { ok: false, refusal: 'error', reason: `git commit-tree printed ${JSON.stringify(sha.slice(0, 80))}` };
        git(['update-ref', '--no-deref', '-m', 'omg factory run: the engine commit of the lane', 'HEAD', sha, input.start]);
        // The worktree's own index follows its HEAD (as `add -A` left it), from objects only: git reads no worktree file.
        try {
            git(['read-tree', tree]);
        }
        catch (err) {
            notes.push(`the lane worktree's index was not moved to the commit (${errText(err)}), so git status there may list the committed changes`);
        }
        if (input.branch) {
            const ref = `refs/heads/${input.branch}`;
            const at = runHostGit(input.repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], GIT_TIMEOUT_MS).trim();
            if (at === input.start)
                runHostGit(input.repoRoot, ['update-ref', '--no-deref', '-m', 'omg factory run: the engine commit of the lane', ref, sha, input.start], GIT_TIMEOUT_MS);
            else
                notes.push(`the lane branch ${input.branch} is at ${at.slice(0, 12) || '(none)'}, not the lane start; it was left there`);
        }
        return { ok: true, sha, files, notes };
    }
    catch (err) {
        return { ok: false, refusal: 'error', reason: `the engine commit failed: ${errText(err)}` };
    }
}
/**
 * The start commit of a conflict-fix lane: `merge-tree --write-tree` of the
 * PR head and the base, committed with both as parents. Conflicted files keep
 * git's conflict markers for the lane to resolve; nothing is checked out, no
 * ref moves, and GIT_ATTR_SOURCE is the empty tree, so no merge driver,
 * filter or attribute from either side applies. The engine's final commit
 * takes the same two parents (commitLaneWork), never this commit.
 */
export function conflictFixStart(repoRoot, head, base, message) {
    const format = runHostGit(repoRoot, ['rev-parse', '--show-object-format'], GIT_TIMEOUT_MS).trim();
    const emptyTree = EMPTY_TREE[format];
    if (!emptyTree)
        throw new Error(`unknown object format ${JSON.stringify(format)}`);
    const env = engineGitEnv({ GIT_ATTR_SOURCE: emptyTree });
    let out;
    try {
        out = runHostGit(repoRoot, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, base], GIT_TIMEOUT_MS, env);
    }
    catch (err) {
        // Exit 1: the merge has conflicts; stdout still names the tree and the conflicted files.
        const e = err;
        if (e.status !== 1 || typeof e.stdout !== 'string')
            throw err;
        out = e.stdout;
    }
    const [tree, ...conflicted] = out.split('\0').filter(Boolean);
    if (!tree || !HEX.test(tree))
        throw new Error(`git merge-tree printed no tree (${JSON.stringify(out.slice(0, 80))})`);
    const sha = runHostGit(repoRoot, ['commit-tree', '--no-gpg-sign', '-p', head, '-p', base, '-m', message, tree], GIT_TIMEOUT_MS, env).trim();
    if (!HEX.test(sha))
        throw new Error(`git commit-tree printed ${JSON.stringify(sha.slice(0, 80))}`);
    return { sha, conflicted: [...new Set(conflicted)] };
}
//# sourceMappingURL=lane-commit.js.map