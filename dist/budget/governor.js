/**
 * Premium-request budget governor: `budget` settings from `.copilot/omg.jsonc`,
 * the hook side (record usage, SessionStart summary, threshold notices) and
 * the `omg team` fan-out check. Everything here is fail-open: a bug or an
 * unreadable ledger yields no message, never a blocked session.
 *
 * Kill switch: `OMC_BUDGET_GOVERNOR=0` turns every part off.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectConfigPath } from '../config/project-config-path.js';
import { getConfigDir } from '../utils/paths.js';
import { parseJsonc } from '../utils/jsonc.js';
import { copilotEventsPath, HOOK_LOCK_TIMEOUT_MS, ledgerPath, ledgerTotals, putRecord, readCopilotSessionUsage, readLedger, readTailTotals, scanSince, recordUsage, updateLedger, } from './ledger.js';
const LIMIT_KEYS = ['softLimit', 'hardLimit', 'perTeamLimit'];
const KNOWN_KEYS = new Set(['mode', 'unit', ...LIMIT_KEYS]);
/** Estimated records re-read per SessionStart to pick up their final totals. */
const REFRESH_MAX = 20;
/** Time budget of that refresh; the rotation picks up the rest next time. */
const REFRESH_DEADLINE_MS = 300;
/** Validate a raw `budget` block; invalid values are dropped and reported, never thrown. */
export function resolveBudgetSettings(raw, env = process.env) {
    const issues = [];
    const settings = { enabled: env.OMC_BUDGET_GOVERNOR !== '0', mode: 'warn', unit: 'premiumRequests' };
    if (raw === undefined || raw === null)
        return { settings, issues };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push('budget: must be an object');
        return { settings, issues };
    }
    const block = raw;
    for (const key of Object.keys(block))
        if (!KNOWN_KEYS.has(key))
            issues.push(`budget.${key}: unknown key`);
    if (block.mode !== undefined) {
        if (block.mode === 'warn' || block.mode === 'enforce')
            settings.mode = block.mode;
        else
            issues.push(`budget.mode: must be "warn" or "enforce" (got ${JSON.stringify(block.mode)}); using "warn"`);
    }
    if (block.unit !== undefined) {
        if (block.unit === 'premiumRequests' || block.unit === 'credits')
            settings.unit = block.unit;
        else
            issues.push(`budget.unit: must be "premiumRequests" or "credits" (got ${JSON.stringify(block.unit)}); using "premiumRequests"`);
    }
    for (const key of LIMIT_KEYS) {
        const value = block[key];
        if (value === undefined)
            continue;
        if (typeof value === 'number' && Number.isFinite(value) && value > 0)
            settings[key] = value;
        else
            issues.push(`budget.${key}: must be a positive number (got ${JSON.stringify(value)}); ignored`);
    }
    if (settings.softLimit !== undefined && settings.hardLimit !== undefined && settings.softLimit > settings.hardLimit) {
        issues.push(`budget.softLimit (${settings.softLimit}) is above budget.hardLimit (${settings.hardLimit})`);
    }
    return { settings, issues };
}
function readBudgetBlock(path) {
    if (!existsSync(path))
        return undefined;
    const parsed = parseJsonc(readFileSync(path, 'utf8'));
    return parsed?.budget;
}
/** User config, then `.copilot/omg.jsonc` of `cwd` (per-key override). */
export function loadBudgetSettings(cwd, env = process.env) {
    let user;
    let project;
    const issues = [];
    try {
        user = readBudgetBlock(join(getConfigDir(), 'claude-omc', 'config.jsonc'));
    }
    catch {
        issues.push('budget: user config unreadable');
    }
    try {
        project = readBudgetBlock(resolveProjectConfigPath(cwd));
    }
    catch {
        issues.push('budget: project config unreadable');
    }
    const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const merged = isObject(user) && isObject(project) ? { ...user, ...project } : project ?? user;
    const resolved = resolveBudgetSettings(merged, env);
    return { settings: resolved.settings, issues: [...issues, ...resolved.issues] };
}
export function hasLimits(s) {
    return s.softLimit !== undefined || s.hardLimit !== undefined || s.perTeamLimit !== undefined;
}
export function usedInUnit(totals, unit) {
    return unit === 'credits' ? totals.credits : totals.premiumRequests;
}
export function formatAmount(value, unit) {
    const n = Number.isInteger(value) ? String(value) : value.toFixed(unit === 'credits' ? 3 : 2);
    return `${n} ${unit === 'credits' ? 'AI credits' : 'premium requests'}`;
}
export function summaryLine(ledger, settings) {
    const t = ledgerTotals(ledger);
    const limits = [
        settings.softLimit !== undefined ? `soft ${settings.softLimit}` : '',
        settings.hardLimit !== undefined ? `hard ${settings.hardLimit}` : '',
        settings.perTeamLimit !== undefined ? `per team ${settings.perTeamLimit}` : '',
    ].filter(Boolean).join(', ');
    const estimated = t.estimatedRecords > 0 ? `; ${t.estimatedRecords} record(s) estimated` : '';
    return `[BUDGET] Copilot usage since ${ledger.since.slice(0, 10)}: ${formatAmount(t.premiumRequests, 'premiumRequests')}, `
        + `${formatAmount(Number(t.credits.toFixed(3)), 'credits')} (${t.sessions} session(s), ${Object.keys(t.teams).length} team(s)${estimated}). `
        + `Limits in ${settings.unit}: ${limits || 'none'} (${settings.mode} mode). Details: omg budget status.`;
}
/** Mark newly crossed thresholds in `ledger` and return the notice, or null. */
export function checkThresholds(ledger, settings, now = new Date()) {
    const totals = ledgerTotals(ledger);
    const used = usedInUnit(totals, settings.unit);
    const n = ledger.notified;
    // A raised limit re-arms its notice.
    if (n.hard && n.hardLimit !== undefined && settings.hardLimit !== undefined && settings.hardLimit > n.hardLimit) {
        delete n.hard;
        delete n.hardLimit;
    }
    if (n.soft && n.softLimit !== undefined && settings.softLimit !== undefined && settings.softLimit > n.softLimit) {
        delete n.soft;
        delete n.softLimit;
    }
    const estimated = totals.estimatedRecords > 0 ? ` (${totals.estimatedRecords} record(s) estimated)` : '';
    const amount = (limit) => `${formatAmount(Number(used.toFixed(3)), settings.unit)} of ${limit} used since ${ledger.since.slice(0, 10)}${estimated}`;
    if (settings.hardLimit !== undefined && used >= settings.hardLimit && !n.hard) {
        n.hard = now.toISOString();
        n.hardLimit = settings.hardLimit;
        if (!n.soft && settings.softLimit !== undefined) {
            n.soft = n.hard;
            n.softLimit = settings.softLimit;
        }
        const gate = settings.mode === 'enforce' ? ' New `omg team` fan-out is refused or clamped until `omg budget reset` or a higher budget.hardLimit.' : '';
        return `[BUDGET] Hard limit reached: ${amount(settings.hardLimit)}.${gate} Tell the user before starting more work.`;
    }
    if (settings.softLimit !== undefined && used >= settings.softLimit && !n.soft) {
        n.soft = now.toISOString();
        n.softLimit = settings.softLimit;
        return `[BUDGET] Soft limit reached: ${amount(settings.softLimit)}. Mention this to the user.`;
    }
    return null;
}
function payloadString(payload, ...keys) {
    for (const key of keys) {
        const v = payload?.[key];
        if (typeof v === 'string' && v.trim())
            return v;
    }
    return undefined;
}
/**
 * One hook invocation. Returns the hook stdout object, or null for no output.
 * Team worker sessions record under their team and never get notices; sdk
 * workers (`OMC_BUDGET_HOST_LEDGER=1`) are recorded by their host instead.
 */
