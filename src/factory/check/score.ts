/**
 * `omg factory check` results (factory forges design §5, cut by critic
 * amendments §A.11): every item gets its bucket from the hard rules
 * (rules.ts); there is no 5-factor score, so the order is bucket (runnable,
 * needs-plan, blocked), then priority (ADO Priority 1..4, GitHub
 * `priority:p0..p3` labels as 1..4; none last), then id. Items are read only
 * through `forge.tracker`; the open-PR lookup goes through `forge.reviews`.
 */

import { stripAnsi } from '../../utils/string-width.js';
import type { Forge, ForgeItem, ResolvedForgeConfig } from '../../forge/types.js';
import type { FactoryPhase } from '../run/state.js';
import { evaluateItem, type CheckBucket, type PlanSource, type RuleLookups, type RuleVerdict } from './rules.js';

export const BUCKET_ORDER: readonly CheckBucket[] = ['runnable', 'needs-plan', 'blocked'];

/** One row of `omg factory check --json` (CHECK_JSON_SCHEMA_VERSION pins the shape). */
export interface CheckResult {
  id: number;
  /** Untrusted tracker text with ANSI sequences and control characters removed. */
  title: string;
  url: string;
  bucket: CheckBucket;
  /** The exact reason code of the rule that decided the bucket; [] when runnable. */
  reasons: string[];
  detail: string;
  /** 1 (highest) .. 4; null when the item has none. */
  priority: number | null;
  planSource: PlanSource | null;
}

/** What the check reads from the repository (cli.ts builds it from git and the run state). */
export interface CheckEnv {
  config: Pick<ResolvedForgeConfig, 'intake' | 'check'>;
  runState(id: number): { phase: FactoryPhase; gate?: { name: string } } | null;
  remoteBranch(branch: string): boolean;
  readPlan(path: string): string | null;
  planBase: string;
}

/** Tracker text for a terminal: ANSI sequences dropped, then every control/format/separator character as a space. */
export const plainText = (v: string): string => stripAnsi(v).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');

/** ADO Priority, else a GitHub `priority:pN` label (p0 -> 1 ... p3 -> 4). */
export function itemPriority(item: ForgeItem): number | null {
  if (item.priority !== undefined && Number.isInteger(item.priority) && item.priority > 0) return item.priority;
  const label = item.labels.map((l) => /^priority:p([0-3])$/i.exec(l)?.[1]).find((p) => p !== undefined);
  return label === undefined ? null : Number(label) + 1;
}

export function compareResults(a: CheckResult, b: CheckResult): number {
  return BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket)
    || (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER)
    || a.id - b.id;
}

/** gh prints a PR for `gh issue view <pr>`; the GitHub tracker refuses it with this message. */
const NOT_AN_ISSUE = /returned no issue url/;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const failed = (id: number, reason: string, detail: string): CheckResult =>
  ({ id, title: '', url: '', bucket: 'blocked', reasons: [reason], detail: plainText(detail), priority: null, planSource: null });

/** An item, else a PR (a dependency may be one): open unless the forge says it is closed or merged; unreadable counts as open. */
function isOpen(forge: Forge, id: number): boolean {
  try {
    return forge.tracker.viewItem(id).open;
  } catch {
    try {
      return forge.reviews.viewPr(id).state === 'OPEN';
    } catch {
      return true;
    }
  }
}

/**
 * The result of one item. A GitHub PR id is `wrong-type`; any other failed
 * read (the item, its run state, PR or branch lookup) is `read-failed`, so one
 * bad item never stops the batch.
 */
export function checkItem(forge: Forge, id: number, env: CheckEnv): CheckResult {
  let item: ForgeItem;
  try {
    item = forge.tracker.viewItem(id);
  } catch (error) {
    if (forge.kind === 'github' && NOT_AN_ISSUE.test(messageOf(error))) return failed(id, 'wrong-type', `#${id} is not an issue (a pull request?)`);
    return failed(id, 'read-failed', `#${id} could not be read: ${messageOf(error)}`);
  }
  const look: RuleLookups = {
    isOpen: (other) => isOpen(forge, other),
    runState: env.runState,
    openPr: (branch) => forge.reviews.findOpenPrForBranch(branch),
    remoteBranch: env.remoteBranch,
    readPlan: env.readPlan,
    planBase: env.planBase,
  };
  let v: RuleVerdict;
  try {
    v = evaluateItem(item, forge.kind, env.config, look);
  } catch (error) {
    return { ...failed(id, 'read-failed', `#${id} could not be checked: ${messageOf(error)}`), title: plainText(item.title), url: plainText(item.url), priority: itemPriority(item) };
  }
  return {
    id: item.id,
    title: plainText(item.title),
    url: plainText(item.url),
    bucket: v.bucket,
    reasons: v.reasons,
    detail: plainText(v.detail),
    priority: itemPriority(item),
    planSource: v.planSource ?? null,
  };
}

/** Every id once, checked and ordered. */
export function checkItems(forge: Forge, ids: readonly number[], env: CheckEnv): CheckResult[] {
  return [...new Set(ids)].map((id) => checkItem(forge, id, env)).sort(compareResults);
}

/** The setup wizard's preview row (src/factory/setup/intake-pick.ts PreviewRow). */
export interface CheckPreviewRow {
  id: number;
  title: string;
  url: string;
  readiness: string;
}

/**
 * The scorer for the setup wizard's `PreviewCheck` hook
 * (`(forge, ids) => PreviewRow[]`): `deps.previewCheck = factoryCheckPreview(env)`.
 * Readiness is the bucket and its reason, e.g. `blocked: pr-exists`.
 */
export function factoryCheckPreview(env: CheckEnv): (forge: Forge, ids: readonly number[]) => CheckPreviewRow[] {
  return (forge, ids) => checkItems(forge, ids, env).map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    readiness: r.reasons.length > 0 ? `${r.bucket}: ${r.reasons[0]}` : r.bucket,
  }));
}
