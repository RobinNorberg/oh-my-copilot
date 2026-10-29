/**
 * ForgeTracker on Azure Boards (factory forges design §5, §6, §7): work
 * items through `wit/workItems`, their comments, type states and WIQL
 * intake; progress and markers as one JSON-patch with `test /rev`.
 */
import { readFileSync } from 'fs';
import { isTrustedAdoAuthor } from '../config.js';
import { adoHtmlToText } from './html.js';
import { adoCall, adoJson, isObject, listValue, projectParams, str } from './invoke.js';
import { areaTagWiql, boardColumnWiql, KANBAN_COLUMN_FIELD, QUERY_ID } from './wiql.js';
/** State categories of a closed item (wit/workitemtypes/{type}/states `category`). */
const CLOSED_CATEGORIES = new Set(['completed', 'removed']);
const DEPENDS_ON = 'System.LinkTypes.Dependency-Reverse';
const CHILD = 'System.LinkTypes.Hierarchy-Forward';
/** A rev conflict on PATCH: HTTP 412 / TF26071 ("changed by someone else"), VS403351 (test op failed). */
const REV_CONFLICT = /\b412\b|TF26071|VS403351|test operation/i;
function readItem(ctx, id) {
    const json = adoJson(adoCall(ctx, 'wit.workItems.GET', { ...projectParams(ctx), id: String(id) }, { $expand: 'relations' }), `work item ${id}`);
    if (!isObject(json) || json.id !== id || typeof json.rev !== 'number' || !isObject(json.fields))
        throw new Error(`work item ${id}: malformed response`);
    return { id, rev: json.rev, fields: json.fields, relations: Array.isArray(json.relations) ? json.relations : [], url: str(json._links?.html?.href) };
}
/** The category of `state` for `type`, lowercased; undefined when the type lists no such state. */
function stateCategory(ctx, type, state) {
    const json = adoJson(adoCall(ctx, 'wit.workItemTypeStates.GET', { ...projectParams(ctx), type }), `states of ${type}`);
    const found = listValue(json).find((s) => isObject(s) && str(s.name)?.toLowerCase() === state.toLowerCase());
    return isObject(found) ? str(found.category)?.toLowerCase() : undefined;
}
const linkedIds = (relations, rel) => relations
    .filter((r) => isObject(r) && r.rel === rel)
    .map((r) => Number(/\/workItems\/(\d+)$/i.exec(str(r.url) ?? '')?.[1]))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
