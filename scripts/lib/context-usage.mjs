import { existsSync, openSync, readFileSync, readSync, statSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TRANSCRIPT_TAIL_BYTES = 4096;
const HUD_CACHE_FILENAME = 'hud-stdin-cache.json';

// Same priority order as SESSION_ID_ENV_VARS in src/hud/stdin.ts, so this
// resolver picks the same session identity the HUD itself would use.
const SESSION_ID_ENV_VARS = ['CLAUDE_SESSION_ID', 'CLAUDECODE_SESSION_ID'];

/**
 * List candidate session ids in the same priority order the HUD uses: the
 * current hook event's own payload first, then the session-id env vars in
 * priority order. Each candidate is tried in order by the caller — an
 * invalid or cache-less candidate must not stop the search, mirroring
 * src/hud/stdin.ts's getStdinCachePath, which skips an invalid env
 * candidate and tries the next one rather than giving up.
 */
function getSessionIdentityCandidates(data) {
  const candidates = [];
  const fromPayload = data?.session_id || data?.sessionId;
  if (typeof fromPayload === 'string' && fromPayload.trim()) {
    candidates.push(fromPayload.trim());
  }
  for (const envVar of SESSION_ID_ENV_VARS) {
    const candidate = process.env[envVar];
    if (typeof candidate === 'string' && candidate.trim()) {
      candidates.push(candidate.trim());
    }
  }
  return candidates;
}

function clampPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Resolve context usage reported directly by a hook event payload.
 * This preserves the #2412 fallback semantics used by the PostToolUse hook.
 */
export function resolveHookContextPercent(data) {
  const contextWindow = data?.context_window;
  if (!contextWindow || typeof contextWindow !== 'object') {
    return null;
  }

  const usedPercentage = contextWindow.used_percentage;
  if (Number.isFinite(usedPercentage) && usedPercentage >= 0) {
    return clampPercent(usedPercentage);
  }

  const size = contextWindow.context_window_size;
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }

  const usage = contextWindow.current_usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = Number(usage.input_tokens || 0);
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens || 0);
  const cacheReadTokens = Number(usage.cache_read_input_tokens || 0);
  const totalTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
  if (!Number.isFinite(totalTokens) || totalTokens < 0) {
    return null;
  }

  return clampPercent((totalTokens / size) * 100);
}

function readJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function hasContextWindowObject(data) {
  return Boolean(
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    Object.prototype.hasOwnProperty.call(data, 'context_window') &&
    data.context_window &&
    typeof data.context_window === 'object' &&
    !Array.isArray(data.context_window),
  );
}

/**
 * Resolve context usage from the persisted HUD stdin cache.
 * The HUD's own getContextPercent implementation remains the source of truth
 * for percent calculation; this helper only locates and parses its cache.
 */
export async function resolveHudCacheContextPercent(data, directory) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return null;

  try {
    const worktreePaths = await import(
      pathToFileURL(join(pluginRoot, 'dist', 'lib', 'worktree-paths.js')).href,
    );
    const hudStdin = await import(
      pathToFileURL(join(pluginRoot, 'dist', 'hud', 'stdin.js')).href,
    );
    const { getWorktreeRoot, getSessionStateDir, listSessionIds, resolveOmcPath } = worktreePaths;
    const { getContextPercent } = hudStdin;
    if (
      typeof getWorktreeRoot !== 'function' ||
      typeof getSessionStateDir !== 'function' ||
      typeof listSessionIds !== 'function' ||
      typeof resolveOmcPath !== 'function' ||
      typeof getContextPercent !== 'function'
    ) {
      return null;
    }

    const root = getWorktreeRoot(directory || undefined) || directory || process.cwd();
    // Mirror the HUD's own session-identity resolution exactly
    // (src/hud/stdin.ts getStdinCachePath): walk the candidates — payload
    // session id first, then the env-var candidates in priority order —
    // and skip only a candidate that FAILS VALIDATION (getSessionStateDir
    // throws). The FIRST candidate that validates is authoritative and the
    // search stops there, exactly like getStdinCachePath: if that
    // identity's own cache is missing or unusable, return null immediately
    // rather than falling through to another (possibly concurrent,
    // unrelated) session's cache — matching readStdinCache's behavior of
    // returning null once a real session-scoped path was determined. Only
    // when NO candidate validates at all do we fall through to the
    // identity-less legacy/mtime recovery path below.
    for (const candidate of getSessionIdentityCandidates(data)) {
      let candidatePath;
      try {
        candidatePath = join(getSessionStateDir(candidate, root), HUD_CACHE_FILENAME);
      } catch {
        continue;
      }
      const cached = readJsonFile(candidatePath);
      if (!hasContextWindowObject(cached)) return null;
      return clampPercent(getContextPercent(cached));
    }

    // No candidate validated to a real identity at all: fall back exactly
    // as the HUD does for a fully identity-less reader — the legacy flat
    // cache first, then the most recently updated session-scoped cache as
    // a last resort (e.g. a detached watcher that never inherited session
    // env vars).
    let cached = readJsonFile(resolveOmcPath('state/' + HUD_CACHE_FILENAME, root));

    if (cached === null) {
      let bestPath = null;
      let bestMtime = -Infinity;
      let sessionIds;
      try {
        sessionIds = listSessionIds(root);
      } catch {
        sessionIds = [];
      }
      for (const sid of sessionIds) {
        let path;
        try {
          path = join(getSessionStateDir(sid, root), HUD_CACHE_FILENAME);
          const stats = statSync(path);
          if (!stats.isFile() || stats.mtimeMs <= bestMtime) continue;
          bestPath = path;
          bestMtime = stats.mtimeMs;
        } catch {
          // Skip missing, invalid, or unreadable session entries.
        }
      }
      if (bestPath) cached = readJsonFile(bestPath);
    }

    if (!hasContextWindowObject(cached)) return null;
    return clampPercent(getContextPercent(cached));
  } catch {
    return null;
  }
}

