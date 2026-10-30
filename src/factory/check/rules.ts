/**
 * `omg factory check` hard rules (factory forges design §5): evaluated in
 * order, the first hit decides the item's bucket and its one reason. The
 * plan rules are the engine's own (src/factory/run/plan-rules.ts), so check
 * and run cannot drift. The 5-factor score is cut (critic amendments
 * §A.11): runnable items are ordered by priority only (score.ts).
 *
 * | Rule                                                         | Bucket     | Reason                     |
 * |--------------------------------------------------------------|------------|----------------------------|
 * | item closed (GitHub CLOSED, ADO Completed/Removed category)  | blocked    | closed                     |
 * | ADO type not in intake.itemTypes, or the GitHub id is a PR   | blocked    | wrong-type                 |
 * | a merged, cancelled or failed factory run state exists       | blocked    | run-finished:<phase>       |
 * | any other factory run state exists                           | blocked    | run-active:<phase>[/<gate>]|
 * | an open PR on factory/issue-<n> (a fork's too, as the engine)| blocked    | pr-exists                  |
 * | a PR from factory/issue-<n> merged into the base             | blocked    | merged                     |
 * | origin/factory/issue-<n> exists without an open PR           | blocked    | branch-exists              |
 * | a dependsOn item is unsatisfied (open, no merged factory PR  | blocked    | depends-on:#n,...          |
 * | into the base, no merged run state; score.ts isSatisfied)    |            |                            |
 * | open children, ADO type Epic/Feature, or GitHub label epic   | blocked    | needs-split                |
 * | no trusted omg-plan: line, no AC heading, empty ADO AC field | needs-plan | no-plan                    |
 * | omg-plan: path not repo-relative, or missing/empty on base   | needs-plan | plan-missing               |
 * | the AC section has no list or checkbox items                 | needs-plan | ac-not-testable            |
 * | too many AC items, size, or body length (factory.check)      | blocked    | too-big                    |
 * | every AC item is vague and names nothing concrete            | needs-plan | ac-vague                   |
 * | else                                                         | runnable   |                            |
 *
 * Closed items are listed as blocked rather than dropped: an id given on the
 * command line always gets a row. The AC rules (ac-not-testable, ac-vague and
 * the AC count of too-big) read the Acceptance-criteria plan only; an
 * omg-plan: file is the plan's own business.
 */

import { isRepoPath } from '../../ship/config.js';
import type { ForgeCheckConfig, ForgeIntakeConfig, ForgeItem, ForgeKind } from '../../forge/types.js';
import { ACCEPTANCE, findPlanLink, hasAcceptanceCriteria } from '../run/plan-rules.js';
import { factoryBranch, TERMINAL_FACTORY_PHASES, type FactoryPhase } from '../run/state.js';

export type CheckBucket = 'runnable' | 'needs-plan' | 'blocked';
export type PlanSource = 'omg-plan' | 'issue-body' | 'ado-acceptance';

export interface RuleVerdict {
  bucket: CheckBucket;
  /** The first rule hit as its exact reason code; empty when runnable. */
  reasons: string[];
  /** One human sentence for the reason (or the plan for a runnable item). */
  detail: string;
  planSource?: PlanSource;
}

/** What the rules read beyond the item itself; score.ts builds it from the forge and the repository. */
export interface RuleLookups {
  /** Whether another item (a child, or a PR) is open; an unreadable one counts as open. */
  isOpen(id: number): boolean;
  /** Whether a dependency is done: closed, its factory PR merged into the base, or its run merged; an unreadable one is not. */
  isSatisfied(id: number): boolean;
  /** The persisted factory run of the item, if any. */
  runState(id: number): { phase: FactoryPhase; gate?: { name: string } } | null;
  /** The open PR number on the item's factory branch, if any (fork PRs included, as the engine's pr-exists gate). */
  openPr(branch: string): number | undefined;
  /** The PR from the item's factory branch merged into the base, if any. */
  mergedPr(branch: string): number | undefined;
  /** Whether origin has the item's factory branch. */
  remoteBranch(branch: string): boolean;
  /** The file at the verified base commit; null when it does not exist there (or the base is unavailable). */
  readPlan(path: string): string | null;
  /** Where readPlan reads, for the reason text (e.g. `origin/dev at 0123456789ab`). */
  planBase: string;
}

export interface RuleConfig {
  intake: Pick<ForgeIntakeConfig, 'itemTypes'>;
  check: ForgeCheckConfig;
}

const SPLIT_TYPES = new Set(['epic', 'feature']);
const HEADING = /^[^\S\r\n]*#{1,6}[^\S\r\n]/;
const LIST_ITEM = /^[^\S\r\n]*(?:[-*+]|\d+[.)])[^\S\r\n]+(?:\[[ xX]\][^\S\r\n]+)?(\S.*)$/;
export const VAGUE = /\b(should work|as needed|etc\.?|tbd|nice|improve|better|clean ?up)\b/i;
/** A concrete noun: a backticked token, a path or file name, a number (counts, HTTP and exit codes). */
const CONCRETE = /`[^`\r\n]+`|[\w.-]*\/[\w.-]+|\b[\w-]+\.[a-z][a-z0-9]{0,4}\b|\d/i;

/** The body's `Acceptance criteria` section: the lines after the heading, up to the next heading. */
export function acceptanceSection(body: string): string {
  const m = ACCEPTANCE.exec(body);
  if (!m) return '';
  const lines = body.slice(m.index).split(/\r?\n/).slice(1);
  const end = lines.findIndex((l) => HEADING.test(l));
  return (end < 0 ? lines : lines.slice(0, end)).join('\n');
}

/** The list and checkbox items of an AC text. */
export function acceptanceItems(text: string): string[] {
  return text.split(/\r?\n/).map((l) => LIST_ITEM.exec(l)?.[1]?.trim()).filter((s): s is string => Boolean(s));
}

export const isVague = (acItem: string): boolean => VAGUE.test(acItem) && !CONCRETE.test(acItem);

const ids = (list: readonly number[]): string => list.map((n) => `#${n}`).join(',');
const hit = (bucket: CheckBucket, reason: string, detail: string): RuleVerdict => ({ bucket, reasons: [reason], detail });

