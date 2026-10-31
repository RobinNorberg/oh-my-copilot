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
 * | any other factory run state exists (a run parked at the      | blocked    | run-active:<phase>[/<gate>]|
 * | intake blocked-by gate is re-evaluated by the rules below)   |            |                            |
 * | an open PR on factory/issue-<n> (a fork's too, as the engine)| blocked    | pr-exists                  |
 * | a PR from factory/issue-<n> merged into the base             | blocked    | merged                     |
 * | origin/factory/issue-<n> exists without an open PR           | blocked    | branch-exists              |
 * | a dependsOn item is unsatisfied (open, no merged factory PR  | blocked    | depends-on:#n,...          |
 * | into the base, no merged run state; score.ts isSatisfied)    |            |                            |
 * | the item depends on itself                                   | blocked    | blocked-by:self            |
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
import type { ForgeCheckConfig, ForgeIntakeConfig, ForgeItem, ForgeKind } from '../../forge/types.js';
import { type FactoryPhase } from '../run/state.js';
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
    runState(id: number): {
        phase: FactoryPhase;
        gate?: {
            name: string;
        };
    } | null;
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
export declare const VAGUE: RegExp;
/** The body's `Acceptance criteria` section: the lines after the heading, up to the next heading. */
export declare function acceptanceSection(body: string): string;
/** The list and checkbox items of an AC text. */
export declare function acceptanceItems(text: string): string[];
export declare const isVague: (acItem: string) => boolean;
/** The bucket of one item: the first §5 rule that hits. */
export declare function evaluateItem(item: ForgeItem, kind: ForgeKind, config: RuleConfig, look: RuleLookups): RuleVerdict;
//# sourceMappingURL=rules.d.ts.map