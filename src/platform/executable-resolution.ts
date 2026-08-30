/**
 * Cross-Platform Executable Resolution
 *
 * One hardened implementation of the "find this binary and optionally ask it
 * for a version" ritual: `where.exe`/`which` with a bounded timeout, shell-free
 * spawns, and a narrow cmd.exe fallback for Windows `.cmd`/`.bat` shims that
 * cannot be started directly.
 */

import { existsSync } from 'fs';
import path from 'path';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'child_process';

export interface CliInfo {
  available: boolean;
  version?: string;
  path?: string;
}

/** The narrow diagnostic result used by doctor-facing callers. */
export interface CliProbeResult {
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
}

interface ProbeExecutionResult extends CliProbeResult {
  /** True only when the version child (direct or COMSPEC) exited with status 0. */
  versionExitedZero: boolean;
}

type SpawnResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: NodeJS.ErrnoException;
};

type PathFlavor = typeof path.posix;

type PlatformModel = {
  isWindows: boolean;
  finder: 'which' | 'where.exe';
  pathFlavor: PathFlavor;
};

const RESOLVE_TIMEOUT_MS = 5000;
const VERSION_TIMEOUT_MS = 3000;
const SAFE_BINARY_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_BATCH_PATH = /^[A-Za-z]:\\(?:[A-Za-z0-9 ._-]+\\)*[A-Za-z0-9 ._-]+\.(?:cmd|bat)$/i;
const SAFE_BATCH_ARG = /^[A-Za-z0-9._=-]+$/;
const VALID_BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);
const ADMITTED_BATCH_START_ERRORS = new Set(['ENOENT', 'UNKNOWN', 'EINVAL']);
const DEFAULT_COMSPEC = 'C:\\Windows\\System32\\cmd.exe';

const INVALID_BINARY_ERROR = 'invalid CLI name';
const RESOLVER_ERROR = 'CLI resolver failed';
const VERSION_ERROR = 'version probe failed';
const VERSION_NO_OUTPUT_ERROR = 'version probe returned no output';
const UNSAFE_BATCH_ERROR = 'version probe skipped: batch path is not literal-safe';

function platformModel(platform: NodeJS.Platform): PlatformModel {
  const isWindows = platform === 'win32';
  return {
    isWindows,
    finder: isWindows ? 'where.exe' : 'which',
    pathFlavor: isWindows ? path.win32 : path.posix,
  };
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return value == null ? '' : String(value);
}

