'use strict';

// Copilot CLI transcripts live at `session-state/<sessionId>/events.jsonl`.
const TRANSCRIPT_SESSION_PATTERN = /[\\/]session-state[\\/]([^\\/]+)[\\/]events\.jsonl$/;

/**
 * True for a subagent's Stop (live probe, Copilot CLI 1.0.91): its session_id
 * is the child session, which gets no later prompt, while transcript_path is
 * the parent's `session-state/<parentId>/events.jsonl`.
 */
function isChildSessionPayload(payload) {
  const transcript = payload && (payload.transcript_path || payload.transcriptPath);
  const sessionId = payload && (payload.session_id || payload.sessionId);
  const match = typeof transcript === 'string' && TRANSCRIPT_SESSION_PATTERN.exec(transcript);
  return Boolean(match) && match[1] !== sessionId;
}

module.exports = { isChildSessionPayload };
