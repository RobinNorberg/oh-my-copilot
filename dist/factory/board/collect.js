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
import chalk from 'chalk';
import { readdirSync } from 'fs';
import { CheckIncompatibleError, CheckUsageError, checkEnvFor, forgeLimitations, openReadForge, parseItemId } from '../check/cli.js';
import { checkItems, plainText } from '../check/score.js';
import { PROGRESS_STAGES } from '../../forge/types.js';
import { latestVerdict, readShipState } from '../../ship/state.js';
import { runCredits } from '../run/budget.js';
import { FactorySafetyError } from '../run/exec.js';
import { factoryOwnerPath, factoryStateDir, ownerHolding, readFactoryState, runKeyOf, runLabel, TERMINAL_FACTORY_PHASES, trackerStageOf, verifyFactoryIntegrity, } from '../run/state.js';
import { renderBoard } from './render.js';
/** Bumped on any change to the `--json` shape (src/factory/board/__tests__ pins it). */
export const BOARD_JSON_SCHEMA_VERSION = 1;
/** A non-terminal run without a gate whose state has not changed for this long is likely lost (the watchdog's idea). */
export const BOARD_STALE_MS = 24 * 60 * 60 * 1000;
const RUN_FILE = /^run-(\d+|heal-[0-9a-f]{8})\.json$/;
const message = (error) => plainText(error instanceof Error ? error.message : String(error));
/** Every run state on disk; an unreadable one is a warning (and, for an item in the source, a `seal` flag). */
export function readRuns(root, warnings) {
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
/** The live engine of a run, read-only (an unreadable owner file shows nothing: the engine's own claim decides). */
function liveOf(root, s) {
    const h = ownerHolding(factoryOwnerPath(root, runKeyOf(s)));
    return h === null || h === 'unreadable' ? {} : { live: { pid: h.pid, host: plainText(h.hostname), since: plainText(String(h.startedAt)) } };
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
        ...liveOf(root, s),
        credits: Number(runCredits(s).toFixed(2)),
        integrity,
        updatedAt: plainText(s.updatedAt),
        ...(s.layout === 2 && s.privateDir ? { privateDir: plainText(s.privateDir) } : {}),
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
/** The merge park's human-review clause, as the engine read the PR when it parked. */
const PARKED_REVIEW = /; human review: [\s\S]*?; if the PR gets new review comments before you merge, rerun [^;]*? first/;
/** The merge park's closing step (engine.ts merge gate): ": run <merge command>, then <rerun>". */
const PARKED_MERGE_STEP = /: run [^;]*, then [^;]*$/;
/**
 * F50: on the local forge, a run parked at the merge gate shows the PR's
 * review state now, not the clause the engine wrote at the park: a change
 * request or open note recorded since (`omg factory pr review`) replaces
 * "no open trusted threads or change requests" with a do-not-merge line.
 * A local read only (the PR store); other forges keep the parked text.
 */
function reviewNow(forge, s, row, warnings) {
    const gate = row.run?.gate;
    if (forge.kind !== 'local' || !gate || s.gate?.name !== 'merge' || s.pr === undefined || !s.head || !forge.reviews.reviewFeedback)
        return;
    let fb;
    try {
        fb = forge.reviews.reviewFeedback(s.pr, s.head);
    }
    catch (error) {
        if (error instanceof FactorySafetyError)
            throw error;
        warnings.push(`omg factory board: the review state of local PR #${s.pr} is unreadable: ${message(error)}`);
        return;
    }
    const by = [...new Set(fb.decisions.filter((d) => d.state === 'changes-requested').map((d) => d.author))];
    if (by.length === 0 && fb.threads.length === 0)
        return;
    const what = [fb.threads.length > 0 ? `${fb.threads.length} open review note(s)` : '', by.length > 0 ? `changes requested by ${by.join(', ')}` : ''].filter(Boolean).join(' and ');
    // The parked ": run <merge command>, then <rerun>" tail goes too: it would tell the human to merge.
    gate.reason = plainText(`${gate.reason.replace(PARKED_REVIEW, '').replace(PARKED_MERGE_STEP, '')}; human review now: ${what} on local PR #${s.pr}: do not merge${typeof s.issue === 'number' && s.kind !== 'ci-heal' ? `; omg factory run ${s.issue} reads it` : ''}`);
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
        reviewNow(forge, s, row, warnings);
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
        reviewNow(forge, s, row, warnings);
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
    if (forge.kind === 'local') {
        // The local backlog's working tree: an item not committed on the base is untrusted, and omg factory run cannot start it yet.
        for (const id of ids) {
            try {
                const item = forge.tracker.viewItem(id);
                if (item.uncommitted)
                    warnings.push(`omg factory board: #${id} (${item.url}) is uncommitted: untrusted until it is committed on ${base}`);
            }
            catch (error) {
                if (error instanceof FactorySafetyError)
                    throw error;
            }
        }
    }
    warnings.push(...(forge.tracker.warnings?.() ?? []));
    const limitations = forgeLimitations(forge, base);
    const json = {
        schemaVersion: BOARD_JSON_SCHEMA_VERSION,
        ok: !board.readFailed,
        forge: config.kind,
        limitations,
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
        for (const l of limitations)
            deps.out(chalk.gray(l));
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