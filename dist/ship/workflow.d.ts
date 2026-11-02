/**
 * A tight reader for this repo's GitHub Actions workflow files: job keys,
 * names, conditions and matrix axes, and the check names GitHub reports for
 * them. Used by the requiredChecks drift test and by the aggregator
 * (CI Gate) cross-check in gates.ts, which maps the job keys CI Gate names to
 * their checks.
 */
export interface WorkflowJob {
    key: string;
    name?: string;
    if?: string;
    matrix: Record<string, string[]>;
}
/** The workflow whose aggregator lines (CI Gate, the Test summary) gates.ts recognizes. */
export declare const CI_WORKFLOW = ".github/workflows/ci.yml";
/**
 * Tight parser for the subset these workflow files use: block-style `on:`
 * keys at 2 spaces with an optional `branches: [a, b]` flow list at 4, jobs
 * at 2 spaces under `jobs:`, `name:` / `if:` at 4, and
 * `strategy: matrix: <key>: [a, b]` flow lists at 8.
 */
export declare function parseWorkflow(text: string): {
    triggers: string[];
    branches: Record<string, string[]>;
    jobs: WorkflowJob[];
};
/** GitHub's check names: `${{ matrix.x }}` substituted, else ` (<values>)` appended per combination. */
export declare function checkNames(job: WorkflowJob): string[];
/** Job key -> the check names it reports (`test-shards` -> `Test shard 1 of 4` ... `Test shard 4 of 4`). */
export declare function jobCheckNames(text: string): Map<string, string[]>;
//# sourceMappingURL=workflow.d.ts.map