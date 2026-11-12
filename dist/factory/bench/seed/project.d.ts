/**
 * The bench fixture's base project (`omg factory bench`): a small
 * TypeScript + vitest library committed on `main` of a fresh local-forge
 * repository. The `.copilot/omg.jsonc` committed with it is the trusted
 * base layer: the local forge, its gate (`npm test`: the zero-dependency
 * lint, tsc and vitest, as `.github/workflows/ci.yml` runs them), the
 * prepare check and the intake source. Contents only; fixture.ts writes them.
 *
 * Bump BENCH_FIXTURE_VERSION on any change here or in issues.ts: results of
 * different fixture versions are not comparable (compare warns).
 */
export declare const BENCH_FIXTURE_VERSION = 1;
/** The integration branch of the fixture (a default ship.trustedBases entry). */
export declare const BENCH_BASE = "main";
/** The backlog label every bench item carries (factory.intake.source). */
export declare const BENCH_LABEL = "bench";
/** The local gate (factory.forge.local.gate) and the acceptance command: the repository's own `npm test`. */
export declare const BENCH_GATE: readonly string[];
/** Where the harness puts an issue's hidden acceptance test in its scratch checkout (inside the tsconfig and vitest globs). */
export declare const ACCEPTANCE_TEST_PATH = "test/bench-acceptance.test.ts";
/**
 * The acceptance command: vitest on the hidden test alone. It runs only on a
 * head that parked at the merge gate, so the full gate (lint, tsc, every
 * test) already passed on exactly that head.
 */
export declare const ACCEPTANCE_ARGV: readonly string[];
export declare const BENCH_OMG_JSONC: string;
/** The base files, path -> content (forward slashes). */
export declare const BENCH_PROJECT_FILES: Readonly<Record<string, string>>;
//# sourceMappingURL=project.d.ts.map