export function runBudgetHook(input) {
    const env = input.env ?? process.env;
    const now = input.now ?? new Date();
    const cwd = payloadString(input.payload, 'cwd') ?? process.cwd();
    const sessionId = payloadString(input.payload, 'session_id', 'sessionId');
    const worker = typeof env.OMC_TEAM_WORKER === 'string' && env.OMC_TEAM_WORKER.includes('/') ? env.OMC_TEAM_WORKER : undefined;
    const ledgerCwd = worker ? env.OMC_TEAM_LEADER_CWD || cwd : cwd;
    const { settings } = loadBudgetSettings(ledgerCwd, env);
    if (!settings.enabled)
        return null;
    const path = ledgerPath(ledgerCwd);
    const lock = { timeoutMs: HOOK_LOCK_TIMEOUT_MS };
    const team = worker?.split('/')[0];
    if (input.phase !== 'submit' && sessionId && env.OMC_BUDGET_HOST_LEDGER !== '1') {
        const events = copilotEventsPath(sessionId);
        if (events) {
            const ledger = readLedger(path);
            const stored = team ? ledger.teams[team]?.[sessionId] : ledger.sessions[sessionId];
            const usage = readCopilotSessionUsage(events, now, { since: scanSince(ledger), ...(stored?.scan ? { prev: stored.scan } : {}) });
            if (usage)
                recordUsage(path, sessionId, usage, team, lock);
        }
    }
    if (worker)
        return null;
    if (input.phase === 'start') {
        refreshEstimates(path, now, lock, input.refreshDeadlineMs);
        if (!hasLimits(settings))
            return null;
        return { continue: true, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: summaryLine(readLedger(path), settings) } };
    }
    if (input.phase === 'turn') {
        if (!hasLimits(settings))
            return null;
        const notice = updateLedger(path, (ledger) => {
            const n = checkThresholds(ledger, settings, now);
            if (n)
                ledger.pendingNotice = n;
            return n;
        }, lock);
        return notice ? { continue: true, systemMessage: notice } : null;
    }
    // submit: deliver a pending notice as model context (Copilot injects top-level additionalContext).
    if (!readLedger(path).pendingNotice)
        return null;
    const notice = updateLedger(path, (ledger) => {
        const n = ledger.pendingNotice;
        delete ledger.pendingNotice;
        return n;
    }, lock);
    return notice ? { continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notice } } : null;
}
/**
 * Upgrade estimated records (sessions and pane team workers) whose session
 * has since written its totals. Bounded: at most REFRESH_MAX records per call,
 * rotating through the candidates, a tail read each, skipped when the events
 * file is unchanged since the last check, and a REFRESH_DEADLINE_MS budget.
 * A record whose events file is gone is marked final. Records without scan
 * state (sdk host records) are their host's business.
 */
