/**
 * OMC HUD - Ultragoal Element
 *
 * Progress of the open ultragoal plan from `.omg/ultragoal/goals.json` (or
 * `.omg/ultragoal/plans/<id>/goals.json`): `goal:2/5`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import {
  ULTRAGOAL_GOALS,
  ULTRAGOAL_PLANS_SUBDIR,
  isUltragoalDone,
  summarizeUltragoalPlan,
  type UltragoalPlan,
} from '../../ultragoal/artifacts.js';
import { RESET } from '../colors.js';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

/** Ultragoal runs span hours per goal, so a plan untouched for a day is abandoned. */
const MAX_PLAN_AGE_MS = 24 * 60 * 60 * 1000;

export interface UltragoalStateForHud {
  complete: number;
  total: number;
  failed: number;
}

function readPlan(path: string): { plan: UltragoalPlan; mtimeMs: number } | null {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const plan = JSON.parse(readFileSync(path, 'utf-8')) as UltragoalPlan;
    if (plan?.version !== 1 || !Array.isArray(plan.goals)) return null;
    // Drop corrupt entries (null, non-objects, no string status) so the summary never throws.
    const goals = plan.goals.filter((goal) => (
      typeof goal === 'object' && goal !== null && typeof goal.status === 'string'
    ));
    return { plan: { ...plan, goals }, mtimeMs };
  } catch {
    return null;
  }
}

/**
 * The most recently written plan that is not done and was touched in the last
 * 24 hours, across the legacy single plan and every `plans/<id>/`.
 */
export function readUltragoalStateForHud(directory: string, now: number = Date.now()): UltragoalStateForHud | null {
  const root = join(getOmcRoot(directory), 'ultragoal');
  if (!existsSync(root)) return null;

  const paths = [join(root, ULTRAGOAL_GOALS)];
  try {
    for (const entry of readdirSync(join(root, ULTRAGOAL_PLANS_SUBDIR), { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(join(root, ULTRAGOAL_PLANS_SUBDIR, entry.name, ULTRAGOAL_GOALS));
    }
  } catch {
    // No plans/ subdir: the legacy single plan only.
  }

  let best: { plan: UltragoalPlan; mtimeMs: number } | null = null;
  for (const path of paths) {
    const candidate = readPlan(path);
    if (!candidate || candidate.plan.goals.length === 0) continue;
    if (now - candidate.mtimeMs > MAX_PLAN_AGE_MS || isUltragoalDone(candidate.plan)) continue;
    if (!best || candidate.mtimeMs > best.mtimeMs) best = candidate;
  }
  if (!best) return null;

  const summary = summarizeUltragoalPlan(best.plan);
  return { complete: summary.complete, total: summary.total, failed: summary.failed };
}

/** Format: goal:2/5 (complete/total), yellow when a goal has failed. */
export function renderUltragoal(state: UltragoalStateForHud | null | undefined): string | null {
  if (!state) return null;
  const color = state.failed > 0 ? YELLOW : GREEN;
  return `goal:${color}${state.complete}/${state.total}${RESET}`;
}
