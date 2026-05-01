import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { triggerStopCallbacks } from './callbacks.js';
import { getOMCConfig } from '../../features/auto-update.js';
import { buildConfigFromEnv, getEnabledPlatforms, getNotificationConfig } from '../../notifications/config.js';
import { notify } from '../../notifications/index.js';
import { cleanupBridgeSessions } from '../../tools/python-repl/bridge-manager.js';
import { resolveToWorktreeRoot, getOmcRoot, validateSessionId, isValidTranscriptPath, resolveSessionStatePath } from '../../lib/worktree-paths.js';
import { SESSION_END_MODE_STATE_FILES, SESSION_METRICS_MODE_FILES } from '../../lib/mode-names.js';
import { clearModeStateFile, readModeState } from '../../lib/mode-state-io.js';
const SESSION_STARTED_MARKER_FILE = 'session-started.json';
function hasExplicitNotificationConfig(profileName) {
    const config = getOMCConfig();
    if (profileName) {
        const profile = config.notificationProfiles?.[profileName];
        if (profile && typeof profile.enabled === 'boolean') {
            return true;
        }
    }
    if (config.notifications && typeof config.notifications.enabled === 'boolean') {
        return true;
    }
    return buildConfigFromEnv() !== null;
}
function getLegacyPlatformsCoveredByNotifications(enabledPlatforms) {
    const overlappingPlatforms = [];
    if (enabledPlatforms.includes('telegram')) {
        overlappingPlatforms.push('telegram');
    }
    if (enabledPlatforms.includes('discord')) {
        overlappingPlatforms.push('discord');
    }
    return overlappingPlatforms;
}
/**
 * Read agent tracking to get spawn/completion counts
 */
function getAgentCounts(directory) {
    const trackingPath = path.join(getOmcRoot(directory), 'state', 'subagent-tracking.json');
    if (!fs.existsSync(trackingPath)) {
        return { spawned: 0, completed: 0 };
    }
    try {
        const content = fs.readFileSync(trackingPath, 'utf-8');
        const tracking = JSON.parse(content);
        const spawned = tracking.agents?.length || 0;
        const completed = tracking.agents?.filter((a) => a.status === 'completed').length || 0;
        return { spawned, completed };
    }
    catch (_error) {
        return { spawned: 0, completed: 0 };
    }
}
/**
 * Detect which modes were used during the session
 */
function getModesUsed(directory) {
    const stateDir = path.join(getOmcRoot(directory), 'state');
    const modes = [];
    if (!fs.existsSync(stateDir)) {
        return modes;
    }
    for (const { file, mode } of SESSION_METRICS_MODE_FILES) {
        const statePath = path.join(stateDir, file);
        if (fs.existsSync(statePath)) {
            modes.push(mode);
        }
    }
    return modes;
}
/**
 * Get session start time from state files.
 *
 * When sessionId is provided, only state files whose session_id matches are
 * considered.  State files that carry a *different* session_id are treated as
 * stale leftovers and skipped — this is the fix for issue #573 where stale
 * state files caused grossly overreported session durations.
 *
 * Legacy state files (no session_id field) are used as a fallback so that
 * older state formats still work.
 *
 * When multiple files match, the earliest started_at is returned so that
 * duration reflects the full session span (e.g. autopilot started before
 * ultrawork).
 */
export function getSessionStartTime(directory, sessionId) {
    const stateDir = path.join(getOmcRoot(directory), 'state');
    if (!fs.existsSync(stateDir)) {
        return undefined;
    }
    const stateFiles = fs.readdirSync(stateDir).filter(f => f.endsWith('.json'));
    let matchedStartTime;
    let matchedEpoch = Infinity;
    let legacyStartTime;
    let legacyEpoch = Infinity;
    for (const file of stateFiles) {
        try {
            const statePath = path.join(stateDir, file);
            const content = fs.readFileSync(statePath, 'utf-8');
            const state = JSON.parse(content);
            if (!state.started_at) {
                continue;
            }
            const ts = Date.parse(state.started_at);
            if (!Number.isFinite(ts)) {
                continue; // skip invalid / malformed timestamps
            }
            if (sessionId && state.session_id === sessionId) {
                // State belongs to the current session — prefer earliest
                if (ts < matchedEpoch) {
                    matchedEpoch = ts;
                    matchedStartTime = state.started_at;
                }
            }
            else if (!state.session_id) {
                // Legacy state without session_id — fallback only
                if (ts < legacyEpoch) {
                    legacyEpoch = ts;
                    legacyStartTime = state.started_at;
                }
            }
            // else: state has a different session_id — stale, skip
        }
        catch (_error) {
            continue;
        }
    }
    return matchedStartTime ?? legacyStartTime;
}
/**
 * Record session metrics
 */
