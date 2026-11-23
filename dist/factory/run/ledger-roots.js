/**
 * The repositories this host's engine ledger knows (`omg factory attention
 * --all-repos`, `omg factory dashboard --serve --all-repos`). READ-ONLY: it
 * lists and reads files under the ledger dir and stats each root; it never
 * creates, locks or writes anything, and runs no subprocess.
 *
 * Trust: the ledger (defaultLedgerDir: `$OMC_STATE_DIR/factory-ledger` or
 * `~/.omg/factory-ledger`) lives outside every repository, so a root is only
 * ever taken from it: the `root` of a repository dir's `run-<key>.json`
 * records, and the `root` of claim owner records (`claims/<16 hex>/run-<key>.owner`)
 * for repositories whose ledger dir is gone. Never from a file inside a
 * repository.
 *
 * A root is listed only when:
 * - it is a plain local absolute, normalised path (claimRoot: no control or
 *   format character, no UNC / device path);
 * - a ledger dir's name is the id the engine derives from it (ledgerRepoId):
 *   a record copied or forged into another repository's dir is refused;
 * - it exists, is a directory, is not reached through a link (its real path
 *   is itself, compared case-insensitively on win32/darwin), and holds `.git`
 *   (a directory, or a `gitdir:` file of a linked worktree or submodule): a
 *   subdirectory of a repository or a plain folder is refused;
 * - no other listed root has the same real path.
 * Each filesystem probe of a root runs async with a timeout (ROOT_PROBE_MS),
 * so a slow or unreachable drive is skipped (`timeout`) rather than stalling
 * the rest. A refused root is counted in `skipped` with its ledger id and a
 * reason; its path (sanitised) is for --verbose / --json only.
 *
 * Bounds: at most MAX_REPOS repository dirs and MAX_CLAIM_DIRS claim dirs are
 * looked at, at most RECORDS_PER_DIR records read per dir, each record
 * through readRegularFile (no link, no FIFO, size-capped). A malformed or
 * unreadable record is skipped with a warning, never fatal.
 */
