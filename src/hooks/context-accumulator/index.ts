/**
 * Context Accumulator Hook
 *
 * Captures key outputs after each autopilot phase or ralph story completion,
 * and injects them into the next phase's agent prompt via a
 * <prior-phase-context> XML block.
 *
 * Stored in .omc/state/sessions/{sessionId}/phase-context.json
 */

import { writeModeState, readModeState, clearModeStateFile } from '../../lib/mode-state-io.js';
import type { PhaseContext, AccumulatedContext } from './types.js';
import { CONTEXT_ACCUMULATOR_CONFIG } from './types.js';

export type { PhaseContext, AccumulatedContext } from './types.js';
export { CONTEXT_ACCUMULATOR_CONFIG } from './types.js';

/**
 * Read accumulated context from session state
 */
export function readAccumulatedContext(
  directory: string,
  sessionId?: string,
): AccumulatedContext | null {
  return readModeState<AccumulatedContext>('phase-context', directory, sessionId);
}

/**
 * Write accumulated context to session state
 */
export function writeAccumulatedContext(
  directory: string,
  context: AccumulatedContext,
  sessionId?: string,
): boolean {
  return writeModeState(
    'phase-context',
    context as unknown as Record<string, unknown>,
    directory,
    sessionId,
  );
}

/**
 * Truncate content to the maximum phase output size.
 */
function truncateContent(content: string): { text: string; truncated: boolean; originalSize: number } {
  const originalSize = Buffer.byteLength(content, 'utf-8');

  if (originalSize <= CONTEXT_ACCUMULATOR_CONFIG.maxPhaseOutputSize) {
    return { text: content, truncated: false, originalSize };
  }

  // Truncate to fit within limit (accounting for truncation marker)
  const markerSize = Buffer.byteLength(CONTEXT_ACCUMULATOR_CONFIG.truncationMarker, 'utf-8');
  const targetSize = CONTEXT_ACCUMULATOR_CONFIG.maxPhaseOutputSize - markerSize;

  // Simple byte-safe truncation: take chars until we exceed target size
  let truncated = content;
  while (Buffer.byteLength(truncated, 'utf-8') > targetSize) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
  }

  return {
    text: truncated + CONTEXT_ACCUMULATOR_CONFIG.truncationMarker,
    truncated: true,
    originalSize,
  };
}

/**
 * Capture a phase output and add it to the accumulated context.
 */
export function capturePhaseOutput(
  directory: string,
  sessionId: string,
  phaseId: string,
  phaseName: string,
  content: string,
  filesChanged: string[] = [],
  decisions: string[] = [],
): boolean {
  let context = readAccumulatedContext(directory, sessionId);
  if (!context) {
    context = {
      phases: [],
      sessionId,
      lastUpdated: new Date().toISOString(),
    };
  }

  const { text, truncated, originalSize } = truncateContent(content);

  const phase: PhaseContext = {
    phaseId,
    phaseName,
    content: text,
    originalSize,
    truncated,
    filesChanged,
    decisions,
    capturedAt: new Date().toISOString(),
  };

  // Replace existing phase with same ID or append
  const existingIndex = context.phases.findIndex((p) => p.phaseId === phaseId);
  if (existingIndex >= 0) {
    context.phases[existingIndex] = phase;
  } else {
    context.phases.push(phase);
  }

  // Cap at max phases
  if (context.phases.length > CONTEXT_ACCUMULATOR_CONFIG.maxPhases) {
    context.phases = context.phases.slice(-CONTEXT_ACCUMULATOR_CONFIG.maxPhases);
  }

  context.lastUpdated = new Date().toISOString();
  return writeAccumulatedContext(directory, context, sessionId);
}

/**
 * Generate the <prior-phase-context> XML block for injection into the next agent's prompt.
 *
 * Returns null if no accumulated context exists.
 */
export function generateContextInjection(
  directory: string,
  sessionId?: string,
): string | null {
  const context = readAccumulatedContext(directory, sessionId);
  if (!context || context.phases.length === 0) {
    return null;
  }

  const lines: string[] = ['<prior-phase-context>'];

  for (const phase of context.phases) {
    lines.push(`\n## ${phase.phaseName} (${phase.phaseId})`);

    if (phase.filesChanged.length > 0) {
      lines.push(`**Files changed:** ${phase.filesChanged.join(', ')}`);
    }

    if (phase.decisions.length > 0) {
      lines.push('**Key decisions:**');
      for (const decision of phase.decisions) {
        lines.push(`- ${decision}`);
      }
    }

    lines.push('');
    lines.push(phase.content);

    if (phase.truncated) {
      lines.push(`\n_Original output was ${phase.originalSize} bytes, truncated to ${CONTEXT_ACCUMULATOR_CONFIG.maxPhaseOutputSize} bytes._`);
    }
  }

  lines.push('\n</prior-phase-context>');
  return lines.join('\n');
}

/**
 * Clear accumulated context for a session.
 * Called on /cancel or session end.
 */
export function clearAccumulatedContext(
  directory: string,
  sessionId?: string,
): boolean {
  return clearModeStateFile('phase-context', directory, sessionId);
}

/**
 * Get summary of accumulated context (for HUD/status display)
 */
export function getContextSummary(
  directory: string,
  sessionId?: string,
): { phaseCount: number; totalSize: number; phases: string[] } | null {
  const context = readAccumulatedContext(directory, sessionId);
  if (!context || context.phases.length === 0) {
    return null;
  }

  return {
    phaseCount: context.phases.length,
    totalSize: context.phases.reduce((sum, p) => sum + Buffer.byteLength(p.content, 'utf-8'), 0),
    phases: context.phases.map((p) => p.phaseName),
  };
}
