/**
 * Pure evaluators for the artifacts of a Tier 1 `omg smoke copilot` session:
 * stdout JSONL, `<COPILOT_HOME>/session-state/<id>/events.jsonl`, the debug
 * process log, and the project's `.omg/` state. Kept free of process spawning
 * so the unit tests can run them against captured fixtures.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
export const EVIDENCE_MAX = 400;
export function excerpt(text, max = EVIDENCE_MAX) {
    if (!text)
        return '';
    const flat = text.replace(/\r/g, '').trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}
/** Parse JSON Lines defensively: non-JSON lines are counted, never thrown. */
export function parseJsonl(text) {
    const events = [];
    let bad = 0;
    let badSample;
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                events.push(parsed);
            else {
                bad++;
                badSample ??= trimmed;
            }
        }
        catch {
            bad++;
            badSample ??= trimmed;
        }
    }
    return { events, bad, badSample };
}
function str(value) {
    return typeof value === 'string' ? value : '';
}
/** Concatenated assistant output (final messages and deltas). */
export function assistantText(events) {
    return events
        .filter((e) => typeof e.type === 'string' && e.type.startsWith('assistant.message'))
        .map((e) => str(e.data?.content) || str(e.data?.deltaContent) || str(e.data?.text))
        .join('');
}
export const SMOKE_TOKEN = 'SMOKE_OK';
export function evaluateSessionExit(input) {
    const { events } = parseJsonl(input.stdout);
    // Only assistant output counts: the prompt itself (echoed as user.message) contains the token.
    const answer = events.length > 0 ? assistantText(events) : input.stdout;
    const source = events.length > 0 ? `${events.length} JSONL events` : 'raw stdout';
    const sawToken = answer.includes(SMOKE_TOKEN);
    if (input.timedOut) {
        return { id: 'session.exit', ok: false, detail: `timed out after ${input.timeoutMs} ms (process tree killed)`, evidence: excerpt(input.stderr || input.stdout) };
    }
    if (input.error) {
        return { id: 'session.exit', ok: false, detail: `spawn failed: ${input.error}` };
    }
    const ok = input.exitCode === 0 && sawToken;
    const modelHint = /from --model flag is not available/.test(input.stderr) ? '; the CLI rejected --model, omit it to let the CLI auto-pick' : '';
    return {
        id: 'session.exit',
        ok,
        detail: ok
            ? `exit 0, assistant replied ${SMOKE_TOKEN} (${source})`
            : `exit ${input.exitCode}, ${sawToken ? 'token present' : `${SMOKE_TOKEN} missing from assistant output`} (${source})${modelHint}`,
        ...(ok ? {} : { evidence: excerpt(input.stderr.trim() || answer || input.stdout.slice(-EVIDENCE_MAX)) }),
    };
}
export function evaluateEventsLog(eventsPath, text) {
    if (text === null) {
        return { check: { id: 'session.events', ok: false, detail: `missing ${eventsPath}` }, events: [] };
    }
    const { events, bad, badSample } = parseJsonl(text);
    const ok = events.length > 0 && bad === 0;
    return {
        check: {
            id: 'session.events',
            ok,
            detail: `${events.length} events parsed, ${bad} unparseable line(s)`,
            ...(ok ? {} : { evidence: excerpt(badSample ?? text) }),
        },
        events,
    };
}
/** Hook types the default (tool-free) prompt must fire. */
export const REQUIRED_HOOK_TYPES = ['sessionStart', 'userPromptSubmitted', 'agentStop', 'sessionEnd'];
/** Hook types that only fire when the model used a tool. */
export const TOOL_HOOK_TYPES = ['preToolUse', 'postToolUse'];
/**
 * Pair `hook.start` with `hook.end`. The end event's `hookType` is used when
 * present; otherwise it is matched through a shared invocation id or the
 * start event's id (parentId).
 */
