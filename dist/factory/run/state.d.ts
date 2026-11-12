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
import { type ForgeKind, type ProgressStage } from '../../forge/types.js';
import { LOCAL_REMOTE } from '../../forge/local/mirror.js';
import { type CodingAgentRunRecord } from './coding-agent-lane.js';
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
/** Every lane kind except review is a write lane. Each but coding-agent is also the phase that runs it; a coding-agent lane runs in the implement phase. */
export type FactoryLaneKind = 'implement' | 'review' | 'fix' | 'conflict-fix' | 'ci-fix' | 'coding-agent';
/** `stalled`: the engine cancelled a lane whose session went quiet past factory.run.laneIdleMinutes (a failed lane). */
export type FactoryLaneStatus = 'running' | 'completed' | 'failed' | 'stalled' | 'lost' | 'cancelled';
export type FactoryLaneVerdict = 'approve' | 'changes-requested' | 'invalid';
export interface FactoryLaneRecord {
    id: string;
    kind: FactoryLaneKind;
    /** The ledger tag source (budget records); absent = `kind`. */
    role?: FactoryLaneKind;
    /** A fix lane started from human review feedback: the forge it came from and how many items it carried. */
    feedback?: {
        source: 'human';
        forge: ForgeKind;
        items: number;
    };
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
    /**
     * Whether the lane's stop is unconfirmed (its Copilot child may still run in
     * its worktree): true when the engine could not confirm it, false once the
     * engine or a human (`--lane-stopped`) confirmed it. Absent (older states,
     * other paths): run clean / reset read the note.
     */
    stopUnconfirmed?: boolean;
    /** The session's last event the engine saw (ISO, refreshed at most once a minute); status and park text name it. */
    lastEventAt?: string;
    startedAt: string;
    endedAt?: string;
}
export interface FactoryGate {
    name: string;
    reason: string;
    at: string;
    /**
     * gate-definition-changed only: the sha256 of the parked head's gate
     * definition, the one definition `--allow-gate-change` may accept.
     */
    definition?: string;
    /**
     * H1 (review-490): output of the PR's own code for this park (the failing
     * tests, a redacted and bounded output tail, a link target it chose).
     * Local only: run status, the board and the CLI show it; the issue
     * comment, PR notes, outcome posts and every other forge write never read
     * it (they get `reason`), because the PR's code chooses what it prints.
     */
    detail?: string;
}
export interface FactoryFinding {
    severity: 'blocker' | 'major' | 'minor' | 'nit';
    /** The review axis of a two-axis review (the base has docs/standards/). */
    axis?: 'spec' | 'standards';
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
    /** The output tail: the failed prepare step's, or the local gate's (F43). */
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
    /**
     * The git remote the run fetches from and pushes to. Absent = `origin`
     * (every GitHub and Azure DevOps run, and states written before the local
     * forge, whose seal still verifies); `omg-local` = the local forge's
     * engine-owned bare mirror. Sealed at creation, never changed.
     */
    remote?: typeof LOCAL_REMOTE;
    /**
     * The local forge only: the factory.forge.local.gate argv this run first
     * ran its gate with. Every later gate run must find the same argv in the
     * trusted config (local-gate.ts assertLocalGateCommand); absent until then.
     */
    localGate?: string[];
    /**
     * The local forge only: the sha256 of the gate definition (local-gate.ts
     * gateDefinition) a human accepted with `omg factory run
     * --allow-gate-change` after the run parked at gate-definition-changed on
     * it. A head whose definition hashes to it is not parked again; any other
     * change is.
     */
    gateChangeApproved?: string;
    /**
     * The trusted ship.prepare.checks this run first prepared with (`auto` =
     * unset, the built-ins the base has). Every later prepare must resolve the
     * same value; a change mid-run parks at prepare-checks. Absent until then.
     */
    prepareChecks?: string[][] | 'auto';
    /**
     * The trusted ship.prepare.build this run first prepared with (`none` =
     * unset), sealed like prepareChecks: a change mid-run parks at
     * prepare-checks, and the merge rule accepts only these outputs.
     */
    prepareBuild?: {
        command: string[];
        outputs: string[];
    } | 'none';
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
    /** The checkout head a prepare left after the PR's code ran in the OS sandbox there (a local gate start failure on it parks at gate-no-verdict). */
    sandboxedPrepareHead?: string;
    /** The head the local gate last ran on in the OS sandbox (the command was handed over): a later gate start failure on it parks at gate-no-verdict. Optional: older state files lack it. */
    sandboxedGateHead?: string;
    /** The head a check last ran on WITHOUT any sandbox through the Windows git-transport fallback: such a run is never auto-merged. */
    gitTransportPlainHead?: string;
    /**
     * The name of the prepare checkout's admin dir under `<common>/worktrees/`,
     * as `worktree add` made it: a later invocation reads the checkout only
     * through that admin dir, never another one its `.git` file names.
     */
    checkoutAdmin?: string;
    /**
     * The last human feedback round consumed (sealed with the rest of the
     * state): when, at which head, the digest of what the fix lane got, and
     * the ids of the threads handed to it (at most MAX_HUMAN_THREAD_IDS).
     */
    humanReview?: {
        seenAt: string;
        head: string;
        digest: string;
        threadIds: string[];
    };
    /**
     * The head at which the human accepted, with `omg factory run
     * --allow-unsandboxed-lanes`, that write lanes ran without the enforced
     * sandbox (460-7); a new head parks again.
     */
    unsandboxedAck?: string;
    /**
     * The head whose prepare checks and local gate the human accepted to run
     * WITHOUT the OS sandbox (`omg factory run --allow-unsandboxed-gates` after
     * an awaiting-human: gates-unsandboxed park; factory.run.sandbox.gates
     * "ack", or "enforced" where the sandbox is unavailable). A prepare that
     * ran under it carries it to the head it prepared; any other head parks again.
     */
    unsandboxedGatesAck?: string;
    /**
     * A write lane's work the engine has not committed yet because its commit
     * parked (audit H3/L3): secret-shaped content (`secretFindings`), or a lane
     * process that survived the kill. The rerun after that park retries the
     * commit of the same worktree (no new lane is billed). `secretAck`: the
     * (path, kind) pairs the human accepted with `--allow-secret-shapes` for
     * THIS lane commit only; a new pair parks again.
     */
    pendingCommit?: FactoryPendingCommit;
    /**
     * Base calibrations of a check in the sandbox (sandbox-exec.ts), keyed by
     * the sha256 of the base sha and the check's argv: whether the command
     * passes in the sandbox on the trusted base itself, and its output tail.
     */
    gateCalibration?: Record<string, {
        ok: boolean;
        tail?: string;
        gitTransport?: true;
    }>;
    /** The Copilot coding agent session of an issue run whose implementer is the agent (coding-agent-lane.ts); sealed, shape-checked on load. */
    codingAgent?: CodingAgentRunRecord;
    /** Human-gate comments already posted (`<gate>@<sha12>` per target), so a rerun does not repeat them. */
    gateComments?: string[];
    /**
     * factory.run.layout "private" (item 2, private-run.ts): set once, when the
     * implement step sealed the base and created the run's private repository;
     * absent = the shared layout (layout 1, every run before it). A run keeps
     * the layout it started with: a resume never switches it.
     */
    layout?: 2;
    /** A private-layout run's dir `<work>/<repo8>/<slug>` (private-store.ts privateRunLayout). */
    privateDir?: string;
    /**
     * The engine's record of the private repository (sealed): the user
     * repository's common git dir resolved at run start, the config hash after
     * the engine's last own config write, the longest tracked path at the base,
     * and the number of the next import (refs/omg-import/<slug>/<n>).
     */
    privateStore?: {
        userGitDir: string;
        configHash: string;
        longestPath: number;
        nextImport: number;
    };
    /**
     * The parents of `pendingHead` as the engine committed it (private layout:
     * the import's expectedParents, never read from the commit). Set and
     * cleared with pendingHead.
     */
    pendingParents?: string[];
    /**
     * The progress stage last written to the tracker (factory forges design §7);
     * absent until the first write succeeds, and in states written before
     * progress sync existed (optional, so their seal still verifies).
     */
    trackerStage?: ProgressStage;
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
/** Exit code of a run that did not start: another engine holds this checkout, the item's run or its claim (FactoryBusyError). */
export declare const EXIT_BUSY = 6;
/**
 * A live owner holds what the caller tried to claim: another engine in this
 * checkout, the item's own run, or the item's claim from another clone.
 * `omg factory run` exits EXIT_BUSY for it; nothing was touched.
 */
export interface FactoryPendingCommit {
    laneId: string;
    /** The phase retry key of the lane (implement, fix@<n>, ...). */
    key: string;
    start: string;
    parents: string[];
    worktree: string;
    branch: string | null;
    message: string;
    secretFindings?: {
        path: string;
        kind: string;
    }[];
    secretAck?: {
        path: string;
        kind: string;
    }[];
}
export declare class FactoryBusyError extends FactoryStateError {
    /** The holder's run key when a live owner file refused (`scan`: the poller's heal scan or base sync, or a read command's fetch). */
    readonly holderRun?: string;
    constructor(message: string, holderRun?: string);
}
/** A tamper hold is set on the checkout (tamper-quarantine.ts): busy (exit 6) until `omg factory run release --tamper`. */
export declare class FactoryTamperHoldError extends FactoryBusyError {
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
/** One engine (issue or ci-heal run) at a time per repository: its lanes and checkouts share the repo's git state. */
export declare function factoryRepoOwnerPath(root: string): string;
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
    remote?: typeof LOCAL_REMOTE;
    itemNoun?: string;
}, now: string): FactoryRunState;
/** Move to `to` (clearing any gate), appending history. Terminal phases never move. */
export declare function moveTo(state: FactoryRunState, to: FactoryPhase, note: string, now: string): FactoryRunState;
/** Park at a named human gate; the phase stays so a rerun re-evaluates it. */
export declare function setGate(state: FactoryRunState, name: string, reason: string, now: string, extra?: Pick<FactoryGate, 'definition' | 'detail'>): FactoryRunState;
/**
 * The tracker progress stage of a run (factory forges design §7): a merge
 * gate or the merge phase is ready-to-merge, any other gate and failed are
 * blocked.
 */
