/**
 * Step 6 of `omg factory setup` (factory forges design §4, §8.6): edits to
 * the `factory` subtree of `.copilot/omg.jsonc` and the user config at its
 * default location, made with jsonc-parser `modify` + `applyEdits` so
 * comments and every other key stay as they are.
 *
 * The forge identity, intake and progress are per repository, so they always
 * go to the project file, whatever `--scope` says: the user config is one
 * file for every repository and its `forge.*` has the highest trust, so a
 * repository's identity there would break (forge-mismatch) or redirect every
 * other repository. The user config gets only the user-only keys, today
 * `forge.azureDevOps.trustedAuthors` (the only layer resolveForgeConfig
 * reads it from). assertFactoryOnly re-parses each result and refuses a
 * write that changed anything but the keys its scope owns, so `ship.*`
 * safety keys can never move.
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
/** Apply edits to JSONC text, keeping comments, formatting and a leading BOM. */
export declare function applyFactoryEdits(text: string, edits: ReadonlyArray<[JSONPath, unknown]>, path?: string): string;
/** Throws unless `before` and `after` differ only in the subtrees `scope` owns. */
export declare function assertFactoryOnly(before: string, after: string, scope: SetupScope, path?: string): void;
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
    projectPath: string;
    userPath: string;
    section: SetupSection;
    /** ADO only; the one thing written to the user config. */
    trustedAuthors?: readonly string[];
}
/** The writes for one setup, with diffs; nothing is written here. Unchanged files are left out. */
export declare function planWrites(input: WritePlanInput): PlannedWrite[];
export declare function applyWrites(planned: readonly PlannedWrite[]): string[];
/** The parsed config a planned write would leave (for validation through resolveForgeConfig). */
export declare function parsedAfter(planned: readonly PlannedWrite[], path: string): unknown;
//# sourceMappingURL=write.d.ts.map