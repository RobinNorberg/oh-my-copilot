/**
 * The GitHub Copilot coding agent as a factory implementer, engine side
 * (factory night 3, goal 6, lane L6b; the forge adapter is
 * src/forge/github/coding-agent.ts). The engine methods live in engine.ts
 * (implement dispatch, the wait, the adopt and the hand-off after publish);
 * this module holds what they share with the guard and the run state:
 *
 * - config: `factory.run.implementer` (`copilot` | `coding-agent`, default
 *   `copilot`), `factory.codingAgent.maxWaitMinutes` (90) and
 *   `factory.codingAgent.maxSessionsPerDay` (5), from the trusted user config;
 *   the working-tree project config may only opt out or lower a number (a
 *   lane can drop a file into the checkout, and a session is billed);
 * - the sealed run-state record of the session (CodingAgentRunRecord) and its
 *   shape check, called by state.ts on every load;
 * - session metering: one premium request per session as an estimate
 *   (decision D6), recorded in the budget ledger tagged role `coding-agent`
 *   and mirrored in the engine ledger directory (outside every lane-writable
 *   root), and the per-day count the cap reads (the larger of the two);
 * - the exact git and gh shapes of the adopt and the hand-off, which the
 *   factory guard (exec.ts) admits: the fetch of one PR head, the read of
 *   FETCH_HEAD, the tree listing of one commit, and the link comment on the
 *   agent's PR (only with the step's CodingAgentContext naming that PR; the
 *   guard runs it with its own copy of the body file).
 *
 * Everything the agent wrote is untrusted lane output. Nothing here reads a
 * title, body, comment or commit message of the agent's PR.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ledgerPath, readLedger, recordUsage } from '../../budget/ledger.js';
import { resolveProjectConfigPath } from '../../config/project-config-path.js';
import { CODING_AGENT_LOGIN } from '../../forge/github/coding-agent.js';
import { atomicWriteFileSync, ensureDirSync } from '../../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../../lib/file-lock.js';
import { userConfigLayers } from '../../ship/config.js';
import { parseJsonc } from '../../utils/jsonc.js';
// --- gates -------------------------------------------------------------------------------------
/** Waiting for the agent (not a human decision): no issue comment; `omg factory run <n>` reads the status again. */
export const CODING_AGENT_WAIT_GATE = 'coding-agent-wait';
/** A human must look: the agent is unavailable, busy on the issue, unassigned, ambiguous, closed, or the read was cut. */
export const CODING_AGENT_GATE = 'coding-agent';
/** The POST returned 2xx but no read showed the agent assigned (the session is counted; never re-assigned). */
export const CODING_AGENT_UNCONFIRMED_GATE = 'coding-agent-unconfirmed';
/** factory.codingAgent.maxSessionsPerDay reached: nothing was assigned. */
export const CODING_AGENT_SESSIONS_GATE = 'coding-agent-sessions';
/** A later read's assignedAt differs from the stored session start: a human re-assigned the agent. */
export const CODING_AGENT_REASSIGNED_GATE = 'coding-agent-reassigned';
/** factory.codingAgent.maxWaitMinutes passed since GitHub's assignedAt while the agent still works. */
export const CODING_AGENT_TIMEOUT_GATE = 'coding-agent-timeout';
/** The finished PR fails the adopt preconditions (adoptPreconditions or the engine's own checks). */
export const CODING_AGENT_ADOPT_GATE = 'coding-agent-adopt';
/** The PR head moved between the status read and the fetch (or the re-read after it). */
export const CODING_AGENT_HEAD_MOVED_GATE = 'coding-agent-head-moved';
/**
 * The pre-assign read's window: from long before any agent existed (a
 * `local` since keeps the skew margin, so the query starts at 2008-01-01),
 * so an assignment or an agent PR of any earlier session shows (item 8).
 */
