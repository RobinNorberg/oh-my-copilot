/**
 * `omg factory dashboard`: a static HTML page (or --json) of every factory run
 * of this repository, from local state. A stopped run with a PR is first
 * checked on the forge: a PR a human merged records the run as merged
 * (src/factory/run/human-merged.ts). Logic in src/factory/dashboard/.
 */
import { Command } from 'commander';
export interface FactoryDashboardDeps {
    root: () => string;
    out: (line: string) => void;
    err: (line: string) => void;
    now?: () => Date;
    /** Records the stopped runs whose PR a human merged (human-merged.ts) before the page is collected; returns lines for stderr. */
    humanMerges?: (root: string) => string[];
}
export declare const defaultDashboardDeps: FactoryDashboardDeps;
export declare function factoryDashboardCommand(deps?: FactoryDashboardDeps): Command;
//# sourceMappingURL=factory-dashboard.d.ts.map