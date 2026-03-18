/**
 * Stagger Launch Hook
 *
 * PreToolUse hook that detects rapid-fire Task tool calls during ultrawork mode
 * and injects advisory stagger delay guidance. This prevents thundering herd
 * rate limits when launching many parallel agents.
 *
 * The stagger is advisory (via prompt injection) rather than blocking,
 * since OMC hooks cannot delay tool execution.
 */

import { readUltraworkState } from '../ultrawork/index.js';
import { readModeState, writeModeState } from '../../lib/mode-state-io.js';

export interface StaggerState {
  /** Timestamp of last Task launch (ms since epoch) */
  lastTaskLaunchMs: number;
  /** Number of rapid-fire launches detected in current burst */
  burstCount: number;
  /** Session ID */
  sessionId?: string;
}

const DEFAULT_STAGGER_DELAY_MS = 1000;

/**
 * Read stagger state from session
 */
export function readStaggerState(
  directory: string,
  sessionId?: string,
): StaggerState | null {
  return readModeState<StaggerState>('stagger-launch', directory, sessionId);
}

/**
 * Write stagger state to session
 */
export function writeStaggerState(
  directory: string,
  state: StaggerState,
  sessionId?: string,
): boolean {
  return writeModeState(
    'stagger-launch',
    state as unknown as Record<string, unknown>,
    directory,
    sessionId,
  );
}

/**
 * Check if stagger guidance should be injected for a Task tool call.
 *
 * Only active during ultrawork mode. Detects when Task calls arrive
 * within the stagger window of the last launch.
 *
 * @returns Stagger guidance message, or null if no stagger needed
 */
export function checkStaggerNeeded(
  directory: string,
  sessionId?: string,
): string | null {
  // Only active during ultrawork mode
  const ultraworkState = readUltraworkState(directory, sessionId);
  if (!ultraworkState || !ultraworkState.active) {
    return null;
  }

  const staggerDelayMs = (ultraworkState as unknown as Record<string, unknown>).stagger_delay_ms as number | undefined
    ?? DEFAULT_STAGGER_DELAY_MS;

  const now = Date.now();
  const staggerState = readStaggerState(directory, sessionId);

  if (!staggerState) {
    // First launch — record and allow
    writeStaggerState(directory, {
      lastTaskLaunchMs: now,
      burstCount: 1,
      sessionId,
    }, sessionId);
    return null;
  }

  const elapsed = now - staggerState.lastTaskLaunchMs;

  // Update state
  const newState: StaggerState = {
    lastTaskLaunchMs: now,
    burstCount: elapsed < staggerDelayMs ? staggerState.burstCount + 1 : 1,
    sessionId,
  };
  writeStaggerState(directory, newState, sessionId);

  // If within stagger window, inject guidance
  if (elapsed < staggerDelayMs) {
    const waitMs = staggerDelayMs - elapsed;
    return `<stagger-launch-advisory>
[STAGGER ADVISORY] Rapid-fire agent launch detected (${elapsed}ms since last launch).
To avoid rate limits, wait approximately ${waitMs}ms before launching the next agent.
Stagger parallel launches by ${staggerDelayMs}ms between each: fire task 1, wait ${staggerDelayMs}ms, fire task 2, etc.
Current burst count: ${newState.burstCount} rapid launches.
</stagger-launch-advisory>`;
  }

  return null;
}

/**
 * Clear stagger state (called on mode deactivation)
 */
export function clearStaggerState(
  directory: string,
  sessionId?: string,
): boolean {
  return writeModeState(
    'stagger-launch',
    { lastTaskLaunchMs: 0, burstCount: 0 } as unknown as Record<string, unknown>,
    directory,
    sessionId,
  );
}

// Re-export default
export { DEFAULT_STAGGER_DELAY_MS };
