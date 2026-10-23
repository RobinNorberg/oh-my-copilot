import type { SessionEndJobV1 } from './cleanup-manifest.js';
/** The job's SessionEnd came from Copilot CLI (scripts/session-end.mjs marks it). */
export declare function isCopilotSessionEndJob(job: SessionEndJobV1 | null): boolean;
/**
 * True while the Copilot session's events show no shutdown after its latest
 * activity. False when the events file is missing or idle past
 * COPILOT_SESSION_IDLE_MS, which keeps the pre-existing behaviour there.
 */
export declare function isCopilotSessionLive(sessionId: string, now?: number, eventsPath?: string | null): boolean;
//# sourceMappingURL=copilot-liveness.d.ts.map