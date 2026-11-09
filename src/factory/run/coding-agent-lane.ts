/**
 * The GitHub Copilot coding agent as a factory implementer, engine side
 * (factory night 3, goal 6, lane L6b; the forge adapter is
 * src/forge/github/coding-agent.ts). The engine methods live in engine.ts
 * (implement dispatch, the wait, the adopt and the hand-off after publish);
 * this module holds what they share with the guard and the run state:
 *
 * - config: `factory.run.implementer` (`copilot` | `coding-agent`, default
 *   `copilot`), `factory.codingAgent.maxWaitMinutes` (90) and
 *   `factory.codingAgent.maxSessionsPerDay` (5) and `factory.codingAgent.repos`
 *   (the per-repository opt-in), from the trusted user config; the
 *   working-tree project config may only opt out or lower a number (a lane
 *   can drop a file into the checkout, and a session is billed);
 *   chooseCodingAgent reads the user layer first and nothing else without
 *   its opt-in;
 * - the sealed run-state record of the session (CodingAgentRunRecord) and its
 *   shape check, called by state.ts on every load;
 * - session metering: one premium request per session as an estimate
 *   (decision D6), recorded in the budget ledger tagged role `coding-agent`
 *   and mirrored in the engine ledger directory (outside every lane-writable
 *   root), the per-day count the cap reads (the larger of the two), and the
 *   cap check made atomic across engines by a provisional mirror entry
 *   written under the mirror's file lock;
 * - the exact git and gh shapes of the adopt and the hand-off, which the
 *   factory guard (exec.ts) admits: the fetch of one PR head (only with the
 *   step context naming it), the read of FETCH_HEAD, the merge-base of two
 *   commits, the tree listing of one commit, and the link comment on the
 *   agent's PR (only with the step context naming that PR; the guard runs it
 *   with its own copy of the body file, which must be the exact link text).
 *
 * Everything the agent wrote is untrusted lane output. Nothing here reads a
 * title, body, comment or commit message of the agent's PR.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ledgerPath, readLedger, recordUsage } from '../../budget/ledger.js';
import { resolveProjectConfigPath } from '../../config/project-config-path.js';
import { CODING_AGENT_LOGIN, type CodingAgentContext, type CodingAgentRepo } from '../../forge/github/coding-agent.js';
import { atomicWriteFileSync, ensureDirSync } from '../../lib/atomic-write.js';
import { acquireFileLockSync, lockPathFor, releaseFileLockSync, withFileLockSync } from '../../lib/file-lock.js';
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
export const PRE_ASSIGN_SINCE = Object.freeze({ at: '2008-01-01T00:02:00Z', source: 'local' as const });

/** Re-reads right after a POST whose first read did not confirm the assignment, before the run parks. */
export const CODING_AGENT_CONFIRM_READS = 3;

// --- config ------------------------------------------------------------------------------------

export type FactoryImplementer = 'copilot' | 'coding-agent';

export interface CodingAgentConfig {
  /** `factory.run.implementer`: who implements an issue run on GitHub. */
  implementer: FactoryImplementer;
  /** `factory.codingAgent.maxWaitMinutes`: how long a session may work before the run parks at coding-agent-timeout. */
  maxWaitMinutes: number;
  /** `factory.codingAgent.maxSessionsPerDay`: sessions the factory starts per UTC day (all runs, all repositories of this user). */
  maxSessionsPerDay: number;
  /** `factory.codingAgent.repos`: the `OWNER/NAME` repositories a billed session may start in (user config only; compared case-insensitively). */
  repos: string[];
}

export const DEFAULT_CODING_AGENT_CONFIG: Readonly<CodingAgentConfig> = Object.freeze({ implementer: 'copilot', maxWaitMinutes: 90, maxSessionsPerDay: 5, repos: [] as string[] });

const IMPLEMENTERS: readonly FactoryImplementer[] = ['copilot', 'coding-agent'];
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

function reposOf(value: unknown, source: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((r) => typeof r === 'string' && REPO_NAME.test(r))) {
    throw new Error(`${source}: factory.codingAgent.repos must be an array of "owner/name" repository names`);
  }
  return [...value] as string[];
}

