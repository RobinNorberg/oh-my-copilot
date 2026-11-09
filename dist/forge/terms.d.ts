/**
 * The words user-facing output uses for a forge and its items, so the local
 * (offline) forge never prints GitHub or Azure DevOps terms (dogfood F23/F35).
 * Every call site reads them from here instead of spelling its own.
 */
import type { ForgeKind } from './types.js';
export interface ForgeTerms {
    /** The forge in a sentence: `GitHub`, `Azure DevOps`, `the local forge`. */
    name: string;
    /** One tracker item: `issue`, `work item`, `backlog item`. */
    item: string;
    /** Where the acceptance list of an item lives when the tracker has its own field or section. */
    acceptance: string;
    /** The item's free text: `issue body`, `work item description`, `backlog item body`. */
    body: string;
}
export declare function forgeTerms(kind: ForgeKind): ForgeTerms;
//# sourceMappingURL=terms.d.ts.map