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
 * - `--live --max-requests N`: real Copilot. Each run is a child `omg
 *   factory run --next --json` in the fixture repository (poll's auto-start
 *   child), so the user's own factory config, sandbox and lanes apply; with
 *   `--parallel N` up to N children at once (each takes a run slot: the
 *   user config must enable parallel runs, as for `omg factory run
 *   --parallel`). Before each start the budget ledger of the fixture
 *   (`<repo>/.omg/state/budget-ledger.json`) is read: no run starts unless
 *   the premium requests used since the bench started leave room for one
 *   more run (MIN_RUN_REQUESTS per run already in flight). A run in flight
 *   is never killed, so the overshoot is bounded by the in-flight runs'
 *   own lane caps (factory.run limits). The acceptance runs in the gate
 *   sandbox (createSandboxRunner, no model turn).
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
    /** Where the results go (default `./bench-results`). */
    outDir?: string;
    log?: (message: string) => void;
    now?: () => Date;
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
/** Run the issue's hidden test (ACCEPTANCE_ARGV) on a scratch clone of the PR head from the mirror, through `runner`. */
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