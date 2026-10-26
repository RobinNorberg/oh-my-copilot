/**
 * The generated Copilot hook manifest (copilot/hooks.json) and one entry run
 * exactly as Copilot CLI spawns it: `exec` + `args` with no shell, the
 * `${CLAUDE_PLUGIN_ROOT}` token replaced by the plugin root, the entry's `env`
 * on top, and the hook payload on stdin. Shared by the tier 2 CLI scenarios
 * (the ultragoal activation seed) and `omg hooks doctor` (the dry dispatch).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
export const PLUGIN_ROOT_TOKEN = '${CLAUDE_PLUGIN_ROOT}';
export const COPILOT_HOOKS_PATH = 'copilot/hooks.json';
/** Parse `<root>/copilot/hooks.json`; throws when it is missing or not a manifest. */
export function readCopilotHookManifest(root) {
    const parsed = JSON.parse(readFileSync(join(root, COPILOT_HOOKS_PATH), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.hooks || typeof parsed.hooks !== 'object') {
        throw new Error(`${COPILOT_HOOKS_PATH} has no "hooks" object`);
    }
    return parsed;
}
export function resolveEntryArgs(entry, root) {
    return entry.args.map((a) => a.replaceAll(PLUGIN_ROOT_TOKEN, root));
}
/** No matcher matches every call; a matcher is an anchored regex over the (Claude-format) tool name. */
export function entryMatches(entry, toolName) {
    if (!entry.matcher)
        return true;
    if (!toolName)
        return false;
    try {
        return new RegExp(`^(?:${entry.matcher})$`).test(toolName);
    }
    catch {
        return false;
    }
}
/** Seconds Copilot would allow an entry before the extra grace the runner adds. */
export const DEFAULT_ENTRY_TIMEOUT_SEC = 30;
const GRACE_MS = 5_000;
export function dispatchHookEntry(event, entry, root, payload, opts) {
    const timeoutMs = (entry.timeoutSec ?? DEFAULT_ENTRY_TIMEOUT_SEC) * 1000 + GRACE_MS;
    const started = Date.now();
    const res = opts.spawnSync(entry.exec, resolveEntryArgs(entry, root), {
        cwd: opts.cwd,
        env: { ...opts.env, ...(entry.env ?? {}) },
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
    });
    const err = res.error;
    const timedOut = err?.code === 'ETIMEDOUT';
    return {
        event,
        matcher: entry.matcher ?? null,
        status: res.status,
        stdout: String(res.stdout ?? ''),
        stderr: String(res.stderr ?? ''),
        durationMs: Date.now() - started,
        timedOut,
        ...(err && !timedOut ? { error: err.message } : {}),
    };
}
//# sourceMappingURL=copilot-hook-manifest.js.map