/**
 * `omg factory bench init`: a fresh local-forge repository with the bench
 * project and its seeded backlog (seed/), in a target directory:
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
import { type BenchIssue } from './seed/issues.js';
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
    /** The engine ledger dir a live run of this fixture uses (default: defaultLedgerDir()). */
    ledgerDir?: string;
    /** Remove the engine ledger an earlier fixture at this path left (staleFixtureLedger), instead of refusing. */
    force?: boolean;
}
/**
 * The engine's host state keyed by this fixture's repository PATH, which an
 * earlier fixture at the same path left behind (a live run's run-N.json
 * ledgers, ci-heal ledgers, a tamper hold): the first run of the new
 * fixture would park state-tampered on it. Per spelling of the repository
 * path the engine may resolve (as given, and through the target's real
 * path), the ledger dir `<ledgerDir>/<key>` (ledger.ts ledgerFilePath; key: repoKey), the heal dir
 * `<ledgerDir>/heal/<key>` and the hold `<ledgerDir>/holds/<key>.json`
 * (tamperHoldPath), where they exist. Claims and private run repositories
 * are keyed by the fixture's base commit, which a new fixture never
 * shares, so they are not listed.
 */
export declare function staleFixtureLedger(root: string, ledgerDir?: string): string[];
/** The repository paths the stale run ledgers (`<key>/run-*.json`) and holds record (`root`); unreadable records add nothing. */
export declare function staleLedgerOwners(stale: readonly string[]): string[];
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