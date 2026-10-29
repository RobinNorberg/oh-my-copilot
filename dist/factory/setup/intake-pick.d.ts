/**
 * Steps 4 and 7 of `omg factory setup` (factory forges design §4, critic
 * amendments §A.11): the intake source, checked against the forge, and the
 * preview of its first items. GitHub intake is a label or a milestone
 * (Projects v2 is cut for now). Azure DevOps intake is a saved flat WIQL
 * query (GUID), a board column, or an area path plus a tag.
 *
 * Spec syntax (`--intake`): `label:<name>`, `milestone:<title>`,
 * `wiql-query:<guid>`, `board-column:<team>/<board>/<column>`,
 * `area-tag:<area path>#<tag>`.
 */
import type { Forge, ForgeKind, IntakeSource } from '../../forge/types.js';
import { type SetupIo } from './guard.js';
/** The wizard's questions; the CLI answers them on a TTY, tests script them. */
export interface Prompter {
    select(question: string, choices: readonly string[]): Promise<string>;
    input(question: string, defaultValue?: string): Promise<string>;
    confirm(question: string, defaultYes?: boolean): Promise<boolean>;
}
export declare const GITHUB_INTAKE_TYPES: readonly ["label", "milestone"];
export declare const ADO_INTAKE_TYPES: readonly ["wiql-query", "board-column", "area-tag"];
export declare function parseIntakeSpec(spec: string, kind: ForgeKind): IntakeSource;
export declare function formatIntakeSpec(s: IntakeSource): string;
export declare function githubLabels(io: SetupIo): string[];
export declare function githubMilestones(io: SetupIo): string[];
export interface AdoSavedQuery {
    id: string;
    path: string;
}
/** Flat saved queries only (a tree or one-hop query yields links, not items). */
export declare function adoSavedQueries(io: SetupIo): AdoSavedQuery[];
export declare function adoTeams(io: SetupIo): string[];
export declare function adoBoards(io: SetupIo, team: string): string[];
export declare function adoBoardColumns(io: SetupIo, team: string, board: string): string[];
/** Area paths as WIQL spells them: `Project\Child\Grandchild`. */
export declare function adoAreaPaths(io: SetupIo): string[];
export declare function adoWorkItemTypes(io: SetupIo): string[];
/**
 * Check a source against the forge. Returns the labels that do not exist yet
 * (a GitHub label source the wizard may create); throws SetupError(5) when the
 * milestone, query, board, column or area does not exist.
 */
export declare function validateIntake(io: SetupIo, source: IntakeSource, labels?: readonly string[]): {
    missingLabels: string[];
};
/** Interactive step 4. `prefill` seeds the ADO answers (area path, team). */
export declare function pickIntake(io: SetupIo, prompter: Prompter, prefill?: {
    team?: string;
    areaPath?: string;
}): Promise<IntakeSource>;
export interface PreviewRow {
    id: number;
    title: string;
    url: string;
    /** Readiness verdict; the default hook only points at `omg factory check`. */
    readiness: string;
}
/** Pluggable readiness hook over the first items of the source (`omg factory check` wires its scorer in). */
export type PreviewCheck = (forge: Forge, ids: readonly number[]) => PreviewRow[];
export declare const READINESS_PLACEHOLDER = "readiness: run `omg factory check`";
export declare const listOnlyPreview: PreviewCheck;
export declare const PREVIEW_LIMIT = 10;
export declare function previewIntake(forge: Forge, source: IntakeSource, check?: PreviewCheck): PreviewRow[];
//# sourceMappingURL=intake-pick.d.ts.map