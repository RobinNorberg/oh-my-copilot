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
import type { Forge, ResolvedForgeConfig } from '../../forge/types.js';
import { type AuthReport } from '../../factory/setup/auth.js';
import { type PreviewCheck, type PreviewRow, type Prompter } from '../../factory/setup/intake-pick.js';
import { type SetupScope, type SetupSection } from '../../factory/setup/write.js';
import { type Exec } from '../../ship/exec.js';
export interface FactorySetupDeps {
    /** Raw exec; the wizard wraps it in setupGuardExec, the preview's forge in factoryGuardExec. */
    exec: Exec;
    env: Readonly<Record<string, string | undefined>>;
    isTTY: () => boolean;
    /** Azure CLI entry point (az-binary.ts); `root` is an untrusted PATH root. */
    resolveAz: (root: string) => AzEntry;
    createForge: (exec: Exec, cwd: string, config: ResolvedForgeConfig) => Forge;
    /** Readiness hook of the preview (`omg factory check` plugs its scorer in). */
    previewCheck: PreviewCheck;
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
    scope?: string;
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
    error?: string;
}
/** Untrusted text without terminal sequences and control or format characters. */
export declare const plainText: (s: unknown) => string;
/** The wizard; never throws (a SetupError becomes its exit code). */
export declare function runFactorySetup(o: FactorySetupOptions, deps?: FactorySetupDeps, cwd?: string): Promise<FactorySetupOutcome>;
export declare function factorySetupCommand(deps?: FactorySetupDeps): Command;
//# sourceMappingURL=factory-setup.d.ts.map