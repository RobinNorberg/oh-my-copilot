/**
 * OMC HUD - Ultragoal Element
 *
 * Progress of the open ultragoal plan from `.omg/ultragoal/goals.json` (or
 * `.omg/ultragoal/plans/<id>/goals.json`): `goal:2/5`.
 */
export interface UltragoalStateForHud {
    complete: number;
    total: number;
    failed: number;
}
/**
 * The most recently written plan that is not done and was touched in the last
 * 24 hours, across the legacy single plan and every `plans/<id>/`.
 */
export declare function readUltragoalStateForHud(directory: string, now?: number): UltragoalStateForHud | null;
/** Format: goal:2/5 (complete/total), yellow when a goal has failed. */
export declare function renderUltragoal(state: UltragoalStateForHud | null | undefined): string | null;
//# sourceMappingURL=ultragoal.d.ts.map