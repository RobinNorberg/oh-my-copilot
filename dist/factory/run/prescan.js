/**
 * The implement lane's free pre-scan (no model call): from the issue's title
 * and plan text it takes the file paths and code identifiers, matches them
 * against the BASE commit's tree (path names, then the text of small tracked
 * files), and returns a short ranked list of likely relevant paths for the
 * implement prompt. A hint only: the lane still changes whatever the plan
 * needs.
 *
 * Only paths and a one-line reason ever leave this module, never file
 * contents. Skipped: anything under a dependency or build directory, binary
 * and large files, secret-looking names, files with secret-shaped content
 * (the lane commit's scan, heal/sanitize.ts), paths a write lane may not
 * change (LANE_PROTECTED_PATHS), paths with characters outside a plain set,
 * and paths the caller's `ignored` check reports (.gitignore). Bounded in
 * tree bytes and entries and in bytes read, so the list depends on the input
 * and the tree only; the wall-time budget is an abort that lists nothing. A
 * git failure rejects (the caller warns and drops the hint).
 */
import { secretShapeKinds } from '../heal/sanitize.js';
import { protectedChanges } from '../../ship/merge.js';
import { LANE_PROTECTED_PATHS } from './lane-commit.js';
const HEX40 = /^[0-9a-f]{40}$/;
/** Only plain paths are listed (a name cannot smuggle markup or instructions into the prompt). */
const SAFE_PATH = /^[\w@+-][\w.@+-]*(?:\/[\w@+-][\w.@+-]*)*$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', '.git', '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'bower_components', 'jspm_packages']);
const BINARY_EXT = /\.(?:png|jpe?g|gif|bmp|ico|webp|avif|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|o|a|lib|obj|wasm|node|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|flac|sqlite|db|bin|pyc|pyo|lockb)$/i;
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum|packages\.lock\.json)$/;
/** Names that usually hold credentials: never listed, whatever their content. */
const SECRET_NAME = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]*credentials[^/]*|[^/]*secrets?(?:\.[^/]*)?)$|\.(?:pem|key|p12|pfx|jks|keystore|crt|cer|der|kdbx)$/i;
/** Words never taken as identifiers (keywords, literals, built-ins and filler that match everywhere). */
const STOP = new Set([
    'and', 'the', 'for', 'not', 'are', 'its', 'with', 'from', 'into', 'that', 'this', 'when', 'than', 'then', 'only', 'each', 'every', 'none',
    'const', 'let', 'var', 'function', 'return', 'new', 'throw', 'throws', 'class', 'interface', 'type', 'enum', 'import', 'export', 'default',
    'true', 'false', 'null', 'undefined', 'void', 'async', 'await', 'typeof', 'instanceof', 'string', 'number', 'boolean', 'object', 'any', 'unknown',
    'Error', 'TypeError', 'RangeError', 'Promise', 'Array', 'Object', 'String', 'Number', 'Math', 'JSON', 'Date', 'Map', 'Set', 'console',
    'npm', 'run', 'test', 'tests', 'src', 'docs', 'lib', 'index', 'main', 'dev', 'readme', 'README', 'todo', 'TODO', 'http', 'https', 'www',
    // Test-framework calls an issue quotes in an example assertion: they match every test file.
    'expect', 'toBe', 'toEqual', 'toStrictEqual', 'toThrow', 'toMatch', 'toContain', 'toHaveBeenCalled', 'toHaveBeenCalledWith', 'describe', 'beforeEach', 'afterEach', 'assert', 'assertEqual',
]);
const MAX_IDENTIFIERS = 12;
const MAX_NAMED_PATHS = 12;
const PATH_TOKEN = /(?<=^|[\s`'"(<[])((?:[\w@+-][\w.@+-]*\/)*[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s`'")>\],:;!?]|\.(?:\s|$))/gm;
/** Only this much of an issue is read (the scan stays linear and small). */
const MAX_SCAN_CHARS = 200_000;
/** An absolute path outside any repository: a Windows drive or UNC path, `~/`, or a POSIX path under a system or home root. */
const OUTSIDE_RE = /(?<![\w/\\.:])(?:[A-Za-z]:[\\/][^\s`'"<>|*?]+|\\\\[\w.$-]+\\[^\s`'"<>|*?]+|~\/[^\s`'"<>|*?]+|\/(?:home|Users|root|etc|var|tmp|opt|mnt|srv|usr|private|Volumes)\/[^\s`'"<>|*?]+)/g;
/** A stack-trace or compiler location after a path (`a.ts:42`, `a.ts:42:7`); at most two groups, so the match is linear. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
/**
 * Outside paths that are never a task's input: executables an issue runs
 * (`#!/usr/bin/env node`, `/usr/local/bin/node`). `/etc/...`, home and temp
 * paths stay: a task that reads one of those (`/etc/hosts`, `~/notes.md`) is
 * the outside read a lane cannot do. `/tmp` is no exception: it is the
 * system temp dir on Linux (os.tmpdir()), where a support file or the bench's
 * outside file lives as often as `%TEMP%` (a drive path, always counted) does
 * on Windows.
 */
const BENIGN_OUTSIDE = /^\/(?:usr\/(?:local\/)?s?bin|s?bin)\//;
/** `p` without trailing sentence punctuation (a loop, so a long run of dots stays linear). */
function trimTrailing(p) {
    let end = p.length;
    while (end > 0 && '.,;:)]'.includes(p[end - 1]))
        end -= 1;
    return p.slice(0, end);
}
/** A matched outside path without trailing punctuation or `:line(:col)`; `line` when it had one. */
function cleanOutside(raw) {
    const p = trimTrailing(raw);
    const line = LINE_SUFFIX.test(p);
    return { path: line ? trimTrailing(p.replace(LINE_SUFFIX, '')) : p, line };
}
/**
 * The longest proper suffix of `path`'s segments that is a tracked file, with
 * at least `minSegs` segments (only the last 16 segments are tried).
 */
function trackedSuffix(path, tracked, minSegs) {
    const segs = path.split(/[\\/]/).filter(Boolean);
    for (let i = Math.max(1, segs.length - 16); i <= segs.length - minSegs; i += 1) {
        const s = segs.slice(i).join('/');
        if (tracked.has(s))
            return s;
    }
    return undefined;
}
/**
 * The repo paths and code identifiers an issue names, each once, in
 * first-seen order. With the base's `tracked` paths, an outside path that
 * ends in a tracked file (a stack frame `/home/alice/proj/src/a.ts:3`)
 * names that file.
 */
export function prescanTerms(input, tracked) {
    // An absolute path outside the repository names nothing in it (its segments are not code names), except a tracked suffix.
    const inRepo = [];
    const text = input.slice(0, MAX_SCAN_CHARS).replace(OUTSIDE_RE, (raw) => {
        const s = tracked ? trackedSuffix(cleanOutside(raw).path, tracked, 1) : undefined;
        if (s && SAFE_PATH.test(s))
            inRepo.push(s);
        return ' ';
    });
    const paths = [];
    const addPath = (p) => { if (!paths.includes(p) && paths.length < MAX_NAMED_PATHS)
        paths.push(p); };
    for (const m of text.matchAll(PATH_TOKEN)) {
        const before = text.slice(Math.max(0, (m.index ?? 0) - 3), m.index);
        // A URL's path or a Windows / UNC absolute path is not a repo path.
        if (/:\/\/?$|[\\:]$/.test(before) || /:\/\//.test(m[1]))
            continue;
        addPath(m[1]);
    }
    // The paths written out first; the tracked files of outside paths (often a long trace) after them.
    for (const p of inRepo)
        addPath(p);
    const identifiers = [];
    const add = (w) => {
        // A secret-shaped word is never a search term (its reason would carry it into the prompt).
        if (w.length < 3 || STOP.has(w) || STOP.has(w.toLowerCase()) || /^\d/.test(w) || identifiers.includes(w) || identifiers.length >= MAX_IDENTIFIERS || secretShapeKinds(w).length > 0)
            return;
        if (paths.some((p) => p.split(/[/.]/).includes(w)))
            return;
        identifiers.push(w);
    };
    // Names that look like code: a call, camelCase, PascalCase with an inner capital, snake_case, an ALL-CAPS constant
    // with a digit or underscore; inside a code span also a span that is one bare identifier (`inStock`). A plain word
    // in a call's arguments (`value`, `min`) or in a string literal names no file, so it is left out.
    const CODE_NAME = /[A-Za-z_$][\w$]*(?=\()|\b[a-z]+[A-Z][\w$]*|\b[A-Z][a-z0-9]+[A-Z][\w$]*|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+|\d)[A-Z0-9_]*\b/g;
    const noStrings = (s) => s.replace(/'[^'\n]*'|"[^"\n]*"/g, ' ');
    const order = [];
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
        const span = m[1].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(span))
            order.push({ at: m.index ?? 0, word: span });
        else
            for (const c of noStrings(span).matchAll(CODE_NAME))
                order.push({ at: (m.index ?? 0) + (c.index ?? 0), word: c[0] });
    }
    // Prose and indented code, with code spans blanked (same length, so positions keep their order).
    // Only indented code loses its string literals: in prose an apostrophe ("file's") is no quote.
    const rest = text.replace(/`[^`\n]+`/g, (s) => ' '.repeat(s.length)).split('\n').map((l) => (/^(?: {4}|\t)\S/.test(l) ? noStrings(l).padEnd(l.length) : l)).join('\n');
    for (const m of rest.matchAll(CODE_NAME))
        order.push({ at: m.index ?? 0, word: m[0] });
    order.sort((a, b) => a.at - b.at);
    for (const { word } of order)
        add(word);
    return { paths, identifiers };
}
/**
 * The absolute paths outside any repository that `text` names as a possible
 * input: a Windows drive or UNC path, `~/`, or a POSIX path under a system or
 * home root. Left out: a location in a stack trace or log (`:line` or
 * `:line:col` after it), an executable path (BENIGN_OUTSIDE), and,
 * with the base's `tracked` paths, a path ending in a tracked file of two or
 * more segments (a frame of this repository at another checkout). Each once,
 * in first-seen order, at most `max`. Linear, deterministic and free; the
 * implement prompt only counts them.
 */
export function outsidePaths(text, max = 5, tracked) {
    const out = new Set();
    for (const m of text.slice(0, MAX_SCAN_CHARS).matchAll(OUTSIDE_RE)) {
        const { path, line } = cleanOutside(m[0]);
        if (line || BENIGN_OUTSIDE.test(path) || (tracked && trackedSuffix(path, tracked, 2)))
            continue;
        out.add(path);
        if (out.size >= max)
            break;
    }
    return [...out];
}
async function treeFiles(git, sha, maxBytes) {
    const out = [];
    for (const rec of (await git(['ls-tree', '-r', '-z', '-l', '--full-tree', sha], undefined, maxBytes)).toString('utf8').split('\0')) {
        const tab = rec.indexOf('\t');
        if (tab < 0)
            continue;
        const [mode, type, oid, size] = rec.slice(0, tab).trim().split(/\s+/);
        if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || !/^[0-9a-f]{40,64}$/.test(oid ?? ''))
            continue;
        out.push({ path: rec.slice(tab + 1), oid, size: Number(size) });
    }
    return out;
}
function eligible(f, maxFileBytes) {
    if (!SAFE_PATH.test(f.path) || !Number.isFinite(f.size) || f.size > maxFileBytes)
        return false;
    const segs = f.path.split('/');
    if (segs.slice(0, -1).some((s) => SKIP_DIRS.has(s)))
        return false;
    if (BINARY_EXT.test(f.path) || LOCKFILE.test(f.path) || SECRET_NAME.test(f.path) || /\.min\.(?:js|css)$/.test(f.path))
        return false;
    return secretShapeKinds(f.path).length === 0;
}
/** `cat-file --batch` of `oids` (`bytes` in all): oid -> bytes (a missing object is left out). */
async function readBlobs(git, oids, bytes) {
    const out = new Map();
    if (oids.length === 0)
        return out;
    // Each object adds one header line (`<oid> blob <size>\n`) and a newline to its bytes.
    const buf = await git(['cat-file', '--batch'], Buffer.from(`${oids.join('\n')}\n`), bytes + oids.length * 100 + 1024);
    let at = 0;
    while (at < buf.length) {
        const nl = buf.indexOf(0x0a, at);
        if (nl < 0)
            break;
        const [oid, type, size] = buf.subarray(at, nl).toString('utf8').split(' ');
        if (type === 'missing' || size === undefined) {
            at = nl + 1;
            continue;
        }
        const n = Number(size);
        out.set(oid, buf.subarray(nl + 1, nl + 1 + n));
        at = nl + 1 + n + 1;
    }
    return out;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The likely relevant files of the base commit `sha` for `text` (issue title
 * and plan): at most `maxFiles`, highest score first, ties by path. A path
 * the issue names scores above a file that defines a named identifier, which
 * scores above one that only mentions it. Empty past the time budget; a git
 * failure (a huge tree included) or a failed ignore check rejects.
 */
export async function likelyRelevantFiles(text, sha, git, o = {}) {
    const maxFiles = o.maxFiles ?? 8;
    const maxFileBytes = o.maxFileBytes ?? 200_000;
    const maxTotal = o.maxTotalBytes ?? 8_000_000;
    const now = o.now ?? Date.now;
    const deadline = now() + (o.budgetMs ?? 2_000);
    if (!HEX40.test(sha) || maxFiles <= 0)
        return [];
    // Without terms and without an outside path (whose tracked suffix could be one) no git runs.
    const first = prescanTerms(text);
    if (first.paths.length === 0 && first.identifiers.length === 0 && text.slice(0, MAX_SCAN_CHARS).search(OUTSIDE_RE) < 0)
        return [];
    const tree = await treeFiles(git, sha, o.maxTreeBytes ?? 16_000_000);
    const tracked = new Set(tree.map((f) => f.path));
    o.onTree?.(tracked);
    const { paths, identifiers } = prescanTerms(text, tracked);
    if (paths.length === 0 && identifiers.length === 0)
        return [];
    if (now() > deadline)
        return [];
    const protectedSet = new Set(protectedChanges(tree.map((f) => f.path), LANE_PROTECTED_PATHS));
    const files = tree.filter((f) => eligible(f, maxFileBytes) && !protectedSet.has(f.path));
    const score = new Map();
    const hit = (path, n, reason) => {
        const e = score.get(path) ?? { n: 0, reasons: [] };
        e.n += n;
        if (!e.reasons.includes(reason))
            e.reasons.push(reason);
        score.set(path, e);
    };
    // Paths the issue names: the exact path, else (a bare file name) every tracked file of that name.
    for (const p of paths) {
        const exact = files.find((f) => f.path === p);
        if (exact)
            hit(exact.path, 100, 'named in the issue');
        else if (!p.includes('/'))
            for (const f of files.filter((x) => x.path.endsWith(`/${p}`)).slice(0, 3))
                hit(f.path, 60, `file name ${p} named in the issue`);
    }
    // The tests of a named source file (`<stem>.test.*`, `<stem>.spec.*`, `test_<stem>.*`, `<stem>_test.*`): the
    // implement prompt asks for tests, and a new function is in no file yet for the identifier search to find.
    for (const named of [...score.keys()]) {
        const base = named.slice(named.lastIndexOf('/') + 1);
        const stem = base.slice(0, base.indexOf('.') > 0 ? base.indexOf('.') : base.length);
        if (stem.length < 2 || /\.(?:test|spec)\./.test(base) || /^test_|_test\./.test(base))
            continue;
        const tests = files.filter((f) => {
            const b = f.path.slice(f.path.lastIndexOf('/') + 1);
            return f.path !== named && (b.startsWith(`${stem}.test.`) || b.startsWith(`${stem}.spec.`) || b.startsWith(`test_${stem}.`) || b.startsWith(`${stem}_test.`));
        });
        for (const f of tests.slice(0, 2))
            hit(f.path, 5, `test file of ${named}`);
    }
    // The text of small tracked files, within the byte and time budget: the named files first (each is checked for
    // binary or secret-shaped content before it may be listed), then, with identifiers, every other eligible file.
    const named = files.filter((f) => score.has(f.path));
    const scan = identifiers.length > 0 && tree.length <= (o.maxTreeEntries ?? 50_000) ? files.filter((f) => !score.has(f.path)) : [];
    const res = identifiers.map((id) => ({
        id,
        word: new RegExp(`(?<![\\w$])${escapeRe(id)}(?![\\w$])`),
        def: new RegExp(`(?:\\b(?:function|const|let|var|class|interface|type|enum|def|fn|func|struct|trait)\\s+|\\b(?:export|public|private|protected|static)\\s+[^\\n=;(]*?)(?<![\\w$])${escapeRe(id)}(?![\\w$])`),
    }));
    let total = 0;
    const batch = [];
    for (const f of [...named, ...scan]) {
        if (total + f.size > maxTotal)
            break;
        total += f.size;
        batch.push(f);
    }
    // The content phase is bounded by bytes only (the same input and tree give the same list); time only aborts.
    if (now() > deadline)
        return [];
    const blobs = await readBlobs(git, batch.map((f) => f.oid), total);
    const cleared = new Set();
    for (const f of batch) {
        if (now() > deadline)
            return [];
        const bytes = blobs.get(f.oid);
        if (!bytes || bytes.subarray(0, 8_000).includes(0))
            continue;
        const body = bytes.toString('utf8');
        if (secretShapeKinds(body).length > 0)
            continue;
        cleared.add(f.path);
        for (const r of res) {
            if (r.def.test(body))
                hit(f.path, 10, `defines \`${r.id}\``);
            else if (r.word.test(body))
                hit(f.path, 3, `mentions \`${r.id}\``);
        }
    }
    // Only files whose text was read and found clean are listed.
    for (const p of [...score.keys()])
        if (!cleared.has(p))
            score.delete(p);
    let ranked = [...score.entries()].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (ranked.length === 0)
        return [];
    // .gitignore: a check that fails rejects the whole scan (never list a path we could not clear).
    if (o.ignored) {
        const ign = await o.ignored(ranked.slice(0, maxFiles * 2).map(([p]) => p));
        ranked = ranked.filter(([p]) => !ign.has(p));
    }
    if (now() > deadline)
        return [];
    return ranked.slice(0, maxFiles).map(([path, e]) => ({ path, reason: oneReason(e.reasons) }));
}
/** At most three reasons, one line. */
function oneReason(reasons) {
    const shown = reasons.slice(0, 3).join('; ');
    return reasons.length > 3 ? `${shown}; +${reasons.length - 3} more` : shown;
}
//# sourceMappingURL=prescan.js.map