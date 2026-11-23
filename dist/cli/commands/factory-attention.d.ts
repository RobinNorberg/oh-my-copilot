/**
 * `omg factory attention [--json] [--verbose] [--exit-zero]`: what needs the
 * human, grouped by the action it needs, from local state only (no network,
 * no forge read, no write). Logic in src/factory/attention/.
 *
 * Exit codes: 0 nothing needs you; 4 something does (EXIT_AWAITING_HUMAN;
 * 0 with --exit-zero); 1 a run state could not be read; 2 usage.
 */
import { Command } from 'commander';
import type { LoadedFactoryRunLimits } from '../../factory/run/budget.js';
import type { OwnerDeps } from '../../factory/run/state.js';
export interface FactoryAttentionDeps {
    root: () => string;
    out: (line: string) => void;
    err: (line: string) => void;
    /** The configured run limits (the credit cap); a throw is a warning and no cap. */
    limits?: (root: string) => LoadedFactoryRunLimits;
    ledgerDir?: string;
    now?: () => number;
    owner?: OwnerDeps;
    /** The terminal width the view is laid out for (default process.stdout.columns; unknown: 80, at least 40). */
    columns?: () => number | undefined;
}
export declare const defaultAttentionDeps: FactoryAttentionDeps;
export declare function factoryAttentionCommand(deps?: FactoryAttentionDeps): Command;
//# sourceMappingURL=factory-attention.d.ts.map