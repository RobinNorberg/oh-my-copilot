/**
 * The gate -> next step table: what a human does at each awaiting-human park.
 *
 * One table for the engine and every read surface, so the sealed
 * FactoryGate.next the engine writes and what a reader shows for a state
 * written before it cannot drift. The engine composes `next` with gateNext
 * when it parks (engine.ts gate()); a reader prefers the sealed value and
 * falls back to gateNext for older states, with the same facts.
 *
 * A step is composed only from engine-held facts: the run key (a positive
 * integer, or `heal-<8 hex>`), the 40-hex head, the PR number, the
 * repository root the engine was started with, the forge kind and the fixed
 * flags below. The reason, the park detail, lane output, titles and branch
 * names never reach an argv. Completeness: __tests__/gate-next.test.ts
 * extracts every gate name the engine can park at from the source and fails
 * on one with no entry; an unknown name gets status, rerun and cancel.
 */
import type { ForgeKind } from '../../forge/types.js';
import { type FactoryGateNextStep, type FactoryRunKey, type FactoryRunState } from './state.js';
/** The human action a gate asks for, in the order a list of parks is read. */
export declare const GATE_GROUPS: readonly ["inspect", "broken", "decide", "merge", "fix", "limits"];
export type GateGroup = (typeof GATE_GROUPS)[number];
/**
 * A step template: `status` (read the run state), `resume` (the rerun; a heal
 * run's `heal approve`), `cancel`, a rerun with one fixed acceptance flag
 * (issue runs only), `merge` (the forge's human merge command; none on Azure
 * DevOps), `release-tamper` (only while a tamper hold is set) and
 * `heal-close` (heal runs only).
 */
export type GateStep = 'status' | 'resume' | 'cancel' | 'merge' | 'release-tamper' | 'heal-close' | 'allow-gate-change' | 'allow-unsandboxed-gates' | 'allow-secret-shapes' | 'allow-unsandboxed-lanes';
export interface GateEntry {
    group: GateGroup;
    steps: readonly GateStep[];
}
/** Every gate the engine parks at under a fixed name (the `<kind>-failed` / `<kind>-declined` names are patterns below). */
export declare const GATE_TABLE: Readonly<Record<string, GateEntry>>;
/** A name this version does not know (a newer engine's): read the state, then rerun or cancel. */
export declare const UNKNOWN_GATE_ENTRY: GateEntry;
/** The table entry of a gate name; `known` false is the unknown fallback. */
export declare function gateSteps(name: string): GateEntry & {
    known: boolean;
};
/** A run key a command may carry: a positive integer issue, or `heal-<8 hex>`. */
export declare function validRunKey(key: unknown): key is FactoryRunKey;
/** The rerun of a parked run; a ci-heal run's `heal approve` also resumes it after any later gate. */
export declare const resumeArgv: (key: FactoryRunKey) => string[];
export declare const cancelArgv: (key: FactoryRunKey) => string[];
/** `omg factory run status <n>`; a heal run `omg factory heal status <sig8>`. */
export declare const statusArgv: (key: FactoryRunKey) => string[];
/** The facts a step is composed from, all engine-held (the engine) or sealed and verified (a reader). */
export interface GateNextFacts {
    key: FactoryRunKey;
    /** The repository root the engine was started with. */
    root: string;
    forge: ForgeKind;
    pr?: number;
    head?: string;
    /** The park holds a lane commit's secret findings (pendingCommit.secretFindings): `--allow-secret-shapes` answers it. */
    secretFindings?: boolean;
    /** The human-review park for lanes without the enforced sandbox: `--allow-unsandboxed-lanes` answers it. */
    unsandboxedLanes?: boolean;
    /** A tamper hold is set on the checkout: `omg factory run release --tamper` comes before a rerun. */
    tamperHold?: boolean;
}
/** The human merge argv the engine prints for that forge; null when there is none to give (Azure DevOps: its command reads a body file, see the PR comment). */
export declare function mergeArgv(f: Pick<GateNextFacts, 'forge' | 'root' | 'pr' | 'head'>): string[] | null;
/** The labels a step may carry (FactoryGate.next[].label is one of these when this version wrote it). */
export declare const GATE_NEXT_LABELS: Readonly<{
    status: "read the run state";
    resume: "rerun the run";
    healResume: "approve or resume the ci-heal run";
    cancel: "cancel the run";
    mergeLocal: "merge the exact head into your base";
    mergeGithub: "merge the exact head the gates checked";
    releaseTamper: "clear the tamper hold after checking .git";
    healClose: "close the heal signature without a fix";
    allow: (flag: string) => string;
}>;
/**
 * The next steps of a park, in table order. A step that cannot be composed
 * from the facts is left out (a flag on a heal run, a merge without a 40-hex
 * head or on Azure DevOps, the tamper release without a hold), and so is one
 * that would not pass the state's own shape check (a root with a control
 * character), so the engine never seals a state its parser refuses. An
 * invalid key gives no step at all.
 */
export declare function gateNext(name: string, f: GateNextFacts): FactoryGateNextStep[];
/**
 * A reader's next steps of a parked state that passed its seal and ledger
 * checks (the caller's job: an unverified state gives no command): the
 * sealed FactoryGate.next, or, for a state sealed before next existed, the
 * table composed from the state's own validated fields. `root` is the
 * reader's repository root; `tamperHold` whether a hold is set on it now.
 */
export declare function stateGateNext(s: FactoryRunState, root: string, tamperHold?: boolean): FactoryGateNextStep[];
/** One argv as a copyable line: a word with any other character is single-quoted (POSIX shells and PowerShell read it the same unless it holds a single quote, written the POSIX way). */
export declare function commandLine(argv: readonly string[]): string;
//# sourceMappingURL=gate-next.d.ts.map