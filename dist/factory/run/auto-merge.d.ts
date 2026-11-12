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
/**
 * A user glob as a test on a folded path: `**` any depth, `*` and `?` inside
 * one segment, a trailing `/` a whole directory; a glob without `/` matches
 * the file name at any depth. Braces `{a,b}` and classes `[ab]` are not glob
 * syntax here: they match literally (write one glob per alternative).
 */
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
/**
 * docs: an allowlist (review-498b N2): root README*, CHANGELOG* and
 * CONTRIBUTING* (.md, .rst, .txt) and `.md`, `.rst`, `.txt` files under the
 * root `docs/`. Nothing else is docs: Markdown elsewhere (src/notes.md, a
 * mission contract, an agent's rules file) may be read by tools or agents.
 */
export declare function isDocsPath(path: string): boolean;
/** Files whose text may carry frontmatter that a tool parses as config (skills, commands, agents, mission contracts): their blobs are read. */
export declare const FRONTMATTER_CANDIDATE: RegExp;
/**
 * Whether the engine reads a changed file's blobs for frontmatter: Markdown-like
 * by its raw name or by its folded name (`README.md.`, `README.md `, fullwidth
 * or zero-width spellings), and every docs-tier path (review-498c L-a).
 */
export declare const isFrontmatterCandidate: (path: string) => boolean;
/** A blob that starts with YAML (`---`) or TOML (`+++`) frontmatter, after an optional BOM and blank space. */
export declare const hasFrontmatter: (text: string) => boolean;
/**
 * The files the BASE package.json runs for every user of the package
 * (review-498b N3, review-498c L-b): every path-like word of its install and
 * publish lifecycle scripts (and of the scripts they run with `npm run
 * <name>`) and its "bin" targets, all denied in every tier. The small tier
 * also needs a `problem`-free result, and anything the engine cannot follow is
 * a problem: a lifecycle that runs a repository file or an interpreter (what
 * it imports is not followed), a runner with flags or an unknown subcommand,
 * a script orchestrator or package executor, a variable, substitution or
 * glob, "gypfile", "workspaces", and (`rootNames`, the base's root file names)
 * a binding.gyp or pnpm-workspace.yaml. Absent package.json (`text` null):
 * only the root-file problems.
 */
export declare function baseInstallFiles(text: string | null, rootNames?: readonly string[]): {
    paths: string[];
    problem?: string;
};
/** One added (`+`) or deleted (`-`) line of a patch and the file it is in (the `+++`/`---` header name, prefix included). */
export interface PatchLine {
    path: string;
    sign: '+' | '-';
    text: string;
}
/**
 * The added and deleted lines of a plain `git diff` patch, each with its
 * file; null when the text has an ANSI escape (a colour setting: the engine
 * cannot read it, so it fails closed).
 */
export declare function patchLines(patch: string): PatchLine[] | null;
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
    /** The .md/.rst/.mdc paths whose BASE or HEAD blob starts with frontmatter (hasFrontmatter); `problem` = a blob could not be read. */
    frontmatter?: {
        paths: readonly string[];
        problem?: string;
    };
    /** The files the BASE package.json runs on install or publish (baseInstallFiles): denied in every tier; `problem` keeps the small tier off. */
    installFiles?: {
        paths: readonly string[];
        problem?: string;
    };
    /** The patch's added and deleted lines (patchLines); null = unreadable, which keeps the tests and small tiers off. Undefined = not read. */
    patch?: readonly PatchLine[] | null;
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
 * configs and package.json's `jest`), read as text: each SETUP_KEY_NAMES
 * value (setup, teardown, reporters, environment, runner, sequencer,
 * serializers, transform...) must be a string literal or an array of them.
 * Anything else (a variable, a call, a template with `${}`, a shorthand or
 * computed key, a relative import or require, mergeConfig, defineWorkspace,
 * defineProject) is a `problem`, and the engine then keeps the tests and
 * small tiers off: it cannot know which file runs.
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
        unsettled?: readonly string[];
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