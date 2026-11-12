/**
 * Opt-in auto-merge by trust tier (night-4 goal 4). Merge stays a human step
 * by default (merge-policy.ts); a repository whose USER config turns on
 * `factory.merge.auto` lets the engine (trusted) merge a low-risk PR itself.
 *
 * Config, user config at its default location only (userConfigLayers
 * `trustedUser`), keyed by repository: the run's repository URL (GitHub; same
 * repoIdentity) or, on the local forge, the repository root path.
 *
 *   "factory": { "merge": { "auto": {
 *     "https://github.com/o/r": { "enabled": true, "tiers": ["docs", "tests"] },
 *     "C:/Code/my-repo": { "enabled": true, "tiers": ["small"], "maxChangedLines": 40, "maxFiles": 3 }
 *   } } }
 *
 * A committed `factory.merge` (the base's `.copilot/omg.jsonc`) is ignored with
 * a notice: lanes can write committed config, so it must never widen trust.
 *
 * Everything here is pure (no git, no spawn): the engine reads the diff, the
 * labels and the human review and hands them in; autoMergeVerdict says
 * whether every condition holds and lists each condition's evidence.
 */
export declare const AUTO_MERGE_TIERS: readonly ["docs", "tests", "small"];
export type AutoMergeTier = (typeof AUTO_MERGE_TIERS)[number];
/** A label on the issue or PR that keeps the merge human. */
export declare const MANUAL_MERGE_LABEL = "factory:manual-merge";
export declare const DEFAULT_SMALL_MAX_CHANGED_LINES = 80;
export declare const DEFAULT_SMALL_MAX_FILES = 10;
export interface AutoMergeConfig {
    enabled: boolean;
    tiers: AutoMergeTier[];
    /** Explicit caps apply to every tier; "small" falls back to the defaults above. */
    maxChangedLines?: number;
    maxFiles?: number;
    /** User globs the docs tier never admits, on top of the built-in deny list. */
    docsDenied?: string[];
    /** User globs no tier admits (guards, sandboxes, gates: your security-critical code). */
    securityCritical?: string[];
}
/**
 * The repository's `factory.merge.auto` entry from the trusted user config.
 * `config` undefined = off (no entry, or `enabled` false); `error` = a
 * malformed value (auto-merge stays off and the engine says why).
 */
export declare function resolveAutoMergeConfig(user: unknown, repo: {
    url?: string;
    root: string;
    local: boolean;
}): {
    config?: AutoMergeConfig;
    key?: string;
    error?: string;
};
/** A committed config (the base's `.copilot/omg.jsonc`) that sets `factory.merge`: the engine ignores it and says so. */
export declare function committedMergeConfig(base: unknown): boolean;
/** One changed path of `git diff --raw` + `--numstat` (no renames): status, modes and line counts. */
export interface ChangedEntry {
    path: string;
    /** git's raw status letter: Added, Deleted, Modified, Type change. */
    status: 'A' | 'D' | 'M' | 'T';
    oldMode: string;
    newMode: string;
    /** null: binary (numstat `-`). */
    added: number | null;
    deleted: number | null;
}
/**
 * `git diff --raw -z --no-renames --no-abbrev` and `git diff --numstat -z
 * --no-renames` of the same range, joined by path; null when either is
 * malformed or they disagree (the caller fails closed).
 */
export declare function parseChangedEntries(rawZ: string, numstatZ: string): ChangedEntry[] | null;
/** A user glob as a test on a folded path: `**` any depth, `*` and `?` inside one segment, a trailing `/` a whole directory; a glob without `/` matches the file name at any depth. */
export declare function globMatcher(glob: string): (path: string) => boolean;
/**
 * The changed paths no tier may auto-merge: the factory's and ship's
 * protected paths, every CI definition, the usual git hook directories,
 * `extra` (the configured protected paths, known-flaky file and core.hooksPath,
 * root-relative), `globs` (the user's securityCritical list), the denied
 * directories anywhere in the path, manifests, lockfiles, config and agent
 * prompt files by name, and any path Windows could resolve elsewhere
 * (protectedChanges' raw `:`/`~`/`..` rule).
 */
