/**
 * Step 5 of `omg factory setup` (factory forges design §4, §7): how factory
 * phases show on the tracker. GitHub uses the `factory:<stage>` label family
 * (labels only, critic amendments §A.11). Azure DevOps maps a stage to a
 * board column and/or a state, checked against the board and the item types'
 * states: a Completed or Removed state only for `done`, never a state for
 * `blocked` or `cancelled`, and a column only when it is on the board.
 *
 * `--progress default|none|<file.json>`; the file holds
 * `{ "enabled"?: boolean, "stages": { "<stage>": { "label" | "column" | "state": "…" } } }`.
 */
import { type ForgeKind, type ForgeProgressConfig, type IntakeSource } from '../../forge/types.js';
import { type SetupIo } from './guard.js';
import { type Prompter } from './intake-pick.js';
export declare function defaultProgress(kind: ForgeKind): ForgeProgressConfig;
export declare function progressFromFlag(spec: string | undefined, kind: ForgeKind): ForgeProgressConfig;
/** Labels the progress family and the intake source need on GitHub, minus the ones that exist. */
export declare function missingGitHubLabels(existing: readonly string[], progress: ForgeProgressConfig, intake?: IntakeSource): string[];
export interface AdoStateInfo {
    name: string;
    category: string;
}
export declare function adoTypeStates(io: SetupIo, type: string): AdoStateInfo[];
/**
 * Validate an ADO mapping: exit 5 when a state or column does not exist or a
 * closed state is used before `done`; exit 2 when a column is mapped but no
 * board is known (`--board <team>/<board>` or a board-column intake).
 */
export declare function validateAdoProgress(io: SetupIo, progress: ForgeProgressConfig, itemTypes: readonly string[], board?: {
    team: string;
    board: string;
}): void;
/** Interactive step 5: the defaults first; GitHub may rename labels, ADO picks columns and the done state. */
export declare function pickProgress(io: SetupIo, prompter: Prompter, itemTypes: readonly string[], board?: {
    team: string;
    board: string;
}): Promise<ForgeProgressConfig>;
//# sourceMappingURL=progress-pick.d.ts.map