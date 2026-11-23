/**
 * OMC HUD - Factory Element
 *
 * What the software factory needs from you, from `omg factory attention`'s
 * collector (local state only, read-only, the same trust rules):
 * Off on every host (opt-in, `elements.factory: true`): a status-line render
 * in a repository with factory state loads the factory modules and collects
 * (about 0.5 s measured on Windows). `factory:4! inspect` (4 items, the worst
 * group Inspect), with `run:1` when
 * an engine is live; `factory:run:1` when engines run and nothing waits;
 * nothing at all when neither. Numbers and fixed words only: no title,
 * reason or other text from a state reaches the status line.
 *
 * Cost: a few file-system checks when the repository has no factory state dir (the factory
 * modules are not even loaded then). A deleted state dir whose runs only the
 * engine ledger still records is not shown here; `omg factory attention`
 * lists those.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { RESET } from '../colors.js';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';

/** The group ids of src/factory/attention/actions.ts ATTENTION_GROUPS: the short names the element prints. */
export const FACTORY_HUD_GROUPS = ['inspect', 'broken', 'decide', 'merge', 'fix', 'limits'] as const;
const GROUPS = FACTORY_HUD_GROUPS;
/** Groups that mean something went wrong (red); the others are decisions or chores (yellow). */
const ALARM = new Set<string>(['inspect', 'broken']);

export interface FactoryStateForHud {
  total: number;
  worst: (typeof GROUPS)[number] | null;
  engines: number;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** The summary for `directory` (a repository root), or null when it has no factory state or anything fails. */
export async function readFactoryStateForHud(
  directory: string,
  load: () => Promise<{ attentionSummary: (root: string) => { total: number; worst: string | null; engines: number } }> = () => import('../../factory/attention/summary.js'),
): Promise<FactoryStateForHud | null> {
  try {
    if (!existsSync(join(getOmcRoot(directory), 'state', 'factory'))) return null;
    const s = (await load()).attentionSummary(directory);
    const worst = GROUPS.find((g) => g === s.worst) ?? null;
    return { total: count(s.total), worst, engines: count(s.engines) };
  } catch {
    return null;
  }
}

export function renderFactory(state: FactoryStateForHud | null | undefined): string | null {
  if (!state) return null;
  const total = count(state.total);
  const engines = count(state.engines);
  const worst = GROUPS.find((g) => g === state.worst);
  const parts: string[] = [];
  if (total > 0) parts.push(`${worst && ALARM.has(worst) ? RED : YELLOW}${total}!${RESET}${worst ? ` ${worst}` : ''}`);
  if (engines > 0) parts.push(`${GREEN}run:${engines}${RESET}`);
  if (parts.length === 0) return null;
  return `factory:${parts.join(' ')}`;
}
