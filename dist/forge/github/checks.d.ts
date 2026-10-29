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
//# sourceMappingURL=checks.d.ts.map