function block(config: unknown, path: readonly string[], source: string): Record<string, unknown> {
  let at: unknown = config;
  for (const key of path) {
    if (at === undefined || at === null) return {};
    if (typeof at !== 'object' || Array.isArray(at)) throw new Error(`${source}: ${path.slice(0, path.indexOf(key)).join('.') || 'the config'} must be an object`);
    at = (at as Record<string, unknown>)[key];
  }
  if (at === undefined || at === null) return {};
  if (typeof at !== 'object' || Array.isArray(at)) throw new Error(`${source}: ${path.join('.')} must be an object`);
  return at as Record<string, unknown>;
}

function implementerOf(value: unknown, source: string): FactoryImplementer | undefined {
  if (value === undefined) return undefined;
  if (!IMPLEMENTERS.includes(value as FactoryImplementer)) throw new Error(`${source}: factory.run.implementer must be "copilot" or "coding-agent"`);
  return value as FactoryImplementer;
}

function countOf(value: unknown, key: 'maxWaitMinutes' | 'maxSessionsPerDay', source: string): number | undefined {
  if (value === undefined) return undefined;
  const ok = typeof value === 'number' && Number.isFinite(value) && (key === 'maxSessionsPerDay' ? Number.isInteger(value) && value >= 0 : value > 0);
  if (!ok) throw new Error(`${source}: factory.codingAgent.${key} must be ${key === 'maxSessionsPerDay' ? 'a non-negative integer' : 'a positive number'}`);
  return value as number;
}

/**
 * Resolve the coding agent keys: defaults < trusted user config; the
 * working-tree project config may only set the implementer back to
 * `copilot` and lower the numbers (anything else is ignored with a warning).
 * Throws on an ill-typed value.
 */
export function resolveCodingAgentConfig(trustedUser: unknown, project: unknown): { config: CodingAgentConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config: CodingAgentConfig = { ...DEFAULT_CODING_AGENT_CONFIG, repos: [] };
  const userRun = block(trustedUser, ['factory', 'run'], 'user config');
  const userAgent = block(trustedUser, ['factory', 'codingAgent'], 'user config');
  config.implementer = implementerOf(userRun.implementer, 'user config') ?? config.implementer;
  config.maxWaitMinutes = countOf(userAgent.maxWaitMinutes, 'maxWaitMinutes', 'user config') ?? config.maxWaitMinutes;
  config.maxSessionsPerDay = countOf(userAgent.maxSessionsPerDay, 'maxSessionsPerDay', 'user config') ?? config.maxSessionsPerDay;
  config.repos = reposOf(userAgent.repos, 'user config') ?? config.repos;
  const projRun = block(project, ['factory', 'run'], 'project config');
  const projAgent = block(project, ['factory', 'codingAgent'], 'project config');
  const implementer = implementerOf(projRun.implementer, 'project config');
  if (implementer === 'copilot') config.implementer = 'copilot';
  else if (implementer === 'coding-agent' && config.implementer !== 'coding-agent') {
    warnings.push('omg factory run: ignoring factory.run.implementer "coding-agent" from the working-tree project config; it starts billed agent sessions, so only the user config can opt in');
  }
  if (projAgent.repos !== undefined) warnings.push('omg factory run: ignoring factory.codingAgent.repos from the working-tree project config; only the user config lists the repositories a billed session may start in');
  for (const key of ['maxWaitMinutes', 'maxSessionsPerDay'] as const) {
    const value = countOf(projAgent[key], key, 'project config');
    if (value === undefined) continue;
    if (value <= config[key]) config[key] = value;
    else warnings.push(`omg factory run: ignoring factory.codingAgent.${key} ${value} from the working-tree project config; it can only lower a limit`);
  }
  return { config, warnings };
}

export type CodingAgentChoice = { use: true; config: CodingAgentConfig; warnings: string[] } | { use: false; warning?: string };

/**
 * Whether this run uses the coding agent: only when the trusted user config
 * says `factory.run.implementer: "coding-agent"`, the forge is GitHub, the
 * run's repository is in the user's `factory.codingAgent.repos` and the
 * project config does not opt out. The user layer is looked at first:
 * without its opt-in nothing else is parsed (an ill-typed project value
 * cannot fail a run that never opted in) and `use: false` comes back
 * silently. A forge or repository miss is `use: false` with one warning (the
 * run takes the Copilot implement lane). Throws only on a config error
 * after the user opted in (the engine then parks).
 */
