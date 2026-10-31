/**
 * `omg factory poll` (ADO parity design §2): the foreground polling loop
 * over heal, intake, PRs and the board. The command lives in
 * src/factory/poll.ts.
 */
import { Command } from 'commander';
import { type FactoryPollDeps } from '../../factory/poll.js';
export declare function factoryPollCommand(deps: FactoryPollDeps): Command;
//# sourceMappingURL=factory-poll.d.ts.map