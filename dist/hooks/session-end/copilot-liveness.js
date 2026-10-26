import { closeSync, fstatSync, openSync, readSync } from 'fs';
import { copilotEventsPath } from '../../budget/ledger.js';
/**
 * Copilot CLI fires SessionEnd after every agentStop, blocked continuations
 * included (live 1.0.91), so on Copilot a SessionEnd does not prove the
 * session is over. Running the session-end actions then would clear live
 * mode state (ultragoal/ralph/autopilot), clean up session-owned teams, stop
 * the reply listener, send "session ended" notifications and spawn the next
 * factory-chain link while the session is still working.
 *
 * The CLI writes `session.shutdown` to `$COPILOT_HOME/session-state/<id>/
 * events.jsonl` when the session really ends (observed about 0.6 s after the
 * last SessionEnd hook). Activity recorded after the last shutdown (a resumed
 * session) means it is live again.
 */
const EVENTS_TAIL_BYTES = 256 * 1024;
/** An events file untouched this long belongs to a session that died without a shutdown event. */
const COPILOT_SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const ACTIVITY_TYPES = new Set(['user.message', 'assistant.turn_start', 'assistant.message', 'tool.execution_start', 'session.resume']);
/** The job's SessionEnd came from Copilot CLI (scripts/session-end.mjs marks it). */
export function isCopilotSessionEndJob(job) {
    return job?.actions['foreground-cleanup']?.payload?.host === 'copilot';
}
/**
 * True while the Copilot session's events show no shutdown after its latest
 * activity. False when the events file is missing or idle past
 * COPILOT_SESSION_IDLE_MS, which keeps the pre-existing behaviour there.
 */
export function isCopilotSessionLive(sessionId, now = Date.now(), eventsPath = copilotEventsPath(sessionId)) {
    if (!eventsPath)
        return false;
    let fd;
    let text = '';
    try {
        fd = openSync(eventsPath, 'r');
        const stat = fstatSync(fd);
        if (now - stat.mtimeMs > COPILOT_SESSION_IDLE_MS)
            return false;
        const start = Math.max(0, stat.size - EVENTS_TAIL_BYTES);
        const buffer = Buffer.alloc(stat.size - start);
        let read = 0;
        while (read < buffer.length) {
            const n = readSync(fd, buffer, read, buffer.length - read, start + read);
            if (n <= 0)
                break;
            read += n;
        }
        text = buffer.toString('utf-8', 0, read);
    }
    catch {
        return false;
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch { /* ignore */ }
        }
    }
    let shutdownAt = -1;
    let activityAt = -1;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.includes('"type"'))
            continue;
        let type;
        try {
            type = JSON.parse(line).type;
        }
        catch {
            continue;
        }
        if (type === 'session.shutdown')
            shutdownAt = index;
        else if (typeof type === 'string' && ACTIVITY_TYPES.has(type))
            activityAt = index;
    }
    return !(shutdownAt >= 0 && shutdownAt > activityAt);
}
//# sourceMappingURL=copilot-liveness.js.map