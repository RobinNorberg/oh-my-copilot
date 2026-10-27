/**
 * OMC HUD - Team Element
 *
 * Compact summary of the most relevant `omg team` run, read through the
 * mission board's team collector: `team:hud-fix 3/4w 5/9t`.
 */
import { type MissionBoardMission } from '../mission-board.js';
export interface TeamStateForHud {
    name: string;
    status: MissionBoardMission['status'];
    runningWorkers: number;
    workerCount: number;
    completedTasks: number;
    totalTasks: number;
    /** Other live teams not shown */
    otherTeams: number;
}
/**
 * Read the live team to show: not done, updated within the last 2 hours,
 * running before blocked before waiting, then the most recently updated.
 */
export declare function readTeamStateForHud(directory: string, now?: number): TeamStateForHud | null;
/**
 * Format: team:hud-fix 3/4w 5/9t (running/total workers, completed/total tasks),
 * plus `blocked` when the team is blocked and `+N` for other live teams.
 */
export declare function renderTeam(state: TeamStateForHud | null | undefined): string | null;
//# sourceMappingURL=team.d.ts.map