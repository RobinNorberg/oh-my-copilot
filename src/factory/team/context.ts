/**
 * The team context of a factory run (night-3 goal 5): the routing owners of
 * the paths a run touches and the recent decisions, both read from the BASE
 * commit only. `readAt` is the caller's allowed read shape
 * (`git show <sha>:<path>`); it returns undefined for an absent file and
 * throws for a failed read. Nothing here touches a working tree or a PR head
 * except the one head read of the append-only check.
 */

import { decisionsAppendOnly, DEFAULT_DECISIONS_MAX_BYTES, recentDecisions } from './decisions.js';
import { parseRouting, routeFor, type TeamRoute } from './routing.js';

export const TEAM_ROUTING_PATH = '.copilot/team/routing.md';
export const TEAM_DECISIONS_PATH = '.copilot/team/decisions.md';

/** Read `path` at one commit; undefined when the file does not exist there. */
export type ReadAt = (path: string) => string | undefined;

export interface TeamContext {
  routes: TeamRoute[];
  decisions: { lines: string[]; truncated: boolean };
  warnings: string[];
}

const MAX_PATHS = 200;
const PATH_IN_TEXT = /(?<![\w./@-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})(?![\w/])/g;

/** Repo-relative file paths mentioned in free text (a plan): a conservative `dir/file.ext` scan, capped. */
export function pathsInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_IN_TEXT)) {
    if (m[1].split('/').includes('..')) continue;
    out.add(m[1]);
    if (out.size >= MAX_PATHS) break;
  }
  return [...out];
}

/** A git C-quoted path body (the text between the quotes) back to the path: escaped quote, backslash, newline, tab and octal bytes. */
function unquoteC(body: string): string {
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92, a: 7, b: 8, f: 12, r: 13, v: 11 };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i], 'utf8')); continue; }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8) & 0xff); i += 3; continue; }
    const esc = escapes[body[i + 1]];
    if (esc !== undefined) { bytes.push(esc); i++; } else bytes.push(92);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The new path of one `diff --git` header (text after `diff --git `): quoted forms decoded, and a path containing ` b/` resolved by the symmetric split first. */
function headerPath(rest: string): string | undefined {
  const quotedNew = /"b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quotedNew) return unquoteC(quotedNew[1]);
  const quotedOld = /^"a\/(?:[^"\\]|\\.)*" b\/(.+)$/.exec(rest);
  if (quotedOld) return quotedOld[1];
  const size = (rest.length - 5) / 2; // `a/X b/X` is 2 * |X| + 5 characters
  if (Number.isInteger(size) && size > 0 && rest.startsWith('a/') && rest.slice(size + 2, size + 5) === ' b/' && rest.slice(2, 2 + size) === rest.slice(size + 5)) return rest.slice(size + 5);
  const at = rest.lastIndexOf(' b/'); // a rename: the old and new paths differ
  return rest.startsWith('a/') && at > 0 ? rest.slice(at + 3) : undefined;
}

/** The changed paths of a unified diff (`diff --git` headers), capped. */
export function pathsInDiff(diff: string): string[] {
  const out = new Set<string>();
  for (const m of diff.matchAll(/^diff --git (.+)$/gm)) {
    const path = headerPath(m[1]);
    if (!path || path.split('/').includes('..')) continue;
    out.add(path);
    if (out.size >= MAX_PATHS) break;
  }
  return [...out];
}

/**
 * Routes for `paths` and the newest decisions, from the base commit. Returns
 * undefined when the base has neither file (or both are empty).
 */
export function loadTeamContext(readBase: ReadAt, paths: readonly string[], maxBytes = DEFAULT_DECISIONS_MAX_BYTES): TeamContext | undefined {
  const routingText = readBase(TEAM_ROUTING_PATH);
  const decisionsText = readBase(TEAM_DECISIONS_PATH);
  const parsed = routingText === undefined ? { routes: [], warnings: [] } : parseRouting(routingText);
  const decisions = decisionsText === undefined ? { lines: [], truncated: false } : recentDecisions(decisionsText, maxBytes);
  if (parsed.routes.length === 0 && decisions.lines.length === 0) return undefined;
  return { routes: routeFor(parsed.routes, paths), decisions, warnings: parsed.warnings };
}

/**
 * The append-only check: the run's base commit text of decisions.md against
 * the PR head's. Returns the reason, or undefined when the head only appends.
 */
export function decisionsViolation(readBase: ReadAt, readHead: ReadAt): string | undefined {
  const r = decisionsAppendOnly(readBase(TEAM_DECISIONS_PATH), readHead(TEAM_DECISIONS_PATH));
  return r.ok ? undefined : r.reason;
}

export interface TeamConfig {
  /** Poll re-comments (prints) a gate parked this long; 0 = off. */
  remindAfterHours: number;
}

export const DEFAULT_TEAM_CONFIG: TeamConfig = { remindAfterHours: 24 };

export class TeamConfigError extends Error {}

/** `factory.poll.remindAfterHours` from the trusted layers (user config, then the base branch's); later layers win. */
export function resolveTeamConfig(layers: readonly unknown[]): TeamConfig {
  const cfg = { ...DEFAULT_TEAM_CONFIG };
  for (const layer of layers) {
    const poll = (layer as { factory?: { poll?: unknown } } | null | undefined)?.factory?.poll;
    if (poll === undefined || poll === null) continue;
    if (typeof poll !== 'object' || Array.isArray(poll)) throw new TeamConfigError('factory.poll must be an object');
    const hours = (poll as { remindAfterHours?: unknown }).remindAfterHours;
    if (hours === undefined) continue;
    if (!Number.isInteger(hours) || (hours as number) < 0 || (hours as number) > 24 * 365) throw new TeamConfigError('factory.poll.remindAfterHours must be an integer from 0 (off) to 8760');
    cfg.remindAfterHours = hours as number;
  }
  return cfg;
}
