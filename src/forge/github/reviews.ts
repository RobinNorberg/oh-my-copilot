/**
 * GitHub pull requests (factory forges design §2, PR 2): the `gh pr` reads
 * and writes of `omg ship`, the gates driver and the factory engine, moved
 * verbatim. Engine-step calls throw GhCommandError with the engine's own
 * message (src/forge/github/gh.ts); the others keep their callers' result
 * handling.
 */

import type { Exec, ExecResult } from '../../ship/exec.js';
import type { PrView } from '../../ship/merge.js';
import type { ForgePr, ForgeRepo, ForgeReviewFeedback, ForgeReviews, PrMergeability } from '../types.js';
import { GhCommandError, ghJson, ghRun } from './gh.js';
import { GITHUB_RATE_LIMITED, parseReviewFeedback, reviewFeedbackArgs, type ReviewTrust } from './graphql.js';
import { ReviewFeedbackError } from '../review-feedback.js';

/** `gh pr view --json` fields the merge step reads. */
export const MERGE_VIEW_FIELDS = 'number,state,isDraft,baseRefName,baseRefOid,headRefOid';

export interface MergeView extends PrView {
  baseRefOid: string;
  /** Set by the factory engine's live-tip view (liveBase): the PR's own recorded baseRefOid, for reads that need a base with settled CI. */
  recordedBaseRefOid?: string;
}

const HEX40 = /^[0-9a-f]{40}$/;

/** Parse `gh pr view --json MERGE_VIEW_FIELDS`; null when a field is missing or malformed. */
export function parseMergeView(stdout: string): MergeView | null {
  let v: Record<string, unknown>;
  try { v = JSON.parse(stdout) as Record<string, unknown>; } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  const ok = typeof v.number === 'number' && typeof v.state === 'string' && typeof v.isDraft === 'boolean' && typeof v.baseRefName === 'string'
    && typeof v.baseRefOid === 'string' && HEX40.test(v.baseRefOid) && typeof v.headRefOid === 'string' && HEX40.test(v.headRefOid);
  return ok ? (v as unknown as MergeView) : null;
}

/** `gh pr view <pr> --json <fields>` in the process cwd (the `omg ship` CLI reads); the caller parses. */
export function ghPrView(exec: Exec, pr: number, fields: string): ExecResult {
  return exec('gh', ['pr', 'view', String(pr), '--json', fields]);
}

/** `gh pr view <pr> --json headRefOid,state`; throws on anything but a full sha and a state. */
export function ghPrHead(exec: Exec, pr: number, cwd: string): { headRefOid: string; state: string } {
  const res = exec('gh', ['pr', 'view', String(pr), '--json', 'headRefOid,state'], { cwd });
  let v: { headRefOid?: unknown; state?: unknown } = {};
  try { v = JSON.parse(res.stdout) as typeof v; } catch { /* checked below */ }
  if (res.status !== 0 || typeof v.headRefOid !== 'string' || !/^[0-9a-f]{40}$/.test(v.headRefOid) || typeof v.state !== 'string') {
    throw new Error(`gh pr view ${pr} did not return a head sha and state (exit ${res.status}): ${res.stderr.trim()}`);
  }
  return { headRefOid: v.headRefOid, state: v.state };
}

/**
 * `gh pr view <pr> --json headRefOid,mergeable,mergeStateStatus`: CONFLICTING
 * (or a DIRTY merge state) is a conflict, MERGEABLE is clean, anything else
 * (UNKNOWN while GitHub computes it lazily) is unknown. Throws on a failed read.
 */
export function ghPrMergeability(exec: Exec, pr: number, cwd: string): PrMergeability {
  const v = ghJson<{ headRefOid?: unknown; mergeable?: unknown; mergeStateStatus?: unknown }>(exec, ['pr', 'view', String(pr), '--json', 'headRefOid,mergeable,mergeStateStatus'], cwd);
  const head = typeof v?.headRefOid === 'string' && HEX40.test(v.headRefOid) ? { headRefOid: v.headRefOid } : {};
  if (v?.mergeable === 'CONFLICTING' || v?.mergeStateStatus === 'DIRTY') return { state: 'conflicting', ...head };
  return { state: v?.mergeable === 'MERGEABLE' ? 'mergeable' : 'unknown', ...head };
}

/** The engine's review read: `gh pr view <pr> --json headRefOid,state`, fields unchecked. */
export function ghPrHeadState(exec: Exec, pr: number, cwd: string): { headRefOid?: unknown; state?: unknown } {
  return ghJson<{ headRefOid?: unknown; state?: unknown }>(exec, ['pr', 'view', String(pr), '--json', 'headRefOid,state'], cwd);
}

/** `gh pr list --head <branch> --json number,state,headRefOid,url` as printed (open PRs only, gh's default). */
export function ghOpenPrs(exec: Exec, branch: string, cwd: string): Array<{ number?: number }> {
  return ghJson<Array<{ number?: number }>>(exec, ['pr', 'list', '--head', branch, '--json', 'number,state,headRefOid,url'], cwd);
}

/** The first open PR's number on `branch`, if gh reports one. */
export function ghFindOpenPr(exec: Exec, branch: string, cwd: string): number | undefined {
  const open = ghOpenPrs(exec, branch, cwd);
  return Array.isArray(open) && typeof open[0]?.number === 'number' ? open[0].number : undefined;
}

/** `gh pr list --head <branch> --base <base> --state merged --json number`: the first merged PR's number, if any. */
export function ghFindMergedPr(exec: Exec, branch: string, base: string, cwd: string): number | undefined {
  const merged = ghJson<Array<{ number?: number }>>(exec, ['pr', 'list', '--head', branch, '--base', base, '--state', 'merged', '--json', 'number'], cwd);
  return Array.isArray(merged) && typeof merged[0]?.number === 'number' ? merged[0].number : undefined;
}

