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
export declare const BENCH_FIXTURE_VERSION = 3;
/** The integration branch of the fixture (a default ship.trustedBases entry). */
export declare const BENCH_BASE = "main";
/** The backlog label every bench item carries (factory.intake.source). */
export declare const BENCH_LABEL = "bench";
/** The local gate (factory.forge.local.gate): the repository's own `npm test`. */
export declare const BENCH_GATE: readonly string[];
/** Where the harness puts an issue's hidden acceptance test in its scratch checkout (inside the tsconfig and vitest globs). */
export declare const ACCEPTANCE_TEST_PATH = "test/bench-acceptance.test.ts";
export declare const BENCH_OMG_JSONC: string;
/** The shipping rates of the base (cents per country code); issue 13 adds one. */
export declare const BASE_RATES: Readonly<Record<string, number>>;
/** src/shipping.ts with these rates. */
export declare const SHIPPING_TS: (rates: Readonly<Record<string, number>>) => string;
/** docs/SHIPPING.md with these rates (test/shipping.test.ts keeps it in step with src/shipping.ts). */
export declare const SHIPPING_MD: (rates: Readonly<Record<string, number>>) => string;
/** src/messages.ts with this checkout message (issues 14 and 15 both change that one line). */
export declare const MESSAGES_TS: (checkout: string) => string;
/** The base files, path -> content (forward slashes). */
export declare const BENCH_PROJECT_FILES: Readonly<Record<string, string>>;
//# sourceMappingURL=project.d.ts.map