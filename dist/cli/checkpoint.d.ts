/**
 * Checkpoint command - Workspace snapshot/rollback for autonomous runs.
 *
 * Thin CLI adapter only: all snapshot logic lives in
 * src/features/checkpoint/index.ts.
 */
import { Command } from 'commander';
/**
 * Returns the `checkpoint` command:
 *
 *   omg checkpoint create [--label <text>]
 *   omg checkpoint list
 *   omg checkpoint rollback <id> [--force]
 */
export declare function checkpointCommand(): Command;
//# sourceMappingURL=checkpoint.d.ts.map