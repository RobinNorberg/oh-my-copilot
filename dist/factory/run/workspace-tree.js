/**
 * Workspaces (monorepos) in the gate's node_modules tree (prepare.ts
 * linkNodeModules): which package dirs of your checkout get a nested
 * per-run tree, from the workspace globs of the TRUSTED BASE (root
 * `package.json` `workspaces`, or `pnpm-workspace.yaml` `packages`), never
 * the PR head's. Globs are expanded against your checkout, bounded
 * (WORKSPACE_MAX_PACKAGES, WORKSPACE_MAX_DEPTH, WORKSPACE_MAX_DIRS), never
 * following a link and never leaving the checkout; a glob with `..`, an
 * absolute path or a backslash is dropped with a note.
 *
 * Supported: npm, pnpm and yarn workspaces with a node_modules layout (yarn
 * classic, yarn berry with `nodeLinker: node-modules`). Not supported, named
 * as a problem: Yarn Plug'n'Play (`.pnp.cjs`), a workspace package that is a
 * nested git repository, and a layout over the bounds.
 */
import { lstatSync, readdirSync, realpathSync } from 'fs';
import { join, relative, sep } from 'path';
/** The most workspace package dirs a tree is built for. */
export const WORKSPACE_MAX_PACKAGES = 256;
/** The deepest a workspace package dir may lie below your checkout (path segments). */
export const WORKSPACE_MAX_DEPTH = 6;
/** The most dirs read while expanding the globs. */
export const WORKSPACE_MAX_DIRS = 20_000;
/** The largest base `package.json` / `pnpm-workspace.yaml` read for the globs. */
export const WORKSPACE_FILE_MAX_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git']);
/**
 * The workspace globs of the base: `workspaces` (an array, or yarn's
 * `{ packages: [...] }`) of the root package.json, else the `packages` list
 * of pnpm-workspace.yaml. Negations (`!glob`) are kept. Unreadable or
 * oversized input is no workspaces.
 */
export function parseWorkspacePatterns(packageJson, pnpmWorkspaceYaml) {
    const out = [];
    if (packageJson !== null && packageJson.length <= WORKSPACE_FILE_MAX_BYTES) {
        try {
            const pkg = JSON.parse(packageJson);
            const ws = pkg?.workspaces;
            const list = Array.isArray(ws) ? ws : ws && typeof ws === 'object' && Array.isArray(ws.packages) ? ws.packages : [];
            for (const p of list)
                if (typeof p === 'string' && p.trim())
                    out.push(p.trim());
        }
        catch { /* not JSON: no workspaces */ }
    }
    if (pnpmWorkspaceYaml !== null && pnpmWorkspaceYaml.length <= WORKSPACE_FILE_MAX_BYTES)
        out.push(...pnpmPackages(pnpmWorkspaceYaml));
    return [...new Set(out)];
}
const unquote = (s) => {
    const t = s.trim();
    return (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')) ? t.slice(1, -1) : t;
};
/** The `packages:` list of a pnpm-workspace.yaml (block or flow style); comments dropped. */
function pnpmPackages(yaml) {
    const out = [];
    const lines = yaml.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, ''));
    for (let i = 0; i < lines.length; i++) {
        const m = /^packages\s*:\s*(.*)$/.exec(lines[i]);
        if (!m)
            continue;
        const rest = m[1].trim();
        if (rest.startsWith('[')) {
            const body = rest.endsWith(']') ? rest.slice(1, -1) : rest.slice(1);
            for (const item of body.split(','))
                if (unquote(item))
                    out.push(unquote(item));
            return out;
        }
        for (let j = i + 1; j < lines.length; j++) {
            const l = lines[j];
            if (!l.trim())
                continue;
            const item = /^\s+-\s*(.+)$/.exec(l) ?? /^-\s*(.+)$/.exec(l);
            if (!item)
                break;
            if (unquote(item[1]))
                out.push(unquote(item[1]));
        }
        return out;
    }
    return out;
}
/**
 * A relative workspace path of the exact shape the tree accepts: forward
 * slashes, no empty segment, no dot segment (`.`, `..`, `.omg`, `.git`:
 * the engine's state and other runs' checkouts live there), no
 * node_modules segment in any case, no segment ending in a dot or space
 * and none with a `~` (win32 aliases: `node_modules.`, `NODE_M~1`), not
 * absolute, no drive, no backslash or control character, at most
 * WORKSPACE_MAX_DEPTH segments. The sandbox grant check
 * (copilot-run/sandbox.ts gateTreeNestedRels) applies the same shape.
 */
