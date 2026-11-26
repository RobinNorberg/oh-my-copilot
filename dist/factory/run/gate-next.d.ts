/**
 * The gate -> human action -> next step table, and the printed form of a
 * command: one module for the engine and every read surface.
 *
 * The engine composes FactoryGate.next with gateNext when it parks
 * (engine.ts park()) and seals it in the run state; a reader (`run status`,
 * `omg factory attention`) prefers that sealed value from a state that
 * passed its seal and ledger checks, and composes the same steps here for a
 * state sealed before the field existed (stateGateNext), so the two cannot
 * drift.
 *
 * One entry per gate name the engine can park at (src/factory/run/: every
 * gate, setGate and park call of the engine, every park
 * object's `name` and every `*_GATE` constant); the completeness tests
 * (__tests__/gate-next.test.ts, attention/__tests__/attention-actions.test.ts)
 * extract them from the source and fail on a name with no entry. Dynamic
 * names (`<kind>-failed`, `<kind>-declined`) are pattern entries over the
 * lane kinds; an unknown name gets the resume and status commands.
 *
 * The `why` line is engine-authored text chosen by the gate name: the run's
 * free-text reason is never in it. A command is composed only from engine
 * facts or validated fields: the run key (a positive integer, or
 * `heal-<8 hex>`), a 40-hex head, a positive PR number, the repository root,
 * the forge kind and the fixed flags below. Title, reason, detail, lane
 * output, branch names and every other free text never reach an argv.
 */
import type { ForgeKind } from '../../forge/types.js';
import { type FactoryGateNextStep, type FactoryRunKey, type FactoryRunState } from './state.js';
/** The human action a gate asks for, in the order a list of parks is read. */
export declare const GATE_GROUPS: readonly ["inspect", "broken", "decide", "merge", "fix", "limits"];
export type GateGroup = (typeof GATE_GROUPS)[number];
/**
 * A step of the table: `resume` (`omg factory run <n>`, a heal run `omg
 * factory heal approve <sig8>`), `cancel`, `status`, a resume with one fixed
 * acceptance flag (issue runs only: `heal approve` takes none), `merge` (the
 * forge's human merge command), `release-tamper` (`omg factory run release
 * --tamper`), and for a heal run `heal-close` / `heal-run`. `release-tamper`,
 * `allow-secret-shapes` and `allow-unsandboxed-lanes` apply only when the
 * park's facts say so (gateStepsFor).
 */
export type GateStep = 'resume' | 'cancel' | 'status' | 'merge' | 'release-tamper' | 'allow-gate-change' | 'allow-unsandboxed-gates' | 'allow-secret-shapes' | 'allow-unsandboxed-lanes' | 'heal-close' | 'heal-run';
export interface GateEntry {
    group: GateGroup;
    /** One line, engine-authored, never the run's reason. */
    why: string;
    steps: readonly GateStep[];
}
/** Every gate name the engine parks at with a fixed name. */
export declare const GATE_TABLE: Readonly<Record<string, GateEntry>>;
/** Pattern entries, for names the engine builds from a lane kind. */
export declare function patternEntry(name: string): GateEntry | null;
/** A name this version does not know (a newer engine's). */
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
/** The run's merge facts, each already shape-checked by the caller or here. */
export interface MergeFacts {
    forge: ForgeKind;
    /** The repository root the engine was started with (`git rev-parse --show-toplevel`). */
    root: string;
    pr?: number;
    head?: string;
}
/** The facts that pick a park's conditional steps, all engine-held (the engine) or sealed and verified (a reader). */
export interface GateNextFacts extends MergeFacts {
    key: FactoryRunKey;
    /** The park holds a lane commit's secret findings (pendingCommit.secretFindings): `--allow-secret-shapes` answers it. */
    secretFindings?: boolean;
    /** The human-review park for lanes without the enforced sandbox: `--allow-unsandboxed-lanes` answers it (the engine's call site says so). */
    unsandboxedLanes?: boolean;
    /** A tamper hold is set on the checkout: `omg factory run release --tamper` comes before a rerun. */
    tamperHold?: boolean;
}
/** The human merge argv the engine prints for that forge; null when there is none to give (Azure DevOps, a missing or malformed field). */
export declare function mergeArgv(m: MergeFacts): string[] | null;
/** One command for a human: a label, the exact argv, and whether it can start lanes (and so spend AI credits). */
export interface NextCommand {
    label: string;
    argv: string[];
    billed: boolean;
}
/**
 * The commands of a step list, in order. A step that cannot be composed
 * from validated fields is left out (a flag on a heal run, a merge without a
 * 40-hex head or on Azure DevOps, a heal step on an issue run). An invalid
 * key gives no command at all.
 */
export declare function nextCommands(key: FactoryRunKey, steps: readonly GateStep[], merge?: MergeFacts): NextCommand[];
/** A gate's steps with the conditional ones its facts do not call for left out. */
export declare function gateStepsFor(name: string, f: Pick<GateNextFacts, 'secretFindings' | 'unsandboxedLanes' | 'tamperHold'>): GateStep[];
/**
 * A park's next commands from its facts, in table order, without any a state
 * parser would refuse (a root with a control character), so the engine never
 * seals a state its parser rejects and a reader's fallback matches.
 */
export declare function gateCommands(name: string, f: GateNextFacts): NextCommand[];
/** The commands of a sealed FactoryGate.next. */
export declare const fromSealed: (next: readonly FactoryGateNextStep[]) => NextCommand[];
/** What the engine seals in FactoryGate.next when it parks at `name`. */
export declare function gateNext(name: string, f: GateNextFacts): FactoryGateNextStep[];
/** The facts of a parked state as a reader has them (no unsandboxed-lanes flag: only the engine's call site knows it). */
export declare function stateFacts(s: FactoryRunState, root: string, tamperHold?: boolean): GateNextFacts;
/**
 * A reader's next commands of a parked state that passed its seal and
 * ledger checks (the caller's job: an unverified state gives no command):
 * the sealed FactoryGate.next, or, for a state sealed before next existed,
 * the table composed from the state's own validated fields. `root` is the
 * reader's repository root; `tamperHold` whether a hold is set on it now.
 */
export declare function stateGateNext(s: FactoryRunState, root: string, tamperHold?: boolean): NextCommand[];
/** One argv as a copyable line for the shell family of `platform` (default: this host's). */
export declare function commandLine(argv: readonly string[], platform?: NodeJS.Platform): string;
/**
 * What a human is shown for a command (the stored argv stays exact). The
 * repository root is the one free-form word a command holds (`git -C
 * <root> ...`): when it is outside the portable set on Windows (cmd.exe
 * ignores single quotes), or holds a character a terminal cannot show
 * anywhere, the `-C <root>` form is withheld and the command is to be run in
 * the repository root (`inRoot`). `--json` keeps the exact argv either way.
 */
export declare function commandText(argv: readonly string[], platform?: NodeJS.Platform): {
    line: string;
    inRoot: boolean;
};
/**
 * A repository root as one copyable word for the shell family of `platform`
 * (the rule commandText applies to `git -C <root>`), or null when it cannot
 * be shown safely there: the caller then names the repository in prose and
 * prints no path inside a command.
 */
export declare function rootWord(root: string, platform?: NodeJS.Platform): string | null;
/** commandText as one phrase: the line, or "in the repository root: <line>". */
export declare function humanCommand(argv: readonly string[], platform?: NodeJS.Platform): string;
//# sourceMappingURL=gate-next.d.ts.map