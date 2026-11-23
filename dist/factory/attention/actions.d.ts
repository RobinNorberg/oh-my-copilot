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
import { gateSteps, patternEntry, type GateEntry, type GateGroup, type GateStep, type NextCommand } from '../run/gate-next.js';
import type { FactoryRunKey } from '../run/state.js';
export { cancelArgv, commandLine, commandText, fromSealed, rootWord, gateCommands, gateStepsFor, mergeArgv, nextCommands, resumeArgv, stateFacts, stateGateNext, statusArgv, validRunKey, type MergeFacts, type NextCommand, } from '../run/gate-next.js';
export declare const ATTENTION_GROUPS: readonly ["inspect", "broken", "decide", "merge", "fix", "limits"];
export type AttentionGroup = GateGroup;
export type ActionStep = GateStep;
export type GateAction = GateEntry;
export declare const GATE_ACTIONS: Readonly<Record<string, GateEntry>>;
export declare const patternAction: typeof patternEntry;
export declare const UNKNOWN_GATE_ACTION: GateEntry;
export declare const gateAction: typeof gateSteps;
export declare const GROUP_TITLES: Readonly<Record<AttentionGroup, string>>;
/** Shown when a state fails its seal or ledger check: only the read-only status command. */
export declare const suppressedCommands: (key: FactoryRunKey) => NextCommand[];
/** A poll reminder's command: the cancel where a rerun re-parks (decisions-rewritten), else the resume. */
export declare function reminderCommand(key: FactoryRunKey, gate: string): string;
//# sourceMappingURL=actions.d.ts.map