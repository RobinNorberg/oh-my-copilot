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
import { spawnSync } from 'child_process';
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
function platformModel(platform) {
    const isWindows = platform === 'win32';
    return {
        isWindows,
        finder: isWindows ? 'where.exe' : 'which',
        pathFlavor: isWindows ? path.win32 : path.posix,
    };
}
function asText(value) {
    if (typeof value === 'string')
        return value;
    if (Buffer.isBuffer(value))
        return value.toString('utf8');
    return value == null ? '' : String(value);
}
function firstNonblankLine(value) {
    for (const line of asText(value).split(/\r\n|\n|\r/)) {
        const trimmed = line.trim();
        if (trimmed)
            return trimmed;
    }
    return undefined;
}
function isValidBinaryName(binary) {
    return typeof binary === 'string' && SAFE_BINARY_NAME.test(binary);
}
function errorCode(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
/**
 * A directory to run the finder from that no untrusted repo can write to.
 *
 * where.exe searches the CURRENT DIRECTORY before PATH and reports the hit as
 * an absolute path, so running it with the inherited cwd lets a claude.exe
 * planted in a cloned repo outrank the real install — and the resolved path
 * then flows on into the worker-spawn path. `which` does not search the cwd,
 * so POSIX needs no override.
 */
function neutralFinderCwd(model) {
    if (!model.isWindows)
        return undefined;
    // The Windows directory needs administrator rights to write to, so it cannot
    // hold a plant plausibly. No existence probe: if it somehow does not exist,
    // the spawn fails and resolution reports nothing, which is the safe answer.
    return process.env.SystemRoot || process.env.windir || 'C:\\Windows';
}
function resolveCliPath(binary, model) {
    try {
        const finderCwd = neutralFinderCwd(model);
        const result = spawnSync(model.finder, [binary], {
            timeout: RESOLVE_TIMEOUT_MS,
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
            ...(finderCwd ? { cwd: finderCwd } : {}),
        });
        // A finder error, timeout, signal, or nonzero exit is a resolution failure.
        if (result.error || result.signal || result.status !== 0)
            return undefined;
        const stdout = asText(result.stdout);
        for (const line of stdout.split(/\r\n|\n|\r/)) {
            const candidate = line.trim();
            if (candidate && model.pathFlavor.isAbsolute(candidate))
                return candidate;
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Resolve a bare binary name to an absolute path via `where.exe`/`which`.
 * Returns undefined for an unsafe name or any resolution failure.
 */
export function resolveExecutable(binary, platform = process.platform) {
    if (!isValidBinaryName(binary))
        return undefined;
    return resolveCliPath(binary, platformModel(platform));
}
/**
 * Presence check for a command. Absolute paths are checked on disk; bare names
 * go through the PATH resolver, which is bounded by a timeout so a hook cannot
 * hang on an unreachable network-drive PATH entry.
 */
export function isExecutableAvailable(command, platform = process.platform) {
    const flavor = platform === 'win32' ? path.win32 : path.posix;
    if (flavor.isAbsolute(command) || path.isAbsolute(command)) {
        try {
            return existsSync(command);
        }
        catch {
            return false;
        }
    }
    return resolveExecutable(command, platform) !== undefined;
}
function directVersionOptions() {
    return {
        timeout: VERSION_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
    };
}
function isLiteralSafeBatchPath(resolvedPath) {
    return SAFE_BATCH_PATH.test(resolvedPath);
}
function isBatchPath(resolvedPath, model) {
    if (!model.isWindows)
        return false;
    const extension = model.pathFlavor.extname(resolvedPath).toLowerCase();
    return VALID_BATCH_EXTENSIONS.has(extension);
}
function isValidatedComspec(candidate) {
    // Whitespace is rejected along with control characters: the batch fallback
    // spawns with windowsVerbatimArguments, which leaves argv[0] unquoted, so a
    // space-bearing COMSPEC would be split into separate arguments.
    if (!candidate || /[\0\r\n\s]/.test(candidate) || /[\\/]$/.test(candidate))
        return false;
    if (!path.win32.isAbsolute(candidate))
        return false;
    return path.win32.basename(candidate).toLowerCase() === 'cmd.exe';
}
function validatedComspec() {
    const configured = process.env.ComSpec ?? process.env.COMSPEC;
    if (isValidatedComspec(configured))
        return configured;
    try {
        if (existsSync(DEFAULT_COMSPEC) && isValidatedComspec(DEFAULT_COMSPEC))
            return DEFAULT_COMSPEC;
    }
    catch {
        // An unavailable filesystem probe only disables optional enrichment.
    }
    return undefined;
}
function canUseBatchFallback(resolvedPath, directResult, model) {
    if (!model.isWindows || !isBatchPath(resolvedPath, model))
        return false;
    if (directResult.status !== null || directResult.signal !== null || !directResult.error)
        return false;
    return ADMITTED_BATCH_START_ERRORS.has(errorCode(directResult.error) ?? '');
}
function runBatchCommand(resolvedPath, args, timeoutMs) {
    const comspec = validatedComspec();
    if (!comspec)
        return undefined;
    // The tail is handed to cmd.exe verbatim, so only a closed argument grammar
    // may reach it — anything else could be reinterpreted as a command.
    if (!args.every(arg => SAFE_BATCH_ARG.test(arg)))
        return undefined;
    // cmd.exe parses the raw command tail itself. The closed path grammar makes
    // this fixed payload safe to pass verbatim and avoids Node re-quoting it.
    const tail = [`"${resolvedPath}"`, ...args].join(' ');
    try {
        return spawnSync(comspec, ['/d', '/v:off', '/s', '/c', `"${tail}"`], {
            timeout: timeoutMs,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: true,
            env: process.env,
        });
    }
    catch {
        return undefined;
    }
}
/**
 * Run a resolved executable with a bounded timeout and no shell. On Windows a
 * `.cmd`/`.bat` shim that refuses to start directly is retried through a
 * validated COMSPEC, but only when its path matches a closed literal grammar.
 */
export function probeExecutable(resolvedPath, options = {}) {
    const args = options.args ?? ['--version'];
    const platform = options.platform ?? process.platform;
    const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
    const model = platformModel(platform);
    let directResult;
    try {
        directResult = spawnSync(resolvedPath, args, {
            ...directVersionOptions(),
            timeout: timeoutMs,
        });
    }
    catch {
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
function failedVersionResult(resolvedPath, error = VERSION_ERROR) {
    return {
        found: true,
        path: resolvedPath,
        error,
        versionExitedZero: false,
    };
}
function executeCliProbe(binary, platform) {
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
export function probeCli(binary, platform = process.platform) {
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
export function detectCli(binary) {
    const result = executeCliProbe(binary, process.platform);
    if (!result.versionExitedZero)
        return { available: false };
    return {
        available: true,
        version: result.version ?? '',
        path: result.path,
    };
}
export function detectAllClis() {
    return {
        claude: detectCli('claude'),
        codex: detectCli('codex'),
        gemini: detectCli('gemini'),
        cursor: detectCli('cursor-agent'),
        grok: detectCli('grok'),
        antigravity: detectCli('agy'),
    };
}
//# sourceMappingURL=executable-resolution.js.map