/**
 * `omg factory bench init`: a fresh local-forge repository with the bench
 * project and its seeded backlog (fixtures/), in a target directory:
 *
 *   <dir>/repo/                 the repository (branch main, no origin)
 *   <dir>/outside/support.txt   the canary file outside the repository (trap #11)
 *   <dir>/bench-fixture.json    what the harness needs: root, base sha, canary
 *
 * The trusted config is the `.copilot/omg.jsonc` committed on main (forge
 * kind local, its gate, the intake source), so `omg factory run --next` in
 * the repository needs no user config. The repository's `node_modules` is
 * the user's to install (`npm install` in <dir>/repo), or a link to an
 * existing one (`--node-modules`, used by the tests and the fake mode).
 */
import { type Exec } from '../../ship/exec.js';
import { type BenchIssue } from './fixtures/issues.js';
export declare const FIXTURE_META_FILE = "bench-fixture.json";
export interface BenchFixtureMeta {
    schemaVersion: 1;
    fixtureVersion: number;
    /** The repository (absolute). */
    root: string;
    base: string;
    /** The base commit the fixture was created at. */
    baseSha: string;
    /** The file outside the repository whose token must never leak (trap outside-read). */
    canaryPath: string;
    canary: string;
    issues: number[];
    createdAt: string;
}
export interface CreateFixtureOptions {
    /** Link `<repo>/node_modules` to this existing node_modules (a junction on Windows). */
    nodeModules?: string;
    exec?: Exec;
    now?: () => Date;
}
/** An AWS-access-key-shaped value, built at runtime (never a literal in the source: push protection). */
export declare const benchAwsKey: () => string;
/** An issue's text with the fixture placeholders filled in. */
export declare function fillPlaceholders(text: string, meta: Pick<BenchFixtureMeta, 'canaryPath'>): string;
/** The backlog file of an issue (`.copilot/backlog/<id>-<slug>.md`, local forge frontmatter). */
export declare function backlogFile(issue: BenchIssue, meta: Pick<BenchFixtureMeta, 'canaryPath'>): {
    path: string;
    text: string;
};
export declare function createBenchFixture(dir: string, o?: CreateFixtureOptions): BenchFixtureMeta;
export declare function readFixtureMeta(dir: string): BenchFixtureMeta;
/**
 * Remove a bench directory without ever following a link: every symlink and
 * junction (the fixture's node_modules link, the gate trees of the engine's
 * prepare checkouts) is unlinked first, then the rest goes.
 */
export declare function removeBenchDir(dir: string): void;
//# sourceMappingURL=fixture.d.ts.map