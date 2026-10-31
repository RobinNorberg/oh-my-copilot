/**
 * ForgeTracker on Azure Boards (factory forges design §5, §6, §7): work
 * items through `wit/workItems`, their comments, type states and WIQL
 * intake; progress and markers as one JSON-patch with `test /rev`.
 *
 * `omg factory enqueue`'s writes (shipyard-factory design §3.3, PR 7b):
 * create a work item of the first intake type, update its title,
 * description, AC, priority and tags, and add a parent or predecessor link.
 * Description and AC are HTML this adapter builds from escaped text; the
 * factory guard passes these writes only with enqueue's TrackerWriteContext.
 */
import { type ForgeTracker, type IntakeSource } from '../types.js';
import { type AdoContext } from './invoke.js';
export declare const splitTags: (tags: unknown) => string[];
/** Text as System.Description HTML: every character escaped, one `<br>` per line break (adoHtmlToText reads the lines back). */
export declare const adoTextHtml: (text: string) => string;
/** The acceptance criteria as an escaped HTML list for Microsoft.VSTS.Common.AcceptanceCriteria. */
export declare const adoListHtml: (items: readonly string[]) => string;
/** `bodyDir`: enqueue's body directory (ForgeOptions.trackerBodyDir); unset, createItem and updateItem read no body file. */
export declare function adoTracker(ctx: AdoContext, intakeSource?: IntakeSource, bodyDir?: string): ForgeTracker;
//# sourceMappingURL=tracker.d.ts.map