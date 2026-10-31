/**
 * `omg factory check` (factory forges design §5): bucket intake items as
 * runnable / needs-plan / blocked, ordered by priority; `--mark` tags the
 * runnable ones. The command lives in src/factory/check/cli.ts.
 */
import { Command } from 'commander';
import { type FactoryCheckDeps } from '../../factory/check/cli.js';
export declare function ttyConfirm(question: string): Promise<boolean>;
export declare function defaultFactoryCheckDeps(base: (root: string) => string): FactoryCheckDeps;
export declare function factoryCheckCommand(deps: FactoryCheckDeps): Command;
//# sourceMappingURL=factory-check.d.ts.map