/**
 * The bench's seeded backlog (`omg factory bench`): graded issues with
 * machine-checkable acceptance, and four TRAP issues. Per issue:
 *
 * - `expect`: the outcomes that count as a pass (score.ts outcomeMatches):
 *   `merged-park` (parked at the human merge with the hidden acceptance test
 *   green on the PR head), `park:<gate>` (`park:*` = any park; traps name
 *   their guard park or a declining lane, and a trap that leaks fails
 *   whatever the outcome),
 *   `not-runnable:<bucket>` (omg factory check never offers it to --next).
 * - `acceptanceTest`: a vitest file the lanes never see; the harness copies it
 *   to ACCEPTANCE_TEST_PATH in a scratch clone of the PR head and runs it
 *   with vitest and a harness-owned config there (runner.ts runAcceptance;
 *   the gate sandbox in --live). The full gate already passed on that head.
 *   Residual risks: the PR's own src runs inside the test (it could patch
 *   vitest's expect at import time), and these tests ship in the npm package
 *   (dist/factory/bench/seed/issues.js), so a live lane that reads the omg
 *   install can find them.
 * - `fake`: the scripted lanes of `--fake`, in the order the engine starts
 *   them (implement, review, then fix / ci-fix / review rounds).
 *
 * Placeholders resolved at fixture time: {{AWS_KEY}} (an AWS-key-shaped
 * value built at runtime, never a literal here) and {{CANARY_PATH}} (a file
 * outside the repository holding a random token).
 */
import type { FactoryFinding } from '../../run/state.js';
export type TrapKind = 'ci-definition' | 'secret' | 'outside-read' | 'trust-config' | 'guarded-git';
/**
 * A write step: the files it writes (fixture placeholders filled), the files
 * it deletes, its final text, and `guardDenials`: guarded git commands the
 * scripted lane "tried", written to its events.jsonl in the shape a real
 * lane's git-guardrails PreToolUse deny takes (score.ts readGuardDenials).
 */
export type FakeStep = {
    kind: 'write';
    files: Readonly<Record<string, string>>;
    delete?: readonly string[];
    text?: string;
    guardDenials?: readonly string[];
} | {
    kind: 'review';
    verdict: 'approve' | 'request-changes';
    findings?: readonly FactoryFinding[];
};
/**
 * The lane path an issue is built to exercise (score.ts scoreClassOf): a
 * ci-fix lane after the gate fails on a check the issue text does not
 * mention; a conflict-fix lane after the harness lands the issue's
 * `conflictsWith` partner. The path is reported as the result's scoreClass,
 * it is not part of the pass verdict (a live lane that runs the tests itself
 * passes without a ci-fix lane).
 */
export type BenchPath = 'ci-fix' | 'conflict-fix';
export interface BenchIssue {
    id: number;
    slug: string;
    title: string;
    /** 1 (trivial) .. 5 (hard). */
    difficulty: number;
    category: 'docs' | 'feature' | 'bug' | 'refactor' | 'format' | 'cross-file' | 'ambiguous' | 'conflict' | 'trap';
    trap?: TrapKind;
    /** The lane path the issue is built to exercise (scoreClass). */
    path?: BenchPath;
    /**
     * The partner of a conflicting pair: after both runs park at the merge, the
     * harness merges the partner's PR head into the base (the human merge) and
     * runs this issue again, so its PR conflicts with the moved base
     * (runner.ts landPartner). `fakeRerun`: the scripted lanes of that rerun.
     */
    conflictsWith?: number;
    fakeRerun?: readonly FakeStep[];
    body: string;
    expect: readonly string[];
    acceptanceTest?: string;
    fake: readonly FakeStep[];
}
export declare const BENCH_ISSUES: readonly BenchIssue[];
//# sourceMappingURL=issues.d.ts.map