export const splitTags = (tags) => (typeof tags === 'string' ? tags.split(';').map((t) => t.trim()).filter(Boolean) : []);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function comments(ctx, id) {
    const json = adoJson(adoCall(ctx, 'wit.comments.GET', { ...projectParams(ctx), workItemId: String(id) }), `comments of work item ${id}`);
    const list = isObject(json) && Array.isArray(json.comments) ? json.comments : [];
    return list.filter(isObject).map((c) => ({
        body: adoHtmlToText(c.text),
        author: str(c.createdBy?.uniqueName) ?? '',
        trusted: isTrustedAdoAuthor(c.createdBy, ctx.config.trustedAuthors),
    }));
}
/** A team board's Kanban column field (work/boards `fields.columnField.referenceName`). */
function boardColumnField(ctx, team, board) {
    const json = adoJson(adoCall(ctx, 'work.boards.GET', { ...projectParams(ctx), team, id: board }), `board ${board}`);
    const field = str((isObject(json) ? json.fields : undefined)?.columnField?.referenceName);
    if (!field || !KANBAN_COLUMN_FIELD.test(field))
        throw new Error(`board ${board} has no Kanban column field`);
    return field;
}
/** The board's Kanban column field: from the board-column source's board, else the one WEF column field on the item. */
function columnField(ctx, item, source) {
    if (source?.type === 'board-column')
        return boardColumnField(ctx, source.team, source.board);
    const fields = Object.keys(item.fields).filter((k) => KANBAN_COLUMN_FIELD.test(k));
    if (fields.length !== 1)
        throw new Error(`work item ${item.id} has ${fields.length} board column fields; use a board-column intake source to name the board`);
    return fields[0];
}
/** One JSON-patch guarded by `test /rev`; on a rev conflict re-read once and retry once (design §7). */
function patchItem(ctx, id, build) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const item = readItem(ctx, id);
        const ops = build(item);
        if (!ops)
            return { ok: true, detail: 'already applied' };
        const call = adoCall(ctx, 'wit.workItems.PATCH', { ...projectParams(ctx), id: String(id) }, {}, [{ op: 'test', path: '/rev', value: item.rev }, ...ops]);
        if (call.ok)
            return { ok: true, detail: `rev ${item.rev} updated` };
        if (attempt === 0 && REV_CONFLICT.test(call.stderr))
            continue;
        return { ok: false, detail: call.stderr || `az exited ${call.status}` };
    }
    return { ok: false, detail: 'rev conflict persisted after one retry' };
}
const failure = (error) => (error instanceof Error ? error.message : String(error));
export function adoTracker(ctx, intakeSource) {
    return {
        viewItem(id) {
            const item = readItem(ctx, id);
            const f = item.fields;
            const type = str(f['System.WorkItemType']) ?? '';
            const state = str(f['System.State']) ?? '';
            const category = type && state ? stateCategory(ctx, type, state) : undefined;
            const acceptance = adoHtmlToText(f['Microsoft.VSTS.Common.AcceptanceCriteria']);
            return {
                id,
                url: item.url ?? `https://dev.azure.com/${encodeURIComponent(ctx.repo.owner)}/${encodeURIComponent(ctx.repo.project ?? '')}/_workitems/edit/${id}`,
                title: str(f['System.Title']) ?? '',
                body: adoHtmlToText(f['System.Description']),
                acceptance: acceptance || undefined,
                // An unknown state is treated as open: the check rules then decide, and nothing is marked done from it.
                open: category === undefined || !CLOSED_CATEGORIES.has(category),
                rawState: state,
                authorTrusted: isTrustedAdoAuthor(f['System.CreatedBy'], ctx.config.trustedAuthors),
                comments: comments(ctx, id),
                labels: splitTags(f['System.Tags']),
                type: type || undefined,
                column: str(f['System.BoardColumn']),
                priority: num(f['Microsoft.VSTS.Common.Priority']),
                size: num(f['Microsoft.VSTS.Scheduling.StoryPoints']) ?? num(f['Microsoft.VSTS.Scheduling.Effort']),
                dependsOn: linkedIds(item.relations, DEPENDS_ON),
                children: linkedIds(item.relations, CHILD),
                repoUrl: ctx.repo.url,
            };
        },
        queryItems(source, limit) {
            const top = { $top: String(limit) };
            let json;
            if (source.type === 'wiql-query') {
                if (!QUERY_ID.test(source.queryId))
                    throw new Error(`saved query id ${JSON.stringify(source.queryId)} is not a GUID`);
                json = adoJson(adoCall(ctx, 'wit.wiql.GET', { ...projectParams(ctx), id: source.queryId }, top), `saved query ${source.queryId}`);
            }
            else if (source.type === 'area-tag') {
                json = adoJson(adoCall(ctx, 'wit.wiql.POST', projectParams(ctx), top, { query: areaTagWiql(source, ctx.intakeItemTypes) }), 'area/tag query');
            }
            else if (source.type === 'board-column') {
                const field = boardColumnField(ctx, source.team, source.board);
                json = adoJson(adoCall(ctx, 'wit.wiql.POST', projectParams(ctx), top, { query: boardColumnWiql(field, source.column, ctx.intakeItemTypes) }), 'board column query');
            }
            else {
                throw new Error(`intake source ${source.type} is a GitHub source`);
            }
            const items = isObject(json) && Array.isArray(json.workItems) ? json.workItems : [];
            return items.map((w) => (isObject(w) ? w.id : undefined)).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, limit);
        },
        comment(id, bodyFile) {
            try {
                const call = adoCall(ctx, 'wit.comments.POST', { ...projectParams(ctx), workItemId: String(id) }, { format: 'markdown' }, { text: readFileSync(bodyFile, 'utf8') });
                return { ok: call.ok, stderr: call.ok ? '' : call.stderr || `az exited ${call.status}` };
            }
            catch (error) {
                return { ok: false, stderr: failure(error) };
            }
        },
        setProgress(id, stage, mapping) {
            // blocked and cancelled never change state (design §7); cancelled writes nothing on ADO.
            const state = stage === 'blocked' || stage === 'cancelled' ? undefined : mapping.state;
            const column = stage === 'cancelled' ? undefined : mapping.column;
            if (state === undefined && column === undefined)
                return { ok: true, detail: 'nothing mapped' };
            try {
                return patchItem(ctx, id, (item) => {
                    const ops = [];
                    if (column !== undefined) {
                        const field = columnField(ctx, item, intakeSource);
                        if (item.fields[field] !== column)
                            ops.push({ op: 'add', path: `/fields/${field}`, value: column });
                    }
                    if (state !== undefined && item.fields['System.State'] !== state) {
                        const category = stateCategory(ctx, str(item.fields['System.WorkItemType']) ?? '', state);
                        if (category === undefined)
                            throw new Error(`state ${JSON.stringify(state)} is not a state of this work item type`);
                        if (CLOSED_CATEGORIES.has(category) && stage !== 'done')
                            throw new Error(`state ${JSON.stringify(state)} closes the item; only the done stage may`);
                        ops.push({ op: 'add', path: '/fields/System.State', value: state });
                    }
                    return ops.length ? ops : null;
                });
            }
            catch (error) {
                return { ok: false, detail: failure(error) };
            }
        },
        addMarker(id, marker) {
            try {
                const res = patchItem(ctx, id, (item) => {
                    const tags = splitTags(item.fields['System.Tags']);
                    if (tags.some((t) => t.toLowerCase() === marker.toLowerCase()))
                        return null;
                    return [{ op: 'add', path: '/fields/System.Tags', value: [...tags, marker].join('; ') }];
                });
                return { ok: res.ok, stderr: res.ok ? '' : res.detail };
            }
            catch (error) {
                return { ok: false, stderr: failure(error) };
            }
        },
    };
}
//# sourceMappingURL=tracker.js.map