export function recordSessionMetrics(directory, input) {
    const endedAt = new Date().toISOString();
    const startedAt = getSessionStartTime(directory, input.session_id);
    const { spawned, completed } = getAgentCounts(directory);
    const modesUsed = getModesUsed(directory);
    const metrics = {
        session_id: input.session_id,
        started_at: startedAt,
        ended_at: endedAt,
        reason: input.reason,
        agents_spawned: spawned,
        agents_completed: completed,
        modes_used: modesUsed,
    };
    // Calculate duration if start time is available
    if (startedAt) {
        try {
            const startTime = new Date(startedAt).getTime();
            const endTime = new Date(endedAt).getTime();
            metrics.duration_ms = endTime - startTime;
        }
        catch (_error) {
            // Invalid date, skip duration
        }
    }
    return metrics;
}
/**
 * Clean up transient state files
 */
export function cleanupTransientState(directory) {
    let filesRemoved = 0;
    const omcDir = getOmcRoot(directory);
    if (!fs.existsSync(omcDir)) {
        return filesRemoved;
    }
    // Remove transient agent tracking
    const trackingPath = path.join(omcDir, 'state', 'subagent-tracking.json');
    if (fs.existsSync(trackingPath)) {
        try {
            fs.unlinkSync(trackingPath);
            filesRemoved++;
        }
        catch (_error) {
            // Ignore removal errors
        }
    }
    // Clean stale checkpoints (older than 24 hours)
    const checkpointsDir = path.join(omcDir, 'checkpoints');
    if (fs.existsSync(checkpointsDir)) {
        const now = Date.now();
        const oneDayAgo = now - 24 * 60 * 60 * 1000;
        try {
            const files = fs.readdirSync(checkpointsDir);
            for (const file of files) {
                const filePath = path.join(checkpointsDir, file);
                const stats = fs.statSync(filePath);
                if (stats.mtimeMs < oneDayAgo) {
                    fs.unlinkSync(filePath);
                    filesRemoved++;
                }
            }
        }
        catch (_error) {
            // Ignore cleanup errors
        }
    }
    // Remove .tmp files in .omcp/
    const removeTmpFiles = (dir) => {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    removeTmpFiles(fullPath);
                }
                else if (entry.name.endsWith('.tmp')) {
                    fs.unlinkSync(fullPath);
                    filesRemoved++;
                }
            }
        }
        catch (_error) {
            // Ignore errors
        }
    };
    removeTmpFiles(omcDir);
    // Clean stale per-session transient markers across every session dir.
    // Patterns are cross-session-safe: short-lived markers/breakers that no
    // live concurrent session is reading.
    //
    // NOTE: hud-stdin-cache.json is now session-scoped (see src/hud/stdin.ts)
    // but is NOT pruned here — deleting it from the wrong session would
    // reintroduce the cross-session interference the new scoping fixed.
    // Proper per-ending-session cleanup requires the caller to pass the
    // ending sessionId in; until that plumbing exists we leave the cache to
    // be overwritten on the next write in the owning session.
    const sessionsDir = path.join(omcDir, 'state', 'sessions');
    if (fs.existsSync(sessionsDir)) {
        const crossSessionSafePatterns = [
            /^cancel-signal/,
            /stop-breaker/,
        ];
        try {
            for (const sid of fs.readdirSync(sessionsDir)) {
                const sessionDir = path.join(sessionsDir, sid);
                try {
                    if (!fs.statSync(sessionDir).isDirectory())
                        continue;
                    for (const file of fs.readdirSync(sessionDir)) {
                        if (crossSessionSafePatterns.some((p) => p.test(file))) {
                            try {
                                fs.unlinkSync(path.join(sessionDir, file));
                                filesRemoved++;
                            }
                            catch {
                                // Best-effort
                            }
                        }
                    }
                }
                catch {
                    // Skip entries we can't stat/read
                }
            }
        }
        catch {
            // Ignore top-level sessions dir read errors
        }
    }
    return filesRemoved;
}
/**
 * Mode state files that should be cleaned up on session end.
 * Imported from the shared mode-names module (issue #1058).
 */
const PYTHON_REPL_TOOL_NAMES = new Set(['python_repl', 'mcp__t__python_repl']);
/**
 * Extract python_repl research session IDs from transcript JSONL.
 * These sessions are terminated on SessionEnd to prevent bridge leaks.
 */
