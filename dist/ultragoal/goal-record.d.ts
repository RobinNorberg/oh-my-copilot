import { type UltragoalItem, type UltragoalPlan } from './artifacts.js';
/**
 * OMG-owned goal record: the Copilot CLI stand-in for Claude Code's `/goal`.
 *
 * Copilot has no Claude `/goal` a hook can observe, so the ultragoal
 * PreToolUse guard (scripts/pre-tool-enforcer.mjs) denied every tool once
 * the confirmation window closed. On Copilot the agent instead writes this
 * record with `omg ultragoal goal-start`: the objective it works on, its
 * acceptance criteria, and one evidence slot per criterion. The hooks read it
 * (scripts/lib/omg-goal-record.mjs mirrors the shape):
 *   - PreToolUse accepts an active record whose objective matches the
 *     ultragoal objective;
 *   - Stop keeps continuing until every criterion has evidence
 *     (`omg ultragoal goal-evidence`), or the user cancels.
 * `checkpoint` and `record-review-blockers` read it as the goal snapshot when
 * no `--claude-goal-json` is passed on Copilot.
 *
 * Path: `<ultragoal dir>/omg-goal.json` (the plan dir in multi-plan mode).
 */
export declare const OMG_GOAL_RECORD = "omg-goal.json";
export interface OmgGoalCriterion {
    id: string;
    text: string;
    evidence?: string;
    recordedAt?: string;
}
export interface OmgGoalRecord {
    version: 1;
    objective: string;
    status: 'active' | 'complete';
    host: 'copilot';
    planId?: string;
    goalId?: string;
    createdAt: string;
    updatedAt: string;
    criteria: OmgGoalCriterion[];
}
export declare function omgGoalRecordPath(cwd: string, planId?: string): string;
export declare function readOmgGoalRecord(cwd: string, planId?: string): Promise<OmgGoalRecord | null>;
export declare function missingGoalCriteria(record: OmgGoalRecord): OmgGoalCriterion[];
export interface StartOmgGoalOptions {
    criteria: string[];
    objective?: string;
    planId?: string;
    now?: Date;
}
/**
 * Write (or replace) the active goal record. The objective defaults to the
 * ultragoal objective the guard expects; evidence already recorded for a
 * criterion with the same text is kept.
 */
export declare function startOmgGoal(cwd: string, options: StartOmgGoalOptions): Promise<OmgGoalRecord>;
export interface RecordOmgGoalEvidenceOptions {
    criterion: string;
    evidence: string;
    planId?: string;
    now?: Date;
}
/** Fill one criterion's evidence slot; the record completes when every slot is filled. */
export declare function recordOmgGoalEvidence(cwd: string, options: RecordOmgGoalEvidenceOptions): Promise<OmgGoalRecord>;
/**
 * The record as a goal snapshot for checkpoint reconciliation: `complete`
 * once every criterion has evidence, `active` before.
 */
export declare function omgGoalRecordSnapshot(record: OmgGoalRecord): {
    objective: string;
    status: 'active' | 'complete';
    source: 'omg-goal-record';
};
/** Model-facing Copilot handoff appended to complete-goals output (Copilot has no Claude /goal). */
export declare function buildCopilotGoalInstruction(goal: UltragoalItem, plan: UltragoalPlan): string;
//# sourceMappingURL=goal-record.d.ts.map