export function refreshEstimates(path, now, lock = {}, deadlineMs = REFRESH_DEADLINE_MS) {
    const ledger = readLedger(path);
    const candidates = [];
    for (const key of Object.keys(ledger.sessions).sort())
        candidates.push({ key, record: ledger.sessions[key] });
    for (const team of Object.keys(ledger.teams).sort()) {
        for (const key of Object.keys(ledger.teams[team]).sort())
            candidates.push({ key, team, record: ledger.teams[team][key] });
    }
    const stale = candidates.filter((c) => c.record.source === 'estimated' && c.record.scan && !c.record.scan.gone);
    if (stale.length === 0)
        return;
    const start = (ledger.refreshCursor ?? 0) % stale.length;
    const deadline = Date.now() + deadlineMs;
    const updates = [];
    let visited = 0;
    // At least one record per call, so the rotation always moves on.
    for (; visited < Math.min(REFRESH_MAX, stale.length) && (visited === 0 || Date.now() < deadline); visited++) {
        const { key, team, record } = stale[(start + visited) % stale.length];
        const scan = record.scan;
        const events = copilotEventsPath(key);
        let stat = null;
        try {
            stat = events ? statSync(events) : null;
        }
        catch {
            stat = null;
        }
        if (!stat) {
            updates.push({ key, team, usage: { ...record, detail: `${record.detail}; events file gone, final`, scan: { ...scan, gone: true }, updatedAt: now.toISOString() } });
            continue;
        }
        const mtimeMs = Math.floor(stat.mtimeMs); // whole ms: survives JSON and filesystems with coarser stamps
        if (scan.checkedSize === stat.size && scan.checkedMtimeMs === mtimeMs)
            continue;
        const checked = { ...scan, checkedSize: stat.size, checkedMtimeMs: mtimeMs };
        const tail = readTailTotals(events, stat.size);
        const usage = tail
            ? { premiumRequests: tail.premium, credits: tail.nano / 1e9, source: 'measured', detail: `${tail.type} (events tail)`, ...(tail.model ? { model: tail.model } : {}), updatedAt: now.toISOString(), scan: checked }
            : { ...record, scan: checked };
        updates.push({ key, team, usage });
    }
    const cursor = (start + visited) % stale.length;
    if (updates.length === 0 && cursor === (ledger.refreshCursor ?? 0))
        return;
    updateLedger(path, (fresh) => {
        if (fresh.since !== ledger.since)
            return; // reset in between: these records are gone
        for (const { key, team, usage } of updates) {
            const current = team ? fresh.teams[team]?.[key] : fresh.sessions[key];
            if (!current)
                continue;
            if (usage.source === 'estimated') {
                // Bookkeeping only (checked size/mtime, gone): never lower what a concurrent hook stored.
                const merged = { ...current, scan: { ...(current.scan ?? usage.scan), checkedSize: usage.scan.checkedSize, checkedMtimeMs: usage.scan.checkedMtimeMs, ...(usage.scan.gone ? { gone: true } : {}) } };
                if (usage.scan.gone && current.source === 'estimated')
                    merged.detail = usage.detail;
                if (team)
                    fresh.teams[team][key] = merged;
                else
                    fresh.sessions[key] = merged;
            }
            else {
                putRecord(fresh, key, usage, team);
            }
        }
        fresh.refreshCursor = cursor;
    }, lock);
}
/**
 * Projected cost of a launch, ESTIMATED: one premium request per copilot
 * worker (its first prompt at an assumed x1 multiplier), or the per-worker
 * credit cap in `credits`. Non-copilot workers are not billed to Copilot.
 */
