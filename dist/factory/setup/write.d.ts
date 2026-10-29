/**
 * Step 6 of `omg factory setup` (factory forges design §4, §8.6): edits to
 * the `factory` subtree of `.copilot/omg.jsonc` (project scope) or the user
 * config at its default location (user scope), made with jsonc-parser
 * `modify` + `applyEdits` so comments and every other key stay as they are.
 * `forge.azureDevOps.trustedAuthors` always goes to the user config, the only
 * layer resolveForgeConfig reads it from. assertFactoryOnly re-parses each
 * result and refuses a write that changed anything outside `factory`, so
 * `ship.*` safety keys can never move.
 */
import { type JSONPath } from 'jsonc-parser';
import type { ForgeIntakeConfig, ForgeProgressConfig, ForgeRepo, IntakeSource } from '../../forge/types.js';
export type SetupScope = 'project' | 'user';
/** The `factory` keys the wizard owns; nothing else under `factory` is touched. */
export interface SetupSection {
    forge: Record<string, unknown>;
    intake: {
        source: IntakeSource;
        itemTypes?: string[];
    };
    progress: Pick<ForgeProgressConfig, 'enabled' | 'stages'>;
}
export declare function buildSection(repo: ForgeRepo, intake: Pick<ForgeIntakeConfig, 'source' | 'itemTypes'> & {
    source: IntakeSource;
}, progress: ForgeProgressConfig, team?: string): SetupSection;
/**
 * The (path, value) edits of a section. Objects the wizard answers as a whole
 * (the intake source, item types, progress stages) are replaced; the forge
 * identity is set key by key so other keys there (trustedAuthors, apiVersion)
 * stay.
 */
export declare function sectionEdits(section: SetupSection): Array<[JSONPath, unknown]>;
export declare function trustedAuthorsEdit(authors: readonly string[]): [JSONPath, unknown];
/** Apply edits to JSONC text, keeping comments and formatting. */
export declare function applyFactoryEdits(text: string, edits: ReadonlyArray<[JSONPath, unknown]>, path?: string): string;
/** Throws unless `before` and `after` differ only under the top-level `factory` key. */
export declare function assertFactoryOnly(before: string, after: string, path?: string): void;
/** A line diff (`-`/`+`, unchanged lines with two spaces), small files only. */
export declare function lineDiff(before: string, after: string): string;
export interface PlannedWrite {
    path: string;
    scope: SetupScope;
    before: string;
    after: string;
    diff: string;
}
export interface WritePlanInput {
    scope: SetupScope;
    projectPath: string;
    userPath: string;
    section: SetupSection;
    /** ADO only; always written to the user config. */
    trustedAuthors?: readonly string[];
}
/** The writes for one setup, with diffs; nothing is written here. Unchanged files are left out. */
export declare function planWrites(input: WritePlanInput): PlannedWrite[];
export declare function applyWrites(planned: readonly PlannedWrite[]): string[];
/** The parsed config a planned write would leave (for validation through resolveForgeConfig). */
export declare function parsedAfter(planned: readonly PlannedWrite[], path: string): unknown;
//# sourceMappingURL=write.d.ts.map