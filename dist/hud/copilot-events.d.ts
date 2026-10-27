/**
 * OMC HUD - Copilot CLI session events reader
 *
 * Copilot CLI has no Claude-style transcript. Its statusline `transcript_path`
 * is the session-state DIRECTORY (`$COPILOT_HOME/session-state/<id>/`), and the
 * append-only `events.jsonl` inside it carries tool, skill, subagent, mode,
 * compaction and usage events (schema: `pkg/<ver>/schemas/session-events.schema.json`).
 *
 * The reader tail-parses that file within the same byte budget as transcript.ts
 * and returns a TranscriptData-compatible result, so the existing agent, skill,
 * call-count, tool and permission elements render it unchanged. Unknown event
 * types and malformed lines are ignored.
 */
import type { TranscriptData } from "./types.js";
export type CopilotSessionMode = "interactive" | "plan" | "autopilot";
export interface CopilotEventsData extends TranscriptData {
    /** Last `session.mode_changed` newMode; null before any change (interactive). */
    mode: CopilotSessionMode | null;
    /** Last reasoningEffort from `session.start`, `session.resume` or `session.model_change`. */
    reasoningEffort: string | null;
    /** A `session.compaction_start` without its `compaction_complete` yet. */
    compacting: boolean;
    /** Completed compactions seen in the tail. */
    compactionCount: number;
    /** Last `session.usage_checkpoint` / `session.shutdown` totals. */
    usage: {
        totalNanoAiu: number;
        totalPremiumRequests: number | null;
    } | null;
}
/**
 * Resolve the session's events.jsonl: `transcript_path` as the session-state
 * directory, or as a file inside it (events.jsonl itself or a sibling), else
 * `$COPILOT_HOME/session-state/<session_id>/events.jsonl`.
 */
export declare function resolveCopilotEventsPath(transcriptPath: string | null | undefined, sessionId: string | null | undefined): string | null;
export interface ReadCopilotEventsOptions {
    staleTaskThresholdMinutes?: number;
    /** Clock for tests. */
    now?: number;
}
/**
 * Read a Copilot session's events.jsonl (see resolveCopilotEventsPath).
 * Returns an empty result when the file is missing or unreadable.
 */
export declare function readCopilotEvents(eventsPath: string | null, options?: ReadCopilotEventsOptions): CopilotEventsData;
//# sourceMappingURL=copilot-events.d.ts.map