export declare function trackerStageOf(s: Pick<FactoryRunState, 'phase' | 'gate'>): ProgressStage;
export declare function computeFactoryIntegrity(state: FactoryRunState): string;
export declare function verifyFactoryIntegrity(state: FactoryRunState): boolean;
/**
 * Why a resume must refuse, or null (critic amendments §A.9): a config change
 * cannot swap adapters mid-run. A state without forgeKind ran on GitHub.
 * With `resolvedRepoUrl` (the forge config's repository), a run whose
 * recorded repoUrl names another repository (repoIdentity) refuses too.
 */
export declare function forgeResumeProblem(state: Pick<FactoryRunState, 'forgeKind' | 'issue' | 'kind' | 'heal' | 'repoUrl'>, resolved: ForgeKind, resolvedRepoUrl?: string): string | null;
/** The git remote of a run: `origin` unless the state seals the local forge's `omg-local`. */
export declare function runRemote(state: Pick<FactoryRunState, 'remote'>): string;
/** The bound of FactoryGate.detail (the engine writes at most about 3 KB). */
export declare const GATE_DETAIL_MAX_CHARS = 4000;
/** Thread ids one human round may record: 100 review threads and 50 review bodies fit. */
export declare const MAX_HUMAN_THREAD_IDS = 200;
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
    /** The run key (the repository owner file and a claim). */
    run?: string;
    /** The checkout the engine runs in (a claim only: it may be another clone). */
    root?: string;
    /** The owner process's start identity (getProcessStartIdentitySync) when it could be read: a reused pid does not hold the file. */
    identity?: string;
}
export interface OwnerDeps {
    pid: number;
    hostname: string;
    isAlive: (pid: number) => boolean;
    /** The start identity of a pid on this host (null: unknown). Absent: identities are neither written nor compared. */
    identityOf?: (pid: number) => string | null;
}
export declare const defaultOwnerDeps: () => OwnerDeps;
/** Owner and claim file text is data: no terminal escape or control character reaches the terminal. */
export declare const ownerText: (v: unknown) => string;
/** `<run>, pid <pid> on <host> since <time>[ in <root>]`, every field through ownerText. */
export declare function describeOwner(o: Partial<FactoryOwner>): string;
/**
 * A held owner file: release() removes it while it is still this process's
 * (false: the release failed, a warning naming the lock was printed, and the
 * file stays until a retry or until this process exits); relabel() rewrites
 * its run field (`run --next` once it picked an item).
 */
