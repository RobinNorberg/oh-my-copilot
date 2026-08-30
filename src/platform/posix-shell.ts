/**
 * POSIX shell discovery for Windows.
 *
 * User-authored commands (autoresearch evaluator commands, hook snippets) are
 * written as POSIX sh: `FOO=1 ./eval.sh`, relative `./` paths, `2>/dev/null`.
 * cmd.exe cannot run any of that, so on Windows we look for a real POSIX shell
 * (Git Bash / MSYS2) and run the command through `bash -c <command>`.
 */

import { existsSync } from 'fs';
import { basename, join } from 'path';

/** Shell basenames we accept as POSIX-compatible for `-c <command>`. */
const POSIX_SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash']);

/** Discovery order on Windows: Git Bash first, then MSYS2/Cygwin layouts. */
const WINDOWS_SHELL_INSTALL_SUFFIXES = [
  join('Git', 'bin', 'bash.exe'),
  join('Git', 'usr', 'bin', 'bash.exe'),
  join('msys64', 'usr', 'bin', 'bash.exe'),
  join('msys32', 'usr', 'bin', 'bash.exe'),
  join('cygwin64', 'bin', 'bash.exe'),
];

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

/**
 * `C:\Windows\System32\bash.exe` is the WSL launcher, not a Windows-native
 * POSIX shell: it runs inside the WSL filesystem namespace, where the Windows
 * cwd and command paths we hand it do not resolve. Never select it.
 */
function isWslLauncher(candidate: string): boolean {
  const normalized = normalizeSeparators(candidate);
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const systemRootNormalized = normalizeSeparators(systemRoot).replace(/\/+$/, '');
  return (
    normalized.startsWith(`${systemRootNormalized}/system32/`) ||
    normalized.startsWith(`${systemRootNormalized}/sysnative/`)
  );
}

function isPosixShellName(candidate: string): boolean {
  const name = basename(candidate.replace(/\\/g, '/')).replace(/\.exe$/i, '');
  return POSIX_SHELL_NAMES.has(name.toLowerCase());
}

function pathEntries(): string[] {
  return (process.env.PATH ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function findBashOnPath(): string | null {
  for (const dir of pathEntries()) {
    const candidate = join(dir, 'bash.exe');
    if (isWslLauncher(candidate)) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findBashInInstallLocations(): string | null {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : undefined,
    process.env.SystemDrive ? `${process.env.SystemDrive}\\` : 'C:\\',
  ].filter((root): root is string => Boolean(root));

  for (const root of roots) {
    for (const suffix of WINDOWS_SHELL_INSTALL_SUFFIXES) {
      const candidate = join(root, suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Locate a POSIX shell able to run a user-authored `sh` command line.
 * Returns null only on Windows when no such shell is installed.
 */
export function findPosixShell(): string | null {
  if (process.platform !== 'win32') {
    return process.env.SHELL || '/bin/sh';
  }

  const fromEnv = process.env.SHELL;
  if (fromEnv && isPosixShellName(fromEnv) && !isWslLauncher(fromEnv) && existsSync(fromEnv)) {
    return fromEnv;
  }

  return findBashOnPath() ?? findBashInInstallLocations();
}

export interface PosixCommandInvocation {
  file: string;
  args: string[];
  /** True only when the platform shell can interpret the command line directly. */
  shell: boolean;
}

/** Guidance shown when Windows has no POSIX shell to interpret a user command. */
export const NO_POSIX_SHELL_MESSAGE =
  'No POSIX shell (bash) found on Windows. Install Git for Windows (which provides Git Bash) ' +
  'or rewrite the command to be shell-neutral, e.g. `node eval.js` instead of `./eval.sh`.';

/**
 * Build the spawn arguments for a user-authored POSIX command line.
 * Returns null on Windows when no POSIX shell exists; callers must surface
 * NO_POSIX_SHELL_MESSAGE rather than falling back to cmd.exe, which would
 * mis-execute the command instead of failing.
 */
export function resolvePosixCommandInvocation(command: string): PosixCommandInvocation | null {
  if (process.platform !== 'win32') {
    return { file: command, args: [], shell: true };
  }

  const shell = findPosixShell();
  if (!shell) return null;
  // -c, not -lc: a login shell sources /etc/profile and ~/.bash_profile first,
  // whose PATH rewrites and cd's would change the command's environment in a
  // way the POSIX `sh -c` path does not. Same execution model on both platforms.
  return { file: shell, args: ['-c', command], shell: false };
}
