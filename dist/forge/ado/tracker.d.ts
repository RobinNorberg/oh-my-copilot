/**
 * ForgeTracker on Azure Boards (factory forges design §5, §6, §7): work
 * items through `wit/workItems`, their comments, type states and WIQL
 * intake; progress and markers as one JSON-patch with `test /rev`.
 */
import type { ForgeTracker, IntakeSource } from '../types.js';
import { type AdoContext } from './invoke.js';
export declare const splitTags: (tags: unknown) => string[];
export declare function adoTracker(ctx: AdoContext, intakeSource?: IntakeSource): ForgeTracker;
//# sourceMappingURL=tracker.d.ts.map