export interface HeldOwner {
    release: () => boolean;
    relabel: (run: string) => void;
    tookOver?: FactoryOwner;
}
/** tryScanLock's hold: `importLock` when it also took the import lock (a slot was held); pass it to withRepoImportLock's `held`. */
export interface ScanHold extends HeldOwner {
    importLock?: HeldOwner;
}
/**
 * Claim the single-runner owner file. A live owner (or one on another host,
 * whose pid cannot be checked) refuses; a dead pid on this host is taken
 * over, and `tookOver` names it for the history.
 */
export declare function acquireFactoryOwner(root: string, key: FactoryRunKey, now: string, deps?: OwnerDeps): HeldOwner;
/**
 * Claim the repository's engine owner file (factoryRepoOwnerPath) for `key`
 * like acquireFactoryOwner: a second engine on the same repository refuses
 * instead of tripping the first one's shared git state checks. `next`:
 * `omg factory run --next` before it picked an item (then relabel()).
 * `scan`: a step that fetches or moves refs without starting a run (the
 * poller's heal tick and local base sync, `omg factory heal scan`).
 */
export declare function acquireFactoryRepoOwner(root: string, key: FactoryRunKey | 'next' | 'scan', now: string, deps?: OwnerDeps): HeldOwner;
/** The slot owner files of private-layout parallel runs (factory.run.maxConcurrent). */
export declare function factorySlotsDir(root: string): string;
export declare function factorySlotPath(root: string, slot: number): string;
/** The repository import lock (an owner record): held only around git transport into or out of your repository. */
export declare function factoryImportLockPath(root: string): string;
/** One slot file a live (or unreadable) holder has: unreadable counts as held. */
export interface HeldSlotView {
    slot: number;
    path: string;
    owner: FactoryOwner | 'unreadable';
}
/** Every slot file a live holder holds or nobody can read, whatever maxConcurrent is now (a lowered value never hides a live run). */
export declare function heldSlots(root: string, deps?: OwnerDeps): HeldSlotView[];
/** A held slot: the owner file of slot `slot`. */
export interface HeldSlot extends HeldOwner {
    slot: number;
}
/**
 * Take one of `max` slots for `key` (claimOwner records: identity, takeover
 * of a dead holder, unreadable = held), then make sure no shared-layout
 * engine holds this checkout's engine lock: a `scan` holder is waited out
 * for at most `scanWaitMs`; any other live holder (or an unreadable file)
 * gives the slot back and is busy. No free slot: FactoryBusyError (exit 6)
 * "N runs active (maxConcurrent N)" with the holders.
 */
