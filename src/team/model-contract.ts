import { spawnSync } from 'child_process';
import { isAbsolute, posix as posixPath, win32 as win32Path } from 'path';
import { homedir } from 'os';
import { validateTeamName } from './team-name.js';
import { normalizeToCcAlias } from '../features/delegation-enforcer.js';
import { isBedrock, isVertexAI, isProviderSpecificModelId } from '../config/models.js';
import { isExternalLLMDisabled } from '../lib/security-config.js';
import { probeExecutable, resolveExecutable } from '../platform/executable-resolution.js';
import type { WorkerLaunchDescriptor } from './types.js';

export type CliAgentType = 'claude' | 'copilot' | 'codex' | 'gemini' | 'cursor' | 'grok' | 'antigravity';

export interface CliAgentContract {
  agentType: CliAgentType;
  binary: string;
  installInstructions: string;
  buildLaunchArgs(model?: string, extraFlags?: string[]): string[];
  parseOutput(rawOutput: string): string;
  /** Whether this agent supports a prompt/headless mode that bypasses TUI input */
  supportsPromptMode?: boolean;
  /** CLI flag for prompt mode (e.g., '-p' for gemini) */
  promptModeFlag?: string;
}

export interface WorkerLaunchConfig {
  teamName: string;
  workerName: string;
  model?: string;
  cwd: string;
  extraFlags?: string[];
  /**
   * Optional pre-validated absolute CLI binary path.
   * Used by runtime preflight validation to ensure spawns are pinned.
   */
  resolvedBinaryPath?: string;
  /**
   * Optional path the worker writes its structured verdict JSON to
   * (used by the CLI-worker output contract for critic/reviewer stages).
   * Consumed by the worker-completion handler in runtime-v2.
   */
  output_file?: string;
}

/** @deprecated Backward-compat shim for older team API consumers. */
export interface CliBinaryValidation {
  valid: boolean;
  binary: string;
  resolvedPath?: string;
  reason?: string;
}

const resolvedPathCache = new Map<string, string>();

const UNTRUSTED_PATH_PATTERNS: RegExp[] = [
  /^\/tmp(\/|$)/,
  /^\/var\/tmp(\/|$)/,
  /^\/dev\/shm(\/|$)/,
];

/**
 * Path semantics for the host platform. Selected per call rather than bound at
 * import time so a platform-stubbed test exercises the matching rules it means to.
 */
function pathFlavor(): typeof posixPath {
  return process.platform === 'win32' ? win32Path : posixPath;
}

/**
 * The user's home directory, resolved the way os.homedir() does but keyed to
 * the platform under evaluation: HOME on POSIX, USERPROFILE on Windows, with
 * the OS lookup as the fallback when neither is set.
 */
function trustedHome(): string {
  const fromEnv = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  return fromEnv?.trim() ? fromEnv : homedir();
}

function getTrustedPrefixes(): string[] {
  const flavor = pathFlavor();
  const home = trustedHome();
  const trusted: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const candidates = [
      appData ? flavor.join(appData, 'npm') : undefined,
      localAppData ? flavor.join(localAppData, 'npm') : undefined,
      localAppData ? flavor.join(localAppData, 'Programs') : undefined,
      localAppData ? flavor.join(localAppData, 'Yarn', 'bin') : undefined,
      programFiles ? flavor.join(programFiles, 'nodejs') : undefined,
      programFilesX86 ? flavor.join(programFilesX86, 'nodejs') : undefined,
      home ? flavor.join(home, '.cargo', 'bin') : undefined,
      home ? flavor.join(home, '.grok', 'bin') : undefined,
      home ? flavor.join(home, '.local', 'bin') : undefined,
    ];
    trusted.push(...candidates.filter((entry): entry is string => Boolean(entry)));
  } else {
    trusted.push('/usr/local/bin', '/usr/bin', '/opt/homebrew');
    if (home) {
      trusted.push(`${home}/.local/bin`);
      trusted.push(`${home}/.nvm`);
      trusted.push(`${home}/.cargo/bin`);
      trusted.push(`${home}/.grok/bin`);
    }
  }

  // npm's configured global prefix is where `npm i -g` puts provider CLIs.
  const npmPrefix = process.env.npm_config_prefix;
  if (npmPrefix && flavor.isAbsolute(npmPrefix)) {
    trusted.push(npmPrefix);
    trusted.push(flavor.join(npmPrefix, 'bin'));
  }

  const custom = (process.env.OMC_TRUSTED_CLI_DIRS ?? '')
    .split(flavor.delimiter)
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => flavor.isAbsolute(part));

  trusted.push(...custom);
  return trusted;
}

