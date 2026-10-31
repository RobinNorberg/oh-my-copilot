/**
 * `omg factory board [--source <spec> | --parent <spec>] [--limit n] [--no-check] [--json]`
 * (ADO parity design §1): a read-only, forge-neutral view across items. It
 * joins the `omg factory check` buckets (checkItems, the same rules), the
 * run state under `.omg/state/factory` (phase, gate, PR, head, lanes,
 * credits, integrity) and the tracker's live stage (GitHub progress labels,
 * ADO board column or state, reverse-mapped through factory.progress.stages).
 * Items with no run sit in `backlog`, sub-grouped by bucket; a run sits in
 * the column of its expected tracker stage (trackerStageOf). `--parent`
 * shows a spec's children (as `check --parent`), and a run parked at the
 * engine's blocked-by gate shows in `blocked` with the gate's reason. Runs
 * in flight whose key is not in the source (an explicit id, ci-heal) are
 * listed under `outside`.
 *
 * Everything goes through openReadForge: check's read guard with no marker,
 * so no tracker or forge write passes; the board writes nothing, not even
 * local state. `--no-check` skips the rules and reads the live stages with
 * one batched `tracker.peekItems` (Azure DevOps), or viewItem per item.
 *
 * Exit codes: 0 shown; 1 an item could not be read; 2 usage; 5 incompatible
 * (forge mismatch, unsupported remote, no intake source and no runs).
 */
import { readdirSync } from 'fs';
import { CheckIncompatibleError, CheckUsageError, checkEnvFor, openReadForge, parseItemId } from '../check/cli.js';
import { checkItems, plainText } from '../check/score.js';
import { PROGRESS_STAGES } from '../../forge/types.js';
import { latestVerdict, readShipState } from '../../ship/state.js';
import { runCredits } from '../run/budget.js';
import { FactorySafetyError } from '../run/exec.js';
import { factoryStateDir, readFactoryState, runLabel, TERMINAL_FACTORY_PHASES, trackerStageOf, verifyFactoryIntegrity, } from '../run/state.js';
import { renderBoard } from './render.js';
/** Bumped on any change to the `--json` shape (src/factory/board/__tests__ pins it). */
export const BOARD_JSON_SCHEMA_VERSION = 1;
/** A non-terminal run without a gate whose state has not changed for this long is likely lost (the watchdog's idea). */
export const BOARD_STALE_MS = 24 * 60 * 60 * 1000;
const RUN_FILE = /^run-(\d+|heal-[0-9a-f]{8})\.json$/;
const message = (error) => plainText(error instanceof Error ? error.message : String(error));
/** Every run state on disk; an unreadable one is a warning (and, for an item in the source, a `seal` flag). */
function readRuns(root, warnings) {
    const runs = new Map();
    const broken = new Set();
    let names;
    try {
        names = readdirSync(factoryStateDir(root));
    }
    catch {
        return { runs, broken };
    }
    for (const name of names.sort()) {
        const m = RUN_FILE.exec(name);
        if (!m)
            continue;
        const key = /^\d+$/.test(m[1]) ? Number(m[1]) : m[1];
        try {
            const state = readFactoryState(root, key);
            if (state)
                runs.set(key, state);
        }
        catch (error) {
            broken.add(key);
            warnings.push(`omg factory board: run state ${runLabel(key)} is unreadable: ${message(error)}`);
        }
    }
    return { runs, broken };
}
const same = (a, b) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
/**
 * The stage the tracker shows now, reverse-mapped through the progress
 * stages: GitHub a progress label; ADO the board column, else the state.
 * When several stages match (ADO stages often share a state), the recorded
 * one wins, so an ambiguous mapping is never reported as drift.
 */
