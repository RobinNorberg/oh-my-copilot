/**
 * `omg factory board [--source <spec> | --parent <spec>] [--limit n] [--no-check] [--json]`
 * (ADO parity design §1): a read-only, forge-neutral view across items. It
 * joins the `omg factory check` buckets (checkItems, the same rules), the
 * run state under `.omg/state/factory` (phase, gate, PR, head, lanes,
 * credits, integrity) and the tracker's live stage (GitHub progress labels,
 * ADO board column or state, reverse-mapped through factory.progress.stages).
 * Items with no run sit in `backlog`, sub-grouped by bucket; a run sits in
 * the column of its expected tracker stage (trackerStageOf). `--parent`
 * shows a spec's children (as `check --parent`), and a run parked at the
 * engine's blocked-by gate shows in `blocked` with the gate's reason. Runs
 * in flight whose key is not in the source (an explicit id, ci-heal) are
 * listed under `outside`.
 *
 * Everything goes through openReadForge: check's read guard with no marker,
 * so no tracker or forge write passes. The one local write: a stopped run
 * (cancelled, failed, parked) whose PR a human merged is recorded as merged
 * first (src/factory/run/human-merged.ts; runFactoryBoard only). `--no-check` skips the rules and reads the live stages with
 * one batched `tracker.peekItems` (Azure DevOps), or viewItem per item.
 *
 * Exit codes: 0 shown; 1 an item could not be read; 2 usage; 5 incompatible
 * (forge mismatch, unsupported remote, no intake source and no runs).
 */
import { type FactoryCheckDeps } from '../check/cli.js';
import { checkItems } from '../check/score.js';
import type { CheckBucket } from '../check/rules.js';
import { type Forge, type ForgeKind, type ProgressStage, type ResolvedForgeConfig } from '../../forge/types.js';
import { type FactoryPhase, type FactoryRunKey, type FactoryRunState } from '../run/state.js';
/** Bumped on any change to the `--json` shape (src/factory/board/__tests__ pins it). */
export declare const BOARD_JSON_SCHEMA_VERSION = 1;
/** A non-terminal run without a gate whose state has not changed for this long is likely lost (the watchdog's idea). */
export declare const BOARD_STALE_MS: number;
export type BoardFlag = 'drift' | 'unsynced' | 'seal' | 'stale';
export type BoardStage = 'backlog' | ProgressStage;
export interface BoardRow {
    id: FactoryRunKey;
    title: string;
    url: string;
    /** The read failure, when the item could not be read. */
    error?: string;
    /** Absent with --no-check. */
    check?: {
        bucket: CheckBucket;
        priority: number | null;
        reasons: string[];
        detail: string;
    };
    run?: {
        phase: FactoryPhase;
        gate?: {
            name: string;
            reason: string;
            detail?: string;
        };
        pr?: number;
        head?: string;
        lanes: number;
        /** The lane running now, if any. */
        runningLane?: string;
        /** The engine running the item now (its owner file held by a live process); absent when none runs. */
        live?: {
            pid: number;
            host: string;
            since: string;
            slot?: number;
        };
        credits: number;
        integrity: 'ok' | 'bad' | 'none';
        updatedAt: string;
        /** factory.run.layout "private": the run dir under the work root (absent = the shared layout). */
        privateDir?: string;
    };
    stage: {
        expected?: ProgressStage;
        recorded?: ProgressStage;
        live?: ProgressStage | 'unmapped';
    };
    /** The tracker's live value the stage was read from (ADO column or state, or the progress label). */
    liveText?: string;
    flags: BoardFlag[];
    /** The latest `omg ship` verdict recorded for the run's PR. */
    gates?: {
        verdict: string;
        sha: string;
        at: string;
    };
}
export interface BoardJson {
    schemaVersion: number;
    ok: boolean;
    forge: ForgeKind;
    /** What the forge cannot do (the local forge's offline lines); empty on GitHub and Azure DevOps. */
    limitations: string[];
    repo: string;
    source: Record<string, unknown> | null;
    /** With --parent: the spec whose children are shown. */
    parent: {
        id: number;
        title: string;
        url: string;
    } | null;
    columns: Array<{
        stage: BoardStage;
        title: string;
        items: BoardRow[];
    }>;
    /** Runs in flight whose key is not in the source. */
    outside: BoardRow[];
    warnings: string[];
}
export interface FactoryBoardOptions {
    source?: string;
    limit?: number;
    parent?: string;
    /** false with --no-check. */
    check?: boolean;
    json?: boolean;
}
/** check's deps plus the clock (stale). */
export type FactoryBoardDeps = Pick<FactoryCheckDeps, 'exec' | 'base' | 'trustedUser' | 'projectConfig' | 'createForge' | 'resolveAz' | 'out' | 'err'> & {
    now?: () => number;
    /** Engine ledger directory (default defaultLedgerDir()): a human merge is recorded only on a state that is the engine's last write. */
    ledgerDir?: string;
};
/** Every run state on disk; an unreadable one is a warning (and, for an item in the source, a `seal` flag). */
export declare function readRuns(root: string, warnings: string[]): {
    runs: Map<FactoryRunKey, FactoryRunState>;
    broken: Set<FactoryRunKey>;
};
/**
 * The stage the tracker shows now, reverse-mapped through the progress
 * stages: GitHub a progress label; ADO the board column, else the state.
 * When several stages match (ADO stages often share a state), the recorded
 * one wins, so an ambiguous mapping is never reported as drift.
 */
export declare function liveStage(kind: ForgeKind, stages: ResolvedForgeConfig['progress']['stages'], item: {
    labels: string[];
    column?: string;
    state: string;
}, recorded?: ProgressStage): {
    stage: ProgressStage | 'unmapped';
    text?: string;
};
export interface CollectBoardInput {
    forge: Forge;
    config: ResolvedForgeConfig;
    root: string;
    /** The source's (or the spec's children's) item ids. */
    ids: readonly number[];
    /** The check environment; null with --no-check. */
    check: Parameters<typeof checkItems>[2] | null;
    now: number;
    warnings: string[];
}
/**
 * F50 / M4: a run parked at the merge gate shows the PR's review state
 * now, not the clause the engine wrote at the park: a change request or open
 * trusted thread recorded since (a GitHub or Azure DevOps review, or
 * `omg factory pr review` on the local forge) replaces "no open trusted
 * threads or change requests" with a do-not-merge line. The same trusted
 * read the engine and `omg factory poll` use (ForgeReviews.reviewFeedback:
 * untrusted authors are already dropped); a forge without it keeps the text,
 * and so does --no-check off the local forge (no PR lookups).
 */
export declare function reviewNow(forge: Forge, s: FactoryRunState, row: BoardRow, warnings: string[]): void;
export declare function collectBoard(input: CollectBoardInput): Pick<BoardJson, 'columns' | 'outside'> & {
    readFailed: boolean;
};
/** Show one board; returns the exit code. Errors other than usage / incompatible propagate (exit 1 at the CLI). */
export declare function runFactoryBoard(o: FactoryBoardOptions, deps: FactoryBoardDeps): Promise<number>;
//# sourceMappingURL=collect.d.ts.map