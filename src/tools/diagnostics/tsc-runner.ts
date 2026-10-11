/**
 * TypeScript Compiler Diagnostics Runner
 *
 * Executes `tsc --noEmit` to get project-level type checking diagnostics.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { resolveExecutable } from '../../platform/executable-resolution.js';

export interface TscDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface TscResult {
  success: boolean;
  diagnostics: TscDiagnostic[];
  errorCount: number;
  warningCount: number;
  /** Raw compiler or invocation failure when no file-position diagnostic is available. */
  error?: string;
}

/**
 * Run TypeScript compiler diagnostics on a directory
 * @param directory - Project directory containing tsconfig.json
 * @returns Result with diagnostics, error count, and warning count
 */
export function runTscDiagnostics(directory: string): TscResult {
  const tsconfigPath = join(directory, 'tsconfig.json');

  if (!existsSync(tsconfigPath)) {
    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0
    };
  }

  // fork deviation: bare execFileSync('tsc') cannot start the Windows tsc.cmd shim (always ENOENT).
  const invocation = resolveTscInvocation(directory);
  if (!invocation) return tscNotFound('ENOENT');

  try {
    execFileSync(invocation.file, invocation.args, {
      cwd: directory,
      encoding: 'utf-8',
      stdio: 'pipe',
      shell: invocation.shell
    });
    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return tscNotFound(error.message);
    const output = error.stdout || error.stderr || '';
    const result = parseTscOutput(output);
    return {
      ...result,
      success: false,
      errorCount: Math.max(1, result.errorCount),
      ...(result.diagnostics.length === 0 ? { error: output.trim() || error.message } : {}),
    };
  }
}

const TSC_ARGS = ['--noEmit', '--pretty', 'false'];

/**
 * fork deviation: prefer the project's own TypeScript (run by this Node), then
 * `tsc` on PATH; on win32 that is the tsc.cmd shim, which only cmd.exe can start.
 * Returns null when win32 has no `tsc` on PATH.
 */
function resolveTscInvocation(directory: string): { file: string; args: string[]; shell: boolean } | null {
  const local = join(directory, 'node_modules', 'typescript', 'bin', 'tsc');
  if (existsSync(local)) return { file: process.execPath, args: [local, ...TSC_ARGS], shell: false };
  if (process.platform !== 'win32') return { file: 'tsc', args: TSC_ARGS, shell: false };
  // The shell sees only this fixed literal command line, never caller input.
  return resolveExecutable('tsc') ? { file: ['tsc', ...TSC_ARGS].join(' '), args: [], shell: true } : null;
}

/** A missing compiler is a failed check, named distinctly from type errors. */
function tscNotFound(detail: string): TscResult {
  return {
    success: false,
    diagnostics: [],
    errorCount: 1,
    warningCount: 0,
    error: `tsc not found (${detail}): install typescript in the project or put tsc on PATH`
  };
}

/**
 * Parse TypeScript compiler output into structured diagnostics
 * Format: file(line,col): error TS1234: message
 */
function parseTscOutput(output: string): TscResult {
  const diagnostics: TscDiagnostic[] = [];

  // Parse tsc output format: file(line,col): error TS1234: message
  const regex = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let match;

  while ((match = regex.exec(output)) !== null) {
    diagnostics.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      severity: match[4] as 'error' | 'warning',
      code: match[5],
      message: match[6]
    });
  }

  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;

  return {
    success: errorCount === 0,
    diagnostics,
    errorCount,
    warningCount
  };
}
