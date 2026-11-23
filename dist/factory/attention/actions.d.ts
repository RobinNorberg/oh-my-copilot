/**
 * `omg factory attention`: the gate -> human action -> command table.
 *
 * One entry per gate name the engine can park at (src/factory/run/: every
 * `this.gate(...)` / `setGate(...)` call, every park object's `name` and
 * every `*_GATE` constant; __tests__/attention-actions.test.ts extracts them
 * from the source and fails on a name with no entry). Dynamic names
 * (`<kind>-failed`, `<kind>-declined`) are pattern entries over the lane
 * kinds. An unknown name lands in "Fix by hand" with the resume and status
 * commands.
 *
 * The `why` line is engine-authored text chosen by the gate name: the run's
 * free-text reason is never in it. A command is composed only from validated
 * fields: the run key (a positive integer, or `heal-<8 hex>`), a 40-hex head
 * sha, a positive PR number, the repository root and the fixed flags below.
 * Title, reason, detail, branch names and every other free text never reach
 * an argv.
 */
import type { ForgeKind } from '../../forge/types.js';
import { type FactoryRunKey } from '../run/state.js';
export declare const ATTENTION_GROUPS: readonly ["inspect", "broken", "decide", "merge", "fix", "limits"];
export type AttentionGroup = (typeof ATTENTION_GROUPS)[number];
export declare const GROUP_TITLES: Readonly<Record<AttentionGroup, string>>;
export interface NextCommand {
    label: string;
    argv: string[];
}
/**
 * A step of the table: `resume` (`omg factory run <n>`, a heal run `omg
 * factory heal approve <sig8>`), `cancel`, `status`, a resume with one fixed
 * acceptance flag (issue runs only: `heal approve` takes none), `merge` (the
 * forge's human merge command), `release-tamper`, and for a heal signature
 * without a run state `heal-close` / `heal-run`.
 */
export type ActionStep = 'resume' | 'cancel' | 'status' | 'merge' | 'allow-gate-change' | 'allow-unsandboxed-gates' | 'allow-secret-shapes' | 'heal-close' | 'heal-run';
export interface GateAction {
    group: AttentionGroup;
    /** One line, engine-authored, never the run's reason. */
    why: string;
    steps: readonly ActionStep[];
}
/** Every gate name the engine parks at with a fixed name. */
export declare const GATE_ACTIONS: Readonly<Record<string, GateAction>>;
/** Pattern entries, for names the engine builds from a lane kind. */
export declare function patternAction(name: string): GateAction | null;
export declare const UNKNOWN_GATE_ACTION: GateAction;
/** The table entry of a gate name; `known` false is the unknown fallback. */
export declare function gateAction(name: string): GateAction & {
    known: boolean;
};
/** A run key a command may carry: a positive integer issue, or `heal-<8 hex>`. */
export declare function validRunKey(key: unknown): key is FactoryRunKey;
export declare function resumeArgv(key: FactoryRunKey): string[];
export declare function cancelArgv(key: FactoryRunKey): string[];
/** `omg factory run status <n>`; a heal run `omg factory heal status <sig8>`. */
export declare function statusArgv(key: FactoryRunKey): string[];
/** The run's merge facts, each already shape-checked by the caller or here. */
export interface MergeFacts {
    forge: ForgeKind;
    /** The repository root (`git rev-parse --show-toplevel`), as the engine derives it. */
    root: string;
    pr?: number;
    head?: string;
}
/** The human merge argv the engine prints for that forge; null when there is none to give (Azure DevOps, a missing or malformed field). */
export declare function mergeArgv(m: MergeFacts): string[] | null;
/**
 * The next commands of a row, in table order. A step that cannot be composed
 * from validated fields is left out (a flag on a heal run, a merge without a
 * 40-hex head). An invalid key gives no command at all.
 */
export declare function nextCommands(key: FactoryRunKey, steps: readonly ActionStep[], merge?: MergeFacts): NextCommand[];
/** Shown when a state fails its seal or ledger check: only the read-only status command. */
export declare const suppressedCommands: (key: FactoryRunKey) => NextCommand[];
/** A poll reminder's command: the cancel where a rerun re-parks (decisions-rewritten), else the resume. */
export declare function reminderCommand(key: FactoryRunKey, gate: string): string;
/** One argv as a copyable line: a word with any other character is single-quoted (a POSIX shell and PowerShell read it the same unless it holds a single quote, written the POSIX way). */
export declare function commandLine(argv: readonly string[]): string;
//# sourceMappingURL=actions.d.ts.map