export function validWorkspaceRel(rel) {
    if (!rel || rel.length > 512 || /[\\:\0-\x1f]/.test(rel) || rel.startsWith('/'))
        return false;
    const segs = rel.split('/');
    return segs.length <= WORKSPACE_MAX_DEPTH && segs.every((s) => s !== '' && !s.startsWith('.') && !/[ .]$/.test(s) && !s.includes('~') && s.toLowerCase() !== 'node_modules');
}
/** `<base>/<rel>` when every segment of it is a plain directory (no link, junction or file on the way); else null. */
export function plainDirUnder(base, rel) {
    if (!validWorkspaceRel(rel))
        return null;
    let p = base;
    for (const s of rel.split('/')) {
        p = join(p, s);
        try {
            const st = lstatSync(p);
            if (st.isSymbolicLink() || !st.isDirectory())
                return null;
        }
        catch {
            return null;
        }
    }
    return p;
}
function segRegex(seg) {
    const body = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    // A wildcard never matches a dot-dir (as glob's default), a literal dot segment does.
    return new RegExp(seg.startsWith('.') ? `^${body}$` : `^(?!\\.)${body}$`);
}
function matchSegs(pat, path) {
    if (pat.length === 0)
        return path.length === 0;
    if (pat[0] === '**')
        return matchSegs(pat.slice(1), path) || (path.length > 0 && !path[0].startsWith('.') && matchSegs(pat, path.slice(1)));
    return path.length > 0 && segRegex(pat[0]).test(path[0]) && matchSegs(pat.slice(1), path.slice(1));
}
/** A glob reduced to segments, or the reason it is dropped. */
function globSegs(raw) {
    let g = raw.trim();
    if (/[\\\0-\x1f]/.test(g))
        return 'it has a backslash or control character';
    if (g.startsWith('/') || /^[A-Za-z]:/.test(g))
        return 'it is absolute';
    if (/[{}[\]]/.test(g))
        return 'brace and bracket globs are not supported';
    while (g.startsWith('./'))
        g = g.slice(2);
    g = g.replace(/\/+$/, '');
    const segs = g.split('/').filter((s) => s !== '' && s !== '.');
    if (segs.length === 0)
        return 'it names the repository root';
    if (segs.includes('..'))
        return 'it leaves the repository (..)';
    if (segs.length > WORKSPACE_MAX_DEPTH)
        return `it is deeper than ${WORKSPACE_MAX_DEPTH} segments`;
    return segs;
}
/**
 * The workspace package dirs of `root` (dirs with a package.json) the base
 * globs match, plus the unsupported-layout problem: Yarn Plug'n'Play, a
 * nested git repository, or more than the bounds. Links are never
 * followed and `node_modules` / `.git` dirs are never entered.
 */
