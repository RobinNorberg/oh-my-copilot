/**
 * OMC HUD - Model Element
 *
 * Renders the current model name.
 */
import { type HudLabels, type ModelFormat } from '../types.js';
/**
 * Format model name for display.
 * Converts model IDs to friendly names based on the requested format.
 */
export declare function formatModelName(modelId: string | null | undefined, format?: ModelFormat): string | null;
/**
 * Render model element.
 */
export declare function renderModel(modelId: string | null | undefined, format?: ModelFormat, labels?: Pick<HudLabels, 'model'>): string | null;
/**
 * Render the Copilot model verbatim. Copilot display names ("GPT-5.4",
 * "Claude Sonnet 5.5", "Auto>fast") do not follow the Claude id patterns that
 * formatModelName shortens, so they are only width-capped.
 */
export declare function renderCopilotModel(name: string | null | undefined, labels?: Pick<HudLabels, 'model'>): string | null;
//# sourceMappingURL=model.d.ts.map