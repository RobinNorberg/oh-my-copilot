/**
 * The team context of a factory run (night-3 goal 5): the routing owners of
 * the paths a run touches and the recent decisions, both read from the BASE
 * commit only. `readAt` is the caller's allowed read shape
 * (`git show <sha>:<path>`); it returns undefined for an absent file and
 * throws for a failed read. Nothing here touches a working tree or a PR head
 * except the one head read of the append-only check.
 */
import { decisionsAppendOnly, DEFAULT_DECISIONS_MAX_BYTES, recentDecisions } from './decisions.js';
import { parseRouting, routeFor } from './routing.js';
export const TEAM_ROUTING_PATH = '.copilot/team/routing.md';
export const TEAM_DECISIONS_PATH = '.copilot/team/decisions.md';
const MAX_PATHS = 200;
const PATH_IN_TEXT = /(?<![\w./@-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})(?![\w/])/g;
/** Repo-relative file paths mentioned in free text (a plan): a conservative `dir/file.ext` scan, capped. */
export function pathsInText(text) {
    const out = new Set();
    for (const m of text.matchAll(PATH_IN_TEXT)) {
        if (m[1].split('/').includes('..'))
            continue;
        out.add(m[1]);
        if (out.size >= MAX_PATHS)
            break;
    }
    return [...out];
}
/** A git C-quoted path body (the text between the quotes) back to the path: escaped quote, backslash, newline, tab and octal bytes. */
function unquoteC(body) {
    const parts = [];
    const escapes = { n: 10, t: 9, '"': 34, '\\': 92, a: 7, b: 8, f: 12, r: 13, v: 11 };
    let i = 0;
    while (i < body.length) {
        const at = body.indexOf('\\', i);
        const end = at < 0 ? body.length : at;
        if (end > i)
            parts.push(Buffer.from(body.slice(i, end), 'utf8')); // whole runs: a surrogate pair is never split
        if (at < 0)
            break;
        const oct = /^[0-7]{3}/.exec(body.slice(at + 1, at + 4));
        if (oct) {
            parts.push(Buffer.from([parseInt(oct[0], 8) & 0xff]));
            i = at + 4;
            continue;
        }
        const esc = escapes[body[at + 1]];
        if (esc !== undefined) {
            parts.push(Buffer.from([esc]));
            i = at + 2;
        }
        else {
            parts.push(Buffer.from([92]));
            i = at + 1;
        }
    }
    return Buffer.concat(parts).toString('utf8');
}
/** The bodies of the C-quoted strings in `text`, one forward pass: git writes every `"` inside a name as `\"`, so an unescaped quote opens or closes. */
function quotedBodies(text) {
    const out = [];
    let start = -1;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (start >= 0 && c === '\\')
            i++;
        else if (c === '"') {
            if (start < 0)
                start = i + 1;
            else {
                out.push(text.slice(start, i));
                start = -1;
            }
        }
    }
    return out;
}
/** The new path of one `diff --git` header (text after `diff --git `): quoted forms decoded, and a path containing ` b/` resolved by the symmetric split first. */
function headerPath(rest) {
    if (rest.endsWith('"')) {
        const last = quotedBodies(rest).pop();
        if (last?.startsWith('b/'))
            return unquoteC(last.slice(2));
    }
    const quotedOld = /^"a\/(?:[^"\\]|\\.)*" b\/(.+)$/.exec(rest);
    if (quotedOld)
        return quotedOld[1];
    const size = (rest.length - 5) / 2; // `a/X b/X` is 2 * |X| + 5 characters
    if (Number.isInteger(size) && size > 0 && rest.startsWith('a/') && rest.slice(size + 2, size + 5) === ' b/' && rest.slice(2, 2 + size) === rest.slice(size + 5))
        return rest.slice(size + 5);
    const at = rest.lastIndexOf(' b/'); // a rename: the old and new paths differ
    return rest.startsWith('a/') && at > 0 ? rest.slice(at + 3) : undefined;
}
/** `rename to X` or `+++ b/X` among the extended header lines (before the first hunk), quoted or not: they name the new path unambiguously. */
function blockPath(lines) {
    let plus;
    for (const line of lines) {
        if (line.startsWith('@@'))
            break;
        if (line.startsWith('rename to ')) {
            const v = line.slice('rename to '.length);
            return v.length > 1 && v.startsWith('"') && v.endsWith('"') ? unquoteC(v.slice(1, -1)) : v;
        }
        if (line.startsWith('+++ ') && plus === undefined) {
            const v = line.slice(4).replace(/\t$/, '');
            if (v.length > 3 && v.startsWith('"b/') && v.endsWith('"'))
                plus = unquoteC(v.slice(3, -1));
            else if (v.startsWith('b/'))
                plus = v.slice(2);
        }
    }
    return plus;
}
/** The changed paths of a unified diff (`diff --git` headers), capped. */
export function pathsInDiff(diff) {
    const out = new Set();
    for (const block of diff.split(/^diff --git /m).slice(1)) {
        const lines = block.split('\n');
        const path = blockPath(lines.slice(1)) ?? headerPath(lines[0].replace(/\r$/, ''));
        if (!path || path.split('/').includes('..'))
            continue;
        out.add(path);
        if (out.size >= MAX_PATHS)
            break;
    }
    return [...out];
}
/**
 * Routes for `paths` and the newest decisions, from the base commit. Returns
 * undefined when the base has neither file (or both are empty).
 */
export function loadTeamContext(readBase, paths, maxBytes = DEFAULT_DECISIONS_MAX_BYTES) {
    const routingText = readBase(TEAM_ROUTING_PATH);
    const decisionsText = readBase(TEAM_DECISIONS_PATH);
    const parsed = routingText === undefined ? { routes: [], warnings: [] } : parseRouting(routingText);
    const decisions = decisionsText === undefined ? { lines: [], truncated: false } : recentDecisions(decisionsText, maxBytes);
    if (parsed.routes.length === 0 && decisions.lines.length === 0)
        return undefined;
    return { routes: routeFor(parsed.routes, paths), decisions, warnings: parsed.warnings };
}
/**
 * The append-only check: the run's base commit text of decisions.md against
 * the PR head's. Returns the reason, or undefined when the head only appends.
 */
export function decisionsViolation(readBase, readHead) {
    const r = decisionsAppendOnly(readBase(TEAM_DECISIONS_PATH), readHead(TEAM_DECISIONS_PATH));
    return r.ok ? undefined : r.reason;
}
export const DEFAULT_TEAM_CONFIG = { remindAfterHours: 24 };
export class TeamConfigError extends Error {
}
/** `factory.poll.remindAfterHours` from the trusted layers (user config, then the base branch's); later layers win. */
export function resolveTeamConfig(layers) {
    const cfg = { ...DEFAULT_TEAM_CONFIG };
    for (const layer of layers) {
        const poll = layer?.factory?.poll;
        if (poll === undefined || poll === null)
            continue;
        if (typeof poll !== 'object' || Array.isArray(poll))
            throw new TeamConfigError('factory.poll must be an object');
        const hours = poll.remindAfterHours;
        if (hours === undefined)
            continue;
        if (!Number.isInteger(hours) || hours < 0 || hours > 24 * 365)
            throw new TeamConfigError('factory.poll.remindAfterHours must be an integer from 0 (off) to 8760');
        cfg.remindAfterHours = hours;
    }
    return cfg;
}
//# sourceMappingURL=context.js.map