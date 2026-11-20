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
 * tree entries, bytes read and wall time; any git failure yields no list.
 */
import { secretShapeKinds } from '../heal/sanitize.js';
import { protectedChanges } from '../../ship/merge.js';
import { LANE_PROTECTED_PATHS } from './lane-commit.js';
const HEX40 = /^[0-9a-f]{40}$/;
/** Only plain paths are listed (a name cannot smuggle markup or instructions into the prompt). */
const SAFE_PATH = /^[\w@+-][\w.@+-]*(?:\/[\w@+-][\w.@+-]*)*$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', '.git', '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'bower_components', 'jspm_packages']);
const BINARY_EXT = /\.(?:png|jpe?g|gif|bmp|ico|webp|avif|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|o|a|lib|obj|wasm|node|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|flac|sqlite|db|bin|pyc|pyo|lockb)$/i;
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/;
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
/** The repo paths and code identifiers an issue names, each once, in first-seen order. */
export function prescanTerms(input) {
    // An absolute path outside the repository names nothing in it (its segments are not code names).
    let text = input;
    for (const p of outsidePaths(input, Infinity))
        text = text.split(p).join(' ');
    const paths = [];
    for (const m of text.matchAll(PATH_TOKEN)) {
        const before = text.slice(Math.max(0, (m.index ?? 0) - 3), m.index);
        // A URL's path or a Windows / UNC absolute path is not a repo path.
        if (/:\/\/?$|[\\:]$/.test(before) || /:\/\//.test(m[1]))
            continue;
        if (!paths.includes(m[1]) && paths.length < MAX_NAMED_PATHS)
            paths.push(m[1]);
    }
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
 * The absolute paths outside any repository that `text` names: a Windows
 * drive or UNC path, `~/`, or a POSIX path under a system or home root.
 * Each once, in first-seen order, at most 5. Deterministic and free; the
 * implement prompt only counts them.
 */
export function outsidePaths(text, max = 5) {
    const out = [];
    const re = /(?<![\w/\\.:])(?:[A-Za-z]:[\\/][^\s`'"<>|*?]+|\\\\[\w.$-]+\\[^\s`'"<>|*?]+|~\/[^\s`'"<>|*?]+|\/(?:home|Users|root|etc|var|tmp|opt|mnt|srv|usr|private|Volumes)\/[^\s`'"<>|*?]+)/g;
    for (const m of text.matchAll(re)) {
        const p = m[0].replace(/[.,;:)\]]+$/, '');
        if (!out.includes(p))
            out.push(p);
        if (out.length >= max)
            break;
    }
    return out;
}
function treeFiles(git, sha) {
    const out = [];
    for (const rec of git(['ls-tree', '-r', '-z', '-l', '--full-tree', sha]).toString('utf8').split('\0')) {
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
/** `cat-file --batch` of `oids`: oid -> bytes (a missing object is left out). */
function readBlobs(git, oids) {
    const out = new Map();
    if (oids.length === 0)
        return out;
    const buf = git(['cat-file', '--batch'], Buffer.from(`${oids.join('\n')}\n`));
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
 * scores above one that only mentions it. Empty on any git failure.
 */
export function likelyRelevantFiles(text, sha, git, o = {}) {
    const maxFiles = o.maxFiles ?? 8;
    const maxFileBytes = o.maxFileBytes ?? 200_000;
    const maxTotal = o.maxTotalBytes ?? 8_000_000;
    const now = o.now ?? Date.now;
    const deadline = now() + (o.budgetMs ?? 2_000);
    if (!HEX40.test(sha) || maxFiles <= 0)
        return [];
    const { paths, identifiers } = prescanTerms(text);
    if (paths.length === 0 && identifiers.length === 0)
        return [];
    let tree;
    try {
        tree = treeFiles(git, sha);
    }
    catch {
        return [];
    }
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
    let blobs;
    try {
        blobs = readBlobs(git, batch.map((f) => f.oid));
    }
    catch {
        return [];
    }
    const cleared = new Set();
    for (const f of batch) {
        if (now() > deadline)
            break;
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
    // .gitignore: a check that fails drops the whole list (never list a path we could not clear).
    if (o.ignored) {
        let ign;
        try {
            ign = o.ignored(ranked.slice(0, maxFiles * 2).map(([p]) => p));
        }
        catch {
            return [];
        }
        ranked = ranked.filter(([p]) => !ign.has(p));
    }
    return ranked.slice(0, maxFiles).map(([path, e]) => ({ path, reason: oneReason(e.reasons) }));
}
/** At most three reasons, one line. */
function oneReason(reasons) {
    const shown = reasons.slice(0, 3).join('; ');
    return reasons.length > 3 ? `${shown}; +${reasons.length - 3} more` : shown;
}
//# sourceMappingURL=prescan.js.map