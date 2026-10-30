/**
 * The smoke side of record/replay (design: .omc/plans/2026-10-29-copilot-replay-design.md,
 * sections 6 and 7): where a run's cassettes and state live, the cassette env
 * each scenario runs with, the merge of a recording's per-process parts into
 * one cassette, the replay summary behind `scn.<name>.replay`, and the
 * `omg smoke cassette verify|import` file work.
 */
import { type Cassette, type CassetteManifest } from './cassette.js';
import { type CassetteMode } from './handler.js';
import { type ReplayStateSummary } from './matcher.js';
import type { PlaceholderDirs } from './redact.js';
export interface CassetteRun {
    mode: CassetteMode;
    /** The `--record` or `--replay` root; a scenario's cassette is `<root>/<platform>-<arch>/<scenario>/`. */
    root: string;
    /** This run's temp state; each scenario gets `<stateRoot>/<scenario>` (claims, ordinals, logs, record parts). */
    stateRoot: string;
    /** `--replay-strict`. */
    strict: boolean;
    /** `--record-overwrite`. */
    overwrite: boolean;
}
/** `<platform>-<arch>` of this machine: the cassette subdir it records into and replays from. */
export declare function platformTag(): string;
export declare function scenarioCassetteDir(run: Pick<CassetteRun, 'root'>, scenario: string): string;
export declare function scenarioStateDir(run: Pick<CassetteRun, 'stateRoot'>, scenario: string): string;
/**
 * The cassette env on top of `base`. With a scenario, the scenario's state
 * dir; without one (the smoke driver's shared client, switched per scenario
 * by `setCassetteScenario`), the unscoped state dir, whose requests both
 * modes answer with a 418 miss.
 */
export declare function cassetteEnv(base: NodeJS.ProcessEnv, run: CassetteRun, dirs: PlaceholderDirs, scenario?: string): NodeJS.ProcessEnv;
/**
 * One cassette from every part the scenario's clients wrote (one per client,
 * several processes for a team). Refuses when any part failed
 * (`<pid>-<n>.failed`), a stream id repeats, or the parts disagree on the
 * platform. Null when nothing was recorded. Global interactions are
 * renumbered in part order.
 */
export declare function mergeRecordedParts(stateDir: string, scenario: string): Cassette | null;
export interface RecordMeta {
    model?: string;
    maxCredits?: number;
    cost?: {
        credits?: number;
        premiumRequests?: number;
    };
    /** The scenarios of the recording run, in the order they ran; a replay runs them in this order. */
    runOrder?: string[];
}
/**
 * Merge the scenario's parts and write the cassette to
 * `<root>/<platform>-<arch>/<scenario>/` through the gate. Returns the
 * cassette dir and the stream count; throws when nothing was recorded or the
 * merge or write refuses.
 *
 * `globalsFrom`: the run's other scenarios. A runtime caches global GETs
 * across the scenarios of one client, so only the first scenario to need one
 * records it; each global key this scenario lacks is copied from them, and a
 * replay of any subset, in any order, finds it (an unserved global is not a
 * replay failure).
 */
export declare function finalizeRecording(run: CassetteRun, scenario: string, meta: RecordMeta, opts?: {
    globalsFrom?: string[];
}): {
    dir: string;
    streams: number;
    interactions: number;
};
/**
 * The selected scenarios in the order their recording ran (the manifests'
 * `runOrder`), or null when no selected cassette stores one. Scenarios the
 * stored order does not name keep their relative order, after the others.
 */
export declare function storedRunOrder<T extends string>(run: Pick<CassetteRun, 'root'>, scenarios: readonly T[]): T[] | null;
/** Where a scenario's parts go when its recording is not written: `<root>/_failed/<scenario>/` (never read as a cassette). */
export declare const FAILED_RECORDINGS_DIR = "_failed";
/**
 * Keep a scenario's recorded parts (each already through the gate) under
 * `<root>/_failed/<scenario>/` for diagnosis, replacing an earlier copy.
 * Returns that dir, or null when the scenario recorded nothing.
 */
export declare function keepFailedParts(run: CassetteRun, scenario: string): string | null;
/** Why recording `scenario` would be refused before any credit is spent (an existing cassette), or null. */
export declare function recordTargetRefusal(run: CassetteRun, scenario: string): string | null;
export type ReplayOutcome = ReplayStateSummary & {
    streams: number;
};
/** What the scenario's replay served, from its state dir; a string when the cassette cannot be read. */
export declare function replayOutcome(run: CassetteRun, scenario: string): ReplayOutcome | string;
/** The model a replay pins: the one every selected cassette was recorded with. */
export declare function replayModel(run: CassetteRun, scenarios: readonly string[]): string | undefined;
/** Whether `scenario` has a cassette for this machine under the run root. */
export declare function hasCassette(run: Pick<CassetteRun, 'root'>, scenario: string): boolean;
export interface GateResult {
    dir: string;
    ok: boolean;
    /** The masked hits (file:line, rule), one per line. */
    detail: string;
}
/** The redaction gate over every cassette under `root` (writes a REDACTION-FAILED marker into each that fails). */
export declare function gateCassettes(root: string): GateResult[];
/** Record the self-verify replay's result in the cassette's manifest. */
export declare function writeSelfVerify(dir: string, selfVerify: NonNullable<CassetteManifest['selfVerify']>): void;
export interface ImportResult {
    /** `<platform>-<arch>/<scenario>` per imported cassette. */
    imported: string[];
    dest: string;
}
/**
 * Copy every cassette under `source` into `<dest>/<platform>-<arch>/<scenario>/`
 * after the gate (no marker written into the source) and a format check.
 * All or nothing: any refusal (a gate hit, an unknown version, a cassette
 * outside its `<platform>-<arch>` dir, an existing target without
 * `overwrite`) copies nothing.
 */
export declare function importCassettes(source: string, dest: string, overwrite?: boolean): ImportResult;
//# sourceMappingURL=run.d.ts.map