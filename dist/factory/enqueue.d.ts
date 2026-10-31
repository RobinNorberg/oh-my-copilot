/**
 * `omg factory enqueue --spec <id> --file <tickets.json> [--dry-run] [--json]`
 * (shipyard ↔ factory design §3.2-§3.4, PR 8; GitHub only, Azure DevOps is
 * PR 9): push launch's C3-approved tickets to the tracker as child items of
 * the spec, idempotently.
 *
 * - The ticket file is validated strictly (unknown fields, duplicate keys,
 *   `blockedBy` cycles, unknown references, AC count, rendered body length,
 *   all-vague AC); any refusal exits 2 before anything is written.
 * - The spec's author must be trusted (OWNER, MEMBER or COLLABORATOR), else
 *   exit 2: enqueue writes into its body and marks its children.
 * - Every item carries a `shipyard-key: <spec>/<key>` footer. A key counts
 *   only on an issue of the configured repository whose author is trusted and
 *   whose `Part of #<spec>` line names the spec; any other holder is ignored
 *   and reported, so an external issue cannot claim a key. Holders come from
 *   the key search and from the spec's task-list children: GitHub search is
 *   eventually consistent, so the task list is rewritten right after each
 *   create and a re-run after a partial failure finds what it created. An
 *   immediate re-run may still need a short wait when a create landed but
 *   its task-list write did not.
 * - Per key: missing → created; present and equal → unchanged (no write);
 *   present, changed and unclaimed → updated; claimed (closed, a factory run
 *   state, an open or merged `factory/issue-<n>` PR, or the branch on origin)
 *   → kept-claimed, never edited. A key in the tracker but not in the file is
 *   reported `orphaned` and never closed.
 * - `Blocked by #n` lines are written in a second pass, once every id is
 *   known; the spec body's `<!-- shipyard:tickets -->` task list is rewritten
 *   as one section.
 * - Model-written text is neutralized before it is posted from the user's
 *   account: @-mentions, `#n`, `GH-n` and `owner/repo#n` references and issue
 *   or PR urls go into code spans (nobody is notified, no backlink appears),
 *   `<!--` is escaped (no comment hides the rest of the body from a reader),
 *   and `omg-plan:`, `shipyard-key:`, `Acceptance criteria` headings, edge,
 *   parent and task-list lines are escaped so they cannot become trusted
 *   plan, key or edge input.
 * - The mark step is `omg factory check <ids> --mark --yes` over this file's
 *   created, updated and unchanged items only (never an orphan or any other
 *   task-list line of the spec); the dry run lists exactly those mark
 *   candidates, so the C3 signature covers them (design Q11), and with the intake label enqueue adds
 *   at create it is what makes the runnable children factory work.
 *
 * Writes go through the factory guard with a TrackerWriteContext (the 7a
 * shapes: `gh issue create|edit --repo … --body-file`, the key search); body
 * files sit in a fresh temporary directory outside the worktree. Every other
 * gh and git call is one of `omg factory check`'s read shapes. `--dry-run`
 * never sets the write mode, so the guard refuses any write it might reach.
 *
 * Exit codes: 0 enqueued (or planned), 1 a tracker read or write failed, or
 * the mark step did, 2 usage or a refused ticket file (nothing written), 5
 * incompatible (no forge, or a forge other than GitHub).
 */
