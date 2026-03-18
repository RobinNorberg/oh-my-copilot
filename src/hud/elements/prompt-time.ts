/**
 * OMC HUD - Prompt Time Element
 *
 * Renders the timestamp of the last user prompt submission.
 * Recorded by the keyword-detector hook on UserPromptSubmit.
 */

import { dim } from '../colors.js';

/**
 * Render prompt submission time.
 *
 * Format: prompt:HH:MM:SS
 */
export function renderPromptTime(promptTime: Date | null): string | null {
  if (!promptTime) return null;

  const hours = String(promptTime.getHours()).padStart(2, '0');
  const minutes = String(promptTime.getMinutes()).padStart(2, '0');
  const seconds = String(promptTime.getSeconds()).padStart(2, '0');

  return `${dim('prompt:')}${hours}:${minutes}:${seconds}`;
}