export function collectHookRuns(events) {
    const runs = [];
    const byKey = new Map();
    const keysOf = (e) => {
        const d = e.data ?? {};
        return [str(d.hookInvocationId), str(d.invocationId), str(d.hookId)].filter(Boolean);
    };
    for (const e of events) {
        if (e.type === 'hook.start') {
            const run = { hookType: str(e.data?.hookType), ended: false, success: null };
            runs.push(run);
            for (const key of keysOf(e))
                byKey.set(key, run);
            if (e.id)
                byKey.set(`id:${e.id}`, run);
        }
        else if (e.type === 'hook.end') {
            const d = e.data ?? {};
            let run = keysOf(e).map((k) => byKey.get(k)).find(Boolean)
                ?? (e.parentId ? byKey.get(`id:${e.parentId}`) : undefined);
            const hookType = str(d.hookType) || run?.hookType || '';
            if (!run || (hookType && run.hookType && run.hookType !== hookType) || run.ended) {
                run = runs.find((r) => !r.ended && r.hookType === hookType);
            }
            if (!run) {
                run = { hookType, ended: false, success: null };
                runs.push(run);
            }
            run.ended = true;
            run.success = typeof d.success === 'boolean' ? d.success : (d.error ? false : null);
            const err = d.error;
            if (err)
                run.error = typeof err === 'string' ? err : JSON.stringify(err);
        }
    }
    return runs;
}
export function evaluateHooks(events) {
    const runs = collectHookRuns(events);
    const toolUsed = events.some((e) => e.type === 'tool.execution_start');
    const checks = [];
    const check = (hookType, optional) => {
        const mine = runs.filter((r) => r.hookType === hookType);
        const id = `hooks.${hookType}`;
        if (mine.length === 0) {
            if (optional && !toolUsed)
                return { id, ok: true, detail: 'n/a (no tool use)' };
            return { id, ok: false, detail: `no hook.start/hook.end with hookType ${hookType}` };
        }
        const ended = mine.filter((r) => r.ended);
        // Only an explicit success:true passes; a missing/null flag is not evidence of success.
        const failed = ended.filter((r) => r.success !== true);
        const ok = ended.length > 0 && failed.length === 0;
        return {
            id,
            ok,
            detail: `${mine.length} start(s), ${ended.length} end(s), ${failed.length} without success:true`,
            ...(ok ? {} : {
                evidence: excerpt(failed.map((r) => r.error ?? `success=${String(r.success)}`).join(' | ') || 'hook.end missing'),
            }),
        };
    };
    for (const t of REQUIRED_HOOK_TYPES)
        checks.push(check(t, false));
    for (const t of TOOL_HOOK_TYPES)
        checks.push(check(t, true));
    return checks;
}
/**
 * `[omg-hook]` stderr lines from scripts/lib/copilot-hook-adapter.cjs that are
 * informational, not failures. Every other `[omg-hook]` line (internal error /
 * failing open, adapter error, hook target is not a file) fails the check.
 */
export const BENIGN_ADAPTER_NOTES = [/continue:false overrides decision:block/, /dropped hookSpecificOutput\.updatedInput/];
/**
 * The adapter fails open by default (non-zero exit -> 0 plus an `[omg-hook]`
 * stderr line), which Copilot records as `hook.end success:true`. The smoke
 * runs with OMC_HOOK_FAIL_CLOSED=1, and this check catches what still slips
 * through by scanning every captured stream for adapter error lines.
 */