import { type Exec } from '../ship/exec.js';
import { type CheckJson, type FactoryCheckDeps } from './check/cli.js';
import { type CheckBucket } from './check/rules.js';
import { type TrackerWriteContext } from './run/exec.js';
export declare const ENQUEUE_SCHEMA_VERSION = 1;
/** The most tickets one file may carry (one launch effort; each is a few gh calls). */
export declare const MAX_TICKETS = 100;
export declare const EDGES_OPEN = "<!-- shipyard:edges -->";
export declare const EDGES_CLOSE = "<!-- /shipyard:edges -->";
export declare const TICKETS_OPEN = "<!-- shipyard:tickets -->";
export declare const TICKETS_CLOSE = "<!-- /shipyard:tickets -->";
export interface Ticket {
    key: string;
    title: string;
    body: string;
    acceptance: string[];
    /** Keys in the file, or `#<n>` for an existing item. */
    blockedBy: string[];
    /** 1..4 → the `priority:p<n-1>` label. */
    priority?: number;
}
export interface TicketFile {
    schemaVersion: 1;
    spec: number;
    tickets: Ticket[];
}
export type EnqueueAction = 'created' | 'updated' | 'unchanged' | 'kept-claimed' | 'orphaned';
export interface EnqueueRow {
    key: string;
    /** null for a ticket a dry run would create. */
    id: number | null;
    action: EnqueueAction;
    /** From the mark step's check; null on a dry run or when the check did not list the item. */
    bucket: CheckBucket | null;
    /** The claim for kept-claimed, else the check's reason codes. */
    reasons: string[];
    /** The mark step considers this item: created, updated or unchanged. */
    markCandidate: boolean;
    /** Dry run only: the exact write. */
    planned?: {
        title: string;
        body: string;
        addLabels: string[];
        removeLabels: string[];
    };
}
export interface EnqueueJson {
    schemaVersion: number;
    ok: boolean;
    dryRun: boolean;
    spec: {
        id: number;
        taskList: 'unchanged' | 'updated';
        planned?: string;
    };
    items: EnqueueRow[];
    /** Key holders that do not count: untrusted author, or not a child of the spec. */
    ignored: Array<{
        id: number;
        key: string;
        reason: string;
    }>;
    mark: CheckJson['mark'] | null;
    warnings: string[];
}
export interface FactoryEnqueueOptions {
    spec: string;
    file: string;
    dryRun?: boolean;
    json?: boolean;
}
/** Parse and validate a ticket file; CheckUsageError (exit 2) on the first problem. */
export declare function parseTicketFile(raw: unknown, maxAcceptanceItems: number): TicketFile;
/** A `blockedBy` cycle among the file's keys as the path that closes it, or null. */
export declare function findCycle(tickets: readonly Ticket[]): string[] | null;
/**
 * Escape what the factory reads as trusted input when an item's author is
 * trusted, as enqueue's items are: the `omg-plan:` link, the `shipyard-key:`
 * footer, an `Acceptance criteria` heading, `Depends on|Blocked by|Part of
 * #n` lines and task-list `- [ ] #n` children (src/forge/github/tracker.ts,
 * src/factory/run/plan-rules.ts). The backslashes render as nothing. `<!--`
 * becomes `&lt;!--`, so an unclosed comment cannot hide the AC, edges and key
 * from a human reader.
 */
export declare function neutralizeTrusted(text: string): string;
/**
 * Put every mention and cross-reference in a code span, so posting the text
 * notifies nobody and leaves no backlink. The span's backtick run is one
 * longer than any run in the text, so it pairs only with itself (CommonMark
 * code spans close on a run of the same length); a backtick right next to it
 * gets a space so the runs never merge, and so does a backslash before it
 * (it would escape the first backtick and no span would form). Inside an existing code span or
 * block it shows as literal backticks, which is harmless.
 */
export declare function neutralizeNotifying(text: string): string;
/** The item title as posted. */
export declare const renderTitle: (t: Ticket) => string;
/** The item body (design §3.3): the ticket body, the AC list, the edges section, the key footer. `edges` are `#<n>` refs. */
export declare function renderTicketBody(spec: number, t: Ticket, edges: readonly string[]): string;
/**
 * The spec body with its `<!-- shipyard:tickets -->` task list set to
 * `children` (appended when absent); a box already ticked stays ticked.
 * Throws CheckUsageError when the section markers are not one ordered pair.
 */
export declare function specBodyWithTickets(body: string, children: readonly number[]): string;
/**
 * enqueue's Exec: the key search, and while `writing()` the issue create and
 * edit, go through the factory guard with the TrackerWriteContext (PR 7a's
 * exact shapes); every other gh and git call through `omg factory check`'s
 * read-only guard. Nothing else runs.
 */
export declare function enqueueGuardExec(exec: Exec, writes: () => TrackerWriteContext | undefined, writing: () => boolean): Exec;
/** Run one enqueue; returns the exit code. Usage and incompatible errors propagate (exit 2 / 5 at the CLI). */
export declare function runFactoryEnqueue(o: FactoryEnqueueOptions, deps: FactoryCheckDeps): Promise<number>;
//# sourceMappingURL=enqueue.d.ts.map