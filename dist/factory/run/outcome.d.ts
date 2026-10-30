/**
 * Outcome write-back (shipyard ↔ factory design §3.6, §9 PR 6): at a phase
 * outcome the engine posts one outcome comment on the item and one rollup
 * line on its parent spec. Each post carries a hidden marker naming
 * (child, phase, head), so the engine finds its own earlier post even when
 * the run state lost the record of it. The spec body is never edited: the
 * rollup is comments only, through the tracker's existing comment path.
 */
import type { ForgeComment, ForgeKind } from '../../forge/types.js';
import type { FactoryRunState } from './state.js';
/** `ready-to-merge` is the merge park (rollup only); the rest are terminal phases (outcome + rollup). */
export type OutcomeEvent = 'ready-to-merge' | 'merged' | 'cancelled' | 'failed';
export interface OutcomePost {
    /** The item the comment goes on. */
    target: number;
    /** The run state's `gateComments` record of this post. */
    tag: string;
    /** Hidden line that identifies the post among the target's comments. */
    marker: string;
    body: string;
}
export declare const outcomeMarker: (kind: "outcome" | "rollup", child: number, event: OutcomeEvent, head12: string) => string;
/** A trusted comment on the target ends with `marker` as a whole line (an untrusted or quoted copy never suppresses a post). */
export declare function postedBefore(comments: readonly ForgeComment[], marker: string): boolean;
export declare function prUrl(forge: ForgeKind, repoUrl: string, pr: number): string;
/**
 * The posts for `event` on child `s.issue`: the outcome comment on the item
 * (terminal events only) and the rollup line on `parent` (when there is one).
 */
export declare function outcomePosts(s: FactoryRunState, event: OutcomeEvent, parent: number | undefined, forge: ForgeKind): OutcomePost[];
//# sourceMappingURL=outcome.d.ts.map