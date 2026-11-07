export type TeamLeaderNextAction = 'answer-blocker' | 'reassign-capped' | 'shutdown' | 'reuse-current-team' | 'launch-new-team' | 'keep-checking-status';
export interface TeamLeaderGuidanceInput {
    tasks: {
        pending: number;
        blocked: number;
        inProgress: number;
        completed: number;
        failed: number;
        /** Terminal: the owning SDK worker hit its credit cap (`team.sdk.maxCreditsPerWorker`). */
        capped?: number;
    };
    workers: {
        total: number;
        alive: number;
        idle: number;
        nonReporting: number;
    };
    /** Worker messages to the leader that nobody answered yet (blockers, questions). */
    leaderInbox?: {
        unread: number;
    };
}
export interface TeamLeaderGuidance {
    nextAction: TeamLeaderNextAction;
    reason: string;
    message: string;
}
export declare function deriveTeamLeaderGuidance(input: TeamLeaderGuidanceInput): TeamLeaderGuidance;
//# sourceMappingURL=leader-nudge-guidance.d.ts.map