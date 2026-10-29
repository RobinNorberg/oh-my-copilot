/**
 * Persisted `omg factory run` state: `.omg/state/factory/run-<key>.json`,
 * where the key is the issue number, or `heal-<sig8>` for a `ci-heal` run
 * (self-healing CI design §5: the plan is the validated diagnosis),
 * written with the ship pattern (src/ship/state.ts): read-modify-write under
 * the file lock, atomic write, sha256 `integrity` seal re-checked before every
 * update. A single-runner owner file `run-<issue>.owner` keeps two engines off
 * one issue. The seal is an unkeyed sha256 that anyone can recompute, so it
 * only catches accidental edits; the engine's defence against a lane that
 * rewrites the file is its own record of the bytes it wrote (ledger.ts).
 *
 * Phases (design §3): intake -> plan -> implement -> publish -> review ->
 * (fix -> publish -> review)* -> prepare -> gates -> merge -> merged, with
 * conflict-fix (prepare's base merge conflicts) and ci-fix (a real check
 * failure) going back through publish -> review. `gate` set means
 * awaiting-human: the phase is kept, and the next `omg factory run <issue>`
 * clears the gate and re-evaluates that phase. merged, cancelled and failed
 * are terminal.
 */
import type { CopilotRunSandboxState } from '../../copilot-run/sandbox.js';
import type { ShipVerdict } from '../../ship/state.js';
import type { ForgeKind } from '../../forge/types.js';
export declare const FACTORY_PHASES: readonly ["intake", "plan", "implement", "publish", "review", "fix", "prepare", "conflict-fix", "gates", "ci-fix", "merge", "merged", "cancelled", "failed"];
export type FactoryPhase = (typeof FACTORY_PHASES)[number];
export declare const TERMINAL_FACTORY_PHASES: readonly FactoryPhase[];
/** `issue`: `omg factory run <issue>`; `ci-heal`: a self-heal run of one CI failure signature. */
export type FactoryRunKind = 'issue' | 'ci-heal';
/** An issue number, or `heal-<sig8>` for a ci-heal run (state, owner, ledger and checkout names). */
export type FactoryRunKey = number | `heal-${string}`;
export declare const HEAL_RUN_KEY: RegExp;
/** ci-heal human gates: a valid diagnosis waits for `omg factory heal approve`; an unusable one is human-only. */
export declare const HEAL_APPROVE_GATE = "heal-approve";
export declare const HEAL_DIAGNOSIS_GATE = "heal-diagnosis";
export declare function healRunKey(sig8: string): FactoryRunKey;
/** Every lane kind except review is a write lane, and each is also the phase that runs it. */
export type FactoryLaneKind = 'implement' | 'review' | 'fix' | 'conflict-fix' | 'ci-fix';
export type FactoryLaneStatus = 'running' | 'completed' | 'failed' | 'lost' | 'cancelled';
export type FactoryLaneVerdict = 'approve' | 'changes-requested' | 'invalid';
export interface FactoryLaneRecord {
    id: string;
    kind: FactoryLaneKind;
    jobId?: string;
    /** The job's local Copilot child (pid and start identity), recorded at the first poll that reports it. */
    process?: {
        pid: number;
        identity: string | null;
    };
    worktree?: string;
    startSha: string;
    endSha?: string;
    status: FactoryLaneStatus;
    /** The AI-credit cap the lane was started with. */
    maxCredits: number;
    /** AI Credits is the unit; premiumRequests is legacy, kept for older readers. */
    usage?: {
        credits: number;
        premiumRequests: number;
        source: 'measured' | 'estimated';
    };
    verdict?: FactoryLaneVerdict;
    /**
     * sha256 of the ship verdict the engine recorded from this lane
     * (shipVerdictHash), written before the ship state: a ship verdict is
     * adopted only when a review lane the engine ran carries its hash.
     */
    verdictHash?: string;
    /** The local job's OS sandbox as it ended (mode, host support, attestation; design §5); absent for remote lanes. */
    sandbox?: CopilotRunSandboxState;
    note?: string;
    startedAt: string;
    endedAt?: string;
}
export interface FactoryGate {
    name: string;
    reason: string;
    at: string;
}
export interface FactoryFinding {
    severity: 'blocker' | 'major' | 'minor' | 'nit';
    file?: string;
    line?: number;
    summary: string;
}
export interface FactoryCiFailure {
    source: 'prepare' | 'ci';
    /** The commit the ci-fix lane starts at (prepare's checkout HEAD, or the PR head). */
    startSha: string;
    /** Failed prepare step or failed check names. */
    checks: string[];
    /** Failing test titles (`file > title`) read from the failed jobs' logs. */
    tests: string[];
    /** The failed prepare step's output tail. */
    detail?: string;
}
export interface FactoryHistoryEntry {
    at: string;
    from: FactoryPhase | null;
    to: FactoryPhase;
    note: string;
}
/**
 * What a ci-heal run is built from, copied once at creation from the heal
 * signature state (whose out-of-repo seal the caller checked) and sealed
 * with the run. The diagnosis is lane output derived from untrusted CI logs:
 * only these validated fields reach a prompt or the PR body, always fenced.
 */
