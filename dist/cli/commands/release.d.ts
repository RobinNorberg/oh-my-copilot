/**
 * `omg release <version>`: the maintainer-only release pipeline as ordered,
 * resumable phases (src/release/engine.ts). `--dry-run` prints the plan and
 * runs nothing; without `--from` a run resumes at the first phase not yet ok.
 *
 * `--drive` keeps going through CI waits and transient GitHub errors until a
 * terminal state; `--detach` runs that loop in a detached process, and
 * `--status` / `--stop` inspect or end it (src/release/drive.ts).
 *
 * Exit codes: 0 ok, 1 a phase failed or is blocked, 2 usage error.
 */
import { Command } from 'commander';
import { type ReleaseDeps, type ReleaseExec } from '../../release/engine.js';
import { type DriveProcess, type DriveSpawn } from '../../release/drive.js';
export interface ReleaseCommandDeps extends Partial<ReleaseDeps> {
    exec?: ReleaseExec;
    /** Drive-mode process probes and the detached spawn (tests). */
    driveProcess?: DriveProcess;
    spawnDriver?: DriveSpawn;
    /** CLI script the detached driver runs (default: the one running now). */
    entry?: string;
    /** Why the running CLI is not the checkout's own (null = it is); default: foreignCliProblem of the entry's package (skipped with a scripted exec). */
    foreignCli?: () => string | null;
}
/** The package root of the CLI script `entry` (the nearest directory up with a package.json), or null. */
export declare function cliPackageRoot(entry: string): string | null;
/**
 * Why the running omg is not the release checkout's own CLI (null = it is, or a byte-identical build of the same
 * version). A release runs the engine of the binary that runs it: a stale global omg once drove a release without
 * the fixes on the checkout's dev (v5.19.4 ran without the CI-beside-the-suite overlap of #403).
 */
export declare function foreignCliProblem(cliRoot: string | null, root: string): string | null;
interface ReleaseCliOptions {
    from?: string;
    to?: string;
    dryRun?: boolean;
    json?: boolean;
    yes?: boolean;
    suite?: string;
    baseline?: string;
    liveSmoke?: boolean;
    forceSmoke?: boolean;
    triageRuns: string;
    triageTimeout: string;
    allowSkippedSmoke?: boolean;
    fixOrphans?: boolean;
    timeout: string;
    drive?: boolean;
    driveMax: string;
    detach?: boolean;
    status?: boolean;
    stop?: boolean;
    flakyCandidates?: boolean;
    allowForeignCli?: boolean;
}
/** The detached driver's command line: this invocation with --drive and without --detach / --json. */
export declare function releaseDriveArgv(version: string, o: ReleaseCliOptions, baseline?: string): string[];
export declare function releaseCommand(overrides?: ReleaseCommandDeps): Command;
export {};
//# sourceMappingURL=release.d.ts.map