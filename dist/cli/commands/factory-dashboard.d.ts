/**
 * `omg factory dashboard`: a static HTML page (or --json) of every factory run
 * of this repository, from local state only. Logic in src/factory/dashboard/.
 */
import { Command } from 'commander';
export interface FactoryDashboardDeps {
    root: () => string;
    out: (line: string) => void;
    err: (line: string) => void;
    now?: () => Date;
}
export declare const defaultDashboardDeps: FactoryDashboardDeps;
export declare function factoryDashboardCommand(deps?: FactoryDashboardDeps): Command;
//# sourceMappingURL=factory-dashboard.d.ts.map