import { promises as fsp, readdirSync, lstatSync } from 'fs';
import { basename, join, resolve } from 'path';
import { plainText } from '../check/score.js';
import { readRegularFile, runKeyOfName } from '../attention/collect.js';
import { canonicalPath, claimRoot } from './claims.js';
import { ledgerRepoId } from './ledger.js';
export const MAX_REPOS = 200;
export const MAX_CLAIM_DIRS = 200;
export const RECORDS_PER_DIR = 4;
/** A ledger record or claim larger than this is not read for its root. */
export const RECORD_MAX_BYTES = 4 * 1024 * 1024;
export const ROOT_PROBE_MS = 3_000;
const ROOT_TEXT_MAX = 300;
const LEDGER_ID = /^[0-9a-f]{16}$/;
const OWNER_FILE = /^run-(\d+|heal-[0-9a-f]{8})\.owner$/;
const shown = (root) => plainText(root).slice(0, ROOT_TEXT_MAX);
/** The names in `dir`, sorted; [] when it cannot be listed. */
function names(dir) {
    try {
        return readdirSync(dir).sort();
    }
    catch {
        return [];
    }
}
/** A real directory (not a link) under the ledger. */
function isPlainDir(path) {
    try {
        return lstatSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
/** The `root` of a JSON record, if it has a string one. */
function recordRoot(path, check) {
    const r = readRegularFile(path, RECORD_MAX_BYTES);
    if (!('bytes' in r))
        return { warning: 'missing' in r ? 'it disappeared' : 'it cannot be read' };
    try {
        const v = JSON.parse(r.bytes.toString('utf8'));
        if (typeof v !== 'object' || v === null || !check(v))
            return { warning: 'it is not a record of this shape' };
        return { root: v.root };
    }
    catch {
        return { warning: 'it is not valid JSON' };
    }
}
/** The root a repository dir's ledger records name (the first readable one of up to RECORDS_PER_DIR). */
function ledgerDirRoot(dir, id) {
    const files = names(dir).filter((n) => runKeyOfName(n) !== null).slice(0, RECORDS_PER_DIR);
    let problems = 0;
    for (const name of files) {
        const key = runKeyOfName(name);
        const got = recordRoot(join(dir, name), (v) => v.version === 1 && v.issue === key);
        if ('warning' in got) {
            problems++;
            continue;
        }
        return rootOf(got.root, id, true);
    }
    // A fixed message: no error text and no path (it may reach the --serve page).
    if (problems > 0)
        return { reason: 'unreadable', warning: `engine ledger dir ${id}: none of its first ${problems} run record(s) is a readable engine record; skipped` };
    return { reason: 'no-root' };
}
/** A recorded root checked for shape and, for a ledger dir, for the dir's id. */
function rootOf(raw, id, bound) {
    const root = claimRoot(raw);
    if (root === null)
        return { reason: 'invalid-root', ...(typeof raw === 'string' ? { root: shown(raw) } : {}) };
    if (bound && ledgerRepoId(root) !== id)
        return { reason: 'id-mismatch', root: shown(root) };
    return { root };
}
const timeout = (p, ms) => {
    let t;
    return Promise.race([p, new Promise((done) => { t = setTimeout(() => done('timeout'), ms); t.unref(); })]).finally(() => clearTimeout(t));
};
/**
 * Whether `root` is a repository top level here: a directory, not reached
 * through a link, holding `.git` (a dir, or a `gitdir:` file). Returns its
 * canonical real path (the dedupe key) or why not.
 */
export async function probeRoot(root, platform = process.platform, ms = ROOT_PROBE_MS) {
    const probe = async () => {
        let st;
        try {
            st = await fsp.lstat(root);
        }
        catch (error) {
            return { reason: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'unreadable' };
        }
        if (st.isSymbolicLink())
            return { reason: 'link' };
        if (!st.isDirectory())
            return { reason: 'not-a-directory' };
        let real;
        try {
            real = await fsp.realpath(root);
        }
        catch {
            return { reason: 'unreadable' };
        }
        // A junction (or a parent link) resolves elsewhere: the engine's root is the real top level.
        if (canonicalPath(real, platform) !== fold(resolve(root), platform))
            return { reason: 'link' };
        let git;
        try {
            git = await fsp.lstat(join(root, '.git'));
        }
        catch {
            return { reason: 'not-a-repository' };
        }
        if (git.isFile()) {
            if (git.size > 4096)
                return { reason: 'not-a-repository' };
            const head = await fsp.readFile(join(root, '.git'), 'utf8').catch(() => '');
            if (!head.startsWith('gitdir:'))
                return { reason: 'not-a-repository' };
        }
        else if (!git.isDirectory())
            return { reason: 'not-a-repository' };
        return { real: canonicalPath(real, platform) };
    };
    const got = await timeout(probe(), ms);
    return got === 'timeout' ? { reason: 'timeout' } : got;
}
const fold = (p, platform) => {
    const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' || platform === 'darwin' ? slashed.toLowerCase() : slashed;
};
/** --repo <path>: resolved against the cwd; it must be a repository top level (null) or the reason it is not. */
export async function checkPinnedRoot(path, platform = process.platform, ms = ROOT_PROBE_MS) {
    const root = resolve(path);
    if (claimRoot(root) === null)
        return { error: `--repo ${JSON.stringify(shown(path))} is not a plain local path` };
    const p = await probeRoot(root, platform, ms);
    if ('reason' in p)
        return { error: `--repo ${JSON.stringify(shown(root))} is not a repository top level (${p.reason})` };
    return { root };
}
/** Every repository the engine ledger of this host records (or the pinned ones), validated; read-only. */
export async function discoverLedgerRoots(o) {
    const platform = o.platform ?? process.platform;
    const maxRepos = o.maxRepos ?? MAX_REPOS;
    const warnings = [];
    const skipped = [];
    const candidates = [];
    const seenIds = new Set();
    const ids = names(o.ledgerDir).filter((n) => LEDGER_ID.test(n) && isPlainDir(join(o.ledgerDir, n)));
    if (ids.length > maxRepos)
        warnings.push(`the engine ledger has ${ids.length} repository dirs; only the first ${maxRepos} were read`);
    for (const id of ids.slice(0, maxRepos)) {
        seenIds.add(id);
        const r = ledgerDirRoot(join(o.ledgerDir, id), id);
        if ('warning' in r && r.warning)
            warnings.push(plainText(r.warning).slice(0, 500));
        if ('reason' in r) {
            // A dir with heal seals only names no root: nothing to list, nothing wrong.
            if (r.reason !== 'no-root')
                skipped.push({ id, reason: r.reason, ...(r.root ? { root: r.root } : {}) });
            continue;
        }
        candidates.push({ id, root: r.root, source: 'ledger', recorded: true });
    }
    // Claim owners name roots too; they add a repository only when its ledger dir is gone.
    const claimsDir = join(o.ledgerDir, 'claims');
    const claimDirs = names(claimsDir).filter((n) => LEDGER_ID.test(n) && isPlainDir(join(claimsDir, n)));
    if (claimDirs.length > MAX_CLAIM_DIRS)
        warnings.push(`the engine ledger has ${claimDirs.length} claim dirs; only the first ${MAX_CLAIM_DIRS} were read`);
    for (const c of claimDirs.slice(0, MAX_CLAIM_DIRS)) {
        for (const name of names(join(claimsDir, c)).filter((n) => OWNER_FILE.test(n)).slice(0, RECORDS_PER_DIR)) {
            const got = recordRoot(join(claimsDir, c, name), (v) => typeof v.hostname === 'string' && typeof v.root === 'string');
            if ('warning' in got)
                continue; // A claim is a hint here: an unreadable one adds nothing.
            const root = claimRoot(got.root);
            if (root === null)
                continue;
            const id = ledgerRepoId(root);
            if (seenIds.has(id) || candidates.length >= maxRepos)
                continue;
            seenIds.add(id);
            candidates.push({ id, root, source: 'claim', recorded: false });
        }
    }
    const probed = await Promise.all(candidates.map(async (c) => ({ c, p: await probeRoot(c.root, platform, o.probeMs) })));
    const byReal = new Map();
    for (const { c, p } of probed) {
        if ('reason' in p) {
            skipped.push({ id: c.id, reason: p.reason, root: shown(c.root) });
            continue;
        }
        if (byReal.has(p.real)) {
            skipped.push({ id: c.id, reason: 'duplicate', root: shown(c.root) });
            continue;
        }
        byReal.set(p.real, { id: c.id, root: c.root, source: c.source, recorded: c.recorded });
    }
    let roots = [...byReal.values()];
    if (o.pinned) {
        // --repo: exactly these roots; each one's ledger record (if any) by its id.
        const known = new Map(roots.map((r) => [canonicalPath(r.root, platform), r]));
        const out = [];
        const seen = new Set();
        for (const pin of o.pinned) {
            const key = canonicalPath(pin, platform);
            if (seen.has(key))
                continue;
            seen.add(key);
            const hit = known.get(key);
            const id = ledgerRepoId(pin);
            out.push(hit ?? { id, root: resolve(pin), source: 'pinned', recorded: isPlainDir(join(o.ledgerDir, id)) });
        }
        roots = out;
        // Skipped records of roots outside the pinned set are not this view's business.
        const pinnedIds = new Set(out.map((r) => r.id));
        return { roots, skipped: skipped.filter((s) => pinnedIds.has(s.id)), warnings };
    }
    roots.sort((a, b) => basename(a.root).localeCompare(basename(b.root)) || a.root.localeCompare(b.root));
    return { roots, skipped, warnings };
}
//# sourceMappingURL=ledger-roots.js.map