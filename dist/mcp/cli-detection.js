// DEPRECATED: Use src/team/cli-detection.ts instead
export * from '../team/cli-detection.js';
import { probeCli } from '../platform/executable-resolution.js';
// Session-level cache for detection results
let codexCache = null;
let geminiCache = null;
/** Availability tracks path resolution here; the version probe stays optional. */
function toDetectionResult(probe, notFoundError, installHint) {
    if (!probe.found || !probe.path) {
        return { available: false, error: notFoundError, installHint };
    }
    return {
        available: true,
        path: probe.path,
        ...(probe.version === undefined ? {} : { version: probe.version }),
        installHint,
    };
}
/**
 * @deprecated Use isCliAvailable('codex') from src/team/cli-detection.ts instead
 */
export function detectCodexCli(useCache = true) {
    if (useCache && codexCache)
        return codexCache;
    const installHint = 'Install Codex CLI: npm install -g @openai/codex';
    const result = toDetectionResult(probeCli('codex'), 'Codex CLI not found on PATH', installHint);
    codexCache = result;
    return result;
}
/**
 * @deprecated Use isCliAvailable('gemini') from src/team/cli-detection.ts instead
 */
export function detectGeminiCli(useCache = true) {
    if (useCache && geminiCache)
        return geminiCache;
    const installHint = 'Install Gemini CLI: npm install -g @google/gemini-cli (see https://github.com/google-gemini/gemini-cli)';
    const result = toDetectionResult(probeCli('gemini'), 'Gemini CLI not found on PATH', installHint);
    geminiCache = result;
    return result;
}
/**
 * Reset detection cache (useful for testing)
 * @deprecated Use detectCli() from src/team/cli-detection.ts which has no cache
 */
export function resetDetectionCache() {
    codexCache = null;
    geminiCache = null;
}
//# sourceMappingURL=cli-detection.js.map