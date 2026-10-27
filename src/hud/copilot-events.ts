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

import { closeSync, openSync, readSync, statSync } from "fs";
import { basename, dirname, join, win32 } from "path";
import { copilotEventsPath } from "../budget/ledger.js";
import type {
  ActiveAgent,
  PendingPermission,
  RecentTool,
  TranscriptData,
} from "./types.js";

/** Same tail window as transcript.ts: tool outputs make Copilot lines large. */
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_AGENTS = 10;
const MAX_RECENT_TOOLS = 20;
const CACHE_MAX_SIZE = 20;

/** Copilot meta tools that would only crowd the RecentTools element. */
const RECENT_TOOLS_SKIP = new Set([
  "skill", "task", "report_intent", "task_complete", "thinking",
  "read_agent", "list_agents", "write_agent", "update_todo",
]);

/** Event types the reader acts on; other lines are skipped before JSON.parse. */
const RELEVANT_TYPES = [
  "tool.execution_start", "tool.execution_complete", "skill.invoked",
  "subagent.started", "subagent.completed", "subagent.failed",
  "session.start", "session.resume", "session.mode_changed", "session.model_change",
  "session.compaction_start", "session.compaction_complete",
  "session.usage_checkpoint", "session.shutdown",
  "permission.requested", "permission.completed",
];

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
  usage: { totalNanoAiu: number; totalPremiumRequests: number | null } | null;
}

interface RawEvent {
  type?: unknown;
  timestamp?: unknown;
  data?: Record<string, unknown>;
}

interface CachedParse {
  key: string;
  result: CopilotEventsData;
}

const cache = new Map<string, CachedParse>();

