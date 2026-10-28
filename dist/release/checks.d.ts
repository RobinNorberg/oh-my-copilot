/**
 * Pure checks behind `omg release`: version order, release prose, version
 * stamps, dist orphans, vitest report diffs, flake triage, smoke reports,
 * the smoke input hash and tag targets.
 * No I/O beyond the `exists` callback, so each rule is tested directly.
 */
export declare const VERSION_RE: RegExp;
/** `5.12.2` (a leading `v` is dropped); throws on anything but X.Y.Z. */
export declare function parseReleaseVersion(raw: string): string;
/** Negative / 0 / positive like a sort comparator; both sides must be X.Y.Z. */
export declare function compareVersions(a: string, b: string): number;
/** `s` as a literal regex source (also a literal `vitest -t` pattern). */
export declare const escapeRe: (s: string) => string;
/**
 * Problems with the release prose humans or agents write before a release:
 * CHANGELOG.md needs the `## [X.Y.Z]` section AND the `# <name> vX.Y.Z` H1
 * the tag-run boundary greps for; `.github/release-body.md` (the GitHub
 * Release body) must mention the version.
 */
export declare function releaseProseProblems(version: string, changelog: string | null, releaseBody: string | null): string[];
/**
 * Files and the version pattern each one carries; mirrors scripts/sync-version.sh plus the stamps it does not cover.
 * The plugin manifests carry one top-level "version" first, so only the first match is replaced (a nested one stays).
 */
export declare const VERSION_STAMPS: ReadonlyArray<{
    file: string;
    pattern: RegExp;
    replace: (v: string) => string;
}>;
/** The stamped content, or null when the file carries no stamp (a silent no-op would ship a stale version). */
export declare function stampVersion(content: string, stamp: (typeof VERSION_STAMPS)[number], version: string): string | null;
/**
 * Tracked tsc outputs under dist/ whose source under src/ is gone (tsc never
 * deletes them, and the runtime-closure check fails on a stale module).
 * Other dist files (copied JSON, bundled .cjs) are not tsc outputs and are skipped.
 */
export declare function findDistOrphans(trackedDist: readonly string[], exists: (repoPath: string) => boolean): string[];
/** Repo-relative forward-slash path of a test file from any checkout (`C:\x\src\a.test.ts` -> `src/a.test.ts`). */
export declare function repoRelativeTestPath(file: string): string;
/**
 * `<file> > <full title>` for every failed test in a vitest JSON report; a
 * file that failed with no failed test (a collection error) is listed as the
 * file alone.
 */
export declare function failingTitlesFromVitestJson(text: string): string[];
/** A baseline is a vitest JSON report or a text file with one `<file> > <title>` per line. */
export declare function parseBaselineTitles(text: string): string[];
/** Failing titles absent from the baseline (the suite gate fails only on these). */
export declare function newFailures(failing: readonly string[], baseline: readonly string[]): string[];
/** More new failing titles than this are a real failure: no isolated reruns. */
export declare const TRIAGE_CAP = 20;
/**
 * `real`: failed every isolated rerun (or a file-level collection error);
 * `load-flaky`: passed every isolated rerun (fails only under suite load, does not block);
 * `mixed`: failed some isolated reruns (may be a real race, blocks).
 */
export type TriageClass = 'real' | 'load-flaky' | 'mixed';
export interface TriageResult {
    /** `<file> > <full title>` as listed by failingTitlesFromVitestJson. */
    title: string;
    file: string;
    runs: number;
    passes: number;
    class: TriageClass;
}
/** The test file and full title of a failing-title line; `name` is null for a file-level collection error. */
export declare function splitFailingTitle(line: string): {
    file: string;
    name: string | null;
};
export declare function classifyTriage(runs: number, passes: number, collectionError?: boolean): TriageClass;
/** Whether a vitest JSON report has the test `name` in `file`, and it passed. */
export declare function testPassedInReport(text: string, file: string, name: string): boolean;
/**
 * `.github/known-flaky-tests.json` entries (file, title, note) plus the
 * triage evidence, for the owner to approve by hand: the engine never edits
 * that file.
 */
export declare function flakyCandidates(version: string, triage: readonly TriageResult[]): Array<{
    file: string;
    title: string;
    note: string;
    evidence: {
        class: TriageClass;
        runs: number;
        passes: number;
        release: string;
    };
}>;
/**
 * What `bridge/cli.cjs smoke copilot --tier 2` loads: a smoke is reused only while every one of these is unchanged.
 * Over-inclusion only costs a re-run; a missed input would reuse a stale green. Each is a shipped path (package.json
 * `files`): the plugin manifests (plugin.json, .claude-plugin), the dirs and .mcp.json the plugin points Copilot at,
 * scripts/ (copilot/hooks.json runs them; the smoke runs scripts/copilot/build-*.mjs --verify), templates, and
 * package-lock.json (the SDK version the scenarios load).
 */
export declare const SMOKE_INPUTS: readonly ["dist", "bridge", "hooks", "agents", "skills", "commands", "copilot", "scripts", "templates", ".claude-plugin", ".mcp.json", "plugin.json", "package.json", "package-lock.json"];
/** sha256 over `<path> <object id>` lines (`-` for an absent path), in SMOKE_INPUTS order. */
export declare function smokeInputHash(ids: ReadonlyArray<readonly [string, string | null]>): string;
/** Why a `smoke copilot --json` report is not a pass; empty = all checks passed. */
export declare function smokeProblems(stdout: string): string[];
/**
 * The commit an annotated tag points at on the remote, from
 * `git ls-remote --tags <remote> refs/tags/<tag> 'refs/tags/<tag>^{}'`:
 * the peeled `^{}` line for an annotated tag, else the plain line
 * (lightweight). Null when the tag is absent.
 */
export declare function remoteTagTarget(lsRemote: string, tag: string): {
    object: string;
    commit: string;
    annotated: boolean;
} | null;
/** Why a tag is not an annotated tag on `expected` (null = it is). */
export declare function tagTargetProblem(tag: string, objectType: string, peeled: string, expected: string): string | null;
//# sourceMappingURL=checks.d.ts.map