/**
 * Steps 4 and 7 of `omg factory setup` (factory forges design §4, critic
 * amendments §A.11): the intake source, checked against the forge, and the
 * preview of its first items. GitHub intake is a label or a milestone
 * (Projects v2 is cut for now). Azure DevOps intake is a saved flat WIQL
 * query (GUID), a board column, or an area path plus a tag.
 *
 * Spec syntax (`--intake`): `label:<name>`, `milestone:<title>`,
 * `wiql-query:<guid>`, `board-column:<team>/<board>/<column>`,
 * `area-tag:<area path>#<tag>`.
 */
import { listLabels } from '../../cli/commands/intake.js';
import { adoGet, adoList, milestonesPath, safeStderr, SetupError } from './guard.js';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GITHUB_INTAKE_TYPES = ['label', 'milestone'];
export const ADO_INTAKE_TYPES = ['wiql-query', 'board-column', 'area-tag'];
export function parseIntakeSpec(spec, kind) {
    const at = spec.indexOf(':');
    const type = at > 0 ? spec.slice(0, at) : spec;
    const rest = at > 0 ? spec.slice(at + 1) : '';
    const allowed = kind === 'github' ? GITHUB_INTAKE_TYPES : ADO_INTAKE_TYPES;
    if (!allowed.includes(type)) {
        const hint = type === 'project-column' ? ' (GitHub Projects v2 intake is not supported yet)' : '';
        throw new SetupError(2, `--intake ${JSON.stringify(spec)}: the ${kind} sources are ${allowed.map((t) => `${t}:…`).join(', ')}${hint}`);
    }
    const empty = () => {
        throw new SetupError(2, `--intake ${JSON.stringify(spec)} has an empty value`);
    };
    switch (type) {
        case 'label':
            return { type, label: rest || empty() };
        case 'milestone':
            return { type, milestone: rest || empty() };
        case 'wiql-query':
            if (!GUID.test(rest))
                throw new SetupError(2, `--intake wiql-query needs a saved-query GUID, got ${JSON.stringify(rest)}`);
            return { type, queryId: rest.toLowerCase() };
        case 'board-column': {
            const parts = rest.split('/');
            if (parts.length !== 3 || parts.some((p) => !p))
                throw new SetupError(2, '--intake board-column needs <team>/<board>/<column>');
            return { type, team: parts[0], board: parts[1], column: parts[2] };
        }
        default: {
            const hash = rest.lastIndexOf('#');
            if (hash <= 0 || hash === rest.length - 1)
                throw new SetupError(2, '--intake area-tag needs <area path>#<tag>');
            return { type: 'area-tag', areaPath: rest.slice(0, hash), tag: rest.slice(hash + 1) };
        }
    }
}
export function formatIntakeSpec(s) {
    switch (s.type) {
        case 'label': return `label:${s.label}`;
        case 'milestone': return `milestone:${s.milestone}`;
        case 'wiql-query': return `wiql-query:${s.queryId}`;
        case 'board-column': return `board-column:${s.team}/${s.board}/${s.column}`;
        case 'area-tag': return `area-tag:${s.areaPath}#${s.tag}`;
    }
}
// ---- forge listings (read-only, through the setup guard) ----
export function githubLabels(io) {
    const list = listLabels(io.cwd, (cmd, args, o) => io.exec(cmd, args, { cwd: o.cwd }));
    if (!list.ok)
        throw new SetupError(5, list.reason);
    return list.names;
}
export function githubMilestones(io) {
    const r = io.exec('gh', ['api', '--hostname', io.repo.host, '--method', 'GET', milestonesPath(io.repo)], { cwd: io.cwd });
    if (r.status !== 0)
        throw new SetupError(5, `cannot list milestones (exit ${r.status}): ${safeStderr(r.stderr)}`);
    try {
        return JSON.parse(r.stdout).map((m) => m.title).filter((t) => typeof t === 'string');
    }
    catch {
        throw new SetupError(5, 'cannot parse the milestone list');
    }
}
/** Flat saved queries only (a tree or one-hop query yields links, not items). */
export function adoSavedQueries(io) {
    const body = adoGet(io, 'wit.queries.GET', { project: io.repo.project }, { $depth: '2', $expand: 'wiql' });
    const out = [];
    const walk = (nodes) => {
        for (const n of nodes) {
            if (n.isFolder === true)
                walk(Array.isArray(n.children) ? n.children : []);
            else if (typeof n.id === 'string' && (n.queryType === undefined || n.queryType === 'flat'))
                out.push({ id: n.id.toLowerCase(), path: String(n.path ?? n.name ?? n.id) });
        }
    };
    walk(adoList(body));
    return out;
}
export function adoTeams(io) {
    return adoList(adoGet(io, 'core.teams.GET', { projectId: io.repo.project })).map((t) => t.name).filter((n) => typeof n === 'string');
}
export function adoBoards(io, team) {
    return adoList(adoGet(io, 'work.boards.GET', { project: io.repo.project, team })).map((b) => b.name).filter((n) => typeof n === 'string');
}
export function adoBoardColumns(io, team, board) {
    return adoList(adoGet(io, 'work.columns.GET', { project: io.repo.project, team, board })).map((c) => c.name).filter((n) => typeof n === 'string');
}
/** Area paths as WIQL spells them: `Project\Child\Grandchild`. */
export function adoAreaPaths(io) {
    const root = adoGet(io, 'wit.classificationNodes.GET', { project: io.repo.project, structureGroup: 'areas' }, { $depth: '5' });
    const out = [];
    const walk = (node, prefix) => {
        if (typeof node.name !== 'string')
            return;
        const path = prefix ? `${prefix}\\${node.name}` : node.name;
        out.push(path);
        for (const child of Array.isArray(node.children) ? node.children : [])
            walk(child, path);
    };
    if (root && typeof root === 'object')
        walk(root, '');
    return out;
}
export function adoWorkItemTypes(io) {
    return adoList(adoGet(io, 'wit.workItemTypes.GET', { project: io.repo.project }))
        .filter((t) => t.isDisabled !== true)
        .map((t) => t.name)
        .filter((n) => typeof n === 'string');
}
const has = (list, value) => list.some((v) => v.toLowerCase() === value.toLowerCase());
/**
 * Check a source against the forge. Returns the labels that do not exist yet
 * (a GitHub label source the wizard may create); throws SetupError(5) when the
 * milestone, query, board, column or area does not exist.
 */
