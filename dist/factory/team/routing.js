/**
 * `.copilot/team/routing.md` (night-3 goal 5): a markdown table
 * `| path glob | role | owner | handle |` that says who owns which paths.
 *
 * Trust: the file is read ONLY from the base commit (context.ts), never from
 * a working tree or a lane's PR head, because lanes are untrusted. Parsing is
 * strict: a bad row is a warning and is dropped. The owner name becomes an
 * `owner:<x>` label or an assignee argument, so it is validated against
 * OWNER_RE here and never taken from issue text.
 */
import { globLimitProblem, matchPathGlob } from '../../team/role-router.js';
import { visibleLine } from '../../forge/review-feedback.js';
/** The file is ignored (with a warning) above this size. */
export const MAX_ROUTING_BYTES = 64 * 1024;
export const MAX_ROUTES = 200;
const MAX_WARNINGS = 20;
/** An owner name: lowercase, safe as a label suffix and as an assignee argument. */
export const OWNER_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ROLE_RE = /^[a-z][a-z0-9-]{0,39}$/;
const HANDLE_RE = /^@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,38})?$/;
const GLOB_RE = /^[A-Za-z0-9_.@+~/*?-]{1,200}$/;
export const isOwnerName = (value) => typeof value === 'string' && OWNER_RE.test(value);
const dash = (cell) => (cell === '' || cell === '-' ? undefined : cell);
/** Parse the table; prose and other lines are ignored. Never throws. */
export function parseRouting(text) {
    const routes = [];
    const warnings = [];
    const warn = (m) => { if (warnings.length < MAX_WARNINGS)
        warnings.push(visibleLine(m));
    else if (warnings.length === MAX_WARNINGS)
        warnings.push('further routing.md warnings omitted'); };
    if (Buffer.byteLength(text, 'utf8') > MAX_ROUTING_BYTES)
        return { routes, warnings: [`routing.md is larger than ${MAX_ROUTING_BYTES} bytes and is ignored`] };
    const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
    lines.forEach((raw, i) => {
        const line = raw.trim();
        if (!line.startsWith('|'))
            return;
        const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        if (cells.every((c) => /^:?-{1,}:?$/.test(c)))
            return; // separator row
        if (cells[0].toLowerCase() === 'path glob')
            return; // header row
        const at = `routing.md line ${i + 1}`;
        if (cells.length !== 4)
            return warn(`${at}: expected 4 columns (path glob, role, owner, handle), found ${cells.length}`);
        const [glob, roleCell, owner, handleCell] = cells;
        const role = dash(roleCell);
        const handle = dash(handleCell);
        if (!GLOB_RE.test(glob) || glob.startsWith('/') || glob.split('/').includes('..'))
            return warn(`${at}: path glob ${JSON.stringify(glob)} is not allowed`);
        const limit = globLimitProblem(glob);
        if (limit)
            return warn(`${at}: path glob ${JSON.stringify(glob)} has ${limit}; the row is dropped`);
        if (glob.split('/').some((seg) => seg.includes('**') && seg !== '**'))
            warn(`${at}: path glob ${JSON.stringify(glob)} has ** inside a segment; ** matches whole path segments only (as in .gitignore and CODEOWNERS), so write **/*.ts or docs/** instead of src/**.ts or docs**`);
        if (role !== undefined && !ROLE_RE.test(role))
            return warn(`${at}: role ${JSON.stringify(role)} is not allowed`);
        if (!isOwnerName(owner))
            return warn(`${at}: owner ${JSON.stringify(owner)} must match ${OWNER_RE}`);
        if (handle !== undefined && !HANDLE_RE.test(handle))
            return warn(`${at}: handle ${JSON.stringify(handle)} must be @login or @org/team`);
        if (routes.length >= MAX_ROUTES)
            return warn(`${at}: more than ${MAX_ROUTES} routes; the row is dropped`);
        routes.push({ glob, ...(role ? { role } : {}), owner, ...(handle ? { handle } : {}) });
    });
    return { routes, warnings };
}
/**
 * The routes for `paths`: per path the FIRST matching row in file order,
 * de-duplicated, in path order. No paths means the catch-all rows (`**`).
 */
export function routeFor(routes, paths) {
    const out = [];
    const seen = new Set();
    for (const path of paths.length > 0 ? paths : ['']) {
        const hit = routes.find((r) => matchPathGlob(r.glob, path));
        if (!hit)
            continue;
        const key = `${hit.owner}\0${hit.role ?? ''}\0${hit.handle ?? ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(hit);
        }
    }
    return out;
}
//# sourceMappingURL=routing.js.map