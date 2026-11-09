/**
 * `factory.forge`, `factory.intake`, `factory.check` and `factory.progress`
 * (factory forges design §3). Trust follows loadTrustedShipConfig: the
 * caller passes the user config at its default location (userConfigLayers
 * `trustedUser`), the `.copilot/omg.jsonc` committed on the verified base
 * (readBaseFile), and the working-tree project config. The resolver is pure
 * (no git, no spawn), like resolveFactoryRunLimits.
 *
 * | Keys                               | Sources (high -> low)                | Working-tree file          |
 * |------------------------------------|--------------------------------------|----------------------------|
 * | forge.* (identity)                 | user -> base -> origin detection     | ignored, warned on a diff  |
 * | forge.azureDevOps.trustedAuthors   | user only                            | ignored, warned            |
 * | progress.* (tracker writes)        | user -> base                         | ignored, warned on a diff  |
 * | heal.pipeline (ADO: which is CI)   | user -> base                         | ignored, warned on a diff  |
 * | intake.autoStart (poll starts runs)| user -> base                         | ignored, warned on a diff  |
 * | review.trustedReviewers            | user -> base                         | ignored, warned on a diff  |
 * | intake.* (the rest), check.*       | project -> user -> base -> defaults  | allowed                    |
 *
 * Config can pin the forge, never redirect it: a kind, org, project or repo
 * that disagrees with the origin remote is refused (`forge-mismatch`).
 *
 * Limitation: `forge.azureDevOps.workItemProject` must equal the repo's
 * project (folded like the other names) or be omitted. The invoke guard pins
 * every `project` route parameter to the repo's project (routes.ts), so work
 * items tracked in another project are not supported yet; a different value
 * is refused (`forge-unsupported`) rather than failing later at the guard.
 *
 * The local (offline) forge, `forge.kind: "local"` (decision D1):
 * | Keys                               | Sources                              | Working-tree file          |
 * |------------------------------------|--------------------------------------|----------------------------|
 * | forge.kind "local", no parseable   | user -> base -> project              | allowed (nothing to        |
 * |   GitHub/ADO origin                |                                      |   downgrade)               |
 * | forge.kind "local" over a GitHub   | user -> base                         | refused (`forge-mismatch`) |
 * |   or ADO origin (drops CI, review) |                                      |                            |
 * | forge.local.gate (a command)       | user -> base                         | ignored, warned on a diff  |
 * | forge.local.backlogDir,            | project -> user -> base -> defaults  | allowed (the run reads     |
 * |   forge.local.gateTimeoutMinutes   |                                      |   items at the base commit)|
 */
import { type ForgeCheckConfig, type ForgeKind, type ForgeRepo, type ProgressMapping, type ProgressStage, type ResolvedForgeConfig } from './types.js';
export type ForgeConfigErrorCode = 'forge-mismatch' | 'forge-unsupported' | 'invalid';
export declare class ForgeConfigError extends Error {
    readonly code: ForgeConfigErrorCode;
    constructor(code: ForgeConfigErrorCode, message: string);
}
export declare const DEFAULT_ADO_API_VERSION = "7.1";
export declare const DEFAULT_INTAKE_LIMIT = 50;
export declare const MAX_INTAKE_LIMIT = 200;
export declare const DEFAULT_INTAKE_MARKER = "factory-ready";
export declare const DEFAULT_ADO_ITEM_TYPES: readonly string[];
export declare const DEFAULT_CHECK_CONFIG: Readonly<ForgeCheckConfig>;
export declare const DEFAULT_LOCAL_BACKLOG_DIR = ".copilot/backlog";
export declare const DEFAULT_LOCAL_GATE_TIMEOUT_MINUTES = 20;
export declare const MAX_LOCAL_GATE_TIMEOUT_MINUTES = 120;
/** GitHub default label family (design §7); `cancelled` removes the family, so it has no label. */
export declare function defaultProgressStages(kind: ForgeKind): Partial<Record<ProgressStage, ProgressMapping>>;
export declare const MAX_TRUSTED_REVIEWERS = 100;
/** The forge kind and repository the origin remote names. */
export declare function detectForgeRepo(originUrl: string): ForgeRepo;
/** Where the caller's repository lives: the local forge names its mirror from it. */
export interface ForgeConfigContext {
    /** The repository root (the checkout the factory runs in). */
    root: string;
    /** The engine-owned forge state directory (getGlobalOmcStatePath('forge')). */
    stateDir: string;
}
export interface LoadedForgeConfig {
    config: ResolvedForgeConfig;
    warnings: string[];
}
/**
 * Resolve the forge settings of one repository.
 * @param trustedUser the user config at its default location (userConfigLayers().trustedUser)
 * @param base the parsed `.copilot/omg.jsonc` committed on the verified base, or undefined when that layer was skipped
 * @param project the parsed working-tree project config
 * @param originUrl `git remote get-url origin`; undefined (or '') when the repository has no origin
 * @param context the repository root and forge stateDir; required when the forge resolves to `local`
 * Throws ForgeConfigError: `forge-mismatch` when config disagrees with the
 * remote (including a working-tree `kind: "local"` over a GitHub or ADO
 * origin), `forge-unsupported` for a missing remote or one that is neither
 * GitHub nor Azure DevOps (without `kind: "local"`), `invalid` for an
 * ill-typed value.
 */
export declare function resolveForgeConfig(trustedUser: unknown, base: unknown, project: unknown, originUrl: string | undefined, context?: ForgeConfigContext): LoadedForgeConfig;
/**
 * Whether an ADO identity is in trustedAuthors (critic amendments §A.10):
 * `uniqueName` only, case-insensitive; the display name is never consulted
 * (anyone can choose it).
 */
export declare function isTrustedAdoAuthor(createdBy: unknown, trustedAuthors: readonly string[]): boolean;
//# sourceMappingURL=config.d.ts.map