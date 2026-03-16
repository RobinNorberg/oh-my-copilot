/**
 * Shared State Management for Cross-Tool Interoperability
 *
 * Manages shared state files at .omg/state/interop/ for communication
 * between OMG (Copilot CLI) and OMX (Codex CLI).
 *
 * Uses atomic writes for safety and supports task/message passing.
 */
export interface InteropConfig {
    sessionId: string;
    createdAt: string;
    omcCwd: string;
    omxCwd?: string;
    status: 'active' | 'completed' | 'failed';
}
export interface SharedTask {
    id: string;
    source: 'omg' | 'omx';
    target: 'omg' | 'omx';
    type: 'analyze' | 'implement' | 'review' | 'test' | 'custom';
    description: string;
    context?: Record<string, unknown>;
    files?: string[];
    createdAt: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    result?: string;
    error?: string;
    completedAt?: string;
}
export interface SharedMessage {
    id: string;
    source: 'omg' | 'omx';
    target: 'omg' | 'omx';
    content: string;
    metadata?: Record<string, unknown>;
    timestamp: string;
    read: boolean;
}
/**
 * Get the interop directory path for a worktree
 */
export declare function getInteropDir(cwd: string): string;
/**
 * Initialize an interop session
 * Creates the interop directory and session config
 */
export declare function initInteropSession(sessionId: string, omcCwd: string, omxCwd?: string): InteropConfig;
/**
 * Read interop configuration
 */
export declare function readInteropConfig(cwd: string): InteropConfig | null;
/**
 * Add a shared task for cross-tool communication
 */
export declare function addSharedTask(cwd: string, task: Omit<SharedTask, 'id' | 'createdAt' | 'status'>): SharedTask;
/**
 * Read all shared tasks
 */
export declare function readSharedTasks(cwd: string, filter?: {
    source?: 'omg' | 'omx';
    target?: 'omg' | 'omx';
    status?: SharedTask['status'];
}): SharedTask[];
/**
 * Update a shared task
 */
export declare function updateSharedTask(cwd: string, taskId: string, updates: Partial<Omit<SharedTask, 'id' | 'createdAt'>>): SharedTask | null;
/**
 * Add a shared message for cross-tool communication
 */
export declare function addSharedMessage(cwd: string, message: Omit<SharedMessage, 'id' | 'timestamp' | 'read'>): SharedMessage;
/**
 * Read shared messages
 */
export declare function readSharedMessages(cwd: string, filter?: {
    source?: 'omg' | 'omx';
    target?: 'omg' | 'omx';
    unreadOnly?: boolean;
}): SharedMessage[];
/**
 * Mark a message as read
 */
export declare function markMessageAsRead(cwd: string, messageId: string): boolean;
/**
 * Clean up interop session
 * Removes all tasks and messages for a session
 */
export declare function cleanupInterop(cwd: string, options?: {
    keepTasks?: boolean;
    keepMessages?: boolean;
    olderThan?: number;
}): {
    tasksDeleted: number;
    messagesDeleted: number;
};
//# sourceMappingURL=shared-state.d.ts.map