export async function extractPythonReplSessionIdsFromTranscript(transcriptPath) {
    // Security: validate transcript path is within allowed directories
    if (!transcriptPath || !isValidTranscriptPath(transcriptPath) || !fs.existsSync(transcriptPath)) {
        return [];
    }
    const sessionIds = new Set();
    const stream = fs.createReadStream(transcriptPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
    });
    try {
        for await (const line of rl) {
            if (!line.trim()) {
                continue;
            }
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            const entry = parsed;
            const contentBlocks = entry.message?.content;
            if (!Array.isArray(contentBlocks)) {
                continue;
            }
            for (const block of contentBlocks) {
                const toolUse = block;
                if (toolUse.type !== 'tool_use' || !toolUse.name || !PYTHON_REPL_TOOL_NAMES.has(toolUse.name)) {
                    continue;
                }
                const sessionId = toolUse.input?.researchSessionID;
                if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
                    sessionIds.add(sessionId.trim());
                }
            }
        }
    }
    finally {
        rl.close();
        stream.destroy();
    }
    return [...sessionIds];
}
/**
 * Clean up mode state files on session end.
 *
 * This prevents stale state from causing the stop hook to malfunction
 * in subsequent sessions. When a session ends normally, all active modes
 * should be considered terminated.
 *
 * @param directory - The project directory
 * @param sessionId - Optional session ID to match. Only cleans states belonging to this session.
 * @returns Object with counts of files removed and modes cleaned
 */
export function cleanupModeStates(directory, sessionId) {
    let filesRemoved = 0;
    const modesCleaned = [];
    const stateDir = path.join(getOmcRoot(directory), 'state');
    if (!fs.existsSync(stateDir)) {
        return { filesRemoved, modesCleaned };
    }
    for (const { file, mode } of SESSION_END_MODE_STATE_FILES) {
        const localPath = path.join(stateDir, file);
        const sessionPath = sessionId ? resolveSessionStatePath(mode, sessionId, directory) : undefined;
        try {
            // For JSON files, check if active before removing
            if (file.endsWith('.json')) {
                const sessionState = sessionId
                    ? readModeState(mode, directory, sessionId)
                    : null;
                let shouldCleanup = sessionState?.active === true;
                if (!shouldCleanup && fs.existsSync(localPath)) {
                    const content = fs.readFileSync(localPath, 'utf-8');
                    const state = JSON.parse(content);
                    // Only clean if marked as active AND belongs to this session
                    // (prevents removing other concurrent sessions' states)
                    if (state.active === true) {
                        // If sessionId is provided, only clean matching states
                        // If state has no session_id, it's legacy - clean it
                        // If state.session_id matches our sessionId, clean it
                        const stateSessionId = state.session_id;
                        if (!sessionId || !stateSessionId || stateSessionId === sessionId) {
                            shouldCleanup = true;
                        }
                    }
                }
                if (shouldCleanup) {
                    const hadLocalPath = fs.existsSync(localPath);
                    const hadSessionPath = Boolean(sessionPath && fs.existsSync(sessionPath));
                    if (clearModeStateFile(mode, directory, sessionId)) {
                        if (hadLocalPath && !fs.existsSync(localPath)) {
                            filesRemoved++;
                        }
                        if (sessionPath && hadSessionPath && !fs.existsSync(sessionPath)) {
                            filesRemoved++;
                        }
                        if (!modesCleaned.includes(mode)) {
                            modesCleaned.push(mode);
                        }
                    }
                }
            }
            else if (fs.existsSync(localPath)) {
                // For marker files, always remove
                fs.unlinkSync(localPath);
                filesRemoved++;
                if (!modesCleaned.includes(mode)) {
                    modesCleaned.push(mode);
                }
            }
        }
        catch {
            // Ignore errors, continue with other files
        }
    }
    return { filesRemoved, modesCleaned };
}
/**
 * Clean up mission-state.json entries belonging to this session.
 * Without this, the HUD keeps showing stale mode/mission info after session end.
 *
 * When sessionId is provided, only removes missions whose source is 'session'
 * and whose id contains the sessionId. When sessionId is omitted, removes all
 * session-sourced missions.
 */
