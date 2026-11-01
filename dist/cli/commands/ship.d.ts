/**
 * `omg ship` — deterministic half of the ship workflow (skill
 * `/ship` drives the agent lanes):
 *   init     start a run for a PR and name the implementer lane
 *   verdict  record an independent reviewer/verifier verdict
 *   prepare  merge the base in, run checks, regenerate the inventory last
 *   gates    apply the merge rule to `gh pr checks` (optionally watch)
 *   merge    refuse unless gates are green and an independent approval
 *            covers the head, and the PR touches no merge-rule file;
 *            admin-merge only with ship.allowAdminMerge (no CLI override)
 *   status   print the persisted run state
 *
 * The safety keys (allowAdminMerge, advisoryChecks, requiredChecks,
 * knownFlakyFile) come from the user config at its default location or the
 * `.copilot/omg.jsonc` committed on a trusted base (ship.trustedBases) at
 * the sha GitHub reports, never the working tree (loadTrustedShipConfig).
 * The base, base sha and head sha always come from GitHub, not the state.
 *
 * Owner-only escape hatch (OMG_SHIP_HUMAN=1, which lane briefs forbid):
 * `init --force` over a blocked or merged run, a state that fails its
 * integrity check, or a run with verdicts under a new implementer / reset
 * fix-round budget; `merge` of a PR touching `.copilot/omg.jsonc`,
 * `.github/known-flaky-tests.json` or `.github/workflows/`.
 *
 * Trust note: OMG_SHIP_HUMAN, the --implementer / --reviewer names and every
 * other environment input are advisory against a hostile lane. A process
 * that controls this command's environment can set OMG_SHIP_HUMAN=1, name
 * any reviewer, or put another `git` / `gh` first on PATH. The engine scrubs
 * the git / gh variables that redirect its commands (scrubShipEnv), reads
 * the user config's safety keys from the OS-reported home only, and checks
 * the remote URL and the base sha against GitHub, but it guards against lanes that follow their
 * briefs or slip, not against one that rewrites its own environment.
 *
 * Exit codes: 0 ok / green / ready, 1 refused or failed, 2 usage error,
 * 8 gates still pending (re-run to keep watching; `gates --drive` never
 * exits 8: it watches up to --drive-max hours, see src/release/drive.ts).
 */
import { Command } from 'commander';
import { type LoadedShipConfig } from '../../ship/config.js';
import { type Exec } from '../../ship/exec.js';
import { type GateReport } from '../../ship/gates.js';
import { type DriveProcess, type DriveSpawn } from '../../release/drive.js';
export declare const EXIT_PENDING = 8;
export interface ShipConfigContext {
    exec: Exec;
    root: string;
    /** The PR's base branch on GitHub: its committed `.copilot/omg.jsonc` is the trusted project layer. */
    base: string;
    /** GitHub's base sha (baseRefOid); the fetched base must equal it before its files are read. */
    baseSha?: string;
    /** The PR's repository URL on GitHub; the remote must point at it before the base is fetched. */
    repoUrl?: string;
    /** merge: an unverifiable base throws (fail closed) instead of falling back to the defaults. */
    strict?: boolean;
}
export type ShipConfigLoader = (ctx: ShipConfigContext) => LoadedShipConfig;
/** A watch that ran out of time while a flaky run's rerun / sibling jobs were still going is pending, not failed. */
export declare function gateExit(report: GateReport, timedOut?: boolean): number;
/** `gates --drive`: the clock, process probes and the detached spawn (tests). */
export interface ShipDriveDeps {
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    proc: DriveProcess;
    spawnDriver?: DriveSpawn;
    /** CLI script the detached driver runs (default: the one running now). */
    entry?: string;
}
export declare function shipCommand(execImpl?: Exec, loadShipConfig?: ShipConfigLoader, drive?: ShipDriveDeps): Command;
//# sourceMappingURL=ship.d.ts.map