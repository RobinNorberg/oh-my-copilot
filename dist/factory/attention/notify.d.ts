/**
 * The `factory-attention` notification: one message per attention item that
 * is new since the poll loop's previous tick. Notifications go to
 * third-party services (Discord, Telegram, Slack, Teams, webhooks), so the
 * payload holds ONLY engine-composed text: the repository's folder name,
 * the run key, the group, the gate name of a row whose state is the
 * engine's own, and the first next command without the repository path.
 * Never a title, reason, detail, note or any other string from a state or a
 * lane. The message also goes through the notification redaction.
 *
 * The event is off unless the user's notification config enables it
 * explicitly (`notifications.events["factory-attention"].enabled: true`;
 * see notify() in src/notifications/index.ts).
 */
import { type AttentionGroup, type NextCommand } from './actions.js';
import type { AttentionItem } from './collect.js';
export interface AttentionNotice {
    repo: string;
    key: string;
    group: AttentionGroup;
    gate: string | null;
    /** The first next command, without `git -C <root>`'s path (the repository root stays local). */
    next: string | null;
}
/** The gate of a trusted row, when it is a plain gate name; null otherwise (an untrusted state names any gate). */
export declare function noticeGate(i: Pick<AttentionItem, 'gate' | 'trust'>): string | null;
/** The first next command as one line, `git -C <root> ...` as `git ...` (run in the repository root). */
export declare function noticeCommand(next: readonly NextCommand[]): string | null;
export declare function attentionNotice(root: string, i: AttentionItem): AttentionNotice | null;
/** One notice for the new items of a tick past the per-tick cap: counts per group only, no key or command. */
export interface AttentionMoreNotice {
    repo: string;
    more: number;
    byGroup: Partial<Record<AttentionGroup, number>>;
}
export declare function attentionMoreNotice(root: string, items: readonly Pick<AttentionItem, 'group'>[]): AttentionMoreNotice;
/**
 * One count-only notice for the rows whose state is not trusted (unverified, damaged, missing, planted slot files):
 * the number only. A lane can write any number of such files, so they never get an item notice of their own.
 */
export interface AttentionCountNotice {
    repo: string;
    count: number;
}
export declare function attentionCountNotice(root: string, count: number): AttentionCountNotice;
export type AnyAttentionNotice = AttentionNotice | AttentionMoreNotice | AttentionCountNotice;
export declare function attentionNoticeText(n: AnyAttentionNotice): string;
type Notify = (event: 'factory-attention', data: {
    sessionId: string;
    message: string;
    replyable: false;
}) => Promise<unknown>;
/**
 * Send one notice (never throws). No session, pane or project field (notify()
 * adds none for this event) and not replyable: nothing a
 * reply says is ever typed into a terminal. `notify` is the notification
 * stack's (lazily imported, so a poll without notifications never loads it).
 * Once `signal` aborts (the poll's timeout), the send is abandoned: the
 * returned promise settles and nothing more is started for it.
 */
export declare function sendAttentionNotice(n: AnyAttentionNotice, notify?: Notify, signal?: AbortSignal): Promise<void>;
/** Settles with `p`, or as soon as `signal` aborts (the promise is abandoned: its result is ignored). */
export declare function untilAborted(p: Promise<unknown>, signal?: AbortSignal): Promise<void>;
export {};
//# sourceMappingURL=notify.d.ts.map