/** The bucket of one item: the first §5 rule that hits. */
export function evaluateItem(item: ForgeItem, kind: ForgeKind, config: RuleConfig, look: RuleLookups): RuleVerdict {
  if (!item.open) return hit('blocked', 'closed', `the item is ${item.rawState || 'closed'}`);

  if (kind === 'azure-devops') {
    const types = config.intake.itemTypes.map((t) => t.toLowerCase());
    if (!item.type || !types.includes(item.type.toLowerCase())) {
      return hit('blocked', 'wrong-type', `work item type ${JSON.stringify(item.type ?? '')} is not in factory.intake.itemTypes (${config.intake.itemTypes.join(', ')})`);
    }
  }

  const run = look.runState(item.id);
  if (run && TERMINAL_FACTORY_PHASES.includes(run.phase)) {
    // The engine never restarts a merged, cancelled or failed run (engine.ts start()).
    return hit('blocked', `run-finished:${run.phase}`, `the factory run is ${run.phase} and is not restarted; see omg factory run status ${item.id}`);
  }
  if (run) {
    const at = run.gate ? `${run.phase}/${run.gate.name}` : run.phase;
    return hit('blocked', `run-active:${at}`, `a factory run is active (${at}); see omg factory run status ${item.id}`);
  }

  const branch = factoryBranch(item.id);
  const pr = look.openPr(branch);
  if (pr !== undefined) return hit('blocked', 'pr-exists', `open PR #${pr} already uses ${branch}`);
  // The item stays open when its factory PR merged into a base other than the default branch; never re-run it.
  const merged = look.mergedPr(branch);
  if (merged !== undefined) return hit('blocked', 'merged', `PR #${merged} from ${branch} already merged into the base`);
  if (look.remoteBranch(branch)) return hit('blocked', 'branch-exists', `origin/${branch} exists without an open PR; the engine would stop at head-moved-externally`);

  const deps = item.dependsOn.filter((d) => !look.isSatisfied(d));
  if (deps.length > 0) return hit('blocked', `depends-on:${ids(deps)}`, `depends on unfinished item${deps.length > 1 ? 's' : ''} ${ids(deps)} (open, no merged factory PR)`);

  const children = item.children.filter((c) => look.isOpen(c));
  if (children.length > 0) return hit('blocked', 'needs-split', `has open children ${ids(children)}`);
  if (kind === 'azure-devops' && item.type && SPLIT_TYPES.has(item.type.toLowerCase())) return hit('blocked', 'needs-split', `work item type ${item.type} needs splitting`);
  if (kind === 'github' && item.labels.some((l) => l.toLowerCase() === 'epic')) return hit('blocked', 'needs-split', 'labelled epic');

  const link = findPlanLink(item.body, item.comments, item.authorTrusted);
  const adoAc = item.acceptance?.trim() ? item.acceptance : undefined;
  const planSource: PlanSource | undefined = link ? 'omg-plan' : adoAc ? 'ado-acceptance' : hasAcceptanceCriteria(item.body) ? 'issue-body' : undefined;
  if (!planSource) return hit('needs-plan', 'no-plan', 'no trusted omg-plan: line and no "Acceptance criteria"');

  if (link) {
    if (!isRepoPath(link)) return hit('needs-plan', 'plan-missing', `omg-plan ${JSON.stringify(link)} is not a repo-relative path`);
    const text = look.readPlan(link);
    if (text === null || !text.trim()) return hit('needs-plan', 'plan-missing', `omg-plan ${link} is missing or empty on ${look.planBase}`);
  }

  const acItems = link ? [] : acceptanceItems(adoAc ?? acceptanceSection(item.body));
  if (!link && acItems.length === 0) return hit('needs-plan', 'ac-not-testable', 'the Acceptance criteria have no list or checkbox items');

  const { maxAcceptanceItems, maxSize, maxBodyChars } = config.check;
  if (acItems.length > maxAcceptanceItems) return hit('blocked', 'too-big', `${acItems.length} acceptance items (max ${maxAcceptanceItems})`);
  if (item.size !== undefined && item.size > maxSize) return hit('blocked', 'too-big', `size ${item.size} (max ${maxSize})`);
  if (item.body.length > maxBodyChars) return hit('blocked', 'too-big', `body is ${item.body.length} characters (max ${maxBodyChars})`);

  if (acItems.length > 0 && acItems.every(isVague)) return hit('needs-plan', 'ac-vague', 'every acceptance item is vague and names no path, command, number or code');

  const detail = link ? `plan: omg-plan ${link}` : `plan: ${acItems.length} acceptance item${acItems.length > 1 ? 's' : ''} (${planSource})`;
  return { bucket: 'runnable', reasons: [], detail, planSource };
}