export function evaluateAdapterErrors(sources) {
    const id = 'hooks.adapter_errors';
    const hits = [];
    const scanned = [];
    for (const { name, text } of sources) {
        if (!text)
            continue;
        scanned.push(name);
        for (const line of text.split(/\r?\n/)) {
            if (!line.includes('[omg-hook]'))
                continue;
            if (BENIGN_ADAPTER_NOTES.some((re) => re.test(line)))
                continue;
            hits.push(`${name}: ${line.trim()}`);
        }
    }
    if (hits.length === 0) {
        return { id, ok: true, detail: `no [omg-hook] error lines in ${scanned.join(', ') || 'any captured stream'}` };
    }
    return { id, ok: false, detail: `${hits.length} [omg-hook] error line(s): a hook failed`, evidence: excerpt(hits.join('\n')) };
}
const PLUGIN_NAME = 'oh-my-copilot';
/** Plugin names from a `Plugins loaded: ["a","b"]` debug line (exact names, not substrings). */
export function parsePluginsLoaded(line) {
    const rest = line.slice(line.indexOf('Plugins loaded:') + 'Plugins loaded:'.length).trim();
    try {
        const parsed = JSON.parse(rest);
        if (Array.isArray(parsed))
            return parsed.filter((n) => typeof n === 'string');
    }
    catch { /* not a JSON array */ }
    return [...rest.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}
export function evaluatePluginsLoaded(logText) {
    const id = 'plugins.loaded';
    if (logText === null)
        return { id, ok: false, detail: 'no debug log found under <home>/logs' };
    const loadedLine = logText.split(/\r?\n/).find((l) => l.includes('Plugins loaded:'));
    const activationLine = logText.split(/\r?\n/).find((l) => /Plugin activation \[agents\]/.test(l));
    const listed = !!loadedLine && parsePluginsLoaded(loadedLine).includes(PLUGIN_NAME);
    const activated = !!activationLine && /loaded=([1-9]\d*)/.test(activationLine);
    const ok = listed && activated;
    return {
        id,
        ok,
        detail: ok
            ? `Plugins loaded lists ${PLUGIN_NAME}; agents activation loaded>=1`
            : `${listed ? '' : `"Plugins loaded:" without ${PLUGIN_NAME}; `}${activated ? '' : 'no "Plugin activation [agents]" with loaded>=1'}`.trim(),
        evidence: excerpt([loadedLine, activationLine].filter(Boolean).join('\n')) || undefined,
    };
}
export const MCP_STDERR_TAG = 'OMC Tools MCP Server running on stdio';
export function evaluateMcpLoaded(events, logText, serverNames) {
    const id = 'mcp.server_loaded';
    const loaded = events.filter((e) => e.type === 'session.mcp_servers_loaded');
    const mentionsOurs = (value) => {
        const json = JSON.stringify(value ?? '');
        return serverNames.some((n) => json.includes(`"${n}"`));
    };
    const ours = loaded.find((e) => mentionsOurs(e.data));
    if (ours) {
        return { id, ok: true, detail: `session.mcp_servers_loaded lists ${serverNames.join(', ')} (events)`, evidence: excerpt(JSON.stringify(ours.data)) };
    }
    const statusChange = events.find((e) => e.type === 'session.mcp_server_status_changed'
        && serverNames.includes(str(e.data?.serverName)) && str(e.data?.status) === 'connected');
    if (statusChange) {
        return { id, ok: true, detail: `session.mcp_server_status_changed ${str(statusChange.data?.serverName)}=connected (events)`, evidence: excerpt(JSON.stringify(statusChange.data)) };
    }
    const tagLine = logText?.split(/\r?\n/).find((l) => l.includes(MCP_STDERR_TAG)
        && serverNames.some((n) => l.includes(`"server_name":"${n}"`) || l.includes(`server_name: ${n}`) || l.includes(`"serverName":"${n}"`)))
        ?? logText?.split(/\r?\n/).find((l) => l.includes(MCP_STDERR_TAG));
    if (tagLine) {
        return { id, ok: true, detail: 'debug log shows the plugin MCP server stderr tag', evidence: excerpt(tagLine) };
    }
    return {
        id,
        ok: false,
        detail: `no session.mcp_servers_loaded/status event naming ${serverNames.join(', ')} and no "${MCP_STDERR_TAG}" in the debug log`,
        evidence: excerpt(loaded.map((e) => JSON.stringify(e.data)).join('\n')) || undefined,
    };
}
export const SESSION_STARTED_MARKER = 'session-started.json';
function walkFiles(root, limit = 500) {
    const out = [];
    const stack = [root];
    while (stack.length && out.length < limit) {
        const dir = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const name of entries) {
            const full = join(dir, name);
            try {
                if (statSync(full).isDirectory())
                    stack.push(full);
                else
                    out.push(full);
            }
            catch { /* raced */ }
        }
    }
    return out;
}
/**
 * Our SessionStart hook (scripts/session-start.mjs) writes
 * `.omg/state/sessions/<id>/session-started.json`; other hooks add more files
 * under `.omg/`. Pass when the marker exists, else when anything was written.
 */
export function evaluateStateWritten(projectDir) {
    const id = 'state.written';
    const omgRoot = join(projectDir, '.omg');
    if (!existsSync(omgRoot))
        return { id, ok: false, detail: `${omgRoot} was not created by the hooks` };
    const files = walkFiles(omgRoot).map((f) => relative(projectDir, f).replace(/\\/g, '/'));
    const marker = files.find((f) => f.endsWith(`/${SESSION_STARTED_MARKER}`) && f.includes('state/sessions/'));
    if (marker)
        return { id, ok: true, detail: `SessionStart wrote ${marker}`, evidence: excerpt(files.join('\n')) };
    return {
        id,
        ok: false,
        detail: files.length ? `.omg/ has ${files.length} file(s) but no state/sessions/*/${SESSION_STARTED_MARKER}` : '.omg/ exists but is empty',
        evidence: excerpt(files.join('\n')) || undefined,
    };
}
export function evaluateSubagent(events, agentName) {
    const id = 'subagent.selected';
    const named = (type) => events.find((e) => e.type === type && str(e.data?.agentName) === agentName);
    // 1.0.91 emits subagent.started before subagent.selected; prefer the contract's event.
    const hit = named('subagent.selected') ?? named('subagent.started');
    if (hit)
        return { id, ok: true, detail: `${hit.type} ${agentName}`, evidence: excerpt(JSON.stringify(hit.data)) };
    const any = events.filter((e) => typeof e.type === 'string' && e.type.startsWith('subagent.'));
    return {
        id,
        ok: false,
        detail: `no subagent.selected/started for ${agentName}`,
        evidence: excerpt(any.map((e) => `${e.type} ${JSON.stringify(e.data)}`).join('\n')) || undefined,
    };
}
//# sourceMappingURL=copilot-session-eval.js.map