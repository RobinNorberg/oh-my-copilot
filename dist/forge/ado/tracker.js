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
import { readFileSync } from 'fs';
import { isBodyFileIn, readTrackerBody } from '../body-file.js';
import { isTrustedAdoAuthor } from '../config.js';
import { shipyardKeys, } from '../types.js';
import { adoOrgUrl } from './guard.js';
import { adoHtmlToText } from './html.js';
import { adoCall, adoJson, isObject, listValue, projectParams, str } from './invoke.js';
import { areaTagWiql, boardColumnWiql, KANBAN_COLUMN_FIELD, QUERY_ID, shipyardKeyWiql } from './wiql.js';
/** State categories of a closed item (wit/workitemtypes/{type}/states `category`). */
const CLOSED_CATEGORIES = new Set(['completed', 'removed']);
const DEPENDS_ON = 'System.LinkTypes.Dependency-Reverse';
const CHILD = 'System.LinkTypes.Hierarchy-Forward';
const PARENT = 'System.LinkTypes.Hierarchy-Reverse';
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
/** The link each relation kind writes, as viewItem reads it back (parent, dependsOn). */
const RELATION_OF = { parent: PARENT, 'depends-on': DEPENDS_ON };
/** findByKey's one WIQL page. */
const KEY_QUERY_TOP = '1000';
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
/** Text as System.Description HTML: every character escaped, one `<br>` per line break (adoHtmlToText reads the lines back). */
export const adoTextHtml = (text) => `<div>${text.replace(/\r\n?/g, '\n').split('\n').map(escapeHtml).join('<br>')}</div>`;
/** The acceptance criteria as an escaped HTML list for Microsoft.VSTS.Common.AcceptanceCriteria. */
export const adoListHtml = (items) => `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
/** Title, description (from the body file, a file directly in enqueue's body directory read like a gh tracker write's), AC and priority as JSON-patch adds. */
function itemFieldOps(item, bodyDir) {
    if (!bodyDir || !isBodyFileIn(item.bodyFile, bodyDir))
        throw new Error(`--body-file ${JSON.stringify(item.bodyFile)} must be a file directly in enqueue's body directory`);
    const body = readTrackerBody(item.bodyFile, (reason) => new Error(reason)).toString('utf8');
    const ops = [{ op: 'add', path: '/fields/System.Title', value: item.title }];
    if (body.trim() !== '')
        ops.push({ op: 'add', path: '/fields/System.Description', value: adoTextHtml(body) });
    if (item.acceptance?.length)
        ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: adoListHtml(item.acceptance) });
    if (item.priority !== undefined)
        ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: item.priority });
    return ops;
}
/** The item's tags with `remove` dropped and `add` appended (case-insensitive); null when nothing changes. */
function editedTags(current, add, remove) {
    const lower = (t) => t.toLowerCase();
    const kept = current.filter((t) => !remove.some((r) => lower(r) === lower(t)));
    const next = [...kept, ...add.filter((a, i) => !kept.some((t) => lower(t) === lower(a)) && add.findIndex((b) => lower(b) === lower(a)) === i)];
    return next.length === current.length && next.every((t, i) => t === current[i]) ? null : next;
}
/** `bodyDir`: enqueue's body directory (ForgeOptions.trackerBodyDir); unset, createItem and updateItem read no body file. */
export function adoTracker(ctx, intakeSource, bodyDir) {
    const tracker = {
        viewItem(id) {
            const item = readItem(ctx, id);
            const f = item.fields;
            const type = str(f['System.WorkItemType']) ?? '';
            const state = str(f['System.State']) ?? '';
            const category = type && state ? stateCategory(ctx, type, state) : undefined;
            const acceptance = adoHtmlToText(f['Microsoft.VSTS.Common.AcceptanceCriteria']);
            const [parent] = linkedIds(item.relations, PARENT);
            const project = str(f['System.TeamProject']);
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
                ...(parent !== undefined ? { parent } : {}),
                repoUrl: ctx.repo.url,
                ...(project ? { project } : {}),
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
        findByKey(spec) {
            const json = adoJson(adoCall(ctx, 'wit.wiql.POST', projectParams(ctx), { $top: KEY_QUERY_TOP }, { query: shipyardKeyWiql(spec) }), 'shipyard-key query');
            const ids = (isObject(json) && Array.isArray(json.workItems) ? json.workItems : [])
                .map((w) => (isObject(w) ? w.id : undefined))
                .filter((n) => Number.isSafeInteger(n) && n > 0);
            const found = [];
            for (const id of ids) {
                const item = tracker.viewItem(id);
                // Exactly one footer line for this spec, read from the item itself (WIQL CONTAINS only narrows).
                const keys = shipyardKeys(item.body).filter(([s]) => s === spec);
                if (keys.length === 1)
                    found.push({ key: keys[0][1], item });
            }
            return found;
        },
        createItem(draft) {
            const type = ctx.intakeItemTypes[0];
            if (!type)
                throw new Error('factory.intake.itemTypes names no work item type to create');
            const ops = itemFieldOps(draft, bodyDir);
            if (draft.labels.length)
                ops.push({ op: 'add', path: '/fields/System.Tags', value: draft.labels.join('; ') });
            // An area-tag intake source: the new item sits in its area path (its tag comes in draft.labels).
            if (intakeSource?.type === 'area-tag')
                ops.push({ op: 'add', path: '/fields/System.AreaPath', value: intakeSource.areaPath });
            const json = adoJson(adoCall(ctx, 'wit.workItems.POST', { ...projectParams(ctx), type }, {}, ops), `create ${type}`);
            if (!isObject(json) || !Number.isSafeInteger(json.id) || json.id <= 0)
                throw new Error(`create ${type}: malformed response`);
            return json.id;
        },
        updateItem(id, update) {
            const fields = itemFieldOps(update, bodyDir);
            const res = patchItem(ctx, id, (item) => {
                const tags = editedTags(splitTags(item.fields['System.Tags']), update.addLabels, update.removeLabels);
                if (tags && tags.length === 0)
                    throw new Error(`work item ${id}: removing its last tag is not a tracker write`);
                // The add replaces the whole list: the guard checks the edit against the tested current tags.
                const current = { op: 'test', path: '/fields/System.Tags', value: str(item.fields['System.Tags']) ?? '' };
                return tags ? [...fields, current, { op: 'add', path: '/fields/System.Tags', value: tags.join('; ') }] : fields;
            });
            if (!res.ok)
                throw new Error(`update work item ${id}: ${res.detail}`);
        },
        addRelation(id, kind, target) {
            const rel = Object.hasOwn(RELATION_OF, kind) ? RELATION_OF[kind] : undefined;
            if (!rel)
                throw new Error(`relation ${JSON.stringify(kind)} is not a tracker write`);
            if (!Number.isSafeInteger(target) || target <= 0 || target === id)
                throw new Error(`work item ${id} cannot link to ${target}`);
            const res = patchItem(ctx, id, (item) => {
                const linked = linkedIds(item.relations, rel);
                if (linked.includes(target))
                    return null;
                // A work item has one parent: a different one is a conflict for the captain, never replaced here.
                if (kind === 'parent' && linked.length > 0)
                    throw new Error(`work item ${id} already has parent ${linked[0]}`);
                // Work item ids are org-wide: the target must be an item of the forge project.
                const project = str(readItem(ctx, target).fields['System.TeamProject']);
                if (!project || project.toLowerCase() !== (ctx.repo.project ?? '').toLowerCase())
                    throw new Error(`work item ${target} is not in project ${ctx.repo.project}`);
                return [{ op: 'add', path: '/relations/-', value: { rel, url: `${adoOrgUrl(ctx.repo.owner)}/_apis/wit/workItems/${target}` } }];
            });
            if (!res.ok)
                throw new Error(`link work item ${id} to ${target}: ${res.detail}`);
        },
    };
    return tracker;
}
//# sourceMappingURL=tracker.js.map