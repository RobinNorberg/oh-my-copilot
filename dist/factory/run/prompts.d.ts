/**
 * The factory lane prompts and the untrusted-text helpers they share. Moved
 * out of engine.ts unchanged (prompts.test.ts pins every prompt byte for
 * byte); engine.ts re-exports the public names.
 */
import { oneLine } from '../../lib/one-line.js';
import type { TeamContext } from '../team/context.js';
import { type LikelyFile } from './prescan.js';
import type { FactoryRunState } from './state.js';
/** The review prompt's diff is cut at this many characters (copilot_run prompts are capped at 100k). */
export declare const MAX_REVIEW_DIFF_CHARS = 60000;
export { oneLine };
/** A backtick fence longer than any backtick run in `content`, so the content cannot close it. */
export declare function fenceFor(content: string): string;
/**
 * The decline protocol of every write lane prompt: a lane that refuses
 * the task on purpose says so in a fixed last line (laneDecline in
 * lane-commit.ts reads it), so the engine parks without a fresh retry that
 * would get the same prompt and decline again.
 */
export declare const DECLINE_RULE = "Use DECLINED only when you deliberately refuse this task or it is impossible as specified: then make NO changes and end your final message with one line `DECLINED: <reason>` (the very last line, after your summary), and the engine stops for a human instead of running the same task again. A task that can only be done with a file outside this worktree (an absolute path elsewhere on the machine) is impossible as specified: lanes may not read or write outside the worktree, and every rerun is denied the same way, so decline it. Never use DECLINED for a failure a rerun can fix (tests that cannot run, a denied command or a missing tool inside this worktree): report that normally.";
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
/** The package.json scripts a write lane is told to run before it finishes (M5), in this order; names only. */
export declare const LANE_SCRIPT_NAMES: readonly string[];
/**
 * LANE_SCRIPT_NAMES that `packageJson` (the BASE commit's package.json text,
 * never the lane's tree) defines as string scripts. Only the names are used;
 * the script bodies never reach a prompt. Unreadable or absent = none.
 */
export declare function laneScripts(packageJson: string | undefined): string[];
/**
 * What a write lane's session will have, from the sandbox settings it starts
 * with (the engine asks the lane backend before the prompt is built; null:
 * not known, or no OS sandbox).
 */
export interface LaneEnvironment {
    /** The settings put the session in the OS sandbox (sandbox.enabled, no OMG_SANDBOX=off). */
    sandboxed: boolean;
    writeNetwork: 'none' | 'registry';
    /** The engine gives the worktree a copy of your node_modules before the session (Windows). */
    nodeModulesReady: boolean;
}
/** The repository guide files the implement prompt names, when the lane's base has them. */
export declare const REPO_GUIDE_FILES: readonly string[];
/**
 * `guides`: those of REPO_GUIDE_FILES the lane's base has (the engine reads the
 * base tree). Only these are named: a lane told to read a missing file spends
 * a tool call failing on it.
 */
export declare function implementPrompt(s: FactoryRunState, team?: TeamContext, scripts?: readonly string[], lane?: LaneEnvironment | null, guides?: readonly string[], likely?: readonly LikelyFile[]): string;
/**
 * The pre-scan's likely relevant files (prescan.ts: plain repo paths of the
 * base and a reason built from plain identifiers, never file contents): a
 * hint after the plan, never a limit on what the lane changes. Empty when
 * the pre-scan found none.
 */
export declare function likelySection(likely: readonly LikelyFile[]): string[];
export declare function fixPrompt(s: FactoryRunState, round: number, scripts?: readonly string[], lane?: LaneEnvironment | null): string;
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
export declare function humanFixPrompt(s: FactoryRunState, round: number, threads: readonly HumanFeedbackThread[], changesRequestedBy?: readonly string[], scripts?: readonly string[], lane?: LaneEnvironment | null): string;
/** `conflicted`: the files the engine's merge left conflict markers in (conflictFixStart), else the ones prepare reported. */
export declare function conflictFixPrompt(s: FactoryRunState, conflicted?: readonly string[], lane?: LaneEnvironment | null): string;
export declare function ciFixPrompt(s: FactoryRunState, lane?: LaneEnvironment | null): string;
/**
 * The review lane's prompt. `standards` (the files under docs/standards/ on
 * the base commit) switches on the two-axis review: spec and standards, each
 * finding naming its axis. Without them the prompt is the single-axis one.
 */
export declare function reviewPrompt(s: FactoryRunState, head: string, diff: string, standards?: readonly string[], team?: TeamContext): string;
//# sourceMappingURL=prompts.d.ts.map