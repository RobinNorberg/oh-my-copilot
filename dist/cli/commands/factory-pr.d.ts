/**
 * `omg factory pr list|view|diff|review` (factory night 3, goal 2): the local
 * (offline) forge's PRs for a human. list, view and diff only read (round-2
 * F42's safe way to inspect a lane's work: the diff runs as the engine's
 * hardened git, no hooks, no external diff driver, no textconv); review plays
 * a human review back into the engine-owned PR store
 * (`<store>/prs/<n>/reviews.jsonl`), which the next `omg factory run` reads
 * through ForgeReviews.reviewFeedback. GitHub and Azure DevOps have their own
 * review UI: there the command refuses (exit 2).
 *
 * Every text a lane could have written (titles, bodies, the diff) is printed
 * without control characters.
 */
import { Command } from 'commander';
import { type FactoryCheckDeps } from '../../factory/check/cli.js';
export declare const FACTORY_PR_JSON_SCHEMA_VERSION = 1;
export interface FactoryPrDeps extends FactoryCheckDeps {
    /** Who is reviewing (default: the OS user). */
    user?: () => string;
    /** The engine ledger directory (its empty hooks dir hardens the diff's git); default defaultLedgerDir(). */
    ledgerDir?: string;
}
/** Lane-written text for a terminal: no control characters but tab and newline. */
export declare const printable: (text: string) => string;
/** One `omg factory pr` action; returns the exit code. */
export declare function runFactoryPr(action: 'list' | 'view' | 'diff' | 'review', o: {
    pr?: string;
    json?: boolean;
    approve?: boolean;
    requestChanges?: boolean;
    comment?: boolean;
    bodyFile?: string;
}, deps: FactoryPrDeps): Promise<number>;
export declare function factoryPrCommand(deps: FactoryPrDeps): Command;
//# sourceMappingURL=factory-pr.d.ts.map