/**
 * `omg factory bench run`: drive the factory over the bench fixture until
 * every issue is terminal, parked or never runnable, or a cap is hit; then
 * score each issue (score.ts) and write `<out>/<timestamp>.json` + `.md`.
 *
 * - `--fake`: in-process. Each pick is omg factory check's order over the
 *   fixture backlog (the same rules `run --next` uses), each run is
 *   runFactoryEngine with the issue's scripted lanes (fake-lanes.ts), the
 *   engine's own state, ledger and forge state under the bench dir, no user
 *   config. Prepare checks, the local gate and the acceptance run as plain
 *   processes: every line of code in the fixture is the bench's own. Zero cost.
 * - `--live --max-requests N`: real Copilot. The bench picks like `run
 *   --next` (omg factory check's order, limited to `--issues`) and starts a
 *   child `omg factory run <id> --json --max-requests <left>` in the fixture
 *   repository (poll's auto-start child), so the user's own factory config,
 *   sandbox and lanes apply; with `--parallel N` up to N children at once
 *   (each takes a run slot: the user config must enable parallel runs). The
 *   per-run cap is HARD in the engine (budget.ts nextLaneCap): no lane starts
 *   once the run's lanes recorded the cap, or when a lane's usage is unknown.
 *   Usage is the largest of the fixture budget ledger's delta, the lanes in
 *   the run states and MIN_RUN_REQUESTS per finished run. The remaining bound:
 *   each run can finish the one lane in flight when it reaches its cap. A run
 *   in flight is never killed (on Windows a kill orphans its Copilot child).
 *   The acceptance runs in the gate sandbox (createSandboxRunner, no model
 *   turn); --live refuses unless the gate sandbox is enforced (or the
 *   container isolation is on).
 */
import type { ResolvedForgeConfig } from '../../forge/types.js';
import { type Exec } from '../../ship/exec.js';
import { type CheckResult } from '../check/score.js';
import { type PollAutoStart } from '../poll.js';
import { type SandboxRunner } from '../run/sandbox-exec.js';
import { type BenchFixtureMeta } from './fixture.js';
import { type BenchAcceptance, type BenchResults } from './score.js';
/** The fewest premium requests a run spends (an implement and a review lane): the headroom a live start needs. */
export declare const MIN_RUN_REQUESTS = 2;
export declare const DEFAULT_BENCH_MAX_MINUTES = 240;
/** How long one acceptance run may take. */
export declare const ACCEPTANCE_TIMEOUT_MS: number;
/** Busy children (exit 6: another engine holds the lock or every slot) in a row before the bench stops. */
export declare const MAX_BUSY_STREAK = 3;
/** The wait after a busy child, times the streak. */
export declare const BUSY_BACKOFF_MS = 5000;
/** The overshoot bound, in the results notes and the CLI help. */
export declare const LIVE_CAP_BOUND = "each run gets the requests left as its own hard cap (omg factory run --max-requests): it starts no lane once its lanes recorded that many, so the bench can end above --max-requests only by the one lane each run has in flight when it reaches its cap";
export declare class BenchUsageError extends Error {
}
export interface BenchRunOptions {
    /** The fixture dir (bench-fixture.json, made by omg factory bench init). */
    dir: string;
    mode: 'fake' | 'live';
    maxRequests?: number;
    maxCredits?: number;
    maxMinutes?: number;
    parallel?: number;
    /** Run only these issue ids (validated; recorded as the results' subset). */
    issues?: readonly number[];
    /** Where the results go (default `./bench-results`). */
    outDir?: string;
    log?: (message: string) => void;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    interrupted?: () => boolean;
    /** Live: the run child (default: poll's auto-start child of this CLI entry). */
    liveStart?: PollAutoStart;
    /** Live: usage recorded in the fixture's budget ledger (default: the ledger file; an unreadable ledger throws). */
    ledger?: (root: string) => {
        premiumRequests: number;
        credits: number;
    };
    /** The runner of the acceptance gate (default: fake plain processes; live the gate sandbox). */
    acceptanceRunner?: SandboxRunner;
    /** Live: the trusted user config (default: userConfigLayers().trustedUser). */
    trustedUser?: unknown;
    /** Live: subscribe the run children to the bench's stop signal (the CLI forwards Ctrl+C). */
    signals?: (forward: (signal: NodeJS.Signals) => void) => () => void;
}
export interface BenchRunOutput {
    results: BenchResults;
    jsonPath: string;
    markdownPath: string;
}
/**
 * The fake mode's gate runner: the command as a plain process (no shell,
 * the gate's scrubbed env), for every purpose. Only the bench's own fixture
 * code ever runs through it.
 */
export declare const plainGateRunner: SandboxRunner;
/** The fake mode's forge: the fixture's committed config only, its state under the bench dir. */
export declare function fakeForgeConfig(meta: BenchFixtureMeta, stateDir: string, exec?: Exec): ResolvedForgeConfig;
/** omg factory check's verdict on every bench item, at the base (the order run --next picks in). */
export declare function checkBacklog(exec: Exec, root: string, base: string, config: ResolvedForgeConfig): CheckResult[];
/** `--issues 2,9,10`: known bench ids, no repeats; null for every issue. */
export declare function benchSubset(ids: readonly number[] | undefined): number[] | null;
/** The CLI form of --issues: comma-separated ids. */
export declare function parseIssueList(raw: string): number[];
/**
 * `--live` runs the lanes' code in prepare checks, the local gate and the
 * acceptance: it needs the gate sandbox enforced (factory.run.sandbox.gates,
 * the user config then the fixture's base), or the container isolation of
 * the user config. Null when allowed, else why not.
 */
export declare function liveSandboxRefusal(trustedUser: unknown, base: unknown): string | null;
/** The number of `it(` / `test(` calls at a line start of a hidden test: the passes the acceptance must report. */
export declare const expectedTests: (test: string) => number;
/**
 * Run the issue's hidden test on a scratch clone of the PR head from the
 * mirror, through `runner`, with a harness-owned vitest config (the head's
 * vitest/vite config, setup files and aliases are never loaded) and the JSON
 * reporter: the run passes only with exit 0 and every expected test passed.
 * The clone checks out links as plain files (core.symlinks=false), and a
 * head that tracks node_modules, turns test/ into a link or a file, or
 * changes package.json `type` / `imports` is refused. Never throws.
 */
export declare function runAcceptance(o: {
    meta: BenchFixtureMeta;
    benchDir: string;
    mirror: string;
    branch: string;
    head: string;
    test: string;
    runner: SandboxRunner;
    exec?: Exec;
    timeoutMs?: number;
}): Promise<BenchAcceptance>;
export declare function runBench(o: BenchRunOptions): Promise<BenchRunOutput>;
//# sourceMappingURL=runner.d.ts.map