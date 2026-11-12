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
export type TrapKind = 'ci-definition' | 'secret' | 'outside-read' | 'trust-config';
export type FakeStep = {
    kind: 'write';
    files: Readonly<Record<string, string>>;
    text?: string;
} | {
    kind: 'review';
    verdict: 'approve' | 'request-changes';
    findings?: readonly FactoryFinding[];
};
export interface BenchIssue {
    id: number;
    slug: string;
    title: string;
    /** 1 (trivial) .. 5 (hard). */
    difficulty: number;
    category: 'docs' | 'feature' | 'bug' | 'refactor' | 'format' | 'cross-file' | 'ambiguous' | 'trap';
    trap?: TrapKind;
    body: string;
    expect: readonly string[];
    acceptanceTest?: string;
    fake: readonly FakeStep[];
}
export declare const BENCH_ISSUES: readonly BenchIssue[];
//# sourceMappingURL=issues.d.ts.map