function firstNonblankLine(value: unknown): string | undefined {
  for (const line of asText(value).split(/\r\n|\n|\r/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isValidBinaryName(binary: string): boolean {
  return typeof binary === 'string' && SAFE_BINARY_NAME.test(binary);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function resolveCliPath(binary: string, model: PlatformModel): string | undefined {
  try {
    const result = spawnSync(model.finder, [binary], {
      timeout: RESOLVE_TIMEOUT_MS,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    }) as SpawnResult;

    // A finder error, timeout, signal, or nonzero exit is a resolution failure.
    if (result.error || result.signal || result.status !== 0) return undefined;

    const stdout = asText(result.stdout);
    for (const line of stdout.split(/\r\n|\n|\r/)) {
      const candidate = line.trim();
      if (candidate && model.pathFlavor.isAbsolute(candidate)) return candidate;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a bare binary name to an absolute path via `where.exe`/`which`.
 * Returns undefined for an unsafe name or any resolution failure.
 */
export function resolveExecutable(
  binary: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!isValidBinaryName(binary)) return undefined;
  return resolveCliPath(binary, platformModel(platform));
}

/**
 * Presence check for a command. Absolute paths are checked on disk; bare names
 * go through the PATH resolver, which is bounded by a timeout so a hook cannot
 * hang on an unreachable network-drive PATH entry.
 */
export function isExecutableAvailable(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const flavor = platform === 'win32' ? path.win32 : path.posix;
  if (flavor.isAbsolute(command) || path.isAbsolute(command)) {
    try {
      return existsSync(command);
    } catch {
      return false;
    }
  }
  return resolveExecutable(command, platform) !== undefined;
}

function directVersionOptions(): SpawnSyncOptionsWithStringEncoding {
  return {
    timeout: VERSION_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  };
}

function isLiteralSafeBatchPath(resolvedPath: string): boolean {
  return SAFE_BATCH_PATH.test(resolvedPath);
}

function isBatchPath(resolvedPath: string, model: PlatformModel): boolean {
  if (!model.isWindows) return false;
  const extension = model.pathFlavor.extname(resolvedPath).toLowerCase();
  return VALID_BATCH_EXTENSIONS.has(extension);
}

function isValidatedComspec(candidate: string | undefined): candidate is string {
  // Whitespace is rejected along with control characters: the batch fallback
  // spawns with windowsVerbatimArguments, which leaves argv[0] unquoted, so a
  // space-bearing COMSPEC would be split into separate arguments.
  if (!candidate || /[\0\r\n\s]/.test(candidate) || /[\\/]$/.test(candidate)) return false;
  if (!path.win32.isAbsolute(candidate)) return false;
  return path.win32.basename(candidate).toLowerCase() === 'cmd.exe';
}

function validatedComspec(): string | undefined {
  const configured = process.env.ComSpec ?? process.env.COMSPEC;
  if (isValidatedComspec(configured)) return configured;
  try {
    if (existsSync(DEFAULT_COMSPEC) && isValidatedComspec(DEFAULT_COMSPEC)) return DEFAULT_COMSPEC;
  } catch {
    // An unavailable filesystem probe only disables optional enrichment.
  }
  return undefined;
}

function canUseBatchFallback(
  resolvedPath: string,
  directResult: SpawnResult,
  model: PlatformModel,
): boolean {
  if (!model.isWindows || !isBatchPath(resolvedPath, model)) return false;
  if (directResult.status !== null || directResult.signal !== null || !directResult.error) return false;
  return ADMITTED_BATCH_START_ERRORS.has(errorCode(directResult.error) ?? '');
}

function runBatchCommand(resolvedPath: string, args: string[], timeoutMs: number): SpawnResult | undefined {
  const comspec = validatedComspec();
  if (!comspec) return undefined;
  // The tail is handed to cmd.exe verbatim, so only a closed argument grammar
  // may reach it — anything else could be reinterpreted as a command.
  if (!args.every(arg => SAFE_BATCH_ARG.test(arg))) return undefined;

  // cmd.exe parses the raw command tail itself. The closed path grammar makes
  // this fixed payload safe to pass verbatim and avoids Node re-quoting it.
  const tail = [`"${resolvedPath}"`, ...args].join(' ');

  try {
    return spawnSync(
      comspec,
      ['/d', '/v:off', '/s', '/c', `"${tail}"`],
      {
        timeout: timeoutMs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: process.env,
      },
    ) as SpawnResult;
  } catch {
    return undefined;
  }
}

export interface ExecutableProbeOptions {
  /** Arguments passed to the resolved executable. Defaults to ['--version']. */
  args?: string[];
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export interface ExecutableProbeResult {
  /** True only when the child (direct or via cmd.exe) exited with status 0. */
  exitedZero: boolean;
  /** First non-blank stdout line, when the child succeeded and produced output. */
  output?: string;
  error?: string;
}

/**
 * Run a resolved executable with a bounded timeout and no shell. On Windows a
 * `.cmd`/`.bat` shim that refuses to start directly is retried through a
 * validated COMSPEC, but only when its path matches a closed literal grammar.
 */
export function probeExecutable(
  resolvedPath: string,
  options: ExecutableProbeOptions = {},
): ExecutableProbeResult {
  const args = options.args ?? ['--version'];
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  const model = platformModel(platform);

  let directResult: SpawnResult;
  try {
    directResult = spawnSync(resolvedPath, args, {
      ...directVersionOptions(),
      timeout: timeoutMs,
    }) as SpawnResult;
  } catch {
    return { exitedZero: false, error: VERSION_ERROR };
  }

  if (directResult.status === 0 && !directResult.signal) {
    const output = firstNonblankLine(directResult.stdout);
    return output === undefined ? { exitedZero: true } : { exitedZero: true, output };
  }

  if (canUseBatchFallback(resolvedPath, directResult, model)) {
    if (!isLiteralSafeBatchPath(resolvedPath)) {
      return { exitedZero: false, error: UNSAFE_BATCH_ERROR };
    }
    const batchResult = runBatchCommand(resolvedPath, args, timeoutMs);
    if (!batchResult || batchResult.status !== 0 || batchResult.signal) {
      return { exitedZero: false, error: VERSION_ERROR };
    }
    const output = firstNonblankLine(batchResult.stdout);
    return output === undefined ? { exitedZero: true } : { exitedZero: true, output };
  }

  return { exitedZero: false, error: VERSION_ERROR };
}

function failedVersionResult(resolvedPath: string, error = VERSION_ERROR): ProbeExecutionResult {
  return {
    found: true,
    path: resolvedPath,
    error,
    versionExitedZero: false,
  };
}

function executeCliProbe(binary: string, platform: NodeJS.Platform): ProbeExecutionResult {
  if (!isValidBinaryName(binary)) {
    return { found: false, error: INVALID_BINARY_ERROR, versionExitedZero: false };
  }

  const resolvedPath = resolveExecutable(binary, platform);
  if (!resolvedPath) {
    return { found: false, error: RESOLVER_ERROR, versionExitedZero: false };
  }

  const probe = probeExecutable(resolvedPath, { platform });
  if (!probe.exitedZero) {
    return failedVersionResult(resolvedPath, probe.error);
  }
  if (probe.output === undefined) {
    return {
      found: true,
      path: resolvedPath,
      error: VERSION_NO_OUTPUT_ERROR,
      versionExitedZero: true,
    };
  }
  return {
    found: true,
    path: resolvedPath,
    version: probe.output,
    versionExitedZero: true,
  };
}

/** Resolve a provider CLI and perform a bounded, shell-free optional version probe. */
export function probeCli(binary: string, platform: NodeJS.Platform = process.platform): CliProbeResult {
  const result = executeCliProbe(binary, platform);
  return {
    found: result.found,
    ...(result.path === undefined ? {} : { path: result.path }),
    ...(result.version === undefined ? {} : { version: result.version }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/**
 * Legacy detector projection. `available` intentionally remains tied to a
 * status-zero version process rather than to successful path resolution.
 */
export function detectCli(binary: string): CliInfo {
  const result = executeCliProbe(binary, process.platform);
  if (!result.versionExitedZero) return { available: false };

  return {
    available: true,
    version: result.version ?? '',
    path: result.path,
  };
}

export function detectAllClis(): Record<string, CliInfo> {
  return {
    claude: detectCli('claude'),
    codex: detectCli('codex'),
    gemini: detectCli('gemini'),
    cursor: detectCli('cursor-agent'),
    grok: detectCli('grok'),
    antigravity: detectCli('agy'),
  };
}