export function liveStage(kind, stages, item, recorded) {
    const pick = (hits, text) => {
        const stage = recorded !== undefined && hits.includes(recorded) ? recorded : hits[0];
        return { stage, text: text(stage) };
    };
    if (kind === 'github') {
        const hits = PROGRESS_STAGES.filter((s) => item.labels.some((l) => same(l, stages[s]?.label)));
        return hits.length ? pick(hits, (s) => stages[s]?.label) : { stage: 'unmapped' };
    }
    const byColumn = PROGRESS_STAGES.filter((s) => same(item.column, stages[s]?.column));
    if (byColumn.length)
        return pick(byColumn, () => item.column);
    const byState = PROGRESS_STAGES.filter((s) => same(item.state, stages[s]?.state));
    if (byState.length)
        return pick(byState, () => item.state);
    return { stage: 'unmapped', text: item.column ?? (item.state || undefined) };
}
/** Whether the engine would write `expected` to the tracker (engine.ts syncProgress): only then can recorded lag behind it. */
function wouldSync(config, s, expected) {
    if (!config.progress.enabled || s.kind === 'ci-heal' || s.phase === 'intake')
        return false;
    if (expected === 'cancelled')
        return s.trackerStage !== undefined;
    const m = config.progress.stages[expected];
    return Boolean(m?.label || m?.column || m?.state);
}
/** The column title: the progress mapping's label, column or state when progress is configured, else the stage name. */
function columnTitle(config, stage) {
    if (stage === 'backlog' || !config.progress.enabled)
        return stage;
    const m = config.progress.stages[stage];
    return plainText(m?.label ?? m?.column ?? m?.state ?? stage);
}
function runPart(root, s, warnings) {
    const integrity = verifyFactoryIntegrity(s) ? 'ok' : s.integrity === undefined ? 'none' : 'bad';
    const running = s.lanes.find((l) => l.status === 'running');
    const run = {
        phase: s.phase,
        ...(s.gate ? { gate: { name: plainText(s.gate.name), reason: plainText(s.gate.reason) } } : {}),
        ...(s.pr !== undefined ? { pr: s.pr } : {}),
        ...(s.head ? { head: plainText(s.head) } : {}),
        lanes: s.lanes.length,
        ...(running ? { runningLane: plainText(running.id) } : {}),
        credits: Number(runCredits(s).toFixed(2)),
        integrity,
        updatedAt: plainText(s.updatedAt),
    };
    if (s.pr === undefined)
        return { run };
    try {
        const ship = readShipState(root, s.pr);
        const v = ship ? latestVerdict(ship) : undefined;
        return v ? { run, gates: { verdict: plainText(v.verdict), sha: v.sha, at: plainText(v.at) } } : { run };
    }
    catch (error) {
        warnings.push(`omg factory board: ship state of PR ${s.pr} is unreadable: ${message(error)}`);
        return { run };
    }
}
function flagsOf(config, s, row, now) {
    const flags = [];
    const { expected, recorded, live } = row.stage;
    if (live !== undefined && recorded !== undefined && live !== recorded)
        flags.push('drift');
    if (expected !== undefined && recorded !== expected && wouldSync(config, s, expected))
        flags.push('unsynced');
    if (row.run?.integrity !== 'ok')
        flags.push('seal');
    const updated = Date.parse(s.updatedAt);
    if (!TERMINAL_FACTORY_PHASES.includes(s.phase) && !s.gate && Number.isFinite(updated) && now - updated > BOARD_STALE_MS)
        flags.push('stale');
    return flags;
}
/** Item reads go through a memo, so check's viewItem reads also give the board its live labels and column. */
function memoTracker(forge) {
    const seen = new Map();
    const tracker = Object.assign(Object.create(forge.tracker), {
        viewItem: (id) => {
            const hit = seen.get(id);
            if (hit)
                return hit;
            const item = forge.tracker.viewItem(id);
            seen.set(id, item);
            return item;
        },
    });
    return { forge: Object.assign(Object.create(forge), { tracker }), seen };
}
export function collectBoard(input) {
    const { config, root, now, warnings } = input;
    const ids = [...new Set(input.ids)];
    const { forge, seen } = memoTracker(input.forge);
    const { runs, broken } = readRuns(root, warnings);
    // The item part of each row: check results (and their memoized reads), or one batched peek.
    const rows = new Map();
    const live = new Map();
    let order;
    if (input.check) {
        const results = checkItems(forge, ids, input.check);
        order = results.map((r) => r.id);
        for (const r of results) {
            const failed = r.reasons[0] === 'read-failed' || r.reasons[0] === 'wrong-type';
            rows.set(r.id, {
                id: r.id, title: r.title, url: r.url,
                ...(failed && !seen.has(r.id) ? { error: r.detail } : {}),
                check: { bucket: r.bucket, priority: r.priority, reasons: r.reasons, detail: r.detail },
                stage: {}, flags: [],
            });
            const item = seen.get(r.id);
            if (item)
                live.set(r.id, { labels: item.labels, column: item.column, state: item.rawState });
        }
    }
    else {
        order = [...ids].sort((a, b) => a - b);
        let peeked;
        if (forge.tracker.peekItems) {
            try {
                // The batch guard takes plain 1-10 digit ids; any other id is a read-failed row, not a board abort.
                peeked = forge.tracker.peekItems(ids.filter((id) => /^[1-9]\d{0,9}$/.test(String(id))));
            }
            catch (error) {
                // A guard refusal is a bug, never an unreadable item.
                if (error instanceof FactorySafetyError)
                    throw error;
                warnings.push(`omg factory board: the batched item read failed: ${message(error)}`);
                peeked = new Map();
            }
        }
        for (const id of order) {
            let p = peeked?.get(id);
            let error;
            if (!peeked) {
                try {
                    const item = forge.tracker.viewItem(id);
                    p = { title: item.title, url: item.url, labels: item.labels, column: item.column, state: item.rawState };
                }
                catch (e) {
                    if (e instanceof FactorySafetyError)
                        throw e;
                    error = `#${id} could not be read: ${message(e)}`;
                }
            }
            else if (!p) {
                error = `#${id} could not be read`;
            }
            rows.set(id, { id, title: plainText(p?.title ?? ''), url: plainText(p?.url ?? ''), ...(error ? { error } : {}), stage: {}, flags: [] });
            if (p)
                live.set(id, { labels: p.labels, column: p.column, state: p.state });
        }
    }
    const columns = ['backlog', ...PROGRESS_STAGES].map((stage) => ({ stage, title: columnTitle(config, stage), items: [] }));
    const column = (stage) => columns.find((c) => c.stage === stage);
    for (const id of order) {
        const row = rows.get(id);
        const s = runs.get(id);
        if (!s) {
            if (broken.has(id))
                row.flags.push('seal');
            const l = live.get(id);
            if (l && config.progress.enabled) {
                const found = liveStage(config.kind, config.progress.stages, l);
                if (found.stage !== 'unmapped')
                    row.stage.live = found.stage;
            }
            column('backlog').items.push(row);
            continue;
        }
        Object.assign(row, runPart(root, s, warnings));
        if (!row.title && s.issueTitle)
            row.title = plainText(s.issueTitle);
        const expected = trackerStageOf(s);
        row.stage = { expected, ...(s.trackerStage ? { recorded: s.trackerStage } : {}) };
        const l = live.get(id);
        if (l && config.progress.enabled) {
            const found = liveStage(config.kind, config.progress.stages, l, s.trackerStage);
            row.stage.live = found.stage;
            if (found.text)
                row.liveText = plainText(found.text);
        }
        row.flags = flagsOf(config, s, row, now);
        column(expected).items.push(row);
    }
    const inSource = new Set(ids);
    const outside = [];
    for (const [key, s] of runs) {
        if (inSource.has(key) || TERMINAL_FACTORY_PHASES.includes(s.phase))
            continue;
        if (s.forgeKind !== undefined && s.forgeKind !== config.kind)
            warnings.push(`omg factory board: run ${runLabel(key)} started on ${s.forgeKind}, but the forge resolves to ${config.kind}`);
        const row = { id: key, title: plainText(s.issueTitle ?? (s.kind === 'ci-heal' ? 'ci-heal' : '')), url: '', stage: { expected: trackerStageOf(s), ...(s.trackerStage ? { recorded: s.trackerStage } : {}) }, flags: [] };
        Object.assign(row, runPart(root, s, warnings));
        row.flags = flagsOf(config, s, row, now);
        outside.push(row);
    }
    outside.sort((a, b) => (typeof a.id === typeof b.id ? (a.id < b.id ? -1 : 1) : typeof a.id === 'number' ? -1 : 1));
    for (const c of columns)
        if (c.stage !== 'backlog')
            c.items.sort((a, b) => a.id - b.id);
    return { columns, outside, readFailed: [...rows.values()].some((r) => r.error !== undefined || r.check?.reasons[0] === 'read-failed') };
}
/** Show one board; returns the exit code. Errors other than usage / incompatible propagate (exit 1 at the CLI). */
export async function runFactoryBoard(o, deps) {
    const parent = o.parent === undefined ? undefined : parseItemId(o.parent);
    if (parent !== undefined && o.source !== undefined)
        throw new CheckUsageError('--parent and --source are exclusive');
    if (parent !== undefined && o.limit !== undefined)
        throw new CheckUsageError('--limit applies to an intake source; --parent shows every child of the spec');
    const warnings = [];
    const checkDeps = { ...deps, isTTY: () => false, confirm: async () => false };
    const { root, base, baseSha, config, forge, exec } = openReadForge(o, checkDeps, warnings, 'omg factory board');
    const source = config.intake.source;
    let spec = null;
    let ids = [];
    if (parent !== undefined) {
        const item = forge.tracker.viewItem(parent);
        spec = { id: item.id, title: plainText(item.title), url: plainText(item.url) };
        ids = item.children;
    }
    else if (source) {
        ids = forge.tracker.queryItems(source, config.intake.limit);
    }
    else if (!hasRuns(root)) {
        throw new CheckIncompatibleError('no intake source and no factory runs: pass --source <spec> or --parent <spec>, or set factory.intake.source');
    }
    const env = o.check === false ? null : checkEnvFor(exec, root, config, base, baseSha);
    const board = collectBoard({ forge, config, root, ids, check: env, now: (deps.now ?? Date.now)(), warnings });
    const json = {
        schemaVersion: BOARD_JSON_SCHEMA_VERSION,
        ok: !board.readFailed,
        forge: config.kind,
        repo: config.repo.url,
        source: parent !== undefined || !source ? null : Object.fromEntries(Object.entries(source).map(([k, v]) => [k, typeof v === 'string' ? plainText(v) : v])),
        parent: spec,
        columns: board.columns,
        outside: board.outside,
        warnings: warnings.map(plainText),
    };
    if (o.json) {
        deps.out(JSON.stringify(json, null, 2));
    }
    else {
        for (const w of json.warnings)
            deps.err(w);
        deps.out(renderBoard(json));
    }
    return json.ok ? 0 : 1;
}
/** Whether any run state file exists (the board without a source shows only those). */
function hasRuns(root) {
    try {
        return readdirSync(factoryStateDir(root)).some((n) => RUN_FILE.test(n));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=collect.js.map