export declare function acquireRunSlot(root: string, key: FactoryRunKey | 'next', max: number, now: () => string, deps?: OwnerDeps, scanWaitMs?: number): HeldSlot;
/** How long an engine waits for another engine's import, fetch or push (sized for a first seed fetch or a slow push of a big repository). */
export declare const IMPORT_LOCK_WAIT_MS: number;
/** How long a scan holder (poll, read commands, clean of a private run) waits for an import in flight. */
export declare const IMPORT_LOCK_SCAN_WAIT_MS = 60000;
/** The busy error of the import lock: the holder and how long it waited; FactoryBusyError.holderRun is `import`. */
export declare class ImportLockBusyError extends FactoryBusyError {
    constructor(message: string);
}
/**
 * Take the repository import lock (factoryImportLockPath) for `label`
 * (`import:<key>`, `scan`): a claimOwner record, so a holder whose process
 * is gone (pid dead, or reused: start identity) is taken over at once and a
 * live holder is never taken over, however long it holds (no age rule: a
 * slow push or a first seed fetch of a big repository keeps it). A live
 * holder is waited for at most `waitMs`, then ImportLockBusyError; an
 * unreadable file is busy at once (a human removes it: omg factory run release).
 */
export declare function acquireImportLock(root: string, label: string, now: () => string, deps?: OwnerDeps, waitMs?: number): HeldOwner;
/**
 * Run `fn` (synchronous: it is never held across an await, so never across
 * a lane or a gate) under the repository import lock (acquireImportLock).
 * Re-entrant inside the synchronous call of an outer withRepoImportLock of
 * this process only. `held`: the caller already holds the lock (a scan
 * hold, an awaited acquireImportLockAsync); `fn` runs inside it and the
 * caller releases it (review-487 L-4: no process-wide flag across awaits).
 */
