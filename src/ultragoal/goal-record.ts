import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readUltragoalPlan,
  ultragoalDir,
  UltragoalError,
  type UltragoalItem,
  type UltragoalPlan,
} from './artifacts.js';

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
export const OMG_GOAL_RECORD = 'omg-goal.json';

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

export function omgGoalRecordPath(cwd: string, planId?: string): string {
  return join(ultragoalDir(cwd, planId), OMG_GOAL_RECORD);
}

export async function readOmgGoalRecord(cwd: string, planId?: string): Promise<OmgGoalRecord | null> {
  let raw: string;
  try {
    raw = await readFile(omgGoalRecordPath(cwd, planId), 'utf-8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as OmgGoalRecord;
  if (parsed?.version !== 1 || typeof parsed.objective !== 'string' || !Array.isArray(parsed.criteria)) {
    throw new UltragoalError(`Invalid OMG goal record at ${omgGoalRecordPath(cwd, planId)}.`);
  }
  return parsed;
}

async function writeOmgGoalRecord(cwd: string, record: OmgGoalRecord): Promise<void> {
  await mkdir(ultragoalDir(cwd, record.planId), { recursive: true });
  await writeFile(omgGoalRecordPath(cwd, record.planId), `${JSON.stringify(record, null, 2)}\n`);
}

export function missingGoalCriteria(record: OmgGoalRecord): OmgGoalCriterion[] {
  return record.criteria.filter((criterion) => !criterion.evidence?.trim());
}

function activeGoal(plan: UltragoalPlan): UltragoalItem | undefined {
  return plan.goals.find((goal) => goal.id === plan.activeGoalId) ?? plan.goals.find((goal) => goal.status === 'in_progress');
}

/** The objective the PreToolUse guard expects (mirrors getExpectedUltragoalObjective). */
function expectedObjective(plan: UltragoalPlan): string | undefined {
  if (plan.claudeGoalMode === 'aggregate' || plan.claudeGoalMode === undefined) {
    if (plan.claudeObjective?.trim()) return plan.claudeObjective.trim();
  }
  return activeGoal(plan)?.objective.trim() || undefined;
}

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
export async function startOmgGoal(cwd: string, options: StartOmgGoalOptions): Promise<OmgGoalRecord> {
  const criteriaText = options.criteria.map((text) => text.trim()).filter(Boolean);
  if (criteriaText.length === 0) throw new UltragoalError('Pass at least one --criterion <acceptance criterion>.');
  let plan: UltragoalPlan | null = null;
  try {
    plan = await readUltragoalPlan(cwd, options.planId);
  } catch (error) {
    if (!(error instanceof UltragoalError)) throw error;
  }
  const objective = options.objective?.trim() || (plan ? expectedObjective(plan) : undefined);
  if (!objective) {
    throw new UltragoalError(plan
      ? 'No active ultragoal story; run `omg ultragoal complete-goals` first or pass --objective.'
      : 'No ultragoal plan found; run `omg ultragoal create-goals ...` first or pass --objective.');
  }
  const now = (options.now ?? new Date()).toISOString();
  const previous = await readOmgGoalRecord(cwd, options.planId);
  const kept = new Map((previous?.objective === objective ? previous.criteria : []).map((criterion) => [criterion.text, criterion]));
  const criteria = criteriaText.map((text, index): OmgGoalCriterion => {
    const old = kept.get(text);
    return { id: `C${index + 1}`, text, ...(old?.evidence ? { evidence: old.evidence, recordedAt: old.recordedAt } : {}) };
  });
  const goalId = plan ? activeGoal(plan)?.id : undefined;
  const record: OmgGoalRecord = {
    version: 1,
    objective,
    status: criteria.every((criterion) => criterion.evidence) ? 'complete' : 'active',
    host: 'copilot',
    ...(options.planId ? { planId: options.planId } : {}),
    ...(goalId ? { goalId } : {}),
    createdAt: previous?.objective === objective ? previous.createdAt : now,
    updatedAt: now,
    criteria,
  };
  await writeOmgGoalRecord(cwd, record);
  return record;
}

export interface RecordOmgGoalEvidenceOptions {
  criterion: string;
  evidence: string;
  planId?: string;
  now?: Date;
}

/** Fill one criterion's evidence slot; the record completes when every slot is filled. */
export async function recordOmgGoalEvidence(cwd: string, options: RecordOmgGoalEvidenceOptions): Promise<OmgGoalRecord> {
  const record = await readOmgGoalRecord(cwd, options.planId);
  if (!record) throw new UltragoalError('No OMG goal record; run `omg ultragoal goal-start --criterion <text>` first.');
  const evidence = options.evidence.trim();
  if (!evidence) throw new UltragoalError('Missing --evidence.');
  const key = options.criterion.trim().toLowerCase();
  const criterion = record.criteria.find((candidate) => candidate.id.toLowerCase() === key);
  if (!criterion) {
    throw new UltragoalError(`Unknown criterion ${options.criterion}; known: ${record.criteria.map((candidate) => candidate.id).join(', ')}.`);
  }
  const now = (options.now ?? new Date()).toISOString();
  criterion.evidence = evidence;
  criterion.recordedAt = now;
  record.status = missingGoalCriteria(record).length === 0 ? 'complete' : 'active';
  record.updatedAt = now;
  await writeOmgGoalRecord(cwd, record);
  return record;
}

/**
 * The record as a goal snapshot for checkpoint reconciliation: `complete`
 * once every criterion has evidence, `active` before.
 */
export function omgGoalRecordSnapshot(record: OmgGoalRecord): { objective: string; status: 'active' | 'complete'; source: 'omg-goal-record' } {
  return { objective: record.objective, status: record.status === 'complete' && missingGoalCriteria(record).length === 0 ? 'complete' : 'active', source: 'omg-goal-record' };
}

/** Model-facing Copilot handoff appended to complete-goals output (Copilot has no Claude /goal). */
export function buildCopilotGoalInstruction(goal: UltragoalItem, plan: UltragoalPlan): string {
  const objective = expectedObjective(plan) ?? goal.objective;
  const planFlag = plan.planId ? ` --plan-id ${plan.planId}` : '';
  return [
    'Copilot CLI goal record (replaces the Claude /goal steps above on GitHub Copilot CLI):',
    '- Copilot has no Claude /goal; do not try to invoke it. The OMG goal record satisfies the ultragoal tool guard.',
    `- Record the objective with its acceptance criteria now: omg ultragoal goal-start${planFlag} --criterion "<criterion 1>" --criterion "<criterion 2>"`,
    `- When a criterion is met, record its evidence: omg ultragoal goal-evidence${planFlag} --criterion C1 --evidence "<tests/files/PR evidence>"`,
    '- The session keeps continuing until every criterion has evidence (or the user cancels with /oh-my-copilot:cancel).',
    '- Checkpoint commands below may omit --claude-goal-json on Copilot; the goal record is used as the snapshot (active until all criteria have evidence, then complete).',
    `Goal record objective: ${objective}`,
  ].join('\n');
}
