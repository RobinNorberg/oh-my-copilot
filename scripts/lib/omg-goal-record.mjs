/**
 * Hook-side reader for the OMG goal record (`omg ultragoal goal-start`), the
 * Copilot CLI stand-in for Claude Code's `/goal`. The writer and the record
 * shape live in src/ultragoal/goal-record.ts; keep the two in step.
 *
 * Resolution mirrors resolveActivePlanId: the legacy single-plan dir wins,
 * else the only plan under plans/. Both the resolved state root and the
 * project's own .omg/ are searched, the same pair the ultragoal hooks already
 * read plans from.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

export const OMG_GOAL_RECORD_FILE = 'omg-goal.json';
const PLAN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function ultragoalDirFor(root) {
  const base = join(root, 'ultragoal');
  if (existsSync(join(base, OMG_GOAL_RECORD_FILE)) || existsSync(join(base, 'goals.json'))) return base;
  let plans = [];
  try {
    plans = readdirSync(join(base, 'plans'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PLAN_ID_PATTERN.test(entry.name));
  } catch {
    return base;
  }
  return plans.length === 1 ? join(base, 'plans', plans[0].name) : base;
}

function isValidRecord(record) {
  return Boolean(record)
    && typeof record === 'object'
    && record.version === 1
    && typeof record.objective === 'string'
    && record.objective.trim() !== ''
    && Array.isArray(record.criteria);
}

/** The first valid record under `roots` (state roots, e.g. `<project>/.omg`), or null. */
export function readOmgGoalRecord(roots) {
  const seen = new Set();
  for (const root of roots) {
    if (typeof root !== 'string' || !root) continue;
    const key = resolve(root);
    if (seen.has(key)) continue;
    seen.add(key);
    const path = join(ultragoalDirFor(root), OMG_GOAL_RECORD_FILE);
    const record = readJson(path);
    if (isValidRecord(record)) return { record, path };
  }
  return null;
}

export function missingGoalCriteria(record) {
  if (!isValidRecord(record)) return [];
  return record.criteria.filter((criterion) => !(typeof criterion?.evidence === 'string' && criterion.evidence.trim()));
}

/** Every criterion has evidence (and there is at least one). */
export function isGoalRecordComplete(record) {
  return isValidRecord(record) && record.criteria.length > 0 && missingGoalCriteria(record).length === 0;
}