export function chooseCodingAgent(trustedUser: unknown, readProject: () => unknown, run: { forgeKind: string; repoUrl: string }): CodingAgentChoice {
  const runBlock = isObj(trustedUser) && isObj(trustedUser.factory) && isObj(trustedUser.factory.run) ? trustedUser.factory.run : undefined;
  if (runBlock?.implementer !== 'coding-agent') return { use: false };
  if (run.forgeKind !== 'github') return { use: false, warning: `omg factory run: the coding agent is GitHub-only; using a Copilot lane (this run's forge is ${run.forgeKind})` };
  const user = resolveCodingAgentConfig(trustedUser, undefined).config;
  const repo = codingAgentRepoOf(run.repoUrl);
  const name = repo ? `${repo.owner}/${repo.name}` : run.repoUrl;
  if (!repo || !user.repos.some((r) => r.toLowerCase() === name.toLowerCase())) {
    return { use: false, warning: `omg factory run: coding agent not enabled for ${name}: add it to factory.codingAgent.repos; using a Copilot lane` };
  }
  const { config, warnings } = resolveCodingAgentConfig(trustedUser, readProject());
  return config.implementer === 'coding-agent' ? { use: true, config, warnings } : { use: false };
}

/** chooseCodingAgent on `trustedUser` (default: the user's own trusted config) and the checkout's project config (.copilot/omg.jsonc). */
export function loadCodingAgentChoice(root: string, run: { forgeKind: string; repoUrl: string }, trustedUser?: unknown): CodingAgentChoice {
  let user = trustedUser;
  if (user === undefined) {
    try {
      user = userConfigLayers().trustedUser;
    } catch (error) {
      return { use: false, warning: `omg factory run: the user config could not be read (${error instanceof Error ? error.message : String(error)}); the coding agent stays off` };
    }
  }
  return chooseCodingAgent(user, () => {
    const path = resolveProjectConfigPath(root);
    return existsSync(path) ? parseJsonc(readFileSync(path, 'utf8')) : undefined;
  }, run);
}

/**
 * Why a run may not use the coding agent although the config asks for it,
 * or null: GitHub only (the agent is a GitHub feature), issue runs only (a
 * ci-heal run has no issue to assign).
 */
export function codingAgentRefusal(forgeKind: string, runKind: 'issue' | 'ci-heal'): string | null {
  if (runKind !== 'issue') return null;
  return forgeKind === 'github' ? null : `factory.run.implementer is "coding-agent", but the Copilot coding agent works on GitHub only and this run's forge is ${forgeKind}; set factory.run.implementer to "copilot" for this repository (the working-tree .copilot/omg.jsonc may do that), then rerun`;
}

// --- sealed run state ----------------------------------------------------------------------------

/**
 * One coding agent session of a run, sealed with the run state
 * (FactoryRunState.codingAgent) and shape-checked on every load.
 */
export interface CodingAgentRunRecord {
  /** The run's coding-agent lane (FactoryLaneRecord.id). */
  laneId: string;
  /** The engine's LOCAL clock just before the assign POST: the `local` since until a read confirms the session. */
  assignAt: string;
  /**
   * `pending`: written before the POST (a crash after it is treated as
   * posted: counted, never re-assigned); `posted`: the POST returned 2xx (a
   * session is counted whatever the read showed); `failed`: the POST failed,
   * a rerun may assign again after a fresh pre-read.
   */
  assign: 'pending' | 'posted' | 'failed';
  /** GitHub's `assignedAt` of the first confirming read, stored once and never refreshed. */
  since?: { at: string; source: 'github' };
  /** The agent PR and exact head the engine adopted (from the read whose adoptPreconditions passed). */
  adopted?: { pr: number; head: string };
  /** The link comment is on the agent PR. */
  linked?: boolean;
  /** The agent PR is closed (decision D5). */
  closed?: boolean;
}

const LANE_ID = /^issue-[1-9]\d{0,9}-coding-agent-[1-9]\d{0,5}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX40 = /^[0-9a-f]{40}$/;
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));
const KEYS = new Set(['laneId', 'assignAt', 'assign', 'since', 'adopted', 'linked', 'closed']);

