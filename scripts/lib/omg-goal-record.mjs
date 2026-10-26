/**
 * Hook-side reader for the OMG goal record (`omg ultragoal goal-start`), the
 * Copilot CLI stand-in for Claude Code's `/goal`. The writer and the record
 * shape live in src/ultragoal/goal-record.ts; keep the two in step.
 *
 * Resolution mirrors resolveActivePlanId: an explicit plan id wins, then the
 * legacy single-plan dir, else every plan under plans/ (the CLI writes
 * plans/<id>/omg-goal.json with --plan-id). Both the resolved state root and
 * the project's own .omg/ are searched, the same pair the ultragoal hooks
 * already read plans from.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

export const OMG_GOAL_RECORD_FILE = 'omg-goal.json';
const PLAN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/** Mirrors getExpectedUltragoalObjective (pre-tool-enforcer.mjs): the state fields an objective is seeded in. */
const STATE_OBJECTIVE_KEYS = ['claude_goal_objective', 'claudeGoalObjective', 'codex_objective', 'codexObjective', 'goal_objective', 'goalObjective', 'objective'];

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function normalizeObjective(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function ultragoalDirsFor(root, planId) {
  const base = join(root, 'ultragoal');
  if (typeof planId === 'string' && PLAN_ID_PATTERN.test(planId)) return [join(base, 'plans', planId)];
  if (existsSync(join(base, OMG_GOAL_RECORD_FILE)) || existsSync(join(base, 'goals.json'))) return [base];
  let plans = [];
  try {
    plans = readdirSync(join(base, 'plans'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PLAN_ID_PATTERN.test(entry.name))
      .map((entry) => join(base, 'plans', entry.name));
  } catch {
    return [base];
  }
  return plans.length > 0 ? plans : [base];
}

/** The objective goal-start defaults to for the plan in `dir` (mirrors expectedObjective in goal-record.ts). */
function planObjectiveFor(dir) {
  const plan = readJson(join(dir, 'goals.json'));
  if (!plan || typeof plan !== 'object') return '';
  if ((plan.claudeGoalMode === 'aggregate' || plan.claudeGoalMode === undefined)
    && typeof plan.claudeObjective === 'string' && plan.claudeObjective.trim()) return plan.claudeObjective.trim();
  const goals = Array.isArray(plan.goals) ? plan.goals : [];
  const active = goals.find((goal) => goal?.id === plan.activeGoalId) ?? goals.find((goal) => goal?.status === 'in_progress');
  return typeof active?.objective === 'string' ? active.objective.trim() : '';
}

function isValidRecord(record) {
  return Boolean(record)
    && typeof record === 'object'
    && record.version === 1
    && typeof record.objective === 'string'
    && record.objective.trim() !== ''
    && Array.isArray(record.criteria);
}

/**
 * The goal record under `roots` (state roots, e.g. `<project>/.omg`), or null:
 * `{ record, path, planObjective }`, planObjective being the objective its own
 * plan expects now. With several plans, a record matching its plan wins, then
 * the most recently updated one.
 */
export function readOmgGoalRecord(roots, { planId } = {}) {
  const seen = new Set();
  const found = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !root) continue;
    const key = resolve(root);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const dir of ultragoalDirsFor(root, planId)) {
      const path = join(dir, OMG_GOAL_RECORD_FILE);
      const record = readJson(path);
      if (isValidRecord(record)) found.push({ record, path, planObjective: planObjectiveFor(dir) });
    }
  }
  const matches = (entry) => !entry.planObjective || normalizeObjective(entry.record.objective) === normalizeObjective(entry.planObjective);
  const updatedAt = (entry) => Date.parse(entry.record.updatedAt) || 0;
  found.sort((a, b) => Number(matches(b)) - Number(matches(a)) || updatedAt(b) - updatedAt(a));
  return found[0] ?? null;
}

/** The plan id the ultragoal state names (`plan_id`, written by create-goals / goal-start via recordUltragoalStatePlanId), if any. */
export function ultragoalStatePlanId(state) {
  const value = state?.plan_id ?? state?.planId;
  return typeof value === 'string' && PLAN_ID_PATTERN.test(value) ? value : undefined;
}

/** The objective a record must carry: the one seeded in the ultragoal state, else its plan's. */
export function expectedGoalObjective(state, found) {
  for (const key of STATE_OBJECTIVE_KEYS) {
    const value = state?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return found?.planObjective ?? '';
}

/** The record belongs to the current ultragoal run: its objective is the expected one (or none is known). */
export function goalRecordMatches(state, found) {
  if (!found) return false;
  const expected = normalizeObjective(expectedGoalObjective(state, found));
  return !expected || normalizeObjective(found.record.objective) === expected;
}

export function missingGoalCriteria(record) {
  if (!isValidRecord(record)) return [];
  return record.criteria.filter((criterion) => !(typeof criterion?.evidence === 'string' && criterion.evidence.trim()));
}

/** Every criterion has evidence (and there is at least one). */
export function isGoalRecordComplete(record) {
  return isValidRecord(record) && record.criteria.length > 0 && missingGoalCriteria(record).length === 0;
}
