/**
 * WIQL for the ADO intake sources (factory forges design §6, §8.5). Queries
 * are built only from config values, never from work item text; every value
 * goes through escapeWiql (the rule AzureDevOpsProvider.escapeWiql uses,
 * restated here because src/forge may not import that spawning module), and
 * a value with a control character is refused rather than escaped.
 */
import type { IntakeSource } from '../types.js';
export declare class WiqlError extends Error {
    constructor(message: string);
}
/** A saved query id: a GUID (design §8.5). */
export declare const QUERY_ID: RegExp;
/** The team board's Kanban column field (work/boards columnField.referenceName). */
export declare const KANBAN_COLUMN_FIELD: RegExp;
/** A WIQL string literal's content: single quotes doubled. */
export declare function escapeWiql(value: string): string;
/** WIQL for an area-path + tag source. */
export declare function areaTagWiql(source: Extract<IntakeSource, {
    type: 'area-tag';
}>, itemTypes: readonly string[]): string;
/** WIQL for a board-column source, given the board's Kanban column field. */
export declare function boardColumnWiql(columnField: string, column: string, itemTypes: readonly string[]): string;
//# sourceMappingURL=wiql.d.ts.map