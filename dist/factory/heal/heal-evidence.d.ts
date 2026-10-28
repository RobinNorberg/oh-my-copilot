/**
 * The heal evidence bundle (design §4): what the debugger lane gets to read,
 * built by the engine from a classified signature. Files:
 *
 * - `classification.json`: the classifier verdict (failing titles per job).
 * - `env-diff.json`: last green vs first red environment per job.
 * - `setup.log`: runner, image and tool-version lines of the red and the green job.
 * - `commits.txt`: `git log --oneline` of lastGreen..firstRed and the changed files.
 * - `test-source.txt`: the failing test file paths (the lane reads the source itself).
 * - `failures/<n>.log`: per failing test, its FAIL line to the next FAIL line, at most 200 lines.
 * - `tails/<n>.log`: per failed step, the last 120 lines of that step's log.
 *
 * Every file is log- or commit-derived, so every file is untrusted
 * (sanitize.ts): lines cleaned and capped at 400 characters, delimiter-
 * carrying lines dropped, each file capped at 64 KiB and the bundle at
 * MAX_BUNDLE_BYTES (later files are omitted first and the omission is
 * recorded). The bundle is written to `.omg/state/factory/heal/<sig8>/evidence/`
 * with a sha256 per file; the caller seals those hashes outside the repository.
 */
import { type FailingTest } from '../../ship/gates.js';
import type { Exec } from '../../ship/exec.js';
import type { HealClassification } from './classify.js';
import { type HealJob } from './history.js';
export declare const EVIDENCE_LIMITS: Readonly<{
    failureLines: 200;
    failureFiles: 10;
    tailLines: 120;
    tailFiles: 6;
    setupLinesPerJob: 80;
    commits: 50;
    testsPerJob: 10;
    fileBytes: number;
    bundleBytes: number;
}>;
export interface EvidenceFile {
    /** Lines as written (and as the prompt numbers them). */
    lines: string[];
    /** For a JSON file: every object key at any depth (citation anchors). */
    jsonKeys?: string[];
    /** What the file holds, engine-authored (job and step names are capped log text). */
    label: string;
}
export interface EvidenceBundle {
    sig8: string;
    /** File name -> content, in prompt order. */
    files: Record<string, EvidenceFile>;
    /** Files left out by the bundle cap. */
    omitted: string[];
    /** Lines dropped because they carried the fence delimiter prefix. */
    droppedLines: number;
}
export interface RedJobLog {
    job: Pick<HealJob, 'name' | 'failedSteps'>;
    log: string;
}
export interface EvidenceInput {
    classification: HealClassification;
    /** The first red run's failed (counted) jobs with their logs. */
    red: readonly RedJobLog[];
    /** The last green run's same-named jobs with their logs. */
    green: readonly {
        name: string;
        log: string;
    }[];
    /** `git log --oneline` lines of lastGreen..firstRed (empty when not available). */
    commits: readonly string[];
}
/** Per failing test: its FAIL line through the next FAIL line, at most `failureLines` lines. */
export declare function failureWindows(log: string, tests: readonly FailingTest[]): {
    test: FailingTest;
    lines: string[];
}[];
/** The last `tailLines` lines of each failed step (the whole log when no line names a step). */
export declare function stepTails(log: string, failedSteps: readonly string[]): {
    step: string;
    lines: string[];
}[];
/** Runner, image and tool-version lines of one job log. */
export declare function setupLines(log: string): string[];
/** The bundle, pure: no I/O. */
export declare function buildEvidence(input: EvidenceInput): EvidenceBundle;
export declare function bundleBytes(bundle: EvidenceBundle): number;
export declare const evidenceDir: (root: string, sig8: string) => string;
/** Write the bundle fresh (old files removed) and return each file's sha256. */
export declare function writeEvidence(root: string, bundle: EvidenceBundle): {
    dir: string;
    hashes: Record<string, string>;
};
/** Files whose content no longer matches its recorded hash (a lane or another process changed the bundle). */
export declare function changedEvidence(root: string, sig8: string, hashes: Readonly<Record<string, string>>): string[];
/**
 * Re-read the red run's failed jobs and logs (and the green run's same-named
 * jobs) through the heal exec guard, plus the commit subjects of the range.
 */
export declare function collectEvidence(exec: Exec, root: string, classification: HealClassification, ignoreJobs: readonly string[]): EvidenceInput;
//# sourceMappingURL=heal-evidence.d.ts.map