function emptyResult(): CopilotEventsData {
  return {
    agents: [],
    todos: [],
    toolCallCount: 0,
    agentCallCount: 0,
    skillCallCount: 0,
    lastToolName: null,
    recentTools: [],
    mode: null,
    reasoningEffort: null,
    compacting: false,
    compactionCount: 0,
    usage: null,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the session's events.jsonl: `transcript_path` as the session-state
 * directory, or as a file inside it (events.jsonl itself or a sibling), else
 * `$COPILOT_HOME/session-state/<session_id>/events.jsonl`.
 */
export function resolveCopilotEventsPath(
  transcriptPath: string | null | undefined,
  sessionId: string | null | undefined,
): string | null {
  if (transcriptPath) {
    try {
      const stat = statSync(transcriptPath);
      const candidate = stat.isDirectory()
        ? join(transcriptPath, "events.jsonl")
        : basename(transcriptPath) === "events.jsonl"
          ? transcriptPath
          : join(dirname(transcriptPath), "events.jsonl");
      if (isFile(candidate)) return candidate;
    } catch {
      // Fall through to the session-id rule.
    }
  }
  if (sessionId) {
    const candidate = copilotEventsPath(sessionId);
    if (candidate && isFile(candidate)) return candidate;
  }
  return null;
}

function readTail(path: string, size: number): string {
  const start = Math.max(0, size - MAX_TAIL_BYTES);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const n = readSync(fd, buffer, offset, length - offset, start + offset);
      if (n === 0) break;
      offset += n;
    }
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  // A mid-file start leaves a partial first line; drop it.
  return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
}

function toDate(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

/** Short target for the RecentTools element: a file name or the head of a command. */
function toolTarget(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const input = args as Record<string, unknown>;
  const path = str(input.path) ?? str(input.file_path) ?? str(input.fileName);
  // win32.basename splits on both separators, so a Windows-recorded path
  // shortens the same way when the HUD runs on Linux or macOS.
  if (path) return win32.basename(path) || path;
  const command = str(input.command);
  if (command) return command.length > 20 ? `${command.slice(0, 20)}...` : command;
  return null;
}

function permissionTarget(request: Record<string, unknown>): string {
  return (
    str(request.fullCommandText) ??
    str(request.fileName) ??
    str(request.path) ??
    str(request.url) ??
    str(request.toolName) ??
    "..."
  ).slice(0, 40);
}

function parseEvents(text: string, staleMs: number, now: number): CopilotEventsData {
  const result = emptyResult();
  const agents = new Map<string, ActiveAgent>();
  const tools = new Map<string, RecentTool>();
  const permissions = new Map<string, PendingPermission>();
  const epoch = new Date(0);

  for (const line of text.split("\n")) {
    if (!line.trim() || !RELEVANT_TYPES.some((type) => line.includes(`"${type}"`))) continue;
    let event: RawEvent;
    try {
      event = JSON.parse(line) as RawEvent;
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") continue;
    const data = event.data && typeof event.data === "object" ? event.data : {};
    const at = toDate(event.timestamp, epoch);

    switch (event.type) {
      case "session.start":
        if (at !== epoch) result.sessionStart = at;
        if ("reasoningEffort" in data) result.reasoningEffort = str(data.reasoningEffort);
        break;
      case "session.resume":
        if ("reasoningEffort" in data) result.reasoningEffort = str(data.reasoningEffort);
        break;
      case "tool.execution_start": {
        const name = str(data.toolName);
        if (!name) break;
        result.toolCallCount++;
        result.lastToolName = name;
        const id = str(data.toolCallId);
        if (id && !RECENT_TOOLS_SKIP.has(name)) {
          if (tools.size >= MAX_RECENT_TOOLS) {
            const oldest = tools.keys().next().value;
            if (oldest !== undefined) tools.delete(oldest);
          }
          tools.set(id, { name, target: toolTarget(data.arguments), status: "running", timestamp: at });
        }
        break;
      }
      case "tool.execution_complete": {
        const tool = tools.get(str(data.toolCallId) ?? "");
        if (tool) tool.status = data.success === false ? "failure" : "success";
        break;
      }
      case "skill.invoked": {
        const name = str(data.name);
        if (!name) break;
        result.skillCallCount++;
        result.lastActivatedSkill = { name, timestamp: at };
        break;
      }
      case "subagent.started": {
        const id = str(data.toolCallId);
        if (!id) break;
        result.agentCallCount++;
        agents.set(id, {
          id,
          type: str(data.agentName) ?? str(data.agentDisplayName) ?? "agent",
          model: str(data.model) ?? undefined,
          description: str(data.agentDescription) ?? undefined,
          status: "running",
          startTime: at,
        });
        break;
      }
      case "subagent.completed":
      case "subagent.failed": {
        const agent = agents.get(str(data.toolCallId) ?? "");
        if (agent) {
          agent.status = "completed";
          agent.endTime = at;
        }
        break;
      }
      case "session.mode_changed": {
        const mode = data.newMode;
        if (mode === "interactive" || mode === "plan" || mode === "autopilot") result.mode = mode;
        break;
      }
      case "session.model_change":
        if ("reasoningEffort" in data) result.reasoningEffort = str(data.reasoningEffort);
        break;
      case "session.compaction_start":
        result.compacting = true;
        break;
      case "session.compaction_complete":
        result.compacting = false;
        result.compactionCount++;
        break;
      case "session.usage_checkpoint":
      case "session.shutdown":
        if (typeof data.totalNanoAiu === "number" && Number.isFinite(data.totalNanoAiu)) {
          result.usage = {
            totalNanoAiu: data.totalNanoAiu,
            totalPremiumRequests:
              typeof data.totalPremiumRequests === "number" ? data.totalPremiumRequests : null,
          };
        }
        break;
      case "permission.requested": {
        const requestId = str(data.requestId);
        const request = data.permissionRequest;
        if (!requestId || !request || typeof request !== "object") break;
        const req = request as Record<string, unknown>;
        permissions.set(requestId, {
          toolName: str(req.kind) ?? "tool",
          targetSummary: permissionTarget(req),
          timestamp: at,
        });
        break;
      }
      case "permission.completed":
        permissions.delete(str(data.requestId) ?? "");
        break;
    }
  }

  // Same stale rule as transcript.ts: a start whose completion fell outside
  // the tail (or never came) stops counting as running.
  for (const agent of agents.values()) {
    if (agent.status === "running" && now - agent.startTime.getTime() > staleMs) {
      agent.status = "completed";
      agent.endTime = new Date(agent.startTime.getTime() + staleMs);
    }
  }
  const all = Array.from(agents.values());
  const running = all.filter((a) => a.status === "running");
  const completed = all.filter((a) => a.status === "completed");
  result.agents = [...running, ...completed.slice(-(MAX_AGENTS - running.length))].slice(0, MAX_AGENTS);
  result.recentTools = Array.from(tools.values());
  result.pendingPermission = Array.from(permissions.values()).pop();
  return result;
}

export interface ReadCopilotEventsOptions {
  staleTaskThresholdMinutes?: number;
  /** Clock for tests. */
  now?: number;
}

/**
 * Read a Copilot session's events.jsonl (see resolveCopilotEventsPath).
 * Returns an empty result when the file is missing or unreadable.
 */
export function readCopilotEvents(
  eventsPath: string | null,
  options: ReadCopilotEventsOptions = {},
): CopilotEventsData {
  if (!eventsPath) return emptyResult();
  const now = options.now ?? Date.now();
  const staleMs = (options.staleTaskThresholdMinutes ?? 30) * 60_000;
  try {
    const stat = statSync(eventsPath);
    if (!stat.isFile()) return emptyResult();
    // The stale rule depends on the clock, so the key carries it per minute.
    const key = `${stat.size}:${stat.mtimeMs}:${staleMs}:${Math.floor(now / 60_000)}`;
    const cached = cache.get(eventsPath);
    if (cached?.key === key) return structuredClone(cached.result);
    const result = parseEvents(readTail(eventsPath, stat.size), staleMs, now);
    if (cache.size >= CACHE_MAX_SIZE) cache.clear();
    cache.set(eventsPath, { key, result: structuredClone(result) });
    return result;
  } catch {
    return emptyResult();
  }
}
