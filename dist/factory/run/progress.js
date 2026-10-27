/**
 * `omg progress` events for a factory run (design §9): agent `factory-<issue>`,
 * file `<state root>/progress/factory-<issue>.log`. Each phase emits `start`
 * then `ok` or `fail`; a human gate emits `blocked` with `note=<gate>:<reason>`;
 * cancel emits `done`; lane waits emit a `heartbeat` at most every 60 s.
 * Emitting never throws (emitProgress is best effort by contract).
 */
import { join } from 'path';
import { defaultProgressDir, emitProgress } from '../../lib/agent-progress.js';
export const HEARTBEAT_MIN_MS = 60_000;
export function factoryProgressFile(root, issue) {
    return join(defaultProgressDir(root), `factory-${issue}.log`);
}
export function createFactoryProgress(input) {
    const file = input.file ?? factoryProgressFile(input.root, input.issue);
    const agent = `factory-${input.issue}`;
    const clock = input.now ?? Date.now;
    let lastBeat = Number.NEGATIVE_INFINITY;
    const emit = (phase, status, note, fields = {}) => {
        const out = { issue: input.issue };
        for (const [k, v] of Object.entries(fields)) {
            if (v === undefined)
                continue;
            out[k] = k === 'sha' ? String(v).slice(0, 12) : k === 'credits' ? Number(v.toFixed(2)) : v;
        }
        emitProgress({ phase, status, agent, file, fields: out, at: new Date(clock()), ...(note !== undefined ? { note } : {}) });
    };
    return {
        file,
        emit,
        heartbeat(phase, note, fields) {
            const t = clock();
            if (t - lastBeat < HEARTBEAT_MIN_MS)
                return;
            lastBeat = t;
            emit(phase, 'heartbeat', note, fields);
        },
    };
}
//# sourceMappingURL=progress.js.map