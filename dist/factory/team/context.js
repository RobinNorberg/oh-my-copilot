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
/** The changed paths of a unified diff (`diff --git a/x b/x` headers), capped. */
export function pathsInDiff(diff) {
    const out = new Set();
    for (const m of diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)) {
        if (m[2].split('/').includes('..'))
            continue;
        out.add(m[2]);
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