export declare function withRepoImportLock<T>(root: string, label: string, fn: () => T, o?: {
    deps?: OwnerDeps;
    waitMs?: number;
    now?: () => string;
    held?: HeldOwner;
}): T;
/**
 * withRepoImportLock whose wait never blocks the event loop (review-487
 * M-3): while another process holds the lock, the holder is re-read every
 * SCAN_POLL_MS between awaited sleeps, so SIGINT, SIGTERM and a supervisor's
 * forwarded stop run meanwhile. The successful claim, the synchronous `fn`
 * and the release run in one synchronous turn: the lock is never held across
 * an await. `stopped`: read between polls; true ends the wait with
 * ImportLockBusyError (nothing ran under the lock; a rerun continues).
 */
export declare function withRepoImportLockAsync<T>(root: string, label: string, fn: () => T, o?: {
    deps?: OwnerDeps;
    waitMs?: number;
    now?: () => string;
    stopped?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
}): Promise<T>;
/** How long an engine-side start (run, heal run/approve/cancel, run reset, run clean, the poller's auto-start) waits for a `scan` holder before it is busy. */
export declare const SCAN_WAIT_MS = 60000;
/** The poller's auto-start blocks the event loop while it waits, so it waits only this long for a `scan` holder. */
export declare const AUTO_START_SCAN_WAIT_MS = 5000;
/** How long a read command waits for another `scan` holder before it reads without fetching. */
export declare const READ_SCAN_WAIT_MS = 10000;
/** The holder is re-read this often while it is `scan`. */
export declare const SCAN_POLL_MS = 500;
/** The scan wait's sleep and clock; tests replace them (vi.spyOn). */
export declare const scanWait: {
    sleep: (ms: number) => void;
    clock: () => number;
};
/**
 * acquireFactoryRepoOwner that waits out a `scan` holder (the poller's heal
 * scan or base sync, or a read command's fetch): the holder is re-read every
 * SCAN_POLL_MS for at most `boundMs`, then the scan busy error (exit 6). Any
 * other holder is busy at once.
 */