export function cleanupMissionState(directory, sessionId) {
    const missionStatePath = path.join(getOmcRoot(directory), 'state', 'mission-state.json');
    if (!fs.existsSync(missionStatePath)) {
        return 0;
    }
    try {
        const content = fs.readFileSync(missionStatePath, 'utf-8');
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed.missions)) {
            return 0;
        }
        const before = parsed.missions.length;
        parsed.missions = parsed.missions.filter((mission) => {
            // Keep non-session missions (e.g., team missions handled by state_clear)
            if (mission.source !== 'session')
                return true;
            // If sessionId provided, only remove missions for this session
            if (sessionId) {
                const missionId = typeof mission.id === 'string' ? mission.id : '';
                return !missionId.includes(sessionId);
            }
            // No sessionId: remove all session-sourced missions
            return false;
        });
        const removed = before - parsed.missions.length;
        if (removed > 0) {
            parsed.updatedAt = new Date().toISOString();
            fs.writeFileSync(missionStatePath, JSON.stringify(parsed, null, 2));
        }
        return removed;
    }
    catch {
        return 0;
    }
}
function cleanupSessionStartedMarker(directory, sessionId) {
    try {
        validateSessionId(sessionId);
    }
    catch {
        return;
    }
    try {
        const markerPath = path.join(getOmcRoot(directory), 'state', 'sessions', sessionId, SESSION_STARTED_MARKER_FILE);
        if (fs.existsSync(markerPath)) {
            fs.unlinkSync(markerPath);
        }
    }
    catch {
        // Best-effort marker cleanup only; SessionEnd cleanup must continue.
    }
}
function extractTeamNameFromState(state) {
    if (!state || typeof state !== 'object')
        return null;
    const rawTeamName = state.team_name ?? state.teamName;
    return typeof rawTeamName === 'string' && rawTeamName.trim() !== ''
        ? rawTeamName.trim()
        : null;
}
async function findSessionOwnedTeams(directory, sessionId) {
    const teamNames = new Set();
    const teamState = readModeState('team', directory, sessionId);
    const stateTeamName = extractTeamNameFromState(teamState);
    if (stateTeamName) {
        teamNames.add(stateTeamName);
    }
    const teamRoot = path.join(getOmcRoot(directory), 'state', 'team');
    if (!fs.existsSync(teamRoot)) {
        return [...teamNames];
    }
    const { teamReadManifest } = await import('../../team/team-ops.js');
    try {
        const entries = fs.readdirSync(teamRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const teamName = entry.name;
            try {
                const manifest = await teamReadManifest(teamName, directory);
                if (manifest?.leader.session_id === sessionId) {
                    teamNames.add(teamName);
                }
            }
            catch {
                // Ignore malformed team state and continue scanning.
            }
        }
    }
    catch {
        // Best-effort only — session end must not fail because team discovery failed.
    }
    return [...teamNames];
}
async function cleanupSessionOwnedTeams(directory, sessionId) {
    const attempted = [];
    const cleaned = [];
    const failed = [];
    const teamNames = await findSessionOwnedTeams(directory, sessionId);
    if (teamNames.length === 0) {
        return { attempted, cleaned, failed };
    }
    const { teamReadConfig, teamCleanup } = await import('../../team/team-ops.js');
    const { shutdownTeamV2 } = await import('../../team/runtime-v2.js');
    const { shutdownTeam } = await import('../../team/runtime.js');
    for (const teamName of teamNames) {
        attempted.push(teamName);
        try {
            const config = await teamReadConfig(teamName, directory);
            if (!config || typeof config !== 'object') {
                await teamCleanup(teamName, directory);
                cleaned.push(teamName);
                continue;
            }
            if (Array.isArray(config.workers)) {
                await shutdownTeamV2(teamName, directory, { force: true, timeoutMs: 0 });
                cleaned.push(teamName);
                continue;
            }
            if (Array.isArray(config.agentTypes)) {
                const legacyConfig = config;
                const sessionName = typeof legacyConfig.tmuxSession === 'string' && legacyConfig.tmuxSession.trim() !== ''
                    ? legacyConfig.tmuxSession.trim()
                    : `omcp-team-${teamName}`;
                const leaderPaneId = typeof legacyConfig.leaderPaneId === 'string' && legacyConfig.leaderPaneId.trim() !== ''
                    ? legacyConfig.leaderPaneId.trim()
                    : undefined;
                await shutdownTeam(teamName, sessionName, directory, 0, undefined, leaderPaneId, legacyConfig.tmuxOwnsWindow === true);
                cleaned.push(teamName);
                continue;
            }
            await teamCleanup(teamName, directory);
            cleaned.push(teamName);
        }
        catch (error) {
            failed.push({
                teamName,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { attempted, cleaned, failed };
}
/**
 * Export session summary to .omcp/sessions/
 */
export function exportSessionSummary(directory, metrics) {
    const sessionsDir = path.join(getOmcRoot(directory), 'sessions');
    // Create sessions directory if it doesn't exist
    if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
    }
    // Validate session_id to prevent path traversal
    try {
        validateSessionId(metrics.session_id);
    }
    catch {
        // Invalid session_id - skip export to prevent path traversal
        return;
    }
    // Write session summary
    const sessionFile = path.join(sessionsDir, `${metrics.session_id}.json`);
    try {
        fs.writeFileSync(sessionFile, JSON.stringify(metrics, null, 2), 'utf-8');
    }
    catch (_error) {
        // Ignore write errors
    }
}
/**
 * Process session end
 */
export async function processSessionEnd(input) {
    // Normalize cwd to the git worktree root so .omcp/state/ is always resolved
    // from the repo root, even when Copilot CLI is running from a subdirectory (issue #891).
    const directory = resolveToWorktreeRoot(input.cwd);
    // Record and export session metrics to disk
    const metrics = recordSessionMetrics(directory, input);
    exportSessionSummary(directory, metrics);
    // Best-effort cleanup for tmux-backed team workers owned by this Copilot
    // session. This does not fix upstream signal-forwarding behavior, but it
    // meaningfully reduces orphaned panes/windows when SessionEnd runs normally.
    await cleanupSessionOwnedTeams(directory, input.session_id);
    // Clean up transient state files
    cleanupTransientState(directory);
    // Clean up mode state files to prevent stale state issues
    // This ensures the stop hook won't malfunction in subsequent sessions
    // Pass session_id to only clean up this session's states
    cleanupModeStates(directory, input.session_id);
    // Clean up mission-state.json entries belonging to this session
    // Without this, the HUD keeps showing stale mode/mission info
    cleanupMissionState(directory, input.session_id);
    // Mark this session as normally ended so SessionStart reconciliation does
    // not treat it as hard-terminated.
    cleanupSessionStartedMarker(directory, input.session_id);
    // Clean up Python REPL bridge sessions used in this transcript (#641).
    // Best-effort only: session end should not fail because cleanup fails.
    try {
        const pythonSessionIds = await extractPythonReplSessionIdsFromTranscript(input.transcript_path);
        if (pythonSessionIds.length > 0) {
            await cleanupBridgeSessions(pythonSessionIds);
        }
    }
    catch {
        // Ignore cleanup errors
    }
    const profileName = process.env.OMC_NOTIFY_PROFILE;
    const notificationConfig = getNotificationConfig(profileName);
    const shouldUseNewNotificationSystem = Boolean(notificationConfig && hasExplicitNotificationConfig(profileName));
    const enabledNotificationPlatforms = shouldUseNewNotificationSystem && notificationConfig
        ? getEnabledPlatforms(notificationConfig, 'session-end')
        : [];
    // Trigger stop hook callbacks (#395). When an explicit session-end notification
    // config already covers Discord/Telegram, skip the overlapping legacy callback
    // path so session-end is only dispatched once per platform.
    await triggerStopCallbacks(metrics, {
        session_id: input.session_id,
        cwd: input.cwd,
    }, {
        skipPlatforms: shouldUseNewNotificationSystem
            ? getLegacyPlatformsCoveredByNotifications(enabledNotificationPlatforms)
            : [],
    });
    // Trigger the new notification system when session-end notifications come
    // from an explicit notifications/profile/env config. Legacy stopHookCallbacks
    // are already handled above and must not be dispatched twice.
    if (shouldUseNewNotificationSystem) {
        try {
            await notify('session-end', {
                sessionId: input.session_id,
                projectPath: input.cwd,
                durationMs: metrics.duration_ms,
                agentsSpawned: metrics.agents_spawned,
                agentsCompleted: metrics.agents_completed,
                modesUsed: metrics.modes_used,
                reason: metrics.reason,
                timestamp: metrics.ended_at,
                profileName,
            });
        }
        catch {
            // Notification failures should never block session end
        }
    }
    // Clean up reply session registry and stop daemon if no active sessions remain
    try {
        const { removeSession, loadAllMappings } = await import('../../notifications/session-registry.js');
        const { stopReplyListener } = await import('../../notifications/reply-listener.js');
        // Remove this session's message mappings
        removeSession(input.session_id);
        // Stop daemon if registry is now empty (no other active sessions)
        const remainingMappings = loadAllMappings();
        if (remainingMappings.length === 0) {
            await stopReplyListener();
        }
    }
    catch {
        // Reply listener cleanup failures should never block session end
    }
    // Return simple response - metrics are persisted to .omcp/sessions/
    return { continue: true };
}
/**
 * Main hook entry point
 */
export async function handleSessionEnd(input) {
    return processSessionEnd(input);
}
//# sourceMappingURL=index.js.map