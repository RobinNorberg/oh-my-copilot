/**
 * The factory lane prompts and the untrusted-text helpers they share. Moved
 * out of engine.ts unchanged (prompts.test.ts pins every prompt byte for
 * byte); engine.ts re-exports the public names.
 */
import type { TeamContext } from '../team/context.js';
import type { FactoryRunState } from './state.js';
/** The review prompt's diff is cut at this many characters (copilot_run prompts are capped at 100k). */
export declare const MAX_REVIEW_DIFF_CHARS = 60000;
/** Untrusted text on one line: control and line-separator characters become spaces, then it is cut. */
export declare function oneLine(text: string | undefined, max?: number): string;
/** A backtick fence longer than any backtick run in `content`, so the content cannot close it. */
export declare function fenceFor(content: string): string;
/** What the lane works for, in its prompt's first line. */
export declare const subject: (s: FactoryRunState) => string;
export declare const planLabel: (s: FactoryRunState) => string;
/** Untrusted multi-line text: newlines kept, every other control or format character a space. */
export declare const untrustedText: (t: string) => string;
/** Lane-derived lines fenced together (the fence is longer than any backtick run in them). */
export declare function fenced(lines: string[]): string[];
/**
 * The team context section (.copilot/team routing and decisions, read from the
 * base commit): data, never instructions. Owners are validated names; the
 * decisions are repository text, shown with control and format characters made
 * visible and fenced. Empty when there is no context.
 */
export declare function teamSection(team: TeamContext | undefined, what: 'plan' | 'diff'): string[];
export declare function implementPrompt(s: FactoryRunState, team?: TeamContext): string;
export declare function fixPrompt(s: FactoryRunState, round: number): string;
export declare const planSection: (s: FactoryRunState) => string[];
/** The human review comments in one fix prompt are cut at this many characters in total. */
export declare const MAX_HUMAN_FEEDBACK_CHARS = 40000;
/** One open human review thread (ForgeReviewFeedback threads): every field is untrusted text. */
export interface HumanFeedbackThread {
    id: string;
    author: string;
    body: string;
    file?: string;
    line?: number;
    at: string;
}
/**
 * The fix lane prompt for a human review round (night 3 goal 2). The
 * reviewers' words are untrusted data: format characters are shown as
 * `<U+XXXX>`, control characters dropped, the whole block fenced, its total
 * capped. `file` is display text only; the engine never opens it.
 */
export declare function humanFixPrompt(s: FactoryRunState, round: number, threads: readonly HumanFeedbackThread[], changesRequestedBy?: readonly string[]): string;
/** `conflicted`: the files the engine's merge left conflict markers in (conflictFixStart), else the ones prepare reported. */
export declare function conflictFixPrompt(s: FactoryRunState, conflicted?: readonly string[]): string;
export declare function ciFixPrompt(s: FactoryRunState): string;
/**
 * The review lane's prompt. `standards` (the files under docs/standards/ on
 * the base commit) switches on the two-axis review: spec and standards, each
 * finding naming its axis. Without them the prompt is the single-axis one.
 */
export declare function reviewPrompt(s: FactoryRunState, head: string, diff: string, standards?: readonly string[], team?: TeamContext): string;
//# sourceMappingURL=prompts.d.ts.map