/** Why `v` is not a CodingAgentRunRecord (state.ts calls it on load), or null. */
export function codingAgentRecordProblem(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'not an object';
  const r = v as Record<string, unknown>;
  if (Object.keys(r).some((k) => !KEYS.has(k))) return 'unknown field';
  if (typeof r.laneId !== 'string' || !LANE_ID.test(r.laneId)) return 'laneId';
  if (!isIso(r.assignAt)) return 'assignAt';
  if (r.assign !== 'pending' && r.assign !== 'posted' && r.assign !== 'failed') return 'assign';
  if (r.since !== undefined) {
    const s = r.since as Record<string, unknown>;
    if (typeof s !== 'object' || s === null || Object.keys(s).length !== 2 || s.source !== 'github' || !isIso(s.at) || !ISO_SECONDS.test(s.at as string)) return 'since';
  }
  if (r.adopted !== undefined) {
    const a = r.adopted as Record<string, unknown>;
    if (typeof a !== 'object' || a === null || Object.keys(a).length !== 2 || !Number.isSafeInteger(a.pr) || (a.pr as number) <= 0
      || typeof a.head !== 'string' || !HEX40.test(a.head)) return 'adopted';
  }
  if (r.linked !== undefined && typeof r.linked !== 'boolean') return 'linked';
  if (r.closed !== undefined && typeof r.closed !== 'boolean') return 'closed';
  return null;
}

// --- repository and status helpers ---------------------------------------------------------------

/** The run's repository (`https://<host>/<owner>/<name>`, as intake recorded it from GitHub) as the adapter's parts, or undefined. */
export function codingAgentRepoOf(repoUrl: string): CodingAgentRepo | undefined {
  const m = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(repoUrl);
  return m ? { host: m[1], owner: m[2], name: m[3] } : undefined;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAgent = (v: unknown): boolean => isObj(v) && v.__typename === 'Bot' && v.login === CODING_AGENT_LOGIN;

/**
 * Open pull requests the agent authored in `repoName` (`OWNER/NAME`) and
 * linked to the issue, from the raw status response, whatever session they
 * belong to (parseCodingAgentStatus files earlier sessions under `ignored`
 * without their state). The pre-assign check refuses on any (item 8).
 */
export function openAgentPrs(stdout: string, repoName: string): number[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return [];
  }
  const issue = isObj(json) && isObj(json.data) && isObj(json.data.repository) ? json.data.repository.issue : undefined;
  const items = isObj(issue) && isObj(issue.timelineItems) && Array.isArray(issue.timelineItems.nodes) ? issue.timelineItems.nodes : [];
  const open = new Set<number>();
  const lower = repoName.toLowerCase();
  for (const e of items) {
    if (!isObj(e) || (e.__typename !== 'ConnectedEvent' && e.__typename !== 'CrossReferencedEvent') || !isAgent(e.actor)) continue;
    const pr = e.__typename === 'ConnectedEvent' ? e.subject : e.source;
    if (!isObj(pr) || pr.__typename !== 'PullRequest' || pr.state !== 'OPEN' || !isAgent(pr.author)) continue;
    const base = isObj(pr.baseRepository) && typeof pr.baseRepository.nameWithOwner === 'string' ? pr.baseRepository.nameWithOwner.toLowerCase() : '';
    if (base === lower && Number.isSafeInteger(pr.number) && (pr.number as number) > 0) open.add(pr.number as number);
  }
  return [...open].sort((a, b) => a - b);
}

// --- guard shapes ----------------------------------------------------------------------------------

const PR_NUMBER = /^[1-9]\d{0,9}$/;

/** `git fetch` of the agent PR's head: no tags, no configured refmap, so only FETCH_HEAD (and objects) change. */
export function codingAgentFetchArgs(pr: number): string[] {
  if (!Number.isSafeInteger(pr) || !PR_NUMBER.test(String(pr))) throw new Error(`coding agent fetch: #${pr} is not a PR number`);
  return ['fetch', '--no-tags', '--refmap=', 'origin', `refs/pull/${pr}/head`];
}

/** The commit the fetch wrote to FETCH_HEAD. */
export const CODING_AGENT_FETCH_HEAD_ARGS: readonly string[] = ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'];

