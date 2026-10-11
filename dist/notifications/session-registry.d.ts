/**
 * Session Registry Module
 *
 * Maps platform message IDs to tmux pane IDs for reply correlation.
 * Uses JSONL append format for atomic writes, following the pattern from
 * session-replay.ts with secure file permissions from daemon.ts.
 *
 * Registry location: XDG-aware global OMC state (legacy ~/.omg/state fallback for reads)
 * File permissions: 0600 (owner read/write only)
 */
export interface SessionMapping {
    platform: "discord-bot" | "telegram" | "slack-bot";
    messageId: string;
    sessionId: string;
    tmuxPaneId: string;
    tmuxSessionName: string;
    event: string;
    createdAt: string;
    projectPath?: string;
    /** AskUserQuestion metadata used to target the Other/free-text field for mobile replies. */
    askUserQuestionOptionCount?: number;
    askUserQuestionAllowOther?: boolean;
    /** Approval-gate mapping: replies to this message resolve the gate instead of injecting a pane. */
    approvalRef?: {
        runsRoot: string;
        runId: string;
        activationId: string;
    };
}
/**
 * Reserve an empty registry while the exact listener generation is stopped.
 * Holding this lock prevents a concurrent notification registration from being
 * lost between its empty check and process termination.
 */
export declare function lockRegistryIfEmpty(): (() => void) | 'active' | null;
/**
 * Register a message mapping (atomic JSONL append).
 *
 * Uses O_WRONLY | O_APPEND | O_CREAT for atomic appends (up to PIPE_BUF bytes on Linux).
 * Each mapping serializes to well under 4096 bytes, making this operation atomic.
 */
export declare function registerMessage(mapping: SessionMapping): boolean;
/**
 * Load all mappings from the JSONL file
 */
export declare function loadAllMappings(): SessionMapping[];
/**
 * Look up a mapping by platform and message ID.
 * Returns the most recent entry when duplicates exist (last match in append-ordered JSONL).
 */
export declare function lookupByMessageId(platform: string, messageId: string): SessionMapping | null;
/**
 * Remove all entries for a given session ID.
 * This is a rewrite operation (infrequent - only on session-end).
 */
export declare function removeSession(sessionId: string): boolean;
/**
 * Remove the pane-injecting entries for a given pane ID. Called by the reply
 * listener when pane verification fails (stale pane cleanup) and by notify()
 * before a non-replyable message. Approval-gate entries (`approvalRef`, from
 * `omg graph` remote approval) are kept: their replies never touch a pane.
 *
 * Pane ids (`%N`) are per tmux/psmux server, and a mapping records no server
 * identifier. With `tmuxSessionName`, an entry recorded under another session
 * name is kept; a collision with the same session name on another server
 * still matches (removal is the safe side).
 */
export declare function removeMessagesByPane(paneId: string, tmuxSessionName?: string): boolean;
/**
 * Record that the pane shows a non-replyable message (a Copilot permission
 * menu) from now on. No registry lock: it must hold when the lock times out.
 * {@link isPaneReplyBlocked} then refuses every mapping created before it, so
 * a reply mapping registered after removeMessagesByPane by a notification
 * that started earlier (concurrent hook children) is never injected.
 * Written via temp file + rename, so a reader never sees a truncated file.
 * An unparseable marker file is replaced by an unnamed marker, which refuses
 * every session's earlier mappings as the unparseable file did.
 */
export declare function markPaneNonReplyable(paneId: string, tmuxSessionName?: string, at?: Date): void;
/**
 * Whether a reply into the pane must be refused: a non-replyable marker for
 * the pane (same session name, or either side unnamed) is not older than the
 * mapping's `createdAt`. Without a mapping, any marker younger than MAX_AGE_MS.
 */
export declare function isPaneReplyBlocked(paneId: string, mapping?: Pick<SessionMapping, 'createdAt' | 'tmuxSessionName'>, nowMs?: number): boolean;
/**
 * Remove entries older than MAX_AGE_MS (24 hours).
 * This is a rewrite operation (infrequent - called periodically by daemon).
 */
export declare function pruneStale(): boolean;
//# sourceMappingURL=session-registry.d.ts.map