export const PRE_ASSIGN_SINCE = Object.freeze({ at: '2008-01-01T00:02:00Z', source: 'local' });
/** Re-reads right after a POST whose first read did not confirm the assignment, before the run parks. */
export const CODING_AGENT_CONFIRM_READS = 3;
export const DEFAULT_CODING_AGENT_CONFIG = Object.freeze({ implementer: 'copilot', maxWaitMinutes: 90, maxSessionsPerDay: 5 });
const IMPLEMENTERS = ['copilot', 'coding-agent'];
function block(config, path, source) {
    let at = config;
    for (const key of path) {
        if (at === undefined || at === null)
            return {};
        if (typeof at !== 'object' || Array.isArray(at))
            throw new Error(`${source}: ${path.slice(0, path.indexOf(key)).join('.') || 'the config'} must be an object`);
        at = at[key];
    }
    if (at === undefined || at === null)
        return {};
    if (typeof at !== 'object' || Array.isArray(at))
        throw new Error(`${source}: ${path.join('.')} must be an object`);
    return at;
}
function implementerOf(value, source) {
    if (value === undefined)
        return undefined;
    if (!IMPLEMENTERS.includes(value))
        throw new Error(`${source}: factory.run.implementer must be "copilot" or "coding-agent"`);
    return value;
}
function countOf(value, key, source) {
    if (value === undefined)
        return undefined;
    const ok = typeof value === 'number' && Number.isFinite(value) && (key === 'maxSessionsPerDay' ? Number.isInteger(value) && value >= 0 : value > 0);
    if (!ok)
        throw new Error(`${source}: factory.codingAgent.${key} must be ${key === 'maxSessionsPerDay' ? 'a non-negative integer' : 'a positive number'}`);
    return value;
}
/**
 * Resolve the coding agent keys: defaults < trusted user config; the
 * working-tree project config may only set the implementer back to
 * `copilot` and lower the numbers (anything else is ignored with a warning).
 * Throws on an ill-typed value.
 */
export function resolveCodingAgentConfig(trustedUser, project) {
    const warnings = [];
    const config = { ...DEFAULT_CODING_AGENT_CONFIG };
    const userRun = block(trustedUser, ['factory', 'run'], 'user config');
    const userAgent = block(trustedUser, ['factory', 'codingAgent'], 'user config');
    config.implementer = implementerOf(userRun.implementer, 'user config') ?? config.implementer;
    config.maxWaitMinutes = countOf(userAgent.maxWaitMinutes, 'maxWaitMinutes', 'user config') ?? config.maxWaitMinutes;
    config.maxSessionsPerDay = countOf(userAgent.maxSessionsPerDay, 'maxSessionsPerDay', 'user config') ?? config.maxSessionsPerDay;
    const projRun = block(project, ['factory', 'run'], 'project config');
    const projAgent = block(project, ['factory', 'codingAgent'], 'project config');
    const implementer = implementerOf(projRun.implementer, 'project config');
    if (implementer === 'copilot')
        config.implementer = 'copilot';
    else if (implementer === 'coding-agent' && config.implementer !== 'coding-agent') {
        warnings.push('omg factory run: ignoring factory.run.implementer "coding-agent" from the working-tree project config; it starts billed agent sessions, so only the user config can opt in');
    }
    for (const key of ['maxWaitMinutes', 'maxSessionsPerDay']) {
        const value = countOf(projAgent[key], key, 'project config');
        if (value === undefined)
            continue;
        if (value <= config[key])
            config[key] = value;
        else
            warnings.push(`omg factory run: ignoring factory.codingAgent.${key} ${value} from the working-tree project config; it can only lower a limit`);
    }
    return { config, warnings };
}
/** resolveCodingAgentConfig on the trusted user config and the checkout's project config (.copilot/omg.jsonc). */
export function loadCodingAgentConfig(root) {
    const path = resolveProjectConfigPath(root);
    const project = existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
    return resolveCodingAgentConfig(userConfigLayers().trustedUser, project);
}
/**
 * Why a run may not use the coding agent although the config asks for it,
 * or null: GitHub only (the agent is a GitHub feature), issue runs only (a
 * ci-heal run has no issue to assign).
 */