/** Every tree entry of one commit (modes included): the adopt's gitlink and symlink check. */
export function codingAgentTreeArgs(sha: string): string[] {
  if (!HEX40.test(sha)) throw new Error(`coding agent tree: ${sha} is not a 40-hex commit`);
  return ['ls-tree', '-r', '-z', '--full-tree', sha];
}

/** `git merge-base <sha40> <sha40>`: where the adopted head left the configured base (read-only). */
export function codingAgentMergeBaseArgs(base: string, head: string): string[] {
  if (!HEX40.test(base) || !HEX40.test(head)) throw new Error('coding agent merge-base: both operands must be 40-hex commits');
  return ['merge-base', base, head];
}

/**
 * The engine's coding agent step context: CodingAgentContext plus, for the
 * adopt's fetch, the one PR number it may fetch (`adopt`), and, for the link
 * comment, the numbers, branch and sha its exact body is built from (`link`).
 */
export interface CodingAgentStepContext extends CodingAgentContext {
  adopt?: number;
  link?: { ownPr: number; branch: string; head: string };
}

/**
 * The git shapes the adopt adds to the factory guard (exec.ts), exact argv:
 * codingAgentFetchArgs (only with a step context whose `adopt` is that PR),
 * CODING_AGENT_FETCH_HEAD_ARGS, codingAgentTreeArgs and codingAgentMergeBaseArgs.
 */
export function isCodingAgentGitArgs(a: readonly string[], ctx?: CodingAgentStepContext): boolean {
  if (a.length === 5 && a[0] === 'fetch') {
    const m = /^refs\/pull\/([1-9]\d{0,9})\/head$/.exec(a[4]);
    return a[1] === '--no-tags' && a[2] === '--refmap=' && a[3] === 'origin' && m !== null
      && ctx?.adopt !== undefined && Number.isSafeInteger(ctx.adopt) && String(ctx.adopt) === m[1];
  }
  if (a.length === CODING_AGENT_FETCH_HEAD_ARGS.length && CODING_AGENT_FETCH_HEAD_ARGS.every((v, i) => a[i] === v)) return true;
  if (a.length === 3 && a[0] === 'merge-base' && HEX40.test(a[1]) && HEX40.test(a[2])) return true;
  return a.length === 5 && a[0] === 'ls-tree' && a[1] === '-r' && a[2] === '-z' && a[3] === '--full-tree' && HEX40.test(a[4]);
}

/** `gh pr comment <pr> --repo <HOST/OWNER/NAME> --body-file <file>`: the D5 link comment on the agent's PR. */
export function codingAgentLinkCommentArgs(repo: CodingAgentRepo, pr: number, bodyFile: string): string[] {
  if (!Number.isSafeInteger(pr) || !PR_NUMBER.test(String(pr))) throw new Error(`coding agent comment: #${pr} is not a PR number`);
  return ['pr', 'comment', String(pr), '--repo', `${repo.host}/${repo.owner}/${repo.name}`, '--body-file', bodyFile];
}

/** argv index of the link comment's body file (the guard runs the comment with its own copy of it). */
export const CODING_AGENT_LINK_BODY_ARG = 6;

/**
 * The guard clause of the link comment: exactly codingAgentLinkCommentArgs
 * for the context's repository and `pr`. Without a CodingAgentContext naming
 * the PR it is refused.
 */
export function isCodingAgentLinkCommentArgs(a: readonly string[], ctx: CodingAgentStepContext | undefined): boolean {
  if (!ctx || ctx.pr === undefined || ctx.link === undefined || !Number.isSafeInteger(ctx.pr) || !PR_NUMBER.test(String(ctx.pr)) || a.length !== 7) return false;
  const file = a[CODING_AGENT_LINK_BODY_ARG];
  return a[0] === 'pr' && a[1] === 'comment' && a[2] === String(ctx.pr) && a[3] === '--repo' && a[4].toLowerCase() === ctx.repo.toLowerCase()
    && a[5] === '--body-file' && typeof file === 'string' && file.length > 0 && !file.startsWith('-') && !/[\r\n\0]/.test(file);
}

/** The link comment (engine text only: numbers, the branch and a sha; nothing the agent wrote). */
export function codingAgentLinkBody(o: { issue: number; ownPr: number; branch: string; head: string }): string {
  return [
    `The factory adopted this pull request's head \`${o.head.slice(0, 12)}\` for issue #${o.issue}: it is now on \`${o.branch}\` in #${o.ownPr}, the factory's own pull request.`,
    '',
    `Review, fix rounds, gates and the human merge continue on #${o.ownPr}; this pull request is closed (\`omg factory run ${o.issue}\`). Please do not push here or click "Update branch".`,
    '',
  ].join('\n');
}

