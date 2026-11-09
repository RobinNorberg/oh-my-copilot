/**
 * `omg factory setup` (factory forges design §4, critic amendments §A.5,
 * §A.7, §A.11): detect the forge, check auth, pick the intake source and the
 * progress mapping, write the `factory` subtree of the config after a diff,
 * then preview the source's first items. Interactive on a TTY; `--yes`,
 * `--json` or no TTY is non-interactive and takes every answer from flags.
 *
 * Exit codes: 0 written or dry run, 2 usage, 3 auth or extension missing,
 * 5 incompatible (unsupported forge, mismatch, unknown query, state
 * validation failed). `--dry-run` writes nothing and creates no label.
 *
 * `--scope user` writes no forge identity, intake or progress to the user
 * config (one file for every repository): those always go to the project
 * file, and the user config gets only trustedAuthors (see write.ts).
 *
 * Reuse (§A.7): label creation calls `checkOrCreateHarborLabels` (intake.ts)
 * with the factory labels, and the `omg factory init` prerequisites come from
 * `validateFactoryPrerequisites` (factory.ts); both are called, not copied.
 */
import { Command } from 'commander';
import { type AzEntry } from '../../forge/ado/az-binary.js';
import type { ForgeFactory } from '../../forge/types.js';
import { type AuthReport } from '../../factory/setup/auth.js';
import { type PreviewCheck, type PreviewRow, type Prompter } from '../../factory/setup/intake-pick.js';
import { type SetupScope, type SetupSection } from '../../factory/setup/write.js';
import { type Exec } from '../../ship/exec.js';
export interface FactorySetupDeps {
    /** Raw exec; the wizard wraps it in setupGuardExec, the preview's forge in checkGuardExec. */
    exec: Exec;
    env: Readonly<Record<string, string | undefined>>;
    isTTY: () => boolean;
    /** Azure CLI entry point (az-binary.ts); `root` is an untrusted PATH root. */
    resolveAz: (root: string) => AzEntry;
    createForge: ForgeFactory;
    /** Readiness hook of the preview; default: the `omg factory check` scorer over the resolved config. */
    previewCheck?: PreviewCheck;
    userConfigPath: () => string;
    /** Interactive answers; default reads the TTY. */
    prompter?: Prompter;
}
export declare const defaultFactorySetupDeps: FactorySetupDeps;
export interface FactorySetupOptions {
    forge?: string;
    org?: string;
    project?: string;
    repo?: string;
    intake?: string;
    itemTypes?: string;
    progress?: string;
    board?: string;
    trustedAuthor?: string;
    /** Azure DevOps: the build definition id heal reads as CI, or none. */
    healPipeline?: string;
    scope?: string;
    /** Write the cloud heartbeat (GitHub workflow or ADO pipeline) instead of running the wizard. */
    workflows?: boolean;
    /** --workflows: read-only (default) | triage (the opt-in write scope). */
    mode?: string;
    /** --workflows: schedule cron (default every 2 hours). */
    cron?: string;
    /** --workflows: replace a file this command did not write. */
    force?: boolean;
    dryRun?: boolean;
    yes?: boolean;
    json?: boolean;
}
export interface FactorySetupOutcome {
    exitCode: number;
    forge?: {
        kind: string;
        host: string;
        owner: string;
        project?: string;
        name: string;
        url: string;
    };
    auth?: AuthReport;
    config?: SetupSection;
    /** Files written; null on a dry run or when nothing changed. */
    written: string[] | null;
    diffs: Array<{
        path: string;
        scope: SetupScope;
        diff: string;
    }>;
    labels: {
        missing: string[];
        created: string[];
    };
    prerequisites: {
        ok: boolean;
        missing: string[];
    };
    preview: PreviewRow[];
    previewError?: string;
    notes: string[];
    /** What the forge cannot do (the local forge's offline lines); empty otherwise. */
    limitations: string[];
    error?: string;
}
/** Untrusted text without terminal sequences and control or format characters. */
export declare const plainText: (s: unknown) => string;
/** The wizard; never throws (a SetupError becomes its exit code). */
export declare function runFactorySetup(o: FactorySetupOptions, deps?: FactorySetupDeps, cwd?: string): Promise<FactorySetupOutcome>;
/**
 * F20: the local forge's base. A ship.base in the project or user config
 * wins (written: false); else `dev` when that branch exists, else the
 * current branch (an unborn one is init.defaultBranch), and setup writes it
 * as ship.base. Null on a detached HEAD with no dev. A ship.base that is set
 * but not a plain branch name is a usage error naming it (exit 2): setup
 * never replaces a value the human wrote.
 */
export declare function detectLocalBase(exec: Exec, root: string, configs: ReadonlyArray<{
    path: string;
    config: unknown;
}>): {
    base: string;
    write: boolean;
} | null;
export declare function factorySetupCommand(deps?: FactorySetupDeps): Command;
//# sourceMappingURL=factory-setup.d.ts.map