export declare function acquireFactoryRepoOwnerForRun(root: string, key: FactoryRunKey | 'next' | 'scan', now: () => string, deps?: OwnerDeps, boundMs?: number): HeldOwner;
/**
 * The checkout's engine lock under key `scan`, for a step that fetches or
 * moves refs without starting a run (the poller's heal tick and base sync,
 * the read commands' base fetch, heal dry runs): the held lock, or the
 * FactoryBusyError when an engine holds the checkout (`waitMs`: a `scan`
 * holder is waited out that long first). Any other error (EACCES on the
 * state dir, ...) throws: it is not "busy".
 */
export declare function tryScanLock(root: string, now: string, deps?: OwnerDeps, waitMs?: number): ScanHold | FactoryBusyError;
/**
 * True when the engine lock of `root` was taken from another folder (its
 * recorded `root`): that folder resolves to this checkout's state root (a
 * linked worktree, or with OMC_STATE_DIR set a clone with the same folder
 * name and origin), so the two cannot run in parallel.
 */
export declare function ownerFromOtherCheckout(prior: Pick<FactoryOwner, 'root'>, root: string, platform?: NodeJS.Platform): boolean;
/** The one rule for an owner or claim file that does not parse: it is held (never taken over, never "not busy") until a human removes it. */
export declare const unreadableOwnerMessage: (path: string, release?: string) => string;
/**
 * Throws FactoryBusyError while the checkout's engine lock is held: a live
 * engine, or an unreadable lock file. Read-only; acquireFactoryRepoOwner
 * stays the binding check.
 */
export declare function refuseWhileEngineRuns(root: string, deps?: OwnerDeps): void;
/**
 * Whether `owner` holds its file against `deps`, as claimOwner decides:
 * another host, or another live pid here whose start identity (when both
 * sides know it) is still the recorded one, so a reused pid does not hold it.
 */
export declare function ownerHolds(owner: Pick<FactoryOwner, 'pid' | 'hostname' | 'identity'>, deps: OwnerDeps): boolean;
/** A parsed owner file with the fields every holder check reads. */
export declare const isOwnerRecord: (v: unknown) => v is FactoryOwner;
/** This process's owner record, with its start identity when deps can read it. */
export declare function ownerRecord(now: string, deps: OwnerDeps, fields?: Pick<FactoryOwner, 'run' | 'root'>): FactoryOwner;
/**
 * The owner holding the file at `path` (read-only; claimOwner stays the
 * binding check): null when there is none or it is taken over by the next
 * claim, `unreadable` when the file cannot be parsed, which every caller
 * treats as held (unreadableOwnerMessage).
 */
export declare function ownerHolding(path: string, deps?: OwnerDeps): FactoryOwner | 'unreadable' | null;
/**
 * Run `fn` under the file lock of an owner or claim file. A contender that
 * cannot take that lock in time (another engine holds it, maybe while it
 * reads a start identity) is busy (FactoryBusyError, exit 6), not an error.
 */
export declare function withOwnerFileLock<T>(path: string, fn: () => T): T;
/**
 * Why an owner or claim file's lock could not be taken. An omg factory
 * process holds it for milliseconds, so a directory at the lock path, or a
 * lock file older than file-lock's stale age (its pid alive: maybe reused by
 * an unrelated program), is stuck: it never goes stale, and the message
 * names the path to remove. A younger one is transient.
 */
export declare function lockBusyMessage(lock: string, nowMs?: number): string;
/**
 * Claim an owner file: a live owner (or one on another host, whose pid
 * cannot be checked) refuses with a FactoryBusyError, and so does a file
 * that does not parse (unreadableOwnerMessage); a dead pid on this host is
 * taken over, and `tookOver` names it.
 */
export declare function claimOwner(path: string, now: string, deps: OwnerDeps, busy: (prior: FactoryOwner) => string, fields?: Pick<FactoryOwner, 'run' | 'root'>): HeldOwner;
//# sourceMappingURL=state.d.ts.map