/** The guard's body check of the link comment: exactly codingAgentLinkBody of the step context's numbers, branch and sha, or why not. */
export function codingAgentLinkBodyProblem(body: string, ctx: CodingAgentStepContext | undefined): string | null {
  if (!ctx?.link) return 'no link comment context';
  const { ownPr, branch, head } = ctx.link;
  return body === codingAgentLinkBody({ issue: ctx.issue, ownPr, branch, head }) ? null : 'the body is not the factory\'s link comment for this context';
}

/**
 * New or changed gitlinks (160000) and symlinks (120000) of `head`'s tree
 * against `base`'s (both `ls-tree -r -z --full-tree` output): host git does
 * not enter a nested repository, and a link can point out of the checkout.
 */
export function linkEntries(baseTree: string, headTree: string): { gitlinks: string[]; symlinks: string[] } {
  const of = (out: string, mode: string) => new Set(out.split('\0').filter((e) => e.startsWith(`${mode} `)).map((e) => {
    const tab = e.indexOf('\t');
    return `${e.slice(0, tab).split(' ')[2]}\t${e.slice(tab + 1)}`;
  }));
  const added = (mode: string) => {
    const known = of(baseTree, mode);
    return [...of(headTree, mode)].filter((x) => !known.has(x)).map((x) => x.slice(x.indexOf('\t') + 1));
  };
  return { gitlinks: added('160000'), symlinks: added('120000') };
}

// --- metering ------------------------------------------------------------------------------------

/** One session's estimate (decision D6): GitHub bills the agent separately from factory lanes; no AI credits of the run's caps. */
export const CODING_AGENT_SESSION_USAGE = Object.freeze({ credits: 0, premiumRequests: 1, source: 'estimated' as const });

const MIRROR_FILE = 'coding-agent-sessions.json';
/** Mirror entries older than this are dropped on write. */
const MIRROR_KEEP_MS = 7 * 24 * 60 * 60_000;

interface SessionMirror {
  version: 1;
  /** `<repo>#<laneId>` -> when the POST returned and for which run. */
  sessions: Record<string, { at: string; run: string; by?: string }>;
}

function readMirror(path: string): SessionMirror {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionMirror>;
    const sessions: SessionMirror['sessions'] = {};
    if (isObj(raw) && isObj(raw.sessions)) {
      for (const [k, v] of Object.entries(raw.sessions)) {
        if (isObj(v) && isIso(v.at) && typeof v.run === 'string') sessions[k] = { at: v.at, run: v.run, ...(typeof v.by === 'string' ? { by: v.by } : {}) };
      }
    }
    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: {} };
  }
}

export interface CodingAgentSession {
  /** The repository root (the budget ledger lives under its state root). */
  root: string;
  /** The engine ledger directory (outside every lane-writable root). */
  ledgerDir: string;
  laneId: string;
  /** runSlug of the run (`issue-<n>`). */
  run: string;
  /** `HOST/OWNER/NAME`. */
  repo: string;
  /** When the POST returned (engine clock, ISO). */
  at: string;
}

/**
 * Count one session, idempotently per lane (a crash after the POST counts it
 * again under the same keys): the budget ledger record `factory-lane:<laneId>`
 * tagged `{ kind: factory-lane, role: coding-agent, run }`, and the engine
 * ledger mirror. Returns the failures (a write that failed is reported, not
 * thrown: the session is real either way).
 */