/**
 * Resolve context usage from the tail of a Claude transcript.
 * Transcript fixtures must include an explicit numeric context_window field;
 * real Claude transcripts commonly omit that field, in which case callers
 * should continue to the hook payload and HUD cache fallbacks.
 */
export function resolveTranscriptContextPercent(transcriptPath, tailBytes = TRANSCRIPT_TAIL_BYTES) {
  if (!transcriptPath) return null;

  let fd = -1;
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0) return null;

    let readSize = Math.min(tailBytes, stat.size, 1024 * 1024);
    if (readSize <= 0) return null;
    const maxReadSize = Math.min(stat.size, 1024 * 1024);
    fd = openSync(transcriptPath, 'r');
    while (true) {
      const offset = stat.size - readSize;
      const buffer = Buffer.alloc(readSize);
      const bytesRead = readSync(fd, buffer, 0, readSize, offset);
      // The first line can begin inside a frame or UTF-8 sequence. Discard it
      // unless the read reaches the file start, then expand until a complete
      // usage frame is found. Never read more than 1 MiB from the snapshot tail.
      const frames = buffer.subarray(0, bytesRead).toString('utf-8').split(/\r?\n/);
      for (let i = frames.length - 1; i >= (offset > 0 ? 1 : 0); i--) {
        let frame;
        try {
          frame = JSON.parse(frames[i]);
        } catch {
          // Ignore invalid or unfinished JSONL records.
          continue;
        }
        const usage = frame?.message?.usage ?? frame?.usage ?? frame;
        const window = usage?.context_window ?? frame?.message?.context_window ?? frame?.context_window;
        const input = usage?.input_tokens;
        const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
        const cacheRead = usage?.cache_read_input_tokens ?? 0;
        if (!Number.isFinite(window) || window <= 0) continue;
        if (![input, cacheCreation, cacheRead].every(value => Number.isFinite(value) && value >= 0)) continue;
        return clampPercent(((input + cacheCreation + cacheRead) / window) * 100);
      }
      if (readSize >= maxReadSize) break;
      readSize = Math.min(readSize * 2, maxReadSize);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch {}
    }
  }
}

/**
 * Prompt token limit per Copilot CLI model id, as [default tier, long_context
 * tier]. From the CLI's `/models` response (`billing.token_prices.<tier>
 * .max_prompt_tokens`) as logged by Copilot CLI 1.0.91 on 2026-10-23. Copilot
 * documents no limits; an id missing here resolves to null (unknown).
 * OMC_COPILOT_CONTEXT_WINDOW (tokens) overrides the table.
 */
export const COPILOT_PROMPT_TOKEN_LIMITS = {
  'claude-sonnet-5.5': [200000, 936000],
  'claude-opus-5.5': [200000, 1000000],
  'claude-haiku-5.5': [100000, 936000],
  'claude-haiku-4.5': [128000, 128000],
  'claude-sonnet-5': [200000, 936000],
  'claude-opus-5': [200000, 936000],
  'claude-fable-5': [200000, 936000],
  'claude-fable-5.1': [200000, 936000],
  'gpt-6.1-sol': [272000, 922000],
  'gpt-6-astra': [272000, 1050000],
  'gpt-6-luna': [272000, 872000],
  'gpt-6-sol': [272000, 872000],
  'gemini-3.8-flash': [200000, 983040],
};

const COPILOT_TRANSCRIPT_TAIL_BYTES = 64 * 1024;
const COPILOT_TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;