/** `gh pr create --draft`; the new PR's number from the url gh prints. */
export function ghCreateDraftPr(exec: Exec, o: { base: string; head: string; title: string; bodyFile: string }, cwd: string): number {
  const out = ghRun(exec, ['pr', 'create', '--draft', '--base', o.base, '--head', o.head, '--title', o.title, '--body-file', o.bodyFile], cwd);
  const m = /\/pull\/(\d+)/.exec(out);
  if (!m) throw new GhCommandError(`gh pr create printed no PR url: ${out.trim().slice(0, 200)}`);
  return Number(m[1]);
}

/** `gh pr view <pr> --json MERGE_VIEW_FIELDS`. */
export function ghMergeView(exec: Exec, pr: number, cwd: string): MergeView {
  const view = parseMergeView(ghRun(exec, ['pr', 'view', String(pr), '--json', MERGE_VIEW_FIELDS], cwd));
  if (!view || view.number !== pr) throw new GhCommandError(`gh pr view ${pr} did not return the PR's state, base and head`);
  return view;
}

/** `gh pr ready <pr>`. */
export function ghMarkReady(exec: Exec, pr: number, cwd: string): void {
  ghRun(exec, ['pr', 'ready', String(pr)], cwd);
}

/** `gh pr comment <pr> --body-file <file>`; never throws on a gh failure. */
export function ghCommentPr(exec: Exec, pr: number, bodyFile: string, cwd: string): { ok: boolean; stderr: string } {
  const res = exec('gh', ['pr', 'comment', String(pr), '--body-file', bodyFile], { cwd });
  return { ok: res.status === 0, stderr: res.stderr };
}

/** `gh repo view --json url` as printed (the ci-heal intake checks the url). */
export function ghRepoView(exec: Exec, cwd: string): { url?: unknown } {
  return ghJson<{ url?: unknown }>(exec, ['repo', 'view', '--json', 'url'], cwd);
}

/** The ForgePr fields, the same list `omg ship merge` reads. */
export const PR_VIEW_FIELDS = 'number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,url';

const PR_STATES: ReadonlySet<string> = new Set(['OPEN', 'MERGED', 'CLOSED']);

/** `gh pr view <pr> --json PR_VIEW_FIELDS`; throws on a missing or malformed field. */
export function ghViewPr(exec: Exec, pr: number, cwd: string): ForgePr {
  const v = ghJson<Record<string, unknown> | null>(exec, ['pr', 'view', String(pr), '--json', PR_VIEW_FIELDS], cwd);
  const ok = typeof v === 'object' && v !== null && v.number === pr && typeof v.state === 'string' && PR_STATES.has(v.state)
    && typeof v.isDraft === 'boolean' && typeof v.baseRefName === 'string' && typeof v.baseRefOid === 'string' && HEX40.test(v.baseRefOid)
    && typeof v.headRefName === 'string' && typeof v.headRefOid === 'string' && HEX40.test(v.headRefOid) && typeof v.url === 'string';
  if (!ok) throw new GhCommandError(`gh pr view ${pr} did not return the PR's state, base and head`);
  return v as unknown as ForgePr;
}

/**
 * The human review input on `pr` at `head` (graphql.ts): one fixed GraphQL
 * read. A non-zero gh exit still counts only when every GraphQL error is about
 * the collaborator list (it needs push access: then only the viewer and
 * trustedReviewers are known, and `trustIncomplete` is set); otherwise it
 * throws. A truncated list or a moved head throws its ReviewFeedbackError
 * subclass unchanged; a rate limit keeps its RATE_LIMITED text (poll backs off).
 */
export function ghReviewFeedback(exec: Exec, repo: ForgeRepo, pr: number, head: string, trust: ReviewTrust, cwd: string): ForgeReviewFeedback {
  const args = reviewFeedbackArgs(repo, pr);
  const res = exec('gh', args, { cwd });
  try {
    return parseReviewFeedback(res.stdout, pr, head, trust, res.status);
  } catch (error) {
    if (error instanceof ReviewFeedbackError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (res.status === 0 || GITHUB_RATE_LIMITED.test(message)) throw new GhCommandError(message);
    throw new GhCommandError(`gh api graphql (review feedback of PR ${pr}) failed (exit ${res.status}): ${res.stderr.trim().split('\n')[0]}`);
  }
}

/** `o.repo` (the configured repository) turns on reviewFeedback; trust comes from `o.review` (trusted config layers). */
export function githubReviews(exec: Exec, cwd: string, o: { repo?: ForgeRepo; review?: ReviewTrust } = {}): ForgeReviews {
  const { repo } = o;
  const trust: ReviewTrust = { trustedReviewers: o.review?.trustedReviewers ?? [] };
  return {
    ...(repo ? { reviewFeedback: (pr: number, head: string) => ghReviewFeedback(exec, repo, pr, head, trust, cwd) } : {}),
    findOpenPrForBranch: (branch) => ghFindOpenPr(exec, branch, cwd),
    findMergedPrForBranch: (branch, base) => ghFindMergedPr(exec, branch, base, cwd),
    createDraftPr: (o) => ghCreateDraftPr(exec, o, cwd),
    viewPr: (pr) => ghViewPr(exec, pr, cwd),
    prHead: (pr) => ghPrHead(exec, pr, cwd),
    mergeability: (pr) => ghPrMergeability(exec, pr, cwd),
    markReady: (pr) => ghMarkReady(exec, pr, cwd),
    commentPr: (pr, bodyFile) => ghCommentPr(exec, pr, bodyFile, cwd),
  };
}