export function codingAgentRefusal(forgeKind, runKind) {
    if (runKind !== 'issue')
        return null;
    return forgeKind === 'github' ? null : `factory.run.implementer is "coding-agent", but the Copilot coding agent works on GitHub only and this run's forge is ${forgeKind}; set factory.run.implementer to "copilot" for this repository (the working-tree .copilot/omg.jsonc may do that), then rerun`;
}
const LANE_ID = /^issue-[1-9]\d{0,9}-coding-agent-[1-9]\d{0,5}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX40 = /^[0-9a-f]{40}$/;
const isIso = (v) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));
const KEYS = new Set(['laneId', 'assignAt', 'assign', 'since', 'adopted', 'linked', 'closed']);
/** Why `v` is not a CodingAgentRunRecord (state.ts calls it on load), or null. */
export function codingAgentRecordProblem(v) {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        return 'not an object';
    const r = v;
    if (Object.keys(r).some((k) => !KEYS.has(k)))
        return 'unknown field';
    if (typeof r.laneId !== 'string' || !LANE_ID.test(r.laneId))
        return 'laneId';
    if (!isIso(r.assignAt))
        return 'assignAt';
    if (r.assign !== 'pending' && r.assign !== 'posted' && r.assign !== 'failed')
        return 'assign';
    if (r.since !== undefined) {
        const s = r.since;
        if (typeof s !== 'object' || s === null || Object.keys(s).length !== 2 || s.source !== 'github' || !isIso(s.at) || !ISO_SECONDS.test(s.at))
            return 'since';
    }
    if (r.adopted !== undefined) {
        const a = r.adopted;
        if (typeof a !== 'object' || a === null || Object.keys(a).length !== 2 || !Number.isSafeInteger(a.pr) || a.pr <= 0
            || typeof a.head !== 'string' || !HEX40.test(a.head))
            return 'adopted';
    }
    if (r.linked !== undefined && typeof r.linked !== 'boolean')
        return 'linked';
    if (r.closed !== undefined && typeof r.closed !== 'boolean')
        return 'closed';
    return null;
}
// --- repository and status helpers ---------------------------------------------------------------
/** The run's repository (`https://<host>/<owner>/<name>`, as intake recorded it from GitHub) as the adapter's parts, or undefined. */
export function codingAgentRepoOf(repoUrl) {
    const m = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(repoUrl);
    return m ? { host: m[1], owner: m[2], name: m[3] } : undefined;
}
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAgent = (v) => isObj(v) && v.__typename === 'Bot' && v.login === CODING_AGENT_LOGIN;
/**
 * Open pull requests the agent authored in `repoName` (`OWNER/NAME`) and
 * linked to the issue, from the raw status response, whatever session they
 * belong to (parseCodingAgentStatus files earlier sessions under `ignored`
 * without their state). The pre-assign check refuses on any (item 8).
 */
export function openAgentPrs(stdout, repoName) {
    let json;
    try {
        json = JSON.parse(stdout);
    }
    catch {
        return [];
    }
    const issue = isObj(json) && isObj(json.data) && isObj(json.data.repository) ? json.data.repository.issue : undefined;
    const items = isObj(issue) && isObj(issue.timelineItems) && Array.isArray(issue.timelineItems.nodes) ? issue.timelineItems.nodes : [];
    const open = new Set();
    const lower = repoName.toLowerCase();
    for (const e of items) {
        if (!isObj(e) || (e.__typename !== 'ConnectedEvent' && e.__typename !== 'CrossReferencedEvent') || !isAgent(e.actor))
            continue;
        const pr = e.__typename === 'ConnectedEvent' ? e.subject : e.source;
        if (!isObj(pr) || pr.__typename !== 'PullRequest' || pr.state !== 'OPEN' || !isAgent(pr.author))
            continue;
        const base = isObj(pr.baseRepository) && typeof pr.baseRepository.nameWithOwner === 'string' ? pr.baseRepository.nameWithOwner.toLowerCase() : '';
        if (base === lower && Number.isSafeInteger(pr.number) && pr.number > 0)
            open.add(pr.number);
    }
    return [...open].sort((a, b) => a - b);
}
// --- guard shapes ----------------------------------------------------------------------------------
const PR_NUMBER = /^[1-9]\d{0,9}$/;
/** `git fetch` of the agent PR's head: no tags, no configured refmap, so only FETCH_HEAD (and objects) change. */
export function codingAgentFetchArgs(pr) {
    if (!Number.isSafeInteger(pr) || !PR_NUMBER.test(String(pr)))
        throw new Error(`coding agent fetch: #${pr} is not a PR number`);
    return ['fetch', '--no-tags', '--refmap=', 'origin', `refs/pull/${pr}/head`];
}
/** The commit the fetch wrote to FETCH_HEAD. */
export const CODING_AGENT_FETCH_HEAD_ARGS = ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'];
/** Every tree entry of one commit (modes included): the adopt's gitlink and symlink check. */
export function codingAgentTreeArgs(sha) {
    if (!HEX40.test(sha))
        throw new Error(`coding agent tree: ${sha} is not a 40-hex commit`);
    return ['ls-tree', '-r', '-z', '--full-tree', sha];
}
/**
 * The git shapes the adopt adds to the factory guard (exec.ts), exact argv:
 * codingAgentFetchArgs, CODING_AGENT_FETCH_HEAD_ARGS and codingAgentTreeArgs.
 */
