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
import { GATE_GROUPS, GATE_TABLE, gateSteps, patternEntry, statusArgv, UNKNOWN_GATE_ENTRY, validRunKey, } from '../run/gate-next.js';
export { cancelArgv, commandLine, commandText, fromSealed, rootWord, gateCommands, gateStepsFor, mergeArgv, nextCommands, resumeArgv, stateFacts, stateGateNext, statusArgv, validRunKey, } from '../run/gate-next.js';
export const ATTENTION_GROUPS = GATE_GROUPS;
export const GATE_ACTIONS = GATE_TABLE;
export const patternAction = patternEntry;
export const UNKNOWN_GATE_ACTION = UNKNOWN_GATE_ENTRY;
export const gateAction = gateSteps;
export const GROUP_TITLES = Object.freeze({
    inspect: 'Inspect',
    broken: 'Broken engine',
    decide: 'Decide',
    merge: 'Merge',
    fix: 'Fix by hand',
    limits: 'Limits / retry',
});
/** Shown when a state fails its seal or ledger check: only the read-only status command. */
export const suppressedCommands = (key) => (validRunKey(key) ? [{ label: 'read the run state', argv: statusArgv(key), billed: false }] : []);
/** A poll reminder's command: the cancel where a rerun re-parks (decisions-rewritten), else the resume. */
export function reminderCommand(key, gate) {
    return gate === 'decisions-rewritten' ? cancelCommand(key) : resumeCommand(key);
}
//# sourceMappingURL=actions.js.map