/**
 * GitHub checks (factory forges design §2, PR 2): `gh pr checks`, the PR
 * head, `gh run list --commit`, job logs and `gh run rerun --failed`. The
 * bodies moved verbatim from src/ship/gates.ts and gates-driver.ts, whose
 * exported names now delegate here; argv, cwd and error text are unchanged.
 */
import type { Exec } from '../../ship/exec.js';
import { type GhCheck, type WorkflowRun } from '../../ship/gates.js';
import type { ForgeChecks } from '../types.js';
/** Run `gh pr checks <pr> --json ...`; "no checks reported" is an empty list. */
export declare function ghPrChecks(exec: Exec, pr: number, cwd?: string): GhCheck[];
/** The PR head sha from `gh pr view <pr> --json headRefOid`. */
export declare function ghHeadSha(exec: Exec, pr: number, cwd?: string): string;
/**
 * Run `gh run list --commit <sha> --json ...`: every Actions workflow run for
 * the head sha. A run whose reported head_sha is another commit is dropped, so
 * a previous head's failed run never counts against this one.
 */
export declare function ghRunsForHead(exec: Exec, headSha: string, cwd?: string): WorkflowRun[];
/** `gh run view --job <id> --log`; `ok: false` (text = whatever stdout held) when gh failed. */
export declare function ghJobLog(exec: Exec, jobId: string, cwd?: string): {
    ok: boolean;
    text: string;
};
/** `gh run rerun <id> --failed`. */
export declare function ghRerun(exec: Exec, runId: string, cwd?: string): {
    ok: boolean;
    stderr: string;
};
/** ForgeChecks on GitHub: `pr checks` already reports the PR head, and a run list is per commit, so `headSha` / `pr` are not needed there. */
export declare function githubChecks(exec: Exec, cwd?: string): ForgeChecks;
/**
 * The two GETs of ghRequiredChecks for `base` of `repoArg` (ghRepoArg):
 * the branch (its `protection.required_status_checks`) and the rules that
 * apply to it (rulesets' `required_status_checks`).
 */
export declare function requiredChecksArgs(repoArg: string, base: string): string[][];
/**
 * The live tip of `base` on `repoArg`: the branch GET of requiredChecksArgs
 * (the same exact shape the run guard admits). A pull request's baseRefOid
 * is the base when the PR was last updated, not the branch now: it stays
 * behind after another merge into the base. Throws GhCommandError on a
 * failed read, on another branch name (a renamed branch redirects) and on
 * anything but a full commit sha.
 */
export declare function ghBranchTip(exec: Exec, repoArg: string, base: string, cwd?: string): string;
/** Pages read of a paginated list (rules, check suites, check runs); a longer list counts as unreadable. */
export declare const MAX_API_PAGES = 10;
/**
 * The paginated GETs of the factory's gate reads at a full commit sha:
 * the commit's check suites and its check runs (with their app ids).
 */
export declare function gateReadArgs(repoArg: string, sha: string, what: 'check-suites' | 'check-runs'): string[];
/** The GETs of latestChecks for `ref` of `repoArg`: the commit's check runs and its combined status. */
export declare function commitChecksArgs(repoArg: string, ref: string): string[][];
/**
 * True for exactly one of the GETs above on `repoArg` (the guards of
 * factory run, setup and check allow these reads and nothing broader).
 * `commits` also allows the commit-check reads (setup and check only).
 */
export declare function isRequiredChecksArgs(args: readonly string[], repoArg: string | undefined, commits?: boolean): boolean;
/**
 * True for exactly one of the factory run's gate reads on `repoArg` (the
 * run guard): the commit-check GETs at a full sha (the base's check names)
 * and the paginated check-suite / check-run GETs (gateReadArgs).
 */
export declare function isGateReadArgs(args: readonly string[], repoArg: string | undefined): boolean;
/**
 * The status checks GitHub requires on `base` (the default of an empty
 * `ship.requiredChecks`): the branch protection's required contexts plus
 * the `required_status_checks` rules of the rulesets that apply to it. Read
 * from the forge API with the user's token, never from the repository tree.
 * undefined = neither read worked (the caller falls back to every reported
 * check); a readable empty list is [].
 */
export declare function ghRequiredChecks(exec: Exec, repoArg: string, base: string, cwd?: string): string[] | undefined;
/**
 * ghRequiredChecks with the app each name is required from: a ruleset's
 * `integration_id`, a classic protection check's `app_id` (absent, null or
 * -1 = any source). A name required from two different apps keeps no app
 * (name matching), since one check run cannot satisfy both.
 */
export declare function ghRequiredCheckRules(exec: Exec, repoArg: string, base: string, cwd?: string): {
    names: string[];
    apps: Record<string, number>;
} | undefined;
/** One check suite of a commit (GET commits/<sha>/check-suites). */
export interface GhCheckSuite {
    status: string;
    /** The app's slug (`github-actions` for workflows); undefined when GitHub names none. */
    app?: string;
    /** latest_check_runs_count: the suite's check runs so far. */
    runs: number;
}
/** The check suites GitHub lists for `sha` (gateReadArgs, paginated); undefined = unreadable. */
export declare function ghCheckSuites(exec: Exec, repoArg: string, sha: string, cwd?: string): GhCheckSuite[] | undefined;
/** The check runs GitHub lists for `sha` with their app ids (gateReadArgs, paginated); undefined = unreadable. */
export declare function ghCheckRunApps(exec: Exec, repoArg: string, sha: string, cwd?: string): Array<{
    name: string;
    appId?: number;
}> | undefined;
/** The check names (check runs and commit statuses) GitHub reports for `ref`; undefined = unreadable (with `both`: either read failed). */
export declare function ghCommitCheckNames(exec: Exec, repoArg: string, ref: string, cwd?: string, both?: boolean): string[] | undefined;
//# sourceMappingURL=checks.d.ts.map