export declare function deniedPaths(paths: readonly string[], extra?: readonly string[], globs?: readonly string[]): string[];
/** docs: Markdown or reStructuredText anywhere, plain text under the root `docs/`. Never .mdx, HTML, scripts, site code or images. */
export declare function isDocsPath(path: string): boolean;
/** tests: a test file by name, or a source / snapshot / fixture-data file under a root test directory or any `__tests__`. */
export declare function isTestPath(path: string): boolean;
export interface TierResult {
    tier?: AutoMergeTier;
    reasons: string[];
    evidence: string[];
}
/** Root-anchored source trees the small tier never touches by default: the factory, ship, the Copilot runner and the forge adapters. */
export declare const SMALL_TIER_DENIED: string[];
export interface ClassifyOptions {
    /** Root-relative protected paths: the configured protected paths, the known-flaky file, the configured core.hooksPath. */
    extraDenied?: readonly string[];
    /** The files the BASE test config runs before or around tests (setupFiles, globalSetup, ...); `problem` = they could not be read. */
    testSetup?: {
        paths: readonly string[];
        problem?: string;
    };
}
/**
 * The first enabled tier (docs, tests, small, in that order) every changed
 * file fits, after the checks every tier shares: at least one change, plain
 * file modes, no binary, no denied path (built-in, configured, the user's
 * securityCritical globs, the base test config's setup files), no deleted
 * test, and the caps.
 */
export declare function classifyChanges(entries: readonly ChangedEntry[] | null, config: AutoMergeConfig, opts?: ClassifyOptions): TierResult;
/** Root config files whose setupFiles / globalSetup the engine reads at the BASE commit (never the head). */
export declare const TEST_CONFIG_NAME: RegExp;
/**
 * The setup files the base's root test configs name (vitest / vite / jest
 * configs and package.json's `jest`), read as text: each setupFiles,
 * setupFilesAfterEnv, globalSetup or globalTeardown value must be a string
 * literal or an array of them. Anything else (a variable, a call, a template
 * with `${}`) is a `problem`, and the engine then keeps the tests and small
 * tiers off: it cannot know which file runs.
 */
export declare function baseTestSetup(files: ReadonlyArray<{
    path: string;
    text: string;
}>): {
    paths: string[];
    problem?: string;
};
/**
 * The parks a run may have had and still auto-merge: waits and ordinary
 * failures a later round fixed. Any other `awaiting-human:` park in the run's
 * history (tamper, secrets, sandbox, protected paths, a park added later)
 * keeps the merge human: an allowlist, so a new park fails closed.
 */
export declare const BENIGN_PARKS: ReadonlySet<string>;
export interface AutoMergeRunFacts {
    /** The run is a ci-heal run (no issue): never auto-merged. */
    ciHeal: boolean;
    forgeKind: 'github' | 'local' | 'azure-devops';
    history: readonly {
        note: string;
    }[];
    unsandboxedAck?: string;
    unsandboxedGatesAck?: string;
    gateChangeApproved?: string;
    secretAck?: readonly unknown[];
}
export interface AutoMergeInput {
    head: string;
    config: AutoMergeConfig;
    run: AutoMergeRunFacts;
    /** decideMerge (+ forge policies) on this head; `checks` = the checks that ran and SUCCEEDED (not skipped or neutral). */
    decision: {
        ok: boolean;
        reasons: readonly string[];
        noChecks?: true;
        checks?: readonly string[];
    };
    /** ship.requiredChecks (config or branch protection): when set, one of them must be among the succeeded checks. */
    requiredChecks?: readonly string[];
    /** ship's latest verifier verdict. */
    verdict?: {
        sha: string;
        verdict: string;
        reviewer: string;
    };
    /** The human review read on this head: undefined = not read (factory.review.human "off"). */
    human?: {
        commentOnly: number;
    };
    /** Issue and PR labels; null = unreadable. */
    labels: readonly string[] | null;
    changes: TierResult;
}
export interface AutoMergeVerdict {
    ok: boolean;
    tier?: AutoMergeTier;
    reasons: string[];
    /** One line per condition that held, for the run history and the PR comment. */
    evidence: string[];
}
/** Every auto-merge condition on the exact head; all must hold. */
export declare function autoMergeVerdict(i: AutoMergeInput): AutoMergeVerdict;
/** The PR comment after the engine merged: the tier and every condition's evidence. */
export declare function autoMergeComment(label: string, tier: AutoMergeTier, head: string, evidence: readonly string[], by: string): string;
//# sourceMappingURL=auto-merge.d.ts.map