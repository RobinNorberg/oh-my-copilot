/**
 * `omg release <version>`: the release as ordered, individually re-runnable
 * phases with gates, so a release is a script run and an agent is needed only
 * to triage a failure.
 *
 *   preflight  clean tree (release prose may be uncommitted), on release/v<v>
 *              containing origin/dev, version above dev's and npm's latest,
 *              gh authenticated, no .git/index.lock, tag not on origin
 *   bump       refuse without the CHANGELOG / release-body prose, then
 *              npm version + every version stamp + prompt projections
 *   build      npm run build, git add -f dist bridge, orphan + untracked
 *              checks, import / --version / MCP start probes
 *   gates      tsc, projections, copilot generators, multi-repo path gate,
 *              optional vitest suite (targeted, or full against a baseline)
 *   smoke      live Tier 2 smoke, only with --live-smoke
 *   commit     release commit, then the inventory regenerated LAST
 *   pr         push, PR to dev, CI gate (ship merge rule), admin merge
 *   promote    PR dev -> main, same gate, merge
 *   tag        annotated v<v> on main's merge commit, verified, pushed (--yes)
 *   verify     tag run green, npm version / latest / provenance, GitHub Release
 *
 * State: `<state root>/release/<version>.json` records each phase result,
 * the release branch and commit, and the PR merge commits; a run without
 * --from resumes at the first phase not yet ok. Before skipping a phase (a
 * resume or --from) its recorded postconditions are re-checked, and a state
 * recorded on another branch or an unrelated HEAD is refused unless --from
 * preflight. Every external command goes through one injectable runner (ReleaseExec).
 */
import { type LoadedShipConfig } from '../ship/config.js';
import { type Exec, type ExecOptions, type ExecResult } from '../ship/exec.js';
import type { ReleaseProgressInput } from './progress.js';
export declare const PHASES: readonly ["preflight", "bump", "build", "gates", "smoke", "commit", "pr", "promote", "tag", "verify"];
export type PhaseId = (typeof PHASES)[number];
export declare function isPhaseId(value: string): value is PhaseId;
export type PhaseStatus = 'ok' | 'skipped' | 'fail' | 'blocked';
export interface PhaseOutcome {
    status: PhaseStatus;
    note: string;
    details?: string[];
}
export interface PhaseRecord extends PhaseOutcome {
    at: string;
}
export interface ReleaseState {
    version: 1;
    release: string;
    createdAt: string;
    updatedAt: string;
    phases: Partial<Record<PhaseId, PhaseRecord>>;
    /** Branch preflight passed on. */
    branch?: string;
    /** HEAD after the commit phase; a resume needs HEAD to descend from it. */
    headSha?: string;
    devPr?: number;
    devMergeSha?: string;
    mainPr?: number;
    mainMergeSha?: string;
    tagRunId?: number;
    /** Run id -> automatic reruns spent (one per run). */
    reruns: Record<string, number>;
}
export type ReleaseExec = (cmd: string, args: string[], opts?: ExecOptions & {
    timeoutMs?: number;
}) => ExecResult;
/** Files the release prose lives in; uncommitted edits to them are folded into the release commit. */
export declare const PROSE_FILES: string[];
export declare const defaultReleaseExec: ReleaseExec;
/** The ship config for a PR's base (omg ship's loader: user config + the base's committed config). */
export type ReleaseShipConfigLoader = (ctx: {
    exec: Exec;
    root: string;
    base: string;
    baseSha?: string;
    repoUrl?: string;
}) => LoadedShipConfig;
export interface ReleaseOptions {
    version: string;
    from?: PhaseId;
    to?: PhaseId;
    dryRun?: boolean;
    /** Tag without the interactive confirmation. */
    yes?: boolean;
    suite?: 'none' | 'targeted' | 'full';
    /** Full-suite baseline: a vitest JSON report or one `<file> > <title>` per line. */
    baseline?: string;
    liveSmoke?: boolean;
    fixOrphans?: boolean;
    /** Total minutes the pr / promote / verify phases wait on CI per invocation. */
    timeoutMinutes?: number;
}
export interface ReleaseDeps {
    exec: ReleaseExec;
    /** Repo root (the release checkout). */
    root: string;
    /** `<state root>` (getOmcRoot): holds release/<version>.json. */
    stateRoot: string;
    /** Node binary for repo scripts and probes. */
    node: string;
    loadShipConfig: ReleaseShipConfigLoader;
    progress: (event: ReleaseProgressInput) => void;
    log: (line: string) => void;
    confirm: (question: string) => Promise<boolean>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
}
export interface ReleaseResult {
    ok: boolean;
    version: string;
    dryRun: boolean;
    statePath: string;
    phases: Array<{
        id: PhaseId;
        status: PhaseStatus | 'planned';
        note: string;
        details?: string[];
        steps?: string[];
    }>;
}
export declare function releaseStatePath(stateRoot: string, version: string): string;
export declare function readReleaseState(stateRoot: string, version: string): ReleaseState | null;
/** Steps each phase runs, as printed by --dry-run. */
export declare function phasePlan(id: PhaseId, v: string, opts: ReleaseOptions): string[];
/** First phase to run: --from, else the first phase not yet ok / skipped in the state (runRelease re-checks the skipped ones). */
export declare function resumePoint(state: ReleaseState | null, from?: PhaseId): PhaseId | null;
export declare function runRelease(deps: ReleaseDeps, opts: ReleaseOptions): Promise<ReleaseResult>;
//# sourceMappingURL=engine.d.ts.map