/** Copilot CLI's transcript is `<COPILOT_HOME>/session-state/<sessionId>/events.jsonl`. */
export function isCopilotTranscript(transcriptPath) {
  return typeof transcriptPath === 'string' && /(^|[\\/])events\.jsonl$/.test(transcriptPath);
}

function copilotPromptLimit(model, contextTier) {
  const override = Number(process.env.OMC_COPILOT_CONTEXT_WINDOW);
  if (Number.isInteger(override) && override > 0) return override;
  const limits = typeof model === 'string' ? COPILOT_PROMPT_TOKEN_LIMITS[model.toLowerCase()] : undefined;
  if (!limits) return null;
  return contextTier === 'long_context' ? limits[1] : limits[0];
}

/**
 * Context usage from a Copilot CLI events.jsonl, newest event first. Copilot
 * persists no live token data: only session.compaction_start and
 * session.shutdown carry `currentTokens`, and the model comes from
 * session.shutdown `currentModel`, session.auto_mode_resolved `chosenModel`
 * or a main-agent session.model_change `newModel` (not `auto`).
 *
 * Returns { percent, currentTokens, model, compacted } where `percent` is
 * null when the tokens, the model or its limit are unknown, and `compacted`
 * is true when a session.compaction_complete is newer than the token sample:
 * Copilot just compacted because the context was full, and the old sample no
 * longer applies (percent is null then).
 */
export function resolveCopilotTranscriptContext(transcriptPath) {
  const unknown = { percent: null, currentTokens: null, model: null, compacted: false };
  if (!isCopilotTranscript(transcriptPath)) return unknown;

  let fd = -1;
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0) return unknown;
    const maxReadSize = Math.min(stat.size, COPILOT_TRANSCRIPT_MAX_BYTES);
    let readSize = Math.min(COPILOT_TRANSCRIPT_TAIL_BYTES, maxReadSize);
    fd = openSync(transcriptPath, 'r');
    while (true) {
      const offset = stat.size - readSize;
      const buffer = Buffer.alloc(readSize);
      const bytesRead = readSync(fd, buffer, 0, readSize, offset);
      const lines = buffer.subarray(0, bytesRead).toString('utf-8').split(/\r?\n/);
      let currentTokens = null;
      let compacted = false;
      let model = null;
      let contextTier = null;
      for (let i = lines.length - 1; i >= (offset > 0 ? 1 : 0); i--) {
        if (!lines[i].includes('"session.')) continue;
        let event;
        try {
          event = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        const data = event?.data;
        if (!data || typeof data !== 'object') continue;
        if (currentTokens === null) {
          if (event.type === 'session.compaction_complete') compacted = true;
          if ((event.type === 'session.compaction_start' || event.type === 'session.shutdown') &&
              Number.isFinite(data.currentTokens) && data.currentTokens >= 0) {
            currentTokens = data.currentTokens;
          }
        }
        if (model === null && !event.agentId) {
          const candidate = event.type === 'session.shutdown' ? data.currentModel
            : event.type === 'session.auto_mode_resolved' ? data.chosenModel
              : event.type === 'session.model_change' ? data.newModel
                : null;
          if (typeof candidate === 'string' && candidate && candidate !== 'auto') model = candidate;
        }
        if (contextTier === null && !event.agentId && typeof data.contextTier === 'string') contextTier = data.contextTier;
        if (currentTokens !== null && model !== null) break;
      }
      if ((currentTokens !== null && model !== null) || readSize >= maxReadSize) {
        if (currentTokens === null || compacted) return { ...unknown, model, compacted };
        const limit = copilotPromptLimit(model, contextTier);
        return { percent: limit ? clampPercent((currentTokens / limit) * 100) : null, currentTokens, model, compacted };
      }
      readSize = Math.min(readSize * 4, maxReadSize);
    }
  } catch {
    return unknown;
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch {}
    }
  }
}

/**
 * Resolve context usage from the best available source, in priority order.
 * null means unknown; callers must not treat it as 0% or 100%.
 * `copilotContext` is a resolveCopilotTranscriptContext() result the caller
 * already has for this transcript, so the events.jsonl is not read twice.
 */
export async function resolveContextPercent(data, transcriptPath, directory, copilotContext) {
  const transcriptPercent = resolveTranscriptContextPercent(transcriptPath);
  if (transcriptPercent !== null) return transcriptPercent;

  const copilotPercent = (copilotContext || resolveCopilotTranscriptContext(transcriptPath)).percent;
  if (copilotPercent !== null) return copilotPercent;

  const hookPercent = resolveHookContextPercent(data);
  if (hookPercent !== null) return hookPercent;

  return resolveHudCacheContextPercent(data, directory);
}
