/**
 * Notification Message Formatters
 *
 * Produces human-readable notification messages for each event type.
 * Supports markdown (Discord/Telegram) and plain text (Slack/webhook) formats.
 */

import type { NotificationPayload } from "./types.js";
import { basename } from "path";

/**
 * Format duration from milliseconds to human-readable string.
 */
function formatDuration(ms?: number): string {
  if (!ms) return "unknown";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Get project display name from path.
 */
function projectDisplay(payload: NotificationPayload): string {
  if (payload.projectName) return payload.projectName;
  if (payload.projectPath) return basename(payload.projectPath);
  return "unknown";
}

/**
 * Build common footer with tmux and project info.
 */
function buildFooter(payload: NotificationPayload, markdown: boolean): string {
  const parts: string[] = [];

  if (payload.tmuxSession) {
    parts.push(
      markdown
        ? `**tmux:** \`${payload.tmuxSession}\``
        : `tmux: ${payload.tmuxSession}`,
    );
  }

  parts.push(
    markdown
      ? `**project:** \`${projectDisplay(payload)}\``
      : `project: ${projectDisplay(payload)}`,
  );

  return parts.join(markdown ? " | " : " | ");
}

/**
 * Format session-start notification message.
 */
export function formatSessionStart(payload: NotificationPayload): string {
  const time = new Date(payload.timestamp).toLocaleTimeString();
  const project = projectDisplay(payload);

  const lines = [
    `# Session Started`,
    "",
    `**Session:** \`${payload.sessionId}\``,
    `**Project:** \`${project}\``,
    `**Time:** ${time}`,
  ];

  if (payload.tmuxSession) {
    lines.push(`**tmux:** \`${payload.tmuxSession}\``);
  }

  return lines.join("\n");
}

/**
 * Format session-stop notification message.
 * Sent when persistent mode blocks a stop (mode is still active).
 */
export function formatSessionStop(payload: NotificationPayload): string {
  const lines = [`# Session Continuing`, ""];

  if (payload.activeMode) {
    lines.push(`**Mode:** ${payload.activeMode}`);
  }

  if (payload.iteration != null && payload.maxIterations != null) {
    lines.push(`**Iteration:** ${payload.iteration}/${payload.maxIterations}`);
  }

  if (payload.incompleteTasks != null && payload.incompleteTasks > 0) {
    lines.push(`**Incomplete tasks:** ${payload.incompleteTasks}`);
  }

  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

/**
 * Format session-end notification message.
 * Full summary with duration, agents, modes, and context.
 */
export function formatSessionEnd(payload: NotificationPayload): string {
  const duration = formatDuration(payload.durationMs);

  const lines = [
    `# Session Ended`,
    "",
    `**Session:** \`${payload.sessionId}\``,
    `**Duration:** ${duration}`,
    `**Reason:** ${payload.reason || "unknown"}`,
  ];

  if (payload.agentsSpawned != null) {
    lines.push(
      `**Agents:** ${payload.agentsCompleted ?? 0}/${payload.agentsSpawned} completed`,
    );
  }

  if (payload.modesUsed && payload.modesUsed.length > 0) {
    lines.push(`**Modes:** ${payload.modesUsed.join(", ")}`);
  }

  if (payload.contextSummary) {
    lines.push("", `**Summary:** ${payload.contextSummary}`);
  }

  appendTmuxTail(lines, payload);

  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

/**
 * Format session-idle notification message.
 * Sent when Copilot stops and no persistent mode is blocking (truly idle).
 */
export function formatSessionIdle(payload: NotificationPayload): string {
  const lines = [`# Session Idle`, ""];

  lines.push(`Copilot has finished and is waiting for input.`);
  lines.push("");

  if (payload.reason) {
    lines.push(`**Reason:** ${payload.reason}`);
  }

  if (payload.modesUsed && payload.modesUsed.length > 0) {
    lines.push(`**Modes:** ${payload.modesUsed.join(", ")}`);
  }

  appendTmuxTail(lines, payload);

  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

/** Matches ANSI escape sequences (CSI and two-character escapes). */
const ANSI_ESCAPE_RE = /\x1b(?:[@-Z\\-_]|\[[0-9;]*[a-zA-Z])/g;

/** Lines starting with these characters are OMG UI chrome, not output. */
const UI_CHROME_RE = /^[●⎿✻·◼]/;

/** Matches the "ctrl+o to expand" hint injected by OMP. */
const CTRL_O_RE = /ctrl\+o to expand/i;

/** Lines composed entirely of box-drawing characters and whitespace. */
const BOX_DRAWING_RE = /^[\s─═│║┌┐└┘┬┴├┤╔╗╚╝╠╣╦╩╬╟╢╤╧╪━┃┏┓┗┛┣┫┳┻╋┠┨┯┷┿╂]+$/;

/** OMG HUD status lines: [OMP#...] or [OMP] (unversioned). */
const OMC_HUD_RE = /\[OMP[#\]]/;

/** Bypass-permissions indicator lines starting with ⏵. */
const BYPASS_PERM_RE = /^⏵/;

/** Bare shell prompt with no command after it. */
const BARE_PROMPT_RE = /^[❯>$%#]+$/;

/** Minimum ratio of alphanumeric characters for a line to be "meaningful". */
const MIN_ALNUM_RATIO = 0.15;

/** Default maximum number of meaningful lines to include in a notification.
 * Matches DEFAULT_TMUX_TAIL_LINES in config.ts. */
const DEFAULT_MAX_TAIL_LINES = 15;

/**
 * Parse raw tmux output into clean, human-readable lines.
 * - Strips ANSI escape codes
 * - Drops lines starting with OMG chrome characters (●, ⎿, ✻, ·, ◼)
 * - Drops "ctrl+o to expand" hint lines
 * - Returns at most `maxLines` non-empty lines (default 10)
 */
export function parseTmuxTail(raw: string, maxLines: number = DEFAULT_MAX_TAIL_LINES): string {
  const meaningful: string[] = [];

  for (const line of raw.split("\n")) {
    const stripped = line.replace(ANSI_ESCAPE_RE, "");
    const trimmed = stripped.trim();

    if (!trimmed) continue;
    if (UI_CHROME_RE.test(trimmed)) continue;
    if (CTRL_O_RE.test(trimmed)) continue;
    if (BOX_DRAWING_RE.test(trimmed)) continue;
    if (OMC_HUD_RE.test(trimmed)) continue;
    if (BYPASS_PERM_RE.test(trimmed)) continue;
    if (BARE_PROMPT_RE.test(trimmed)) continue;

    // Alphanumeric density check: drop lines mostly composed of special characters
    const alnumCount = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
    if (trimmed.length >= 8 && alnumCount / trimmed.length < MIN_ALNUM_RATIO) continue;

    meaningful.push(stripped.trimEnd());
  }

  return meaningful.slice(-maxLines).join("\n");
}

/**
 * Append tmux tail content to a message if present in the payload.
 */
function appendTmuxTail(lines: string[], payload: NotificationPayload): void {
  if (payload.tmuxTail) {
    const parsed = parseTmuxTail(payload.tmuxTail, payload.maxTailLines);
    if (parsed) {
      lines.push("");
      lines.push("**Recent output:**");
      lines.push("```");
      lines.push(parsed);
      lines.push("```");
    }
  }
}

/**
 * Format agent-call notification message.
 * Sent when a new agent (Task) is spawned.
 */
export function formatAgentCall(payload: NotificationPayload): string {
  const lines = [`# Agent Spawned`, ""];

  if (payload.agentName) {
    lines.push(`**Agent:** \`${payload.agentName}\``);
  }

  if (payload.agentType) {
    lines.push(`**Type:** \`${payload.agentType}\``);
  }

  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

/**
 * Format ask-user-question notification message.
 * Notifies the user that Copilot is waiting for input.
 */
export function formatAskUserQuestion(payload: NotificationPayload): string {
  const lines = [`# Input Needed`, ""];

  if (payload.question) {
    lines.push(`**Question:** ${payload.question}`);
    lines.push("");
  }

  lines.push(`Copilot is waiting for your response.`);
  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

/**
 * Parse a Teams tag list entry into display name and AAD object ID.
 * Format: "DisplayName:AAD-Object-ID" (e.g. "John Doe:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
 * Returns null if the format is invalid.
 */
function parseTeamsMention(tag: string): { name: string; id: string } | null {
  const colonIdx = tag.indexOf(":");
  if (colonIdx <= 0 || colonIdx === tag.length - 1) return null;
  const name = tag.slice(0, colonIdx).trim();
  const id = tag.slice(colonIdx + 1).trim();
  if (!name || !id) return null;
  return { name, id };
}

/**
 * Format notification as a Microsoft Teams Adaptive Card.
 * Returns the JSON body to POST to a Teams webhook (Power Automate Workflows or O365 Connectors).
 * Supports @mentions via tagList entries in "DisplayName:AAD-Object-ID" format.
 *
 * Adaptive Card schema: https://adaptivecards.io/schemas/adaptive-card.json
 */
export function formatTeamsAdaptiveCard(payload: NotificationPayload, tagList?: string[]): string {
  const project = projectDisplay(payload);
  const time = new Date(payload.timestamp).toLocaleTimeString();

  // Build facts array based on event type
  const facts: Array<{ title: string; value: string }> = [];

  switch (payload.event) {
    case "session-start":
      facts.push({ title: "Session", value: payload.sessionId });
      facts.push({ title: "Project", value: project });
      facts.push({ title: "Time", value: time });
      if (payload.tmuxSession) {
        facts.push({ title: "tmux", value: payload.tmuxSession });
      }
      break;

    case "session-stop":
      if (payload.activeMode) {
        facts.push({ title: "Mode", value: payload.activeMode });
      }
      if (payload.iteration != null && payload.maxIterations != null) {
        facts.push({ title: "Iteration", value: `${payload.iteration}/${payload.maxIterations}` });
      }
      if (payload.incompleteTasks != null && payload.incompleteTasks > 0) {
        facts.push({ title: "Incomplete tasks", value: String(payload.incompleteTasks) });
      }
      break;

    case "session-end":
      facts.push({ title: "Session", value: payload.sessionId });
      facts.push({ title: "Duration", value: formatDuration(payload.durationMs) });
      facts.push({ title: "Reason", value: payload.reason || "unknown" });
      if (payload.agentsSpawned != null) {
        facts.push({ title: "Agents", value: `${payload.agentsCompleted ?? 0}/${payload.agentsSpawned} completed` });
      }
      if (payload.modesUsed && payload.modesUsed.length > 0) {
        facts.push({ title: "Modes", value: payload.modesUsed.join(", ") });
      }
      break;

    case "session-idle":
      if (payload.reason) {
        facts.push({ title: "Reason", value: payload.reason });
      }
      if (payload.modesUsed && payload.modesUsed.length > 0) {
        facts.push({ title: "Modes", value: payload.modesUsed.join(", ") });
      }
      break;

    case "ask-user-question":
      if (payload.question) {
        facts.push({ title: "Question", value: payload.question });
      }
      break;

    case "agent-call":
      if (payload.agentName) {
        facts.push({ title: "Agent", value: payload.agentName });
      }
      if (payload.agentType) {
        facts.push({ title: "Type", value: payload.agentType });
      }
      break;
  }

  // Add footer facts
  if (payload.tmuxSession && payload.event !== "session-start") {
    facts.push({ title: "tmux", value: payload.tmuxSession });
  }
  facts.push({ title: "Project", value: project });

  // Map event to title and color
  const eventTitles: Record<string, { title: string; style: string }> = {
    "session-start": { title: "Session Started", style: "good" },
    "session-stop": { title: "Session Continuing", style: "attention" },
    "session-end": { title: "Session Ended", style: "default" },
    "session-idle": { title: "Session Idle", style: "warning" },
    "ask-user-question": { title: "Input Needed", style: "attention" },
    "agent-call": { title: "Agent Spawned", style: "default" },
  };

  const eventInfo = eventTitles[payload.event] || { title: payload.event, style: "default" };

  // Build Adaptive Card body
  const body: unknown[] = [
    {
      type: "TextBlock",
      size: "Medium",
      weight: "Bolder",
      text: eventInfo.title,
      style: "heading",
    },
    {
      type: "FactSet",
      facts: facts.map((f) => ({ title: f.title, value: f.value })),
    },
  ];

  // Add context summary if present
  if (payload.contextSummary && payload.event === "session-end") {
    body.push({
      type: "TextBlock",
      text: `**Summary:** ${payload.contextSummary}`,
      wrap: true,
    });
  }

  // Add tmux tail if present
  if (payload.tmuxTail) {
    const parsed = parseTmuxTail(payload.tmuxTail, payload.maxTailLines);
    if (parsed) {
      body.push(
        {
          type: "TextBlock",
          text: "**Recent output:**",
          spacing: "Medium",
        },
        {
          type: "TextBlock",
          text: parsed,
          fontType: "Monospace",
          wrap: true,
          maxLines: 10,
        },
      );
    }
  }

  // Parse mention tags and build entities + mention text
  const mentions: Array<{ name: string; id: string }> = [];
  if (tagList) {
    for (const tag of tagList) {
      const parsed = parseTeamsMention(tag);
      if (parsed) mentions.push(parsed);
    }
  }

  // Prepend mention text block if there are valid mentions
  if (mentions.length > 0) {
    const mentionText = mentions.map((m) => `<at>${m.name}</at>`).join(" ");
    body.unshift({
      type: "TextBlock",
      text: mentionText,
      wrap: true,
    });
  }

  // Build msteams entities for @mentions
  const msteams = mentions.length > 0
    ? {
        entities: mentions.map((m) => ({
          type: "mention",
          text: `<at>${m.name}</at>`,
          mentioned: {
            id: m.id,
            name: m.name,
          },
        })),
      }
    : undefined;

  // Wrap in Adaptive Card envelope
  // Power Automate Workflows expect this format
  const card = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body,
          ...(msteams && { msteams }),
        },
      },
    ],
  };

  return JSON.stringify(card);
}

/**
 * Format notification message based on event type.
 * Returns a markdown-formatted string suitable for Discord/Telegram.
 */
export function formatNotification(payload: NotificationPayload): string {
  switch (payload.event) {
    case "session-start":
      return formatSessionStart(payload);
    case "session-stop":
      return formatSessionStop(payload);
    case "session-end":
      return formatSessionEnd(payload);
    case "session-idle":
      return formatSessionIdle(payload);
    case "ask-user-question":
      return formatAskUserQuestion(payload);
    case "agent-call":
      return formatAgentCall(payload);
    default:
      return payload.message || `Event: ${payload.event}`;
  }
}
