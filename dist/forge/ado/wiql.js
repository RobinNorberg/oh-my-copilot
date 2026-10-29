/**
 * WIQL for the ADO intake sources (factory forges design §6, §8.5). Queries
 * are built only from config values, never from work item text; every value
 * goes through escapeWiql (the rule AzureDevOpsProvider.escapeWiql uses,
 * restated here because src/forge may not import that spawning module), and
 * a value with a control character is refused rather than escaped.
 */
export class WiqlError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WiqlError';
    }
}
/** A saved query id: a GUID (design §8.5). */
export const QUERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The team board's Kanban column field (work/boards columnField.referenceName). */
export const KANBAN_COLUMN_FIELD = /^WEF_[0-9A-F]{32}_Kanban\.Column$/;
/** A WIQL string literal's content: single quotes doubled. */
export function escapeWiql(value) {
    if (typeof value !== 'string' || value === '' || /\p{Cc}/u.test(value))
        throw new WiqlError(`refused WIQL value ${JSON.stringify(value)}`);
    return value.replace(/'/g, "''");
}
const literal = (v) => `'${escapeWiql(v)}'`;
function typeFilter(itemTypes) {
    return itemTypes.length === 0 ? [] : [`[System.WorkItemType] IN (${itemTypes.map(literal).join(', ')})`];
}
function query(conditions) {
    return `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(' AND ')} ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.Id] ASC`;
}
/** WIQL for an area-path + tag source. */
export function areaTagWiql(source, itemTypes) {
    return query([
        '[System.TeamProject] = @project',
        `[System.AreaPath] UNDER ${literal(source.areaPath)}`,
        `[System.Tags] CONTAINS ${literal(source.tag)}`,
        ...typeFilter(itemTypes),
    ]);
}
/** WIQL for a board-column source, given the board's Kanban column field. */
export function boardColumnWiql(columnField, column, itemTypes) {
    if (!KANBAN_COLUMN_FIELD.test(columnField))
        throw new WiqlError(`refused board column field ${JSON.stringify(columnField)}`);
    return query(['[System.TeamProject] = @project', `[${columnField}] = ${literal(column)}`, ...typeFilter(itemTypes)]);
}
//# sourceMappingURL=wiql.js.map