export function recordCodingAgentSession(s: CodingAgentSession): string[] {
  const failures: string[] = [];
  try {
    recordUsage(ledgerPath(s.root), `factory-lane:${s.laneId}`, {
      ...CODING_AGENT_SESSION_USAGE, detail: 'coding agent session (estimate: one premium request; GitHub bills it separately)', updatedAt: s.at,
      tag: { kind: 'factory-lane', role: 'coding-agent', run: s.run },
    }, undefined, { timeoutMs: 5_000 });
  } catch (error) {
    failures.push(`budget ledger: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    ensureDirSync(s.ledgerDir);
    const path = join(s.ledgerDir, MIRROR_FILE);
    withFileLockSync(lockPathFor(path), () => {
      const m = readMirror(path);
      const now = Date.parse(s.at);
      for (const [k, v] of Object.entries(m.sessions)) if (now - Date.parse(v.at) > MIRROR_KEEP_MS) delete m.sessions[k];
      // A provisional entry of reserveCodingAgentSession keeps its time (the day it was counted on).
      m.sessions[`${s.repo}#${s.laneId}`] ??= { at: s.at, run: s.run };
      atomicWriteFileSync(path, JSON.stringify(m, null, 2));
    }, { timeoutMs: 5_000 });
  } catch (error) {
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
export function codingAgentSessionsOn(root: string, ledgerDir: string, day: string): number {
  let budget = 0;
  try {
    const ledger = readLedger(ledgerPath(root));
    budget = Object.entries(ledger.sessions).filter(([key, r]) => key.startsWith('factory-lane:') && r.tag?.role === 'coding-agent'
      && typeof r.updatedAt === 'string' && r.updatedAt.slice(0, 10) === day).length;
  } catch { /* the mirror still counts */ }
  const mirror = Object.values(readMirror(join(ledgerDir, MIRROR_FILE)).sessions).filter((v) => v.at.slice(0, 10) === day).length;
  return Math.max(budget, mirror);
}

/** The engine ledger mirror's lock could not be taken in time: another engine is reserving a session (the caller reports busy). */
export class CodingAgentSessionsBusyError extends Error {
  constructor(path: string) {
    super(`the coding agent session count (${path}) is locked by another engine`);
    this.name = 'CodingAgentSessionsBusyError';
  }
}

function underMirrorLock<T>(ledgerDir: string, timeoutMs: number, fn: (path: string) => T): T {
  ensureDirSync(ledgerDir);
  const path = join(ledgerDir, MIRROR_FILE);
  const handle = acquireFileLockSync(lockPathFor(path), { timeoutMs });
  if (!handle) throw new CodingAgentSessionsBusyError(path);
  try {
    return fn(path);
  } finally {
    releaseFileLockSync(handle);
  }
}

/**
 * The cap check, atomic across engines: under the mirror's file lock, count
 * the day's sessions and, below `max`, write a provisional mirror entry for
 * this lane before the lock is released, so a second engine counts it before
 * its own POST. `by` (the caller's process identity) is read by the caller
 * BEFORE the lock. A lock timeout throws CodingAgentSessionsBusyError.
 */
export function reserveCodingAgentSession(s: CodingAgentSession & { by: string }, max: number, timeoutMs = 5_000): { ok: boolean; used: number } {
  const day = s.at.slice(0, 10);
  return underMirrorLock(s.ledgerDir, timeoutMs, (path) => {
    const used = codingAgentSessionsOn(s.root, s.ledgerDir, day);
    if (used >= max) return { ok: false, used };
    const m = readMirror(path);
    m.sessions[`${s.repo}#${s.laneId}`] = { at: s.at, run: s.run, by: s.by };
    atomicWriteFileSync(path, JSON.stringify(m, null, 2));
    return { ok: true, used };
  });
}

/** Drop the provisional entry after a definite refusal of the assign (no session started), under the same lock. */
export function releaseCodingAgentSession(s: Pick<CodingAgentSession, 'ledgerDir' | 'repo' | 'laneId'>, timeoutMs = 5_000): void {
  underMirrorLock(s.ledgerDir, timeoutMs, (path) => {
    const m = readMirror(path);
    if (!(`${s.repo}#${s.laneId}` in m.sessions)) return;
    delete m.sessions[`${s.repo}#${s.laneId}`];
    atomicWriteFileSync(path, JSON.stringify(m, null, 2));
  });
}

/**
 * Whether a failed assign POST was refused for certain, so no session
 * started: gh exited with a status and reported an HTTP 4xx for the request.
 * A timeout or signal (no exit status), a network error or a 5xx leaves the
 * outcome unknown. (A guard refusal before the spawn is the caller's other
 * definite case.)
 */
export function isDefiniteAssignRefusal(message: string): boolean {
  return /failed \(exit [1-9]\d*\): .*\bHTTP 4\d\d\b/.test(message);
}
