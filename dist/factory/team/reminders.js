/**
 * Stale-gate reminders (night-3 goal 5), one self-contained step of
 * `omg factory poll`. A run parked at a human gate (awaiting-human) for longer
 * than `factory.poll.remindAfterHours` (default 24; 0 = off) is reminded at
 * most once per window, mentioning the routing handles of the paths its plan
 * names. READ-ONLY on git and the forge: the routing file comes from the
 * base commit through the caller's read shape, nothing is fetched, and the
 * result is printed by poll. The step keeps its own record,
 * `<state>/factory/reminders.json`; it never writes a sealed run state.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync, ensureDirSync } from '../../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../../lib/file-lock.js';
import { visibleLine } from '../../forge/review-feedback.js';
import { factoryStateDir, runLabel, TERMINAL_FACTORY_PHASES, verifyFactoryIntegrity } from '../run/state.js';
import { pathsInText, TEAM_ROUTING_PATH } from './context.js';
import { parseRouting, routeFor } from './routing.js';
export const remindersPath = (root) => join(factoryStateDir(root), 'reminders.json');
function readRecord(path) {
    if (!existsSync(path))
        return {};
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return {};
        const out = {};
        for (const [k, v] of Object.entries(raw)) {
            const r = v;
            if (r && typeof r.gateAt === 'string' && typeof r.remindedAt === 'string')
                out[k] = { gateAt: r.gateAt, remindedAt: r.remindedAt };
        }
        return out;
    }
    catch {
        return {};
    }
}
/** The reminders due now; records them so the same run is reminded once per window. */
export function staleGateReminders(o) {
    if (!o.afterHours || o.afterHours <= 0)
        return [];
    const windowMs = o.afterHours * 3_600_000;
    const path = remindersPath(o.root);
    ensureDirSync(join(path, '..'));
    return withFileLockSync(lockPathFor(path), () => {
        const before = readRecord(path);
        const next = {};
        const due = [];
        let routes;
        for (const [key, s] of o.runs) {
            if (!s.gate || TERMINAL_FACTORY_PHASES.includes(s.phase))
                continue;
            const label = runLabel(key);
            if (!verifyFactoryIntegrity(s)) {
                o.warn?.(`reminder: ${label} is unsound (its state fails the integrity seal), skipped`);
                continue;
            }
            const parkedAt = Date.parse(s.gate.at);
            if (!Number.isFinite(parkedAt))
                continue;
            const rec = before[label];
            const last = rec && rec.gateAt === s.gate.at ? Date.parse(rec.remindedAt) : parkedAt;
            if (!Number.isFinite(last) || o.nowMs - last < windowMs) {
                if (rec && rec.gateAt === s.gate.at)
                    next[label] = rec;
                continue;
            }
            if (routes === undefined) {
                routes = [];
                try {
                    const text = o.readBase?.(TEAM_ROUTING_PATH);
                    if (text !== undefined) {
                        const parsed = parseRouting(text);
                        routes = parsed.routes;
                        for (const w of parsed.warnings)
                            o.warn?.(w);
                    }
                }
                catch (error) {
                    o.warn?.(visibleLine(`routing.md unreadable at the base commit: ${error instanceof Error ? error.message : String(error)}`));
                }
            }
            const handles = [...new Set(routeFor(routes, pathsInText(s.plan?.text ?? '')).flatMap((r) => (r.handle ? [r.handle] : [])))];
            due.push({ run: key, gate: visibleLine(s.gate.name), hours: Math.floor((o.nowMs - parkedAt) / 3_600_000), handles, reason: visibleLine(s.gate.reason).slice(0, 300) });
            next[label] = { gateAt: s.gate.at, remindedAt: new Date(o.nowMs).toISOString() };
        }
        if (JSON.stringify(next) !== JSON.stringify(before))
            atomicWriteFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
        return due;
    }, { timeoutMs: 5_000 });
}
//# sourceMappingURL=reminders.js.map