export function governTeamFanout(input) {
    const { settings, agentTypes } = input;
    const workerCount = agentTypes.length;
    if (!settings.enabled)
        return { workerCount };
    const copilot = agentTypes.filter((t) => t === 'copilot').length;
    const perWorker = settings.unit === 'credits' ? input.maxCreditsPerWorker : 1;
    const used = usedInUnit(input.totals, settings.unit);
    const bounds = [];
    if (settings.perTeamLimit !== undefined)
        bounds.push({ budget: settings.perTeamLimit, label: `budget.perTeamLimit ${settings.perTeamLimit}` });
    if (settings.hardLimit !== undefined) {
        bounds.push({ budget: Math.max(0, settings.hardLimit - used), label: `the ${formatAmount(Number(Math.max(0, settings.hardLimit - used).toFixed(3)), settings.unit)} left of budget.hardLimit ${settings.hardLimit}` });
    }
    if (copilot === 0 || bounds.length === 0)
        return { workerCount };
    const tightest = bounds.reduce((a, b) => (b.budget < a.budget ? b : a));
    const projected = copilot * perWorker;
    if (projected <= tightest.budget)
        return { workerCount };
    const basis = settings.unit === 'credits' ? `x ${perWorker} credit cap` : 'x 1 premium request for the first prompt, estimated';
    // A floor: each worker's first prompt at x1; follow-ups and multipliers add to it.
    const amount = settings.unit === 'credits' ? formatAmount(projected, settings.unit) : `at least ${formatAmount(projected, settings.unit)}`;
    const over = `[omg budget] projected ${amount} (${copilot} copilot worker(s) ${basis}) exceeds ${tightest.label}`;
    if (settings.mode !== 'enforce' || input.override) {
        return { workerCount, notice: `${over}; starting anyway (${input.override ? '--budget-override' : 'warn mode'}).` };
    }
    const allowed = Math.floor(tightest.budget / perWorker);
    const fix = 'Pass --budget-override, raise the limit in .copilot/omg.jsonc, or run `omg budget reset`.';
    if (allowed >= 1 && copilot === workerCount && input.clampable) {
        return { workerCount: allowed, notice: `${over}; clamped to ${allowed} worker(s). ${fix}` };
    }
    return { workerCount, refusal: `${over}; team launch refused. ${fix}` };
}
//# sourceMappingURL=governor.js.map