export interface FactoryHealRecord {
    sig8: string;
    /** The deterministic classifier's class. */
    class: string;
    firstRed: {
        runId: string;
        sha: string;
    };
    lastGreen?: {
        runId: string;
        sha: string;
    };
    /** `file > title` of the failing tests the classifier parsed. */
    failingTests: string[];
    env: Array<{
        field: string;
        green?: string;
        red?: string;
    }>;
    diagnosis: {
        class: string;
        rootCause: string;
        evidence: string[];
        reproduced: boolean;
        reproCommand?: string;
        fix: {
            summary: string;
            files: string[];
            acceptance: string[];
        } | null;
    };
    /** Set by the engine at the plan step: a human ran `omg factory heal approve`, or factory.heal.autoImplement applied. */
    approved?: {
        at: string;
        by: 'human' | 'auto-implement';
    };
}
export interface FactoryRunState {
    version: 1;
    /** Absent in states written before ci-heal runs existed: `issue`. */
    kind?: FactoryRunKind;
    /** The issue number; 0 for a ci-heal run, which has no issue. */
    issue: number;
    heal?: FactoryHealRecord;
    /**
     * The forge the run started on (critic amendments §A.9). Absent in states
     * written before forges existed, which ran on GitHub; optional, so their
     * integrity seal still verifies.
     */
    forgeKind?: ForgeKind;
    repoUrl: string;
    base: string;
    branch: string;
    phase: FactoryPhase;
    gate?: FactoryGate;
    /** Issue snapshot taken at intake (title and body feed the lane prompts). */
    issueTitle?: string;
    issueBody?: string;
    /** `omg-plan: <repo path>` from the issue body, else the newest comment carrying one. */
    planLink?: string;
    plan?: {
        source: 'link' | 'issue-body' | 'heal-diagnosis';
        path?: string;
        blob?: string;
        text: string;
    };
    /** origin/<base> the implement lane started at. */
    baseSha?: string;
    pr?: number;
    implementer: string;
    /** Last head the engine pushed. */
    head?: string;
    /** A write lane's head waiting for publish. */
    pendingHead?: string;
    /** The last review's findings, fed to the next fix lane. */
    findings?: FactoryFinding[];
    /** Prepare's base merge conflicted outside inventory/: the files, fed to the conflict-fix lane. */
    conflicts?: string[];
    /** What the next ci-fix lane fixes: a prepare check or CI checks on the head. */
    ciFailure?: FactoryCiFailure;
    /** A prepare pushed `head` with these housekeeping commits; ship records them before gates. */
    prepared?: {
        head: string;
        housekeeping: string[];
    };
    /** merge -> gates returns so far; the cap holds across reruns. */
    mergeBounces?: number;
    /** The engine-owned prepare checkout's HEAD when the engine last left it. */
    checkoutHead?: string;
    /** Human-gate comments already posted (`<gate>@<sha12>` per target), so a rerun does not repeat them. */
    gateComments?: string[];
    lanes: FactoryLaneRecord[];
    /** Lane failures retried per phase key (`implement`, `review@<sha12>`, `fix@<round>`). */
    retries: Record<string, number>;
    /** Consecutive lost lanes per kind (a completed lane resets it). */
    lostStreak: Partial<Record<FactoryLaneKind, number>>;
    /** Wall time the engine spent on this run, across invocations. */
    elapsedMs: number;
    ciFixRounds: number;
    cancelRequested?: boolean;
    history: FactoryHistoryEntry[];
    createdAt: string;
    updatedAt: string;
    integrity?: string;
}
export declare class FactoryStateError extends Error {
    constructor(message: string);
}
/** The run's key: its issue number, or `heal-<sig8>` for a ci-heal run. */
export declare function runKeyOf(s: Pick<FactoryRunState, 'kind' | 'issue' | 'heal'>): FactoryRunKey;
/** `issue-7` or `heal-0123abcd`: the prefix of lane ids and the prepare checkout's worker name. */
export declare const runSlug: (key: FactoryRunKey) => string;
/** `#7` or `heal-0123abcd`, for messages. */
export declare const runLabel: (key: FactoryRunKey) => string;
export declare function implementerName(key: FactoryRunKey): string;
export declare function reviewerName(key: FactoryRunKey, jobId: string): string;
export declare function factoryBranch(key: FactoryRunKey): string;
export declare function factoryStateDir(root: string): string;
export declare function factoryStatePath(root: string, key: FactoryRunKey): string;
export declare function factoryOwnerPath(root: string, key: FactoryRunKey): string;
/** `omg factory run cancel` and `omg factory heal cancel` drop this file; the engine alone writes the state file. */
export declare function factoryCancelPath(root: string, key: FactoryRunKey): string;
export declare function factoryCancelRequested(root: string, key: FactoryRunKey): boolean;
/** The hash a review lane record keeps of the ship verdict the engine recorded from it. */
export declare function shipVerdictHash(v: Pick<ShipVerdict, 'reviewer' | 'verdict' | 'sha' | 'at' | 'notes'>): string;
export declare function createFactoryState(input: {
    issue: number;
    repoUrl: string;
    base: string;
    heal?: FactoryHealRecord;
}, now: string): FactoryRunState;
/** Move to `to` (clearing any gate), appending history. Terminal phases never move. */
export declare function moveTo(state: FactoryRunState, to: FactoryPhase, note: string, now: string): FactoryRunState;
/** Park at a named human gate; the phase stays so a rerun re-evaluates it. */
export declare function setGate(state: FactoryRunState, name: string, reason: string, now: string): FactoryRunState;
export declare function computeFactoryIntegrity(state: FactoryRunState): string;
export declare function verifyFactoryIntegrity(state: FactoryRunState): boolean;
/**
 * Why a resume must refuse, or null (critic amendments §A.9): a config change
 * cannot swap adapters mid-run. A state without forgeKind ran on GitHub.
 * With `resolvedRepoUrl` (the forge config's repository), a run whose
 * recorded repoUrl names another repository (repoIdentity) refuses too.
 */