export function isCodingAgentGitArgs(a) {
    if (a.length === 5 && a[0] === 'fetch') {
        const m = /^refs\/pull\/([1-9]\d{0,9})\/head$/.exec(a[4]);
        return a[1] === '--no-tags' && a[2] === '--refmap=' && a[3] === 'origin' && m !== null;
    }
    if (a.length === CODING_AGENT_FETCH_HEAD_ARGS.length && CODING_AGENT_FETCH_HEAD_ARGS.every((v, i) => a[i] === v))
        return true;
    return a.length === 5 && a[0] === 'ls-tree' && a[1] === '-r' && a[2] === '-z' && a[3] === '--full-tree' && HEX40.test(a[4]);
}
/** `gh pr comment <pr> --repo <HOST/OWNER/NAME> --body-file <file>`: the D5 link comment on the agent's PR. */
export function codingAgentLinkCommentArgs(repo, pr, bodyFile) {
    if (!Number.isSafeInteger(pr) || !PR_NUMBER.test(String(pr)))
        throw new Error(`coding agent comment: #${pr} is not a PR number`);
    return ['pr', 'comment', String(pr), '--repo', `${repo.host}/${repo.owner}/${repo.name}`, '--body-file', bodyFile];
}
/** argv index of the link comment's body file (the guard runs the comment with its own copy of it). */
export const CODING_AGENT_LINK_BODY_ARG = 6;
/**
 * The guard clause of the link comment: exactly codingAgentLinkCommentArgs
 * for the context's repository and `pr`. Without a CodingAgentContext naming
 * the PR it is refused.
 */
export function isCodingAgentLinkCommentArgs(a, ctx) {
    if (!ctx || ctx.pr === undefined || !Number.isSafeInteger(ctx.pr) || !PR_NUMBER.test(String(ctx.pr)) || a.length !== 7)
        return false;
    const file = a[CODING_AGENT_LINK_BODY_ARG];
    return a[0] === 'pr' && a[1] === 'comment' && a[2] === String(ctx.pr) && a[3] === '--repo' && a[4].toLowerCase() === ctx.repo.toLowerCase()
        && a[5] === '--body-file' && typeof file === 'string' && file.length > 0 && !file.startsWith('-') && !/[\r\n\0]/.test(file);
}
/** The link comment (engine text only: numbers, the branch and a sha; nothing the agent wrote). */
export function codingAgentLinkBody(o) {
    return [
        `The factory adopted this pull request's head \`${o.head.slice(0, 12)}\` for issue #${o.issue}: it is now on \`${o.branch}\` in #${o.ownPr}, the factory's own pull request.`,
        '',
        `Review, fix rounds, gates and the human merge continue on #${o.ownPr}; this pull request is closed (\`omg factory run ${o.issue}\`). Please do not push here or click "Update branch".`,
        '',
    ].join('\n');
}
/**
 * New or changed gitlinks (160000) and symlinks (120000) of `head`'s tree
 * against `base`'s (both `ls-tree -r -z --full-tree` output): host git does
 * not enter a nested repository, and a link can point out of the checkout.
 */