export function validateIntake(io, source, labels) {
    switch (source.type) {
        case 'label':
            return { missingLabels: has(labels ?? githubLabels(io), source.label) ? [] : [source.label] };
        case 'milestone':
            if (!githubMilestones(io).includes(source.milestone))
                throw new SetupError(5, `unknown milestone ${JSON.stringify(source.milestone)}: not an open milestone of ${io.repo.owner}/${io.repo.name}`);
            return { missingLabels: [] };
        case 'wiql-query':
            if (!adoSavedQueries(io).some((q) => q.id === source.queryId))
                throw new SetupError(5, `unknown query ${source.queryId}: not a flat saved query in project ${io.repo.project}`);
            return { missingLabels: [] };
        case 'board-column':
            if (!has(adoBoards(io, source.team), source.board))
                throw new SetupError(5, `unknown board ${JSON.stringify(source.board)} for team ${JSON.stringify(source.team)}`);
            if (!has(adoBoardColumns(io, source.team, source.board), source.column))
                throw new SetupError(5, `unknown column ${JSON.stringify(source.column)} on board ${JSON.stringify(source.board)}`);
            return { missingLabels: [] };
        case 'area-tag':
            if (!has(adoAreaPaths(io), source.areaPath))
                throw new SetupError(5, `unknown area path ${JSON.stringify(source.areaPath)} in project ${io.repo.project}`);
            return { missingLabels: [] };
    }
}
/** Interactive step 4. `prefill` seeds the ADO answers (area path, team). */
export async function pickIntake(io, prompter, prefill = {}) {
    if (io.repo.kind === 'github') {
        const type = await prompter.select('Intake source', GITHUB_INTAKE_TYPES);
        if (type === 'milestone') {
            const milestones = githubMilestones(io);
            if (milestones.length === 0)
                throw new SetupError(5, `${io.repo.owner}/${io.repo.name} has no open milestone`);
            return { type: 'milestone', milestone: await prompter.select('Milestone', milestones) };
        }
        const label = await prompter.input('Intake label (created after confirmation when missing)', 'factory');
        return { type: 'label', label };
    }
    const type = await prompter.select('Intake source', ADO_INTAKE_TYPES);
    if (type === 'wiql-query') {
        const queries = adoSavedQueries(io);
        if (queries.length === 0)
            throw new SetupError(5, `project ${io.repo.project} has no flat saved query`);
        const picked = await prompter.select('Saved query', queries.map((q) => `${q.path} (${q.id})`));
        return { type: 'wiql-query', queryId: queries[queries.map((q) => `${q.path} (${q.id})`).indexOf(picked)].id };
    }
    if (type === 'board-column') {
        const teams = adoTeams(io);
        const team = prefill.team && has(teams, prefill.team) ? prefill.team : await prompter.select('Team', teams);
        const board = await prompter.select('Board', adoBoards(io, team));
        const column = await prompter.select('Column', adoBoardColumns(io, team, board));
        return { type: 'board-column', team, board, column };
    }
    const areas = adoAreaPaths(io);
    const areaPath = prefill.areaPath && has(areas, prefill.areaPath) ? prefill.areaPath : await prompter.select('Area path', areas);
    const tag = await prompter.input('Tag', 'factory');
    return { type: 'area-tag', areaPath, tag };
}
export const READINESS_PLACEHOLDER = 'readiness: run `omg factory check`';
export const listOnlyPreview = (forge, ids) => ids.map((id) => {
    const item = forge.tracker.viewItem(id);
    return { id: item.id, title: item.title, url: item.url, readiness: READINESS_PLACEHOLDER };
});
export const PREVIEW_LIMIT = 10;
export function previewIntake(forge, source, check = listOnlyPreview) {
    return check(forge, forge.tracker.queryItems(source, PREVIEW_LIMIT).slice(0, PREVIEW_LIMIT));
}
//# sourceMappingURL=intake-pick.js.map