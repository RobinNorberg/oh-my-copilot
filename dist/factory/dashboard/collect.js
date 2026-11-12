/**
 * `omg factory dashboard` data (goal 6): everything comes from LOCAL state,
 * the sealed run states under `.omg/state/factory/` (finished runs stay there)
 * and optional `bench-results/*.json`. No forge or network call.
 *
 * Every string taken from a run (issue title, park reason, finding text) is
 * untrusted, so it goes through plainText here and is HTML-escaped again at
 * render time (render.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { plainText } from '../check/score.js';
import { readRuns } from '../board/collect.js';
import { runCredits } from '../run/budget.js';
import { FACTORY_PHASES, runKeyOf, runLabel } from '../run/state.js';
export const DASHBOARD_SCHEMA_VERSION = 1;
const GATE_NOTE = /^awaiting-human: ([^:]+):/;
const MAX_BENCH_FILES = 50;
const MAX_BENCH_BYTES = 1_000_000;
const MAX_BENCH_ISSUES = 100;
const text = (v, max = 300) => plainText(String(v)).slice(0, max);
const emptyUsage = () => ({ credits: 0, premiumRequests: 0, lanes: 0 });
const round = (n) => Math.round(n * 1000) / 1000;
function add(into, credits, premiumRequests) {
    into.credits = round(into.credits + credits);
    into.premiumRequests += premiumRequests;
    into.lanes += 1;
}
const ms = (iso) => Date.parse(iso);
const isParkNote = (h) => h.from !== null && h.from === h.to;
/** Milliseconds per phase: each transition runs until the next one; the last runs to updatedAt (nothing once terminal). Park notes are not transitions. */
export function phaseDurations(s) {
    const out = {};
    const moves = s.history.filter((h) => !isParkNote(h));
    for (let i = 0; i < moves.length; i++) {
        const last = i === moves.length - 1;
        if (last && (moves[i].to === 'merged' || moves[i].to === 'cancelled' || moves[i].to === 'failed'))
            continue;
        const start = ms(moves[i].at);
        const end = last ? ms(s.updatedAt) : ms(moves[i + 1].at);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
            continue;
        out[moves[i].to] = (out[moves[i].to] ?? 0) + (end - start);
    }
    return out;
}
export function summarizeRun(s) {
    const roles = {};
    const total = emptyUsage();
    for (const lane of s.lanes) {
        const role = lane.role ?? lane.kind;
        const credits = lane.usage?.credits ?? 0;
        const requests = lane.usage?.premiumRequests ?? 0;
        add((roles[role] ??= emptyUsage()), credits, requests);
        add(total, credits, requests);
    }
    total.credits = round(runCredits(s));
    const parks = s.history.flatMap((h) => GATE_NOTE.exec(h.note)?.[1] ?? []).map((n) => text(n, 60));
    return {
        key: runLabel(runKeyOf(s)),
        kind: s.kind ?? 'issue',
        title: text(s.issueTitle ?? (s.heal ? 'ci-heal' : ''), 160),
        phase: s.phase,
        gate: s.gate ? { name: text(s.gate.name, 60), reason: text(s.gate.reason) } : null,
        pr: typeof s.pr === 'number' ? s.pr : null,
        createdAt: text(s.createdAt, 40),
        updatedAt: text(s.updatedAt, 40),
        elapsedMs: Number.isFinite(s.elapsedMs) ? s.elapsedMs : 0,
        phaseMs: phaseDurations(s),
        roles,
        parks,
        ...total,
    };
}
function scalarEntries(v) {
    const out = {};
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        return out;
    for (const [k, val] of Object.entries(v).slice(0, 40)) {
        if (typeof val === 'number' || typeof val === 'boolean')
            out[text(k, 60)] = val;
        else if (typeof val === 'string')
            out[text(k, 60)] = text(val, 120);
    }
    return out;
}
/** Read `bench-results/*.json`: a file counts when it parses and carries a numeric `schemaVersion`; anything else is skipped with a warning. */
export function readBenchResults(root, warnings) {
    const dir = join(root, 'bench-results');
    if (!existsSync(dir))
        return [];
    let names;
    try {
        names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort().slice(-MAX_BENCH_FILES);
    }
    catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        const path = join(dir, name);
        try {
            if (statSync(path).size > MAX_BENCH_BYTES)
                throw new Error('larger than 1 MB');
            const j = JSON.parse(readFileSync(path, 'utf8'));
            if (typeof j !== 'object' || j === null || typeof j.schemaVersion !== 'number')
                throw new Error('no numeric schemaVersion');
            const rows = Array.isArray(j.issues) ? j.issues.slice(0, MAX_BENCH_ISSUES) : [];
            const issues = rows.flatMap((r) => {
                const o = r;
                if (typeof o !== 'object' || o === null)
                    return [];
                const id = o.id ?? o.issue ?? o.key;
                const outcome = o.outcome ?? o.result ?? o.status;
                if ((typeof id !== 'string' && typeof id !== 'number') || (typeof outcome !== 'string' && typeof outcome !== 'boolean'))
                    return [];
                return [{ id: text(id, 60), outcome: text(outcome, 60), expect: typeof o.expect === 'string' ? text(o.expect, 60) : null }];
            });
            const stamp = j.createdAt ?? j.timestamp ?? j.startedAt;
            out.push({
                file: text(name, 120),
                schemaVersion: j.schemaVersion,
                createdAt: typeof stamp === 'string' ? text(stamp, 40) : null,
                mode: typeof j.mode === 'string' ? text(j.mode, 30) : null,
                totals: scalarEntries(j.totals),
                issues,
            });
        }
        catch (error) {
            warnings.push(`bench-results/${text(name, 120)}: skipped (${text(error instanceof Error ? error.message : error, 120)})`);
        }
    }
    return out;
}
/** Parse `--since`: a date (`2026-11-01`) or an ISO timestamp. */
export function parseSince(value) {
    const t = Date.parse(value.trim());
    if (!/^\d{4}-\d{2}-\d{2}/.test(value.trim()) || !Number.isFinite(t))
        throw new Error(`--since must be a date like 2026-11-01, got ${JSON.stringify(value)}`);
    return t;
}
export function collectDashboard(root, o = {}) {
    const warnings = [];
    const sinceMs = o.since === undefined ? null : parseSince(o.since);
    const { runs: states } = readRuns(root, warnings);
    const inRange = [...states.values()].filter((s) => sinceMs === null || !(ms(s.updatedAt) < sinceMs));
    const runs = inRange
        .map(summarizeRun)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.key.localeCompare(b.key)));
    const totals = { ...emptyUsage(), runs: runs.length, elapsedMs: 0 };
    const statuses = new Map();
    const parks = new Map();
    const phases = new Map();
    const roles = new Map();
    const days = new Map();
    for (const r of runs) {
        totals.credits = round(totals.credits + r.credits);
        totals.premiumRequests += r.premiumRequests;
        totals.lanes += r.lanes;
        totals.elapsedMs += r.elapsedMs;
        const status = r.gate ? `awaiting-human: ${r.gate.name}` : r.phase;
        statuses.set(status, (statuses.get(status) ?? 0) + 1);
        for (const p of r.parks)
            parks.set(p, (parks.get(p) ?? 0) + 1);
        for (const [p, v] of Object.entries(r.phaseMs))
            phases.set(p, (phases.get(p) ?? 0) + v);
        for (const [role, u] of Object.entries(r.roles)) {
            const into = roles.get(role) ?? emptyUsage();
            into.credits = round(into.credits + u.credits);
            into.premiumRequests += u.premiumRequests;
            into.lanes += u.lanes;
            roles.set(role, into);
        }
    }
    // Per day: by the lane's end (else start) time.
    for (const s of inRange) {
        for (const lane of s.lanes) {
            const t = ms(lane.endedAt ?? lane.startedAt);
            if (!Number.isFinite(t) || (sinceMs !== null && t < sinceMs))
                continue;
            const day = new Date(t).toISOString().slice(0, 10);
            const into = days.get(day) ?? emptyUsage();
            add(into, lane.usage?.credits ?? 0, lane.usage?.premiumRequests ?? 0);
            days.set(day, into);
        }
    }
    const order = (p) => { const i = FACTORY_PHASES.indexOf(p); return i < 0 ? 99 : i; };
    return {
        schemaVersion: DASHBOARD_SCHEMA_VERSION,
        generatedAt: (o.now?.() ?? new Date()).toISOString(),
        since: o.since === undefined ? null : text(o.since, 40),
        runs,
        totals,
        statuses: [...statuses].map(([phase, count]) => ({ phase, count })).sort((a, b) => b.count - a.count || a.phase.localeCompare(b.phase)),
        parkReasons: [...parks].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        phaseMs: [...phases].map(([phase, v]) => ({ phase, ms: v })).sort((a, b) => order(a.phase) - order(b.phase)),
        byRole: [...roles].map(([role, u]) => ({ role, ...u })).sort((a, b) => b.credits - a.credits || a.role.localeCompare(b.role)),
        byDay: [...days].map(([day, u]) => ({ day, ...u })).sort((a, b) => (a.day < b.day ? -1 : 1)),
        bench: readBenchResults(root, warnings),
        warnings,
    };
}
//# sourceMappingURL=collect.js.map