export declare function forgeResumeProblem(state: Pick<FactoryRunState, 'forgeKind' | 'issue' | 'kind' | 'heal' | 'repoUrl'>, resolved: ForgeKind, resolvedRepoUrl?: string): string | null;
/** Read and shape-check the state file; throws FactoryStateError on malformed content. */
export declare function readFactoryState(root: string, key: FactoryRunKey): FactoryRunState | null;
/** Parse and shape-check the bytes of a state file (read once by the caller). */
export declare function parseFactoryState(path: string, key: FactoryRunKey, raw: string): FactoryRunState;
/**
 * Read-modify-write under the state file's lock; the result is sealed. A
 * stored state failing its integrity check is refused (the run is `failed`
 * for the engine; a human replaces the file).
 */
export declare function updateFactoryState(root: string, key: FactoryRunKey, mutate: (current: FactoryRunState | null) => FactoryRunState, options?: {
    onWrite?: (path: string, content: string) => void;
    /**
     * Called under the lock with the exact bytes read (null: no file); throw
     * to refuse. `mutate` gets the state parsed from these same bytes, never
     * from a second read (the engine compares them with its ledger).
     */
    verify?: (bytes: Buffer | null) => void;
}): FactoryRunState;
/**
 * Seal and write `state` without the lock and without reading the file: the
 * engine's park at state-tampered, which must not depend on the current
 * bytes (or a lock file) that an unconfirmed lane may still be rewriting.
 */
export declare function overwriteFactoryState(root: string, key: FactoryRunKey, state: FactoryRunState): {
    sealed: FactoryRunState;
    content: string;
};
/**
 * `omg factory run cancel`: drop the cancel request file next to the state.
 * The state file stays engine-only (the engine ledger flags any other
 * writer); the returned state shows the request.
 */
export declare function requestFactoryCancel(root: string, key: FactoryRunKey, now: string): FactoryRunState;
export interface FactoryOwner {
    pid: number;
    hostname: string;
    startedAt: string;
}
export interface OwnerDeps {
    pid: number;
    hostname: string;
    isAlive: (pid: number) => boolean;
}
export declare const defaultOwnerDeps: () => OwnerDeps;
/**
 * Claim the single-runner owner file. A live owner (or one on another host,
 * whose pid cannot be checked) refuses; a dead pid on this host is taken
 * over, and `tookOver` names it for the history.
 */
export declare function acquireFactoryOwner(root: string, key: FactoryRunKey, now: string, deps?: OwnerDeps): {
    release: () => void;
    tookOver?: FactoryOwner;
};
//# sourceMappingURL=state.d.ts.map