function isTrustedPrefix(resolvedPath: string): boolean {
  const flavor = pathFlavor();
  return getTrustedPrefixes().some(prefix => {
    // A raw startsWith would treat a sibling whose name merely begins with the
    // prefix as trusted — `/usr/bin` would match `/usr/bin-malicious/grok`.
    // `relative` enforces the directory boundary, and its win32 form compares
    // case-insensitively the way the filesystem does.
    const relative = flavor.relative(prefix, resolvedPath);
    if (relative === '') return true;
    return !relative.startsWith('..') && !flavor.isAbsolute(relative);
  });
}

function assertBinaryName(binary: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(binary)) {
    throw new Error(`Invalid CLI binary name: ${binary}`);
  }
}

/** @deprecated Backward-compat shim; non-interactive shells should generally skip RC files. */
export function shouldLoadShellRc(): boolean {
  return false;
}

/** @deprecated Backward-compat shim retained for API compatibility. */
export function resolveCliBinaryPath(binary: string): string {
  assertBinaryName(binary);
  const cached = resolvedPathCache.get(binary);
  if (cached) return cached;

  const found = resolveExecutable(binary);
  if (!found) {
    throw new Error(`CLI binary '${binary}' not found in PATH`);
  }

  const resolvedPath = pathFlavor().normalize(found);
  if (!pathFlavor().isAbsolute(resolvedPath)) {
    throw new Error(`Resolved CLI binary '${binary}' to relative path`);
  }

  if (UNTRUSTED_PATH_PATTERNS.some(pattern => pattern.test(resolvedPath))) {
    throw new Error(`Resolved CLI binary '${binary}' to untrusted location: ${resolvedPath}`);
  }

  if (!isTrustedPrefix(resolvedPath)) {
    console.warn(`[omc:cli-security] CLI binary '${binary}' resolved to non-standard path: ${resolvedPath}`);
  }

  resolvedPathCache.set(binary, resolvedPath);
  return resolvedPath;
}

/** @deprecated Backward-compat shim retained for API compatibility. */
export function clearResolvedPathCache(): void {
  resolvedPathCache.clear();
}

