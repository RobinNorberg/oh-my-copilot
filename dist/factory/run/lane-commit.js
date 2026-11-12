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
 * in after the checks cannot make GIT read a file outside it; the engine's
 * own read could follow a link swapped onto a parent directory, so
 * engineRead pins every parent's identity and checks it again after the
 * read, which leaves only a swap away and back inside that window: see
 * REFERENCE's security model), then
 * `write-tree` and `commit-tree` with engine-chosen parents and the
 * engine-owned identity, so no commit hook and no signing program runs and
 * nothing the lane wrote picks the author. The lane's branch and its
 * worktree's HEAD move to the commit only from the value they started at.
 * The caller first proves the lane's process tree gone (lane-procs.ts).
 *
 * Refused before any commit: a lane that moved its HEAD, a new or changed
 * gitlink (host git never enters a nested repository, so its content is
 * unreviewed; the engine reads each start gitlink's checked-out HEAD
 * itself; a submodule directory that is gone is committed as a deletion,
 * as `add -A` did), a link host git could follow out of the worktree, a
 * changed symlink placeholder (core.symlinks=false), a file over
 * LANE_FILE_MAX_BYTES, changed files over LANE_COMMIT_MAX_BYTES together,
 * a merge-rule or lane-protected path, secret-shaped
 * content in a changed file, a changed path's name or the commit message
 * (heal/sanitize.ts SECRET_SHAPES: a key or token the lane could have copied
 * in from outside its sandbox) unless acknowledged or allow-listed, and an
 * empty change.
 *
 * Parameterised by explicit paths only (the worktree with its recorded git
 * links, and `repoRoot`, whose common git dir holds the lane's branch): a
 * run whose lanes work in another repository passes that repository's root.
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
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
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
/** The refusal of a completed lane that changed nothing (the bench scores a trap's implement-failed park with it as "declined"). */
export const LANE_LEFT_NO_CHANGES = 'the lane left no changes in its worktree';
/**
 * oh-my-copilot's own runtime artifacts a lane's session and plugin hooks
 * write in its worktree: everything under `.omg/` (state, sessions,
 * notepad.md, project-memory.json with your home path in it, plans, research,
 * logs, artifacts, handoffs, ultragoal, ...) except `.omg/skills/`, the
 * documented committable exception. Skipped by the engine's staging when
 * untracked (never committed or summarized; a lane that changed only these
 * left no changes); a path the start tree tracks is staged as any other (L1).
 */
export function isOmcRuntimePath(path) {
    return path.startsWith(`${OmcPaths.ROOT}/`) && !path.startsWith(`${OmcPaths.SKILLS}/`);
}
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
 * husky installs. CI_DEFINITION_PATHS: with no `ship.requiredChecks` the
 * gates require every check the forge reports, so a lane must not be able to
 * drop a CI system's definition and with it the checks.
 */
export const CI_DEFINITION_PATHS = ['.circleci/', '.gitlab-ci.yml', '.buildkite/', '.travis.yml', 'Jenkinsfile', 'appveyor.yml', '.appveyor.yml', '.drone.yml', 'bitbucket-pipelines.yml', '.woodpecker/', '.woodpecker.yml'];
/** Every CI system's definition paths (GitHub Actions, Azure Pipelines, the rest): the gates' no-CI rule reads them from the base and head trees. */
export const CI_TREE_PATHS = ['.github/workflows/', ...ADO_PIPELINE_PATHS, ...CI_DEFINITION_PATHS];
export const LANE_PROTECTED_PATHS = ['.github/', '.copilot/', '.claude/', '.vscode/', '.mcp.json', '.husky/', '.omg/skills/', '.omc/skills/', 'AGENTS.md', 'CLAUDE.md', ...ADO_PIPELINE_PATHS, ...CI_DEFINITION_PATHS];
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
/** The finding path of a secret shape in the commit message. */
export const SECRET_MESSAGE_PATH = '(commit message)';
/** The finding path of a secret shape in a changed path's NAME: a hash of it, so the value is never echoed. */
export const secretPathLabel = (path) => `(the name of a changed path, sha256 ${createHash('sha256').update(path).digest('hex').slice(0, 12)})`;
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
/**
 * A changed file bigger than this is refused (`error`) instead of read: the
 * engine holds every changed file in memory (and a batch of them twice
 * while it builds a fast-import stream), so a multi-GB file would crash
 * it. 100 MiB is
 * GitHub's own hard per-file limit: a bigger file could never be pushed.
 */
export const LANE_FILE_MAX_BYTES = 100 * 1024 * 1024;
/**
 * The changed files of one lane commit together (review-484b 6): over this
 * the commit is refused (`error`) instead of read on. The engine keeps
 * every changed file's bytes for the secret scan, so this bounds its memory;
 * 1 GiB is half of GitHub's 2 GiB limit for one push (the run's push
 * carries the lane commit), and no reviewable change of a coding lane comes
 * near it.
 */
export const LANE_COMMIT_MAX_BYTES = 1024 * 1024 * 1024;
/** The blobs go to git in `fast-import` streams of about this size, so the stream never doubles all the bytes at once. */
export const FAST_IMPORT_BATCH_BYTES = 64 * 1024 * 1024;
const gone = (err) => ['ENOENT', 'ENOTDIR'].includes(err.code ?? '');
/**
 * Read `rel` under `worktree` without following any link: the worktree and
 * every parent component lstat'ed (a link there is `swapped`; a missing or
 * non-directory one means the path is gone) and their (dev, ino) kept, the
 * file itself lstat'ed, opened (O_NOFOLLOW where the platform has it), its
 * fstat dev/ino compared with the lstat, read whole, then lstat'ed again
 * (same file, same size), and then the whole parent chain lstat'ed again: a
 * junction or symlink swapped onto a parent after its first lstat (O_NOFOLLOW
 * guards only the last component, and open follows a link in the middle)
 * changes that component's identity. On Linux the opened descriptor's own
 * path (/proc/self/fd) must also be the expected one. Anything that changed
 * between the steps is `swapped`. Not closed: a parent swapped away and back
 * again entirely between two lstats (see REFERENCE, security model).
 * `realRoot` is the worktree's realpath (computed once by the caller).
 */
export function engineRead(worktree, rel, realRoot) {
    const segs = rel.split('/');
    const chain = [];
    // The worktree itself may sit under a link the user made (a home dir on another drive): followed, but pinned.
    const top = statSync(worktree, { bigint: true });
    chain.push({ path: worktree, dev: top.dev, ino: top.ino, follow: true });
    let dir = worktree;
    for (let i = 0; i < segs.length - 1; i++) {
        dir = join(dir, segs[i]);
        let st;
        try {
            st = lstatSync(dir, { bigint: true });
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
        chain.push({ path: dir, dev: st.dev, ino: st.ino, follow: false });
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
    if (first.size > BigInt(LANE_FILE_MAX_BYTES))
        return { kind: 'big', size: first.size };
    const fd = openSync(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.dev !== first.dev || opened.ino !== first.ino)
            return { kind: 'swapped', why: `${rel} was replaced between its lstat and its open` };
        if (opened.size > BigInt(LANE_FILE_MAX_BYTES))
            return { kind: 'big', size: opened.size };
        if (process.platform === 'linux') {
            // The path the kernel opened, whatever the components were at that moment.
            let viaFd = '';
            try {
                viaFd = readlinkSync(`/proc/self/fd/${fd}`);
            }
            catch { /* no /proc: the chain check below still runs */ }
            const expected = join(realRoot ?? realpathSync.native(worktree), ...segs);
            if (viaFd && viaFd !== expected)
                return { kind: 'swapped', why: `${rel} was opened through another path (${viaFd})` };
        }
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
    for (const c of chain) {
        let st;
        try {
            st = c.follow ? statSync(c.path, { bigint: true }) : lstatSync(c.path, { bigint: true });
        }
        catch {
            return { kind: 'swapped', why: `${relative(worktree, c.path) || 'the worktree'} disappeared while the engine read ${rel}` };
        }
        if ((!c.follow && st.isSymbolicLink()) || !st.isDirectory() || st.dev !== c.dev || st.ino !== c.ino) {
            return { kind: 'swapped', why: `${relative(worktree, c.path).split(sep).join('/') || 'the worktree'} was replaced while the engine read ${rel}` };
        }
    }
    return { kind: 'file', bytes, exec: (Number(first.mode) & 0o100) !== 0, nlink: Number(first.nlink) };
}
/**
 * What a start-tree gitlink (160000) at `rel` is checked out at, read by the
 * engine (host git runs with --ignore-submodules=all and never enters it):
 * `absent` when the directory is gone, `unchecked` when it holds no `.git`
 * (a submodule that was never initialised: git keeps the gitlink as it is),
 * the sha its HEAD names, or `unknown` with why. Nothing here is committed;
 * the sha is only compared.
 */
export function gitlinkHead(worktree, rel) {
    const dir = join(worktree, ...rel.split('/'));
    let st;
    try {
        st = lstatSync(dir);
    }
    catch (err) {
        if (gone(err))
            return { kind: 'absent' };
        return { kind: 'unknown', why: errText(err) };
    }
    if (st.isSymbolicLink())
        return { kind: 'unknown', why: 'it is a link' };
    if (!st.isDirectory())
        return { kind: 'not-dir' };
    const dotGit = join(dir, '.git');
    let g;
    try {
        g = lstatSync(dotGit);
    }
    catch (err) {
        if (gone(err))
            return { kind: 'unchecked' };
        return { kind: 'unknown', why: errText(err) };
    }
    try {
        let gitDir;
        if (g.isDirectory())
            gitDir = dotGit;
        else if (g.isFile()) {
            const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
            if (!m)
                return { kind: 'unknown', why: 'its .git file names no gitdir' };
            gitDir = resolve(dir, m[1]);
        }
        else
            return { kind: 'unknown', why: 'its .git is a link' };
        let refsDir = gitDir;
        try {
            refsDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
        }
        catch { /* not a linked worktree */ }
        let head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        for (let depth = 0; depth < 5 && head.startsWith('ref:'); depth++) {
            const ref = head.slice(4).trim();
            if (!/^refs\/[^\0]+$/.test(ref) || ref.split('/').includes('..'))
                return { kind: 'unknown', why: `its HEAD names ${JSON.stringify(ref.slice(0, 80))}` };
            const base = existsSync(join(gitDir, ...ref.split('/'))) ? gitDir : refsDir;
            try {
                head = readFileSync(join(base, ...ref.split('/')), 'utf8').trim();
            }
            catch {
                let packed = '';
                try {
                    packed = readFileSync(join(refsDir, 'packed-refs'), 'utf8');
                }
                catch { /* none */ }
                const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`) && !l.startsWith('#') && !l.startsWith('^'));
                if (!line)
                    return { kind: 'unknown', why: `its HEAD names ${ref}, which has no commit` };
                head = line.split(' ')[0];
            }
        }
        return HEX.test(head) ? { kind: 'head', sha: head } : { kind: 'unknown', why: 'its HEAD names no commit' };
    }
    catch (err) {
        return { kind: 'unknown', why: errText(err) };
    }
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
    // Untrimmed: the first entry's status code may start with a space.
    const start = treeEntries(git(['ls-tree', '-r', '-z', '--full-tree', input.start]));
    // L1 (review-490): only UNTRACKED runtime paths are skipped; a tracked one (a repository may commit .omg/plans) the
    // lane changed or deleted is committed and summarized like any other path.
    const listed = statusPaths(runHostGit(input.worktree, [...worktreeGitDirArgs(input.worktree), '--no-optional-locks', '-c', 'core.untrackedCache=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], GIT_TIMEOUT_MS))
        .filter((p) => (!isOmcRuntimePath(p) || start.has(p)) && !ignored.has(p.replace(/\/$/, '')))
        .sort();
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
    // Every gitlink of the start tree, read by the engine (status runs with --ignore-submodules=all, so a moved submodule
    // is never listed): a different commit checked out refuses as `add -A` + the gitlink check did. The directory gone is
    // a deletion, as `add -A` staged it (review-484b 5): it adds no content.
    const movedGitlinks = [];
    for (const [path, e] of start) {
        if (e.mode !== '160000')
            continue;
        const at = gitlinkHead(input.worktree, path);
        if (at.kind === 'unchecked' || at.kind === 'not-dir' || (at.kind === 'head' && at.sha === e.sha))
            continue;
        if (at.kind === 'absent') {
            deleted.push(path);
            continue;
        }
        movedGitlinks.push(`${path} (${at.kind === 'head' ? `checked out at ${at.sha.slice(0, 12)}, not ${e.sha.slice(0, 12)}` : at.why})`);
    }
    if (movedGitlinks.length > 0) {
        return refuse('gitlink', `the lane changed nested repositories (gitlinks): ${movedGitlinks.slice(0, 5).join(', ')}; host git does not enter them, so their content is not reviewed`);
    }
    const realRoot = realpathSync.native(input.worktree);
    const maxTotal = input.limits?.totalBytes ?? LANE_COMMIT_MAX_BYTES;
    let total = 0;
    for (const path of listed) {
        const read = engineRead(input.worktree, path, realRoot);
        const was = start.get(path);
        if (read.kind === 'swapped')
            return refuse('escaped', `a path of the lane's change cannot be read safely: ${read.why}; host git could read through it outside the worktree`);
        if (read.kind === 'link') {
            symlinks.push(path);
            continue;
        }
        if (read.kind === 'other')
            return refuse('error', `${path} is not a regular file, directory or link`);
        if (read.kind === 'big')
            return refuse('error', `${path} is ${read.size} bytes, over the lane commit's per-file limit of ${LANE_FILE_MAX_BYTES} bytes (GitHub refuses files over 100 MiB); nothing was committed`);
        if (read.kind === 'deleted' || read.kind === 'dir') {
            // A tracked file replaced by a directory: the file goes; the directory's files are listed on their own.
            if (was && was.mode !== '160000')
                deleted.push(path);
            continue;
        }
        // A symlink checked out as a text placeholder (core.symlinks=false, Git for Windows' default): `add -A` kept the
        // 120000 mode with the new text as the link target, which the old check refused.
        if (was?.mode === '120000') {
            symlinks.push(path);
            continue;
        }
        // A hard link to a file outside the worktree passes the link checks, but shares its inode.
        if (read.nlink > 1) {
            hardLinked.push(path);
            continue;
        }
        total += read.bytes.length;
        if (total > maxTotal)
            return refuse('error', `the lane's changed files are over the lane commit's total limit of ${maxTotal} bytes; nothing was committed`);
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
        // One fast-import per batch of about FAST_IMPORT_BATCH_BYTES: the stream copies only that batch's bytes.
        const batchBytes = input.limits?.batchBytes ?? FAST_IMPORT_BATCH_BYTES;
        for (let from = 0; from < raw.length;) {
            let to = from;
            let size = 0;
            while (to < raw.length && (to === from || size + raw[to].bytes.length <= batchBytes))
                size += raw[to++].bytes.length;
            const batch = raw.slice(from, to);
            const marks = join(tmp, 'marks');
            const stream = Buffer.concat([...batch.flatMap((f, i) => [Buffer.from(`blob\nmark :${i + 1}\ndata ${f.bytes.length}\n`), f.bytes, Buffer.from('\n')]), Buffer.from('done\n')]);
            git(['fast-import', '--quiet', '--done', `--export-marks=${marks}`], env, stream);
            const byMark = new Map(readFileSync(marks, 'utf8').split('\n').map((l) => /^:(\d+) ([0-9a-f]+)$/.exec(l.trim())).filter((m) => m !== null).map((m) => [Number(m[1]), m[2]]));
            batch.forEach((f, i) => {
                const sha = byMark.get(i + 1);
                if (!sha || !HEX.test(sha))
                    throw new Error(`git fast-import wrote no blob for ${f.path}`);
                shas.set(f.path, sha);
            });
            from = to;
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
        // A token in a path name would be pushed too; the finding names the path by a hash so the value is never echoed.
        for (const path of changed) {
            for (const kind of secretShapeKinds(path))
                findings.push({ path: secretPathLabel(path), kind });
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
        if (hit.length > 0) {
            // A CI definition decides which checks the gates require: only a human changes it, never a lane.
            const ci = protectedChanges(hit, ['.github/workflows/', ...ADO_PIPELINE_PATHS, ...CI_DEFINITION_PATHS]);
            const human = ci.length > 0 ? `. ${ci.join(', ')} ${ci.length === 1 ? 'is a CI definition path' : 'are CI definition paths'}, which a factory lane may never change: a human must make that change, in a commit or PR of their own outside the factory` : '';
            return refuse('protected', `the lane changed merge-rule or lane-protected paths: ${hit.join(', ')}${human}`);
        }
        const acked = new Set((input.secretAck ?? []).map(findingKey));
        // The commit message carries the lane's own summary: a token it quotes would be pushed with it.
        const messageFindings = secretShapeKinds(input.message).map((kind) => ({ path: SECRET_MESSAGE_PATH, kind }));
        const secrets = [...staged.findings, ...messageFindings].filter((f) => !acked.has(findingKey(f)));
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
            return { ok: false, refusal: 'empty', reason: LANE_LEFT_NO_CHANGES };
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