export function expandWorkspaceDirs(root, patterns, warn) {
    for (const pnp of ['.pnp.cjs', '.pnp.js']) {
        try {
            lstatSync(join(root, pnp));
            return { dirs: [], problem: `Yarn Plug'n'Play is not supported in the gate (${join(root, pnp)}): set nodeLinker: node-modules in .yarnrc.yml and run yarn install` };
        }
        catch { /* not PnP */ }
    }
    const positive = [];
    const negative = [];
    for (const raw of patterns) {
        const neg = raw.trim().startsWith('!');
        const segs = globSegs(neg ? raw.trim().slice(1) : raw);
        if (typeof segs === 'string') {
            warn?.(`omg factory run: the base's workspace glob ${JSON.stringify(raw)} is ignored for the gate's node_modules tree: ${segs}`);
            continue;
        }
        (neg ? negative : positive).push(segs);
    }
    const found = new Set();
    let visited = 0;
    let over = null;
    const walk = (rel, pat) => {
        if (over)
            return;
        if (++visited > WORKSPACE_MAX_DIRS) {
            over = `more than ${WORKSPACE_MAX_DIRS} dirs would be read to expand the workspace globs`;
            return;
        }
        const dir = join(root, ...rel);
        if (rel.length > 0 && matchSegs(pat, rel)) {
            try {
                if (lstatSync(join(dir, 'package.json')).isFile())
                    found.add(rel.join('/'));
            }
            catch { /* not a package */ }
            if (found.size > WORKSPACE_MAX_PACKAGES) {
                over = `more than ${WORKSPACE_MAX_PACKAGES} workspace packages`;
                return;
            }
        }
        if (rel.length >= WORKSPACE_MAX_DEPTH)
            return;
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of names) {
            if (SKIP_DIRS.has(name))
                continue;
            try {
                const st = lstatSync(join(dir, name));
                if (st.isSymbolicLink() || !st.isDirectory())
                    continue;
            }
            catch {
                continue;
            }
            walk([...rel, name], pat);
            if (over)
                return;
        }
    };
    for (const pat of positive) {
        // Start below the literal prefix of the glob (`packages/*` reads only packages/).
        const prefix = [];
        for (const s of pat.slice(0, -1)) {
            if (/[*?]/.test(s))
                break;
            prefix.push(s);
        }
        if (prefix.length > 0 && !plainDirUnder(root, prefix.join('/')))
            continue;
        walk(prefix, pat);
        if (over)
            break;
    }
    if (over)
        return { dirs: [], problem: `the workspace layout of ${root} is over the gate's bounds (${over})` };
    const dirs = [...found].filter((d) => validWorkspaceRel(d) && !negative.some((n) => matchSegs(n, d.split('/')))).sort();
    for (const d of dirs) {
        try {
            lstatSync(join(root, ...d.split('/'), '.git'));
            return { dirs: [], problem: `the workspace package ${d} is a nested git repository (${join(root, ...d.split('/'), '.git')}), which the gate does not support` };
        }
        catch { /* not a nested repository */ }
    }
    return { dirs, problem: null };
}
/** The base's workspace globs through `read` (a trusted base reader: a path at the base commit, or null). */
export function baseWorkspacePatterns(read) {
    return parseWorkspacePatterns(read('package.json'), read('pnpm-workspace.yaml'));
}
/** realpath, case-folded on win32 for comparisons. */
function canon(p) {
    const r = realpathSync.native(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
}
/**
 * Where a link in your node_modules goes in the gate's tree when it points
 * into your working tree outside any node_modules (a workspace self-link
 * such as `node_modules/@scope/pkg -> ../../packages/pkg`, or a `file:`
 * dependency): the same dir of the GATE checkout, so the gate tests the
 * PR's code and never writes yours. `{ keep: true }`: not such a link (it is
 * linked to yours read-only as before). `{ skip }`: such a link whose dir
 * is not a plain dir in the gate checkout (left out, with the reason).
 */
export function workspaceLinkTarget(entry, root, checkout) {
    let st;
    try {
        st = lstatSync(entry);
    }
    catch {
        return { keep: true };
    }
    if (!st.isSymbolicLink())
        return { keep: true };
    let real;
    let rootReal;
    try {
        real = canon(entry);
        rootReal = canon(root);
    }
    catch {
        return { keep: true };
    }
    const rel = relative(rootReal, real);
    if (rel === '')
        return { skip: `${entry} points to your checkout's root` };
    if (rel.startsWith('..') || /^[A-Za-z]:/.test(rel) || rel.startsWith(sep))
        return { keep: true };
    const segs = rel.split(sep);
    if (segs.includes('node_modules'))
        return { keep: true };
    // The case of the path as it is in the checkout (realpath of a win32 root may have been lower-cased above).
    const original = relative(realpathSync.native(root), realpathSync.native(entry)).split(sep).join('/');
    const to = plainDirUnder(checkout, original);
    return to ? { to } : { skip: `${entry} points to ${original} of your checkout, which is not a plain dir in the gate checkout` };
}
//# sourceMappingURL=workspace-tree.js.map