/**
 * `omg factory attention`: the gate -> human action -> command table.
 *
 * The table, the command composition and the quoting live in
 * src/factory/run/gate-next.ts, shared with the engine, which seals a park's
 * next commands (FactoryGate.next) from the same table; this module keeps
 * attention's names for them and the read-side text (group titles, the
 * suppressed and reminder commands). See gate-next.ts for the rules: a
 * command is composed only from validated fields, never from free text.
 */

import { cancelCommand, resumeCommand } from '../run/engine.js';
import {
  GATE_GROUPS, GATE_TABLE, gateSteps, patternEntry, statusArgv, UNKNOWN_GATE_ENTRY, validRunKey,
  type GateEntry, type GateGroup, type GateStep, type NextCommand,
} from '../run/gate-next.js';
import type { FactoryRunKey } from '../run/state.js';

export {
  cancelArgv, commandLine, commandText, fromSealed, gateCommands, gateStepsFor, mergeArgv, nextCommands, resumeArgv, stateFacts, stateGateNext, statusArgv, validRunKey,
  type MergeFacts, type NextCommand,
} from '../run/gate-next.js';

export const ATTENTION_GROUPS = GATE_GROUPS;
export type AttentionGroup = GateGroup;
export type ActionStep = GateStep;
export type GateAction = GateEntry;
export const GATE_ACTIONS = GATE_TABLE;
export const patternAction = patternEntry;
export const UNKNOWN_GATE_ACTION = UNKNOWN_GATE_ENTRY;
export const gateAction = gateSteps;

export const GROUP_TITLES: Readonly<Record<AttentionGroup, string>> = Object.freeze({
  inspect: 'Inspect',
  broken: 'Broken engine',
  decide: 'Decide',
  merge: 'Merge',
  fix: 'Fix by hand',
  limits: 'Limits / retry',
});

/** Shown when a state fails its seal or ledger check: only the read-only status command. */
export const suppressedCommands = (key: FactoryRunKey): NextCommand[] => (validRunKey(key) ? [{ label: 'read the run state', argv: statusArgv(key), billed: false }] : []);

/** A poll reminder's command: the cancel where a rerun re-parks (decisions-rewritten), else the resume. */
export function reminderCommand(key: FactoryRunKey, gate: string): string {
  return gate === 'decisions-rewritten' ? cancelCommand(key) : resumeCommand(key);
}
