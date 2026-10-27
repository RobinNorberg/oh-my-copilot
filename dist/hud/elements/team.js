/**
 * OMC HUD - Team Element
 *
 * Compact summary of the most relevant `omg team` run, read through the
 * mission board's team collector: `team:hud-fix 3/4w 5/9t`.
 */
import { readTeamMissions } from '../mission-board.js';
import { RESET } from '../colors.js';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
/** Same window as the other OMC state readers: older team dirs are abandoned. */
const MAX_TEAM_AGE_MS = 2 * 60 * 60 * 1000;
const STATUS_RANK = {
    running: 0,
    blocked: 1,
    waiting: 2,
    done: 3,
};
/**
 * Read the live team to show: not done, updated within the last 2 hours,
 * running before blocked before waiting, then the most recently updated.
 */
export function readTeamStateForHud(directory, now = Date.now()) {
    let missions;
    try {
        // Every worker counts towards the running total, not only the board's top 3.
        // Stale dirs are skipped unread; a corrupt team is dropped on its own.
        missions = readTeamMissions(directory, { enabled: true, maxAgentsPerMission: Number.MAX_SAFE_INTEGER }, MAX_TEAM_AGE_MS, now);
    }
    catch {
        // The teams root itself is unreadable.
        return null;
    }
    const live = missions
        .filter((mission) => mission.status !== 'done')
        .filter((mission) => now - (Date.parse(mission.updatedAt) || 0) <= MAX_TEAM_AGE_MS)
        .sort((left, right) => (STATUS_RANK[left.status] - STATUS_RANK[right.status]
        || (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0)));
    const top = live[0];
    if (!top)
        return null;
    return {
        name: top.teamName ?? top.name,
        status: top.status,
        runningWorkers: top.agents.filter((agent) => agent.status === 'running').length,
        workerCount: top.workerCount,
        completedTasks: top.taskCounts.completed,
        totalTasks: top.taskCounts.total,
        otherTeams: live.length - 1,
    };
}
/**
 * Format: team:hud-fix 3/4w 5/9t (running/total workers, completed/total tasks),
 * plus `blocked` when the team is blocked and `+N` for other live teams.
 */
export function renderTeam(state) {
    if (!state)
        return null;
    const parts = [
        `team:${CYAN}${state.name}${RESET}`,
        `${state.runningWorkers}/${state.workerCount}w`,
        `${state.completedTasks}/${state.totalTasks}t`,
    ];
    if (state.status === 'blocked')
        parts.push(`${YELLOW}blocked${RESET}`);
    if (state.otherTeams > 0)
        parts.push(`+${state.otherTeams}`);
    return parts.join(' ');
}
//# sourceMappingURL=team.js.map