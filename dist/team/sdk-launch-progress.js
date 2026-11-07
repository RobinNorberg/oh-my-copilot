/**
 * Launch progress for one sdk-transport worker (`omg team --transport sdk`).
 *
 * A worker launch can take minutes (runtime start, session create, the first
 * model reply). This poller reads the host's session file and writes one line
 * per launch phase reached, a heartbeat line while a phase lasts, and a final
 * per-phase breakdown, so the leader is never silent while it waits.
 */
import { readFileSync } from 'node:fs';
import { sdkWorkerFiles } from './sdk-transport.js';
/** Launch phases in order: the mark, its label once reached, and what the launch waits on next. */
export const SDK_LAUNCH_PHASES = [
    { mark: 'host_started_at', label: 'host started', next: 'starting the copilot runtime', span: 'host' },
    { mark: 'client_started_at', label: 'runtime started', next: 'creating the session', span: 'runtime' },
    { mark: 'session_created_at', label: 'session created', next: 'waiting for the bootstrap prompt', span: 'session' },
    { mark: 'first_send_at', label: 'bootstrap sent', next: 'waiting for the first turn', span: 'bootstrap' },
    { mark: 'turn_started_at', label: 'first turn started', next: 'waiting for first model reply', span: 'first turn' },
    { mark: 'first_message_at', label: 'ready', next: '', span: 'first reply' },
];
const READY = 'first_message_at';
function readLaunchSession(stateRoot, workerName) {
    try {
        return JSON.parse(readFileSync(sdkWorkerFiles(stateRoot, workerName).session, 'utf8'));
    }
    catch {
        return null; // not written yet, or mid-rename on win32
    }
}
/** Index of the last phase reached, or -1. */
export function lastSdkLaunchPhase(session) {
    const timeline = session?.timeline ?? {};
    let last = -1;
    SDK_LAUNCH_PHASES.forEach((phase, i) => { if (timeline[phase.mark])
        last = i; });
    return last;
}
const seconds = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`;
/** `runtime 8s, session 20s, ...`: the time from each reached phase to the previous one. */
export function formatSdkLaunchBreakdown(session) {
    const timeline = session?.timeline ?? {};
    const parts = [];
    let previous = null;
    for (const phase of SDK_LAUNCH_PHASES) {
        const at = timeline[phase.mark] ? Date.parse(timeline[phase.mark]) : NaN;
        if (!Number.isFinite(at))
            continue;
        if (previous !== null)
            parts.push(`${phase.span} ${seconds(at - previous)}`);
        previous = at;
    }
    return parts.join(', ');
}
/**
 * Start writing launch progress for `workerName`; returns an idempotent stop.
 * It stops by itself once the worker gave its first model reply or the host
 * failed. A stop before that writes the breakdown so far.
 */
export function startSdkLaunchProgress(stateRoot, workerName, write, options = {}) {
    const now = options.now ?? Date.now;
    const read = options.readSession ?? readLaunchSession;
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    const startedAt = now();
    const prefix = `[omg team] ${workerName}:`;
    const emit = (line) => { try {
        write(`${prefix} ${line}`);
    }
    catch { /* progress is advisory */ } };
    let reported = -1;
    let lastLineAt = startedAt;
    let done = false;
    const timer = {};
    const finish = (line) => {
        if (done)
            return;
        done = true;
        if (timer.handle !== undefined)
            (options.clearInterval ?? ((h) => clearInterval(h)))(timer.handle);
        emit(line);
    };
    const tick = () => {
        if (done)
            return;
        const session = read(stateRoot, workerName);
        const elapsed = seconds(now() - startedAt);
        const breakdown = formatSdkLaunchBreakdown(session);
        if (session?.timeline?.[READY]) {
            finish(`ready in ${elapsed}${breakdown ? ` (${breakdown})` : ''}`);
            return;
        }
        if (session?.state === 'failed') {
            finish(`host failed after ${elapsed}${session.last_error ? `: ${session.last_error}` : ''}`);
            return;
        }
        const phase = lastSdkLaunchPhase(session);
        if (phase > reported) {
            reported = phase;
            lastLineAt = now();
            emit(`${elapsed}, ${SDK_LAUNCH_PHASES[phase].label}`);
        }
        else if (now() - lastLineAt >= heartbeatMs) {
            lastLineAt = now();
            const state = phase >= 0
                ? `${SDK_LAUNCH_PHASES[phase].label}, ${SDK_LAUNCH_PHASES[phase].next}`
                : 'waiting for the sdk host';
            emit(`${elapsed}, ${state}`);
        }
    };
    const every = options.setInterval ?? ((fn, ms) => {
        const timer = setInterval(fn, ms);
        timer.unref?.();
        return timer;
    });
    timer.handle = every(tick, options.pollMs ?? 1_000);
    return () => {
        if (done)
            return;
        tick();
        if (done)
            return;
        const breakdown = formatSdkLaunchBreakdown(read(stateRoot, workerName));
        finish(`launch wait ended after ${seconds(now() - startedAt)}${breakdown ? ` (${breakdown})` : ''}`);
    };
}
//# sourceMappingURL=sdk-launch-progress.js.map