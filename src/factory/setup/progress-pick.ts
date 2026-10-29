/**
 * Step 5 of `omg factory setup` (factory forges design §4, §7): how factory
 * phases show on the tracker. GitHub uses the `factory:<stage>` label family
 * (labels only, critic amendments §A.11). Azure DevOps maps a stage to a
 * board column and/or a state, checked against the board and the item types'
 * states: a Completed or Removed state only for `done`, never a state for
 * `blocked` or `cancelled`, and a column only when it is on the board.
 *
 * `--progress default|none|<file.json>`; the file holds
 * `{ "enabled"?: boolean, "stages": { "<stage>": { "label" | "column" | "state": "…" } } }`.
 */

import { existsSync, readFileSync } from 'fs';
import { defaultProgressStages } from '../../forge/config.js';
import { PROGRESS_STAGES, type ForgeKind, type ForgeProgressConfig, type IntakeSource, type ProgressMapping, type ProgressStage } from '../../forge/types.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { adoGet, adoList, SetupError, type SetupIo } from './guard.js';
import { adoBoardColumns, type Prompter } from './intake-pick.js';

export function defaultProgress(kind: ForgeKind): ForgeProgressConfig {
  return { enabled: true, stages: defaultProgressStages(kind) };
}

export function progressFromFlag(spec: string | undefined, kind: ForgeKind): ForgeProgressConfig {
  if (spec === undefined || spec === 'default') return defaultProgress(kind);
  if (spec === 'none') return { enabled: false, stages: {} };
  if (!existsSync(spec)) throw new SetupError(2, `--progress must be default, none or a JSON file; ${JSON.stringify(spec)} does not exist`);
  let raw: unknown;
  try {
    raw = parseJsonc(readFileSync(spec, 'utf8'));
  } catch (error) {
    throw new SetupError(2, `--progress ${spec}: ${(error as Error).message}`);
  }
  const o = (raw ?? {}) as { enabled?: unknown; stages?: unknown };
  if (typeof o !== 'object' || Array.isArray(o) || (o.enabled !== undefined && typeof o.enabled !== 'boolean') || typeof o.stages !== 'object' || o.stages === null || Array.isArray(o.stages)) {
    throw new SetupError(2, `--progress ${spec} must be { "enabled"?: boolean, "stages": { "<stage>": { … } } }`);
  }
  return { enabled: o.enabled ?? true, stages: o.stages as Partial<Record<ProgressStage, ProgressMapping>> };
}

/** Labels the progress family and the intake source need on GitHub, minus the ones that exist. */
export function missingGitHubLabels(existing: readonly string[], progress: ForgeProgressConfig, intake?: IntakeSource): string[] {
  const want = new Set<string>();
  if (intake?.type === 'label') want.add(intake.label);
  if (progress.enabled) for (const m of Object.values(progress.stages)) if (m?.label) want.add(m.label);
  const have = new Set(existing.map((l) => l.toLowerCase()));
  return [...want].filter((l) => !have.has(l.toLowerCase()));
}

export interface AdoStateInfo {
  name: string;
  category: string;
}

export function adoTypeStates(io: SetupIo, type: string): AdoStateInfo[] {
  return adoList(adoGet(io, 'wit.workItemTypeStates.GET', { project: io.repo.project!, type }))
    .filter((s) => typeof s.name === 'string')
    .map((s) => ({ name: s.name as string, category: String(s.category ?? '') }));
}

const CLOSED_CATEGORIES = new Set(['completed', 'removed']);

/**
 * Validate an ADO mapping: exit 5 when a state or column does not exist or a
 * closed state is used before `done`; exit 2 when a column is mapped but no
 * board is known (`--board <team>/<board>` or a board-column intake).
 */
export function validateAdoProgress(io: SetupIo, progress: ForgeProgressConfig, itemTypes: readonly string[], board?: { team: string; board: string }): void {
  if (!progress.enabled) return;
  const entries = Object.entries(progress.stages) as Array<[ProgressStage, ProgressMapping]>;
  const states = new Map<string, AdoStateInfo[]>();
  let columns: string[] | undefined;
  for (const [stage, m] of entries) {
    if (m.label !== undefined) throw new SetupError(5, `progress.stages.${stage}.label is a GitHub mapping; Azure DevOps maps a column and/or a state`);
    if (m.state !== undefined) {
      if (stage === 'blocked' || stage === 'cancelled') throw new SetupError(5, `progress.stages.${stage}.state is not allowed: ${stage} never changes the work item state`);
      for (const type of itemTypes) {
        if (!states.has(type)) states.set(type, adoTypeStates(io, type));
        const found = states.get(type)!.find((s) => s.name.toLowerCase() === m.state!.toLowerCase());
        if (!found) throw new SetupError(5, `state validation failed: ${JSON.stringify(m.state)} is not a ${type} state`);
        if (CLOSED_CATEGORIES.has(found.category.toLowerCase()) && stage !== 'done') {
          throw new SetupError(5, `state validation failed: ${JSON.stringify(m.state)} is a ${found.category} state, allowed only for done`);
        }
      }
    }
    if (m.column !== undefined) {
      if (!board) throw new SetupError(2, `progress.stages.${stage}.column needs a board: pass --board <team>/<board> or use a board-column intake`);
      columns ??= adoBoardColumns(io, board.team, board.board);
      if (!columns.some((c) => c.toLowerCase() === m.column!.toLowerCase())) throw new SetupError(5, `column ${JSON.stringify(m.column)} is not on board ${JSON.stringify(board.board)}`);
    }
  }
}

/** Interactive step 5: the defaults first; GitHub may rename labels, ADO picks columns and the done state. */
export async function pickProgress(io: SetupIo, prompter: Prompter, itemTypes: readonly string[], board?: { team: string; board: string }): Promise<ForgeProgressConfig> {
  const kind = io.repo.kind;
  const defaults = defaultProgress(kind);
  if (kind === 'github') {
    console.error(`Progress labels: ${Object.values(defaults.stages).map((m) => m!.label).join(', ')}`);
    if (await prompter.confirm('Use the default factory:<stage> labels?', true)) return defaults;
    if (!(await prompter.confirm('Write progress labels at all?', true))) return { enabled: false, stages: {} };
    const stages: Partial<Record<ProgressStage, ProgressMapping>> = {};
    for (const stage of PROGRESS_STAGES) {
      if (stage === 'cancelled') continue;
      const label = await prompter.input(`Label for ${stage}`, `factory:${stage}`);
      if (label) stages[stage] = { label };
    }
    return { enabled: true, stages };
  }
  if (!(await prompter.confirm('Move work items on the board as the factory runs?', Boolean(board)))) return { enabled: false, stages: {} };
  const stages: Partial<Record<ProgressStage, ProgressMapping>> = {};
  if (board) {
    const columns = ['(none)', ...adoBoardColumns(io, board.team, board.board)];
    for (const stage of PROGRESS_STAGES) {
      if (stage === 'cancelled') continue;
      const column = await prompter.select(`Board column for ${stage}`, columns);
      if (column !== '(none)') stages[stage] = { column };
    }
  }
  const type = itemTypes[0];
  if (type) {
    const done = ['(none)', ...adoTypeStates(io, type).map((s) => s.name)];
    const state = await prompter.select(`State for done (${type})`, done);
    if (state !== '(none)') stages.done = { ...stages.done, state };
  }
  return { enabled: true, stages };
}
