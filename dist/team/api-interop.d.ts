export declare const TEAM_API_OPERATIONS: readonly ["send-message", "broadcast", "mailbox-list", "mailbox-mark-delivered", "mailbox-mark-notified", "create-task", "read-task", "list-tasks", "update-task", "claim-task", "transition-task-status", "release-task-claim", "read-config", "read-manifest", "read-worker-status", "read-worker-heartbeat", "update-worker-heartbeat", "write-worker-inbox", "write-worker-identity", "append-event", "get-summary", "cleanup", "write-shutdown-request", "read-shutdown-ack", "read-monitor-snapshot", "write-monitor-snapshot", "read-task-approval", "write-task-approval", "orphan-cleanup"];
export type TeamApiOperation = typeof TEAM_API_OPERATIONS[number];
export type TeamApiEnvelope = {
    ok: true;
    operation: TeamApiOperation;
    data: Record<string, unknown>;
} | {
    ok: false;
    operation: TeamApiOperation | 'unknown';
    error: {
        code: string;
        message: string;
    };
};
export declare function resolveTeamApiCliCommand(_env?: NodeJS.ProcessEnv): 'omc team api';
export declare function resolveTeamApiOperation(name: string): TeamApiOperation | null;
export declare function buildLegacyTeamDeprecationHint(legacyName: string, originalArgs?: Record<string, unknown>, env?: NodeJS.ProcessEnv): string;
export declare function executeTeamApiOperation(operation: TeamApiOperation, args: Record<string, unknown>, fallbackCwd: string): Promise<TeamApiEnvelope>;
//# sourceMappingURL=api-interop.d.ts.map