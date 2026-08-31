/**
 * POSIX shell discovery for Windows.
 *
 * User-authored commands (autoresearch evaluator commands, hook snippets) are
 * written as POSIX sh: `FOO=1 ./eval.sh`, relative `./` paths, `2>/dev/null`.
 * cmd.exe cannot run any of that, so on Windows we look for a real POSIX shell
 * (Git Bash / MSYS2) and run the command through `bash -c <command>`.
 */
/**
 * Locate a POSIX shell able to run a user-authored `sh` command line.
 * Returns null only on Windows when no such shell is installed.
 */
export declare function findPosixShell(): string | null;
export interface PosixCommandInvocation {
    file: string;
    args: string[];
    /** True only when the platform shell can interpret the command line directly. */
    shell: boolean;
}
/** Guidance shown when Windows has no POSIX shell to interpret a user command. */
export declare const NO_POSIX_SHELL_MESSAGE: string;
/**
 * Build the spawn arguments for a user-authored POSIX command line.
 * Returns null on Windows when no POSIX shell exists; callers must surface
 * NO_POSIX_SHELL_MESSAGE rather than falling back to cmd.exe, which would
 * mis-execute the command instead of failing.
 */
export declare function resolvePosixCommandInvocation(command: string): PosixCommandInvocation | null;
//# sourceMappingURL=posix-shell.d.ts.map