/** @deprecated Backward-compat shim retained for API compatibility. */
export function validateCliBinaryPath(binary: string): CliBinaryValidation {
  try {
    const resolvedPath = resolveCliBinaryPath(binary);
    return { valid: true, binary, resolvedPath };
  } catch (error) {
    return {
      valid: false,
      binary,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export const _testInternals = {
  UNTRUSTED_PATH_PATTERNS,
  getTrustedPrefixes,
  isTrustedPrefix,
};

/**
 * Detect parent launch env for Claude Code API-key auth.
 *
 * Claude Code's `--dangerously-skip-permissions` only bypasses permission
 * prompts. When an API key is present, `--bare` is needed to avoid the
 * interactive OAuth/session login path for team worker panes.
 */
export function shouldUseClaudeBareMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim().length > 0;
}

const CONTRACTS: Record<CliAgentType, CliAgentContract> = {
  claude: {
    agentType: 'claude',
    binary: 'claude',
    installInstructions: 'Install Claude CLI: https://claude.ai/download',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--dangerously-skip-permissions'];
      if (shouldUseClaudeBareMode() && !extraFlags.includes('--bare')) {
        args.push('--bare');
      }
      if (model) {
        // Provider-specific model IDs (Bedrock, Vertex) must be passed as-is.
        // Normalizing them to aliases like "sonnet" causes Claude Code to expand
        // them to Anthropic API names (claude-sonnet-5) which are invalid on
        // these providers. (issue #1695)
        const resolved = isProviderSpecificModelId(model) ? model : normalizeToCcAlias(model);
        args.push('--model', resolved);
      }
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
  copilot: {
    agentType: 'copilot',
    binary: 'copilot',
    installInstructions: 'Install Copilot CLI: https://github.com/github/copilot-cli',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--dangerously-skip-permissions'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
  codex: {
    agentType: 'codex',
    binary: 'codex',
    installInstructions: 'Install Codex CLI: npm install -g @openai/codex',
    // Team workers must be persistent interactive panes. Do not use `codex exec`
    // or positional prompt mode here; runtime dispatch writes inbox.md and nudges
    // the live Codex TUI with `codex` as the worker process.
    supportsPromptMode: false,
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--dangerously-bypass-approvals-and-sandbox'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      // Codex outputs JSONL — extract the last assistant message
      const lines = rawOutput.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.type === 'message' && parsed.role === 'assistant') {
            return parsed.content ?? rawOutput;
          }
          if (parsed.type === 'result' || parsed.output) {
            return parsed.output ?? parsed.result ?? rawOutput;
          }
        } catch {
          // not JSON, skip
        }
      }
      return rawOutput.trim();
    },
  },
  gemini: {
    agentType: 'gemini',
    binary: 'gemini',
    installInstructions: 'Install Gemini CLI: npm install -g @google/gemini-cli',
    supportsPromptMode: true,
    promptModeFlag: '-p',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--approval-mode', 'yolo'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
  grok: {
    agentType: 'grok',
    binary: 'grok',
    installInstructions: 'Install Grok Build: https://build.grok.com',
    supportsPromptMode: true,
    promptModeFlag: '-p',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--always-approve'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
  antigravity: {
    agentType: 'antigravity',
    binary: 'agy',
    installInstructions: 'Install the Antigravity CLI (agy) per the official instructions at https://antigravity.google, then verify with `agy --version`.',
    supportsPromptMode: true,
    promptModeFlag: '-p',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      // agy's `-p`/`--print` is appended by getPromptModeArgs as `-p <instruction>`,
      // where the prompt is the VALUE of `-p` (not a boolean). All other flags
      // MUST precede that `-p`, so buildLaunchArgs returns only the leading flags
      // (like grok). --dangerously-skip-permissions suppresses approval prompts,
      // so no trust-confirm send-keys is needed (unlike gemini). Verified agy 1.0.10.
      const args = ['--dangerously-skip-permissions'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
  cursor: {
    agentType: 'cursor',
    binary: 'cursor-agent',
    installInstructions: 'Install Cursor Agent CLI: see https://docs.cursor.com/cli',
    // Team workers must be persistent interactive panes, so the one-shot
    // `-p/--print` path is deliberately unused here (same stance as codex).
    supportsPromptMode: false,
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      // `--force` suppresses per-command approval prompts and `--trust` accepts
      // the workspace, which together are cursor-agent's equivalent of the
      // approval bypass every other provider already passes. Without them a
      // worker pane opened on a directory cursor has not seen before stops at
      // "Workspace Trust Required" and exits; team worktrees are freshly
      // created per worker, so they always hit that path. `omc ask cursor`
      // already launches with `--force --trust` for the same reason.
      const args = ['--force', '--trust'];
      const extra = extraFlags.filter(flag => !['--force', '-f', '--yolo', '--trust'].includes(flag));
      // `--model <id>` is a documented global option; ids come from
      // `cursor-agent --list-models` (e.g. cursor-grok-4.6-high, composer-2.5).
      if (model) args.push('--model', model);
      return [...args, ...extra];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
};

export function getContract(agentType: CliAgentType): CliAgentContract {
  const contract = CONTRACTS[agentType];
  if (!contract) {
    throw new Error(`Unknown agent type: ${agentType}. Supported: ${Object.keys(CONTRACTS).join(', ')}`);
  }
  if (agentType !== 'claude' && isExternalLLMDisabled()) {
    throw new Error(
      `External LLM provider "${agentType}" is blocked by security policy (disableExternalLLM). ` +
      `Only Claude workers are allowed in the current security configuration.`
    );
  }
  return contract;
}

function validateBinaryRef(binary: string): void {
  if (isAbsolute(binary)) return;
  if (/^[A-Za-z0-9._-]+$/.test(binary)) return;
  throw new Error(`Unsafe CLI binary reference: ${binary}`);
}

function resolveBinaryPath(binary: string): string {
  validateBinaryRef(binary);
  if (isAbsolute(binary)) return binary;

  // An unresolvable name falls back to the bare binary so a PATH lookup by the
  // spawning shell still gets a chance.
  return resolveExecutable(binary) ?? binary;
}

export function isCliAvailable(agentType: CliAgentType): boolean {
  const contract = getContract(agentType);
  try {
    const resolvedBinary = resolveBinaryPath(contract.binary);

    if (resolvedBinary === contract.binary && process.platform === 'win32') {
      // Unresolved on Windows: only a shell PATH lookup can still find it.
      const result = spawnSync(resolvedBinary, ['--version'], { timeout: 5000, shell: true });
      return result.status === 0;
    }

    return probeExecutable(resolvedBinary, { timeoutMs: 5000 }).exitedZero;
  } catch {
    return false;
  }
}

export function validateCliAvailable(agentType: CliAgentType): void {
  // Platform support first: a clear "unsupported on this OS" error is more useful
  // than a binary-not-found message when the binary exists but headless mode is
  // unsupported here (e.g. antigravity on Windows).
  assertHeadlessSupported(agentType);
  if (!isCliAvailable(agentType)) {
    const contract = getContract(agentType);
    throw new Error(
      `CLI agent '${agentType}' not found. ${contract.installInstructions}`
    );
  }
}

export function resolveValidatedBinaryPath(agentType: CliAgentType): string {
  const contract = getContract(agentType);
  return resolveCliBinaryPath(contract.binary);
}

export function buildLaunchArgs(agentType: CliAgentType, config: WorkerLaunchConfig): string[] {
  return getContract(agentType).buildLaunchArgs(config.model, config.extraFlags);
}

export function buildWorkerArgv(agentType: CliAgentType, config: WorkerLaunchConfig): string[] {
  validateTeamName(config.teamName);
  const contract = getContract(agentType);
  const binary = config.resolvedBinaryPath
    ? (() => {
        validateBinaryRef(config.resolvedBinaryPath);
        return config.resolvedBinaryPath;
      })()
    : resolveBinaryPath(contract.binary);
  const args = buildLaunchArgs(agentType, config);
  return [binary, ...args];
}

export function validateWorkerLaunchDescriptor(value: unknown): WorkerLaunchDescriptor {
  const descriptor = value as Partial<WorkerLaunchDescriptor> | null;
  if (!descriptor || descriptor.schema_version !== 1
    || typeof descriptor.provider !== 'string'
    || !Object.prototype.hasOwnProperty.call(descriptor, 'model')
    || (descriptor.model !== null && (typeof descriptor.model !== 'string' || descriptor.model.length === 0))
    || typeof descriptor.binary !== 'string' || descriptor.binary.length === 0 || descriptor.binary.includes('\0')
    || !(isAbsolute(descriptor.binary) || win32Path.isAbsolute(descriptor.binary))
    || !Array.isArray(descriptor.args) || descriptor.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('Invalid worker launch descriptor');
  }
  getContract(descriptor.provider as CliAgentType);
  const args = descriptor.provider === 'cursor'
    ? [
        '--force',
        '--trust',
        ...descriptor.args.filter(flag => !['--force', '-f', '--yolo', '--trust'].includes(flag)),
      ]
    : [...descriptor.args];
  return {
    schema_version: 1,
    provider: descriptor.provider as CliAgentType,
    model: descriptor.model,
    binary: descriptor.binary,
    args,
  };
}

export function buildValidatedWorkerLaunchDescriptor(
  agentType: CliAgentType,
  config: WorkerLaunchConfig,
  appendedArgs: readonly string[] = [],
): WorkerLaunchDescriptor {
  const [binary, ...args] = buildWorkerArgv(agentType, config);
  return validateWorkerLaunchDescriptor({
    schema_version: 1,
    provider: agentType,
    model: config.model ?? null,
    binary,
    args: [...args, ...appendedArgs],
  });
}

export function buildWorkerCommand(agentType: CliAgentType, config: WorkerLaunchConfig): string {
  return buildWorkerArgv(agentType, config)
    .map((part) => `'${part.replace(/'/g, `'\"'\"'`)}'`)
    .join(' ');
}

const WORKER_MODEL_ENV_ALLOWLIST = [
  'ANTHROPIC_MODEL',
  'CLAUDE_MODEL',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
  'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
  'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'OMC_MODEL_HIGH',
  'OMC_MODEL_MEDIUM',
  'OMC_MODEL_LOW',
  'OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL',
  'OMC_CODEX_DEFAULT_MODEL',
  'OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL',
  'OMC_GEMINI_DEFAULT_MODEL',
  'OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL',
  'OMC_GROK_DEFAULT_MODEL',
  'OMC_EXTERNAL_MODELS_DEFAULT_ANTIGRAVITY_MODEL',
  'OMC_ANTIGRAVITY_DEFAULT_MODEL',
] as const;

export function getWorkerEnv(
  teamName: string,
  workerName: string,
  agentType: CliAgentType,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  validateTeamName(teamName);
  const workerEnv: Record<string, string> = {
    OMC_TEAM_WORKER: `${teamName}/${workerName}`,
    OMC_TEAM_NAME: teamName,
    OMC_WORKER_AGENT_TYPE: agentType,
  };

  for (const key of WORKER_MODEL_ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) {
      workerEnv[key] = value;
    }
  }

  return workerEnv;
}

export function parseCliOutput(agentType: CliAgentType, rawOutput: string): string {
  return getContract(agentType).parseOutput(rawOutput);
}

/**
 * Check if an agent type supports prompt/headless mode (bypasses TUI).
 */
export function isPromptModeAgent(agentType: CliAgentType): boolean {
  const contract = getContract(agentType);
  return !!contract.supportsPromptMode;
}

/**
 * Resolve the active model for Claude team workers on Bedrock/Vertex.
 *
 * When running on a non-standard provider (Bedrock, Vertex), workers need
 * the provider-specific model ID passed explicitly via --model. Without it,
 * Claude Code falls back to its built-in default (claude-sonnet-5) which
 * is invalid on these providers.
 *
 * Resolution order:
 *   1. ANTHROPIC_MODEL / CLAUDE_MODEL env vars (user's explicit setting)
 *   2. Provider tier-specific env vars (CLAUDE_CODE_BEDROCK_SONNET_MODEL, etc.)
 *   3. undefined — let Claude Code handle its own default
 *
 * Returns undefined when not on Bedrock/Vertex (standard Anthropic API
 * handles bare aliases fine).
 */
export function resolveClaudeWorkerModel(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // When force-inherit routing is enabled, do not resolve/override worker model.
  // This preserves parent model inheritance and avoids alias normalization drift.
  if (env.OMC_ROUTING_FORCE_INHERIT === 'true') {
    return undefined;
  }

  // Only needed for non-standard providers
  if (!isBedrock() && !isVertexAI()) {
    return undefined;
  }

  // Direct model env vars — highest priority
  const directModel = env.ANTHROPIC_MODEL || env.CLAUDE_MODEL || '';
  if (directModel) {
    return directModel;
  }

  // Fallback: Bedrock tier-specific env vars (default to sonnet tier)
  const bedrockModel =
    env.CLAUDE_CODE_BEDROCK_SONNET_MODEL ||
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
    '';
  if (bedrockModel) {
    return bedrockModel;
  }

  // OMC tier env vars
  const omcModel = env.OMC_MODEL_MEDIUM || '';
  if (omcModel) {
    return omcModel;
  }

  return undefined;
}

/**
 * Get the extra CLI args needed to pass an instruction in prompt mode.
 * Returns empty array if the agent does not support prompt mode.
 */
/**
 * Whether a CLI agent's headless/prompt mode is supported on the given platform.
 * Antigravity (`agy`) `-p`/`--print` takes the prompt as an argv value and cannot
 * read it from stdin; on Windows that argv path is unreliable and `agy` has known
 * upstream Windows `-p` limitations. This centralizes the same platform support
 * decision the advisor (`scripts/run-provider-advisor.js`) enforces for `omc ask`.
 */
export function isHeadlessSupportedOnPlatform(
  agentType: CliAgentType,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (agentType === 'antigravity' && platform === 'win32') {
    return false;
  }
  return true;
}

/** Throw a clear, actionable error if the agent's headless mode is unsupported here. */
export function assertHeadlessSupported(agentType: CliAgentType): void {
  if (!isHeadlessSupportedOnPlatform(agentType)) {
    throw new Error(
      `CLI agent '${agentType}' headless/prompt mode is not supported on Windows: ` +
      `\`agy --print\` takes the prompt as an argv value (it cannot read stdin) and has ` +
      `known upstream Windows \`-p\` limitations. Run '${agentType}' team workers on ` +
      `macOS/Linux, or use the 'gemini' provider on Windows.`,
    );
  }
}

export function getPromptModeArgs(agentType: CliAgentType, instruction: string): string[] {
  const contract = getContract(agentType);
  if (!contract.supportsPromptMode) {
    return [];
  }
  // Centralized platform guard: refuse unsupported headless paths (e.g. antigravity
  // on Windows) before building `-p <prompt>`, so the team path fails clearly here
  // instead of attempting an unreliable argv spawn that fails/hangs opaquely.
  assertHeadlessSupported(agentType);
  // If a flag is defined (e.g. gemini's '-p'), prepend it; otherwise the
  // instruction is passed as a positional argument (e.g. codex [PROMPT]).
  if (contract.promptModeFlag) {
    return [contract.promptModeFlag, instruction];
  }
  return [instruction];
}
