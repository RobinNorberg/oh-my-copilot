/**
 * `omg factory attention --all-repos`: the attention view of every
 * repository this host's engine ledger knows (run/ledger-roots.ts), one
 * collectAttention per root with that repository's own trust checks (its
 * states against ITS seals and ledger records), grouped by repository.
 * Read-only and local, as the single-repository view: no network, no forge,
 * no write and no lock in any repository or in the ledger.
 *
 * The `omg` commands are repository-relative and `omg` has no global
 * working-directory option, so a row of another repository prints them
 * under "in <root>:" and `--json` gives every command a `cwd`. A root that
 * cannot be shown safely in a command for this host's shell (rootWord) is
 * named in prose only. `git -C <root>` merge commands already carry the root.
 */
import type { LedgerRoot, SkippedRoot } from '../run/ledger-roots.js';
import { type AttentionGroup } from './actions.js';
import { type AttentionData, type CollectAttentionOptions } from './collect.js';
/** A root in a header: plain, and cut in the middle to this many characters. */
export declare const ROOT_HEADER_MAX = 72;
export interface RepoAttention {
    id: string;
    root: string;
    /** The repository the command runs in (its commands need no cwd). */
    current: boolean;
    recorded: boolean;
    data: AttentionData;
    /** Collection time (--verbose). */
    ms: number;
}
export interface AllReposAttention {
    repos: RepoAttention[];
    skipped: SkippedRoot[];
    warnings: string[];
    generatedAt: string;
    byGroup: Record<AttentionGroup, number>;
    readFailed: boolean;
    items: number;
    engines: number;
    /** Discovery time (--verbose). */
    discoveryMs: number;
}
/** A root for a header line: plainText, cut in the middle so both ends stay readable. */
export declare function rootHeader(root: string, max?: number): string;
/** A repository taking longer than this to collect gets a note in --verbose (no kill: the command is one-shot). */
export declare const SLOW_REPO_MS = 1000;
/**
 * A repository's header line: labelled, its folder name quoted (JSON string
 * escapes) and both name and path plain and cut, so a directory name cannot
 * pass for a command or a run row (the line never starts with `$`, `#` or `==`).
 */
export declare function repoHeader(root: string, tags?: string): string;
export interface CollectAllOptions extends Omit<CollectAttentionOptions, 'limits'> {
    /** The cwd's repository top level, or null outside one. */
    current: string | null;
    limits?: (root: string) => CollectAttentionOptions['limits'];
    platform?: NodeJS.Platform;
    clock?: () => number;
}
export declare function collectAllRepos(roots: readonly LedgerRoot[], skipped: SkippedRoot[], warnings: string[], o: CollectAllOptions, discoveryMs?: number): AllReposAttention;
/** The `--all-repos --json` shape: each repository's attentionJson body, with a `cwd` on every command. */
export declare function allReposJson(d: AllReposAttention): Record<string, unknown>;
export declare function renderAllRepos(d: AllReposAttention, o?: {
    verbose?: boolean;
    platform?: NodeJS.Platform;
}): string;
//# sourceMappingURL=all-repos.d.ts.map