export function linkEntries(baseTree, headTree) {
    const of = (out, mode) => new Set(out.split('\0').filter((e) => e.startsWith(`${mode} `)).map((e) => {
        const tab = e.indexOf('\t');
        return `${e.slice(0, tab).split(' ')[2]}\t${e.slice(tab + 1)}`;
    }));
    const added = (mode) => {
        const known = of(baseTree, mode);
        return [...of(headTree, mode)].filter((x) => !known.has(x)).map((x) => x.slice(x.indexOf('\t') + 1));
    };
    return { gitlinks: added('160000'), symlinks: added('120000') };
}
// --- metering ------------------------------------------------------------------------------------
/** One session's estimate (decision D6): GitHub bills the agent separately from factory lanes; no AI credits of the run's caps. */
export const CODING_AGENT_SESSION_USAGE = Object.freeze({ credits: 0, premiumRequests: 1, source: 'estimated' });
const MIRROR_FILE = 'coding-agent-sessions.json';
/** Mirror entries older than this are dropped on write. */
const MIRROR_KEEP_MS = 7 * 24 * 60 * 60_000;
function readMirror(path) {
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        const sessions = {};
        if (isObj(raw) && isObj(raw.sessions)) {
            for (const [k, v] of Object.entries(raw.sessions))
                if (isObj(v) && isIso(v.at) && typeof v.run === 'string')
                    sessions[k] = { at: v.at, run: v.run };
        }
        return { version: 1, sessions };
    }
    catch {
        return { version: 1, sessions: {} };
    }
}
/**
 * Count one session, idempotently per lane (a crash after the POST counts it
 * again under the same keys): the budget ledger record `factory-lane:<laneId>`
 * tagged `{ kind: factory-lane, role: coding-agent, run }`, and the engine
 * ledger mirror. Returns the failures (a write that failed is reported, not
 * thrown: the session is real either way).
 */
export function recordCodingAgentSession(s) {
    const failures = [];
    try {
        recordUsage(ledgerPath(s.root), `factory-lane:${s.laneId}`, {
            ...CODING_AGENT_SESSION_USAGE, detail: 'coding agent session (estimate: one premium request; GitHub bills it separately)', updatedAt: s.at,
            tag: { kind: 'factory-lane', role: 'coding-agent', run: s.run },
        }, undefined, { timeoutMs: 5_000 });
    }
    catch (error) {
        failures.push(`budget ledger: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        ensureDirSync(s.ledgerDir);
        const path = join(s.ledgerDir, MIRROR_FILE);
        withFileLockSync(lockPathFor(path), () => {
            const m = readMirror(path);
            const now = Date.parse(s.at);
            for (const [k, v] of Object.entries(m.sessions))
                if (now - Date.parse(v.at) > MIRROR_KEEP_MS)
                    delete m.sessions[k];
            m.sessions[`${s.repo}#${s.laneId}`] ??= { at: s.at, run: s.run };
            atomicWriteFileSync(path, JSON.stringify(m, null, 2));
        }, { timeoutMs: 5_000 });
    }
    catch (error) {
        failures.push(`engine ledger: ${error instanceof Error ? error.message : String(error)}`);
    }
    return failures;
}
/**
 * Sessions the factory started on UTC `day` (`YYYY-MM-DD`): the larger of the
 * budget ledger's role `coding-agent` records and the engine ledger mirror (a
 * lane can reach the repository's state root, not the engine ledger; `omg
 * budget reset` clears the budget ledger, not the mirror).
 */
export function codingAgentSessionsOn(root, ledgerDir, day) {
    let budget = 0;
    try {
        const ledger = readLedger(ledgerPath(root));
        budget = Object.entries(ledger.sessions).filter(([key, r]) => key.startsWith('factory-lane:') && r.tag?.role === 'coding-agent'
            && typeof r.updatedAt === 'string' && r.updatedAt.slice(0, 10) === day).length;
    }
    catch { /* the mirror still counts */ }
    const mirror = Object.values(readMirror(join(ledgerDir, MIRROR_FILE)).sessions).filter((v) => v.at.slice(0, 10) === day).length;
    return Math.max(budget, mirror);
}
//# sourceMappingURL=coding-agent-lane.js.map