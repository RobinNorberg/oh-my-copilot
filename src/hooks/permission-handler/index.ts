import * as fs from 'fs';
import * as path from 'path';
import { getOmcRoot, getWorktreeRoot } from '../../lib/worktree-paths.js';
import { getCopilotConfigDir } from '../../utils/config-dir.js';
import type { ToolAnnotations } from '../../tools/types.js';

export interface PermissionRequestInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: {
    command?: string;
    file_path?: string;
    content?: string;
    [key: string]: unknown;
  };
  tool_use_id: string;
}

export interface HookOutput {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    decision?: {
      behavior: 'allow' | 'deny' | 'ask';
      reason?: string;
    };
  };
}

const SAFE_PATTERNS = [
  /^git (status|diff|log|branch|show|fetch)/,
  /^npm (test|run (test|lint|build|check|typecheck))/,
  /^pnpm (test|run (test|lint|build|check|typecheck))/,
  /^yarn (test|run (test|lint|build|check|typecheck))/,
  /^tsc( |$)/,
  /^gh (issue|pr) (view|list|status)\b/,
  /^eslint /,
  /^prettier /,
  /^cargo (test|check|clippy|build)/,
  /^pytest/,
  /^python -m pytest/,
  /^ls( |$)/,
  /^grep /,
  /^find /,
  /^wc /,
  /^pwd$/,
  /^which /,
  /^echo /,
  /^env$/,
  /^node --version$/,
  /^dotnet (--version|--list-sdks|--list-runtimes|--info)$/,
  /^dotnet (build|test|run|restore|clean)( |$)/,
  /^gh (pr|issue|repo|api|run|workflow) (view|list|status|diff|checks)/,
  /^gh auth status/,
  /^az (account show|group list|resource list|ad signed-in-user show)/,
  /^az devops (project list|configure)/,
  /^az pipelines (list|show|runs list)/,
  /^az repos (list|show|pr list)/,
  // REMOVED: cat, head, tail - they allow reading arbitrary files
];

// Shell metacharacters that enable command chaining and injection
// See GitHub Issue #146 for full list of dangerous characters
// Note: Quotes ("') intentionally excluded - they're needed for paths with spaces
// and command substitution is already caught by $ detection
const DANGEROUS_SHELL_CHARS = /[;&|`$()<>\n\r\t\0\\{}\[\]*?~!#]/;

// Heredoc operator detection (<<, <<-, <<~, with optional quoting of delimiter)
const HEREDOC_PATTERN = /<<[-~]?\s*['"]?\w+['"]?/;

// --- Deny tracking & escalation ---
const CONSECUTIVE_DENY_LIMIT = 3;
const TOTAL_DENY_LIMIT = 20;

interface DenyTracker {
  consecutiveDenials: number;
  totalDenials: number;
  totalAllows: number;
  lastDecision: 'allow' | 'deny' | 'ask' | null;
}

const sessionDenyTracker: DenyTracker = {
  consecutiveDenials: 0,
  totalDenials: 0,
  totalAllows: 0,
  lastDecision: null,
};

function trackDecision(decision: 'allow' | 'deny' | 'ask'): void {
  sessionDenyTracker.lastDecision = decision;
  if (decision === 'deny') {
    sessionDenyTracker.consecutiveDenials++;
    sessionDenyTracker.totalDenials++;
  } else if (decision === 'allow') {
    sessionDenyTracker.consecutiveDenials = 0;
    sessionDenyTracker.totalAllows++;
  }
}

function shouldEscalate(): boolean {
  return (
    sessionDenyTracker.consecutiveDenials >= CONSECUTIVE_DENY_LIMIT ||
    sessionDenyTracker.totalDenials >= TOTAL_DENY_LIMIT
  );
}

// --- Audit logging ---
function logPermissionDecision(
  toolName: string,
  command: string | undefined,
  decision: 'allow' | 'deny' | 'ask',
  reason: string,
  directory: string,
): void {
  try {
    const logDir = path.join(getOmcRoot(directory), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, 'permissions.log');
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      tool: toolName,
      command: command?.slice(0, 200),
      decision,
      reason,
      denials: sessionDenyTracker.totalDenials,
      allows: sessionDenyTracker.totalAllows,
    });
    fs.appendFileSync(logPath, entry + '\n');
  } catch {
    // Audit logging is best-effort; never fail the permission decision
  }
}

// --- Annotation-aware MCP tool approval ---
function isAnnotationSafe(annotations: ToolAnnotations | undefined): boolean {
  if (!annotations) return false;
  return annotations.readOnlyHint === true && annotations.destructiveHint !== true;
}

/**
 * Patterns that are safe to auto-allow even when they contain heredoc content.
 * Matched against the first line of the command (before the heredoc body).
 * Issue #608: Prevents full heredoc body from being stored in settings.local.json.
 */
const SAFE_HEREDOC_PATTERNS = [
  /^git commit\b/,
  /^git tag\b/,
];

const SAFE_RIPGREP_FLAGS = new Set([
  '-n',
  '--line-number',
  '-S',
  '--smart-case',
  '-F',
  '--fixed-strings',
  '-i',
  '--ignore-case',
  '--no-heading',
]);

const BACKGROUND_MUTATION_SUBAGENTS = new Set([
  'executor',
  'designer',
  'writer',
  'debugger',
  'git-master',
  'test-engineer',
  'qa-tester',
  'document-specialist',
]);

function readPermissionAllowEntries(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const settings = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      permissions?: { allow?: unknown };
    };
    const allow = settings?.permissions?.allow;
    return Array.isArray(allow) ? allow.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export function getCopilotPermissionAllowEntries(directory: string): string[] {
  const projectSettingsPath = path.join(directory, '.copilot', 'settings.local.json');
  const globalConfigDir = getCopilotConfigDir();
  const candidatePaths = [
    projectSettingsPath,
    path.join(globalConfigDir, 'settings.local.json'),
    path.join(globalConfigDir, 'settings.json'),
  ];

  const allowEntries = new Set<string>();
  for (const candidatePath of candidatePaths) {
    for (const entry of readPermissionAllowEntries(candidatePath)) {
      allowEntries.add(entry.trim());
    }
  }

  return [...allowEntries];
}

function hasGenericToolPermission(allowEntries: string[], toolName: string): boolean {
  return allowEntries.some(entry => entry === toolName || entry.startsWith(`${toolName}(`));
}

export function hasCopilotPermissionApproval(
  directory: string,
  toolName: 'Edit' | 'Write' | 'Bash',
  command?: string,
): boolean {
  const allowEntries = getCopilotPermissionAllowEntries(directory);

  if (toolName !== 'Bash') {
    return hasGenericToolPermission(allowEntries, toolName);
  }

  if (allowEntries.includes('Bash')) {
    return true;
  }

  const trimmedCommand = command?.trim();
  if (!trimmedCommand) {
    return false;
  }

  return allowEntries.includes(`Bash(${trimmedCommand})`);
}

export interface BackgroundPermissionFallbackResult {
  shouldFallback: boolean;
  missingTools: string[];
}

export function getBackgroundTaskPermissionFallback(
  directory: string,
  subagentType?: string,
): BackgroundPermissionFallbackResult {
  const normalizedSubagentType = subagentType?.trim().toLowerCase();
  if (!normalizedSubagentType || !BACKGROUND_MUTATION_SUBAGENTS.has(normalizedSubagentType)) {
    return { shouldFallback: false, missingTools: [] };
  }

  const missingTools = ['Edit', 'Write'].filter(
    toolName => !hasCopilotPermissionApproval(directory, toolName as 'Edit' | 'Write'),
  );

  return {
    shouldFallback: missingTools.length > 0,
    missingTools,
  };
}

export function getBackgroundBashPermissionFallback(
  directory: string,
  command?: string,
): BackgroundPermissionFallbackResult {
  if (!command || isSafeCommand(command) || isHeredocWithSafeBase(command)) {
    return { shouldFallback: false, missingTools: [] };
  }

  return hasCopilotPermissionApproval(directory, 'Bash', command)
    ? { shouldFallback: false, missingTools: [] }
    : { shouldFallback: true, missingTools: ['Bash'] };
}

/**
 * Check if a command matches safe patterns
 */
export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();

  // SECURITY: Reject ANY command with shell metacharacters
  // These allow command chaining that bypasses safe pattern checks
  if (DANGEROUS_SHELL_CHARS.test(trimmed)) {
    return false;
  }

  return SAFE_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Check if a command is a heredoc command with a safe base command.
 * Issue #608: Heredoc commands contain shell metacharacters (<<, \n, $, etc.)
 * that cause isSafeCommand() to reject them. When they fall through to Copilot
 * Code's native permission flow and the user approves "Always allow", the entire
 * heredoc body (potentially hundreds of lines) gets stored in settings.local.json.
 *
 * This function detects heredoc commands and checks whether the base command
 * (first line) matches known-safe patterns, allowing auto-approval without
 * polluting settings.local.json.
 */
export function isHeredocWithSafeBase(command: string): boolean {
  const trimmed = command.trim();

  // Heredoc commands from Copilot CLI are always multi-line
  if (!trimmed.includes('\n')) {
    return false;
  }

  // Must contain a heredoc operator
  if (!HEREDOC_PATTERN.test(trimmed)) {
    return false;
  }

  // Extract the first line as the base command
  const firstLine = trimmed.split('\n')[0].trim();

  // Check if the first line starts with a safe pattern
  return SAFE_HEREDOC_PATTERNS.some(pattern => pattern.test(firstLine));
}

function tokenizeShellCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    return null;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function isRipgrepReadOnly(tokens: string[]): boolean {
  if (tokens[0] !== 'rg') return false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (SAFE_RIPGREP_FLAGS.has(t)) continue;
      if (t.startsWith('--type=') || t.startsWith('--glob=') || t.startsWith('-g')) continue;
      if (t === '--type' || t === '--glob' || t === '-g' || t === '-t') { i++; continue; }
      return false;
    }
  }
  return true;
}

function isInsideGitWorktree(cwd: string): boolean {
  try {
    return !!getWorktreeRoot(cwd);
  } catch {
    return false;
  }
}

export function isSafeRepoInspectionCommand(command: string, cwd: string): boolean {
  if (!isInsideGitWorktree(cwd)) return false;
  const tokens = tokenizeShellCommand(command);
  if (!tokens || tokens.length === 0) return false;
  if (isRipgrepReadOnly(tokens)) return true;
  if (/^cat( |$)/.test(command) || /^head( |$)/.test(command) || /^tail( |$)/.test(command)) return true;
  return false;
}

export function isSafeTargetedLocalTestCommand(command: string, cwd: string): boolean {
  if (!isInsideGitWorktree(cwd)) return false;
  const tokens = tokenizeShellCommand(command);
  if (!tokens || tokens.length < 2) return false;
  const bin = tokens[0];
  if (bin === 'npx' && tokens[1] === 'vitest' && tokens.includes('run') && tokens.some(t => t.endsWith('.test.ts') || t.endsWith('.test.js'))) return true;
  if (bin === 'pytest' && tokens.some(t => t.endsWith('.py') || t.includes('::') || t.startsWith('tests/'))) return true;
  if (bin === 'go' && tokens[1] === 'test' && tokens.some(t => t.startsWith('./') || t.includes('...'))) return true;
  return false;
}

export function isSafeAutoApprovedCommand(command: string, cwd: string): boolean {
  return isSafeCommand(command)
    || isSafeRepoInspectionCommand(command, cwd)
    || isSafeTargetedLocalTestCommand(command, cwd)
    || isHeredocWithSafeBase(command);
}

/**
 * Check if an active mode (autopilot/ultrawork/ralph/team) is running
 */
export function isActiveModeRunning(directory: string): boolean {
  const stateDir = path.join(getOmcRoot(directory), 'state');

  if (!fs.existsSync(stateDir)) {
    return false;
  }

  const activeStateFiles = [
    'autopilot-state.json',
    'ralph-state.json',
    'ultrawork-state.json',
    'team-state.json',
    'omc-teams-state.json',
  ];

  for (const stateFile of activeStateFiles) {
    const statePath = path.join(stateDir, stateFile);
    if (fs.existsSync(statePath)) {
      // JSON state files: check active/status fields
      try {
        const content = fs.readFileSync(statePath, 'utf-8');
        const state = JSON.parse(content);

        // Check if mode is active
        if (state.active === true || state.status === 'running' || state.status === 'active') {
          return true;
        }
      } catch (_error) {
        // Ignore parse errors, continue checking
        continue;
      }
    }
  }

  return false;
}

/**
 * Build a permission decision result with tracking and audit logging.
 */
function makeDecision(
  behavior: 'allow' | 'deny' | 'ask',
  reason: string,
  toolName: string,
  command: string | undefined,
  directory: string,
): HookOutput {
  trackDecision(behavior);
  logPermissionDecision(toolName, command, behavior, reason, directory);

  if (behavior === 'allow' || behavior === 'deny') {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior, reason },
      },
    };
  }

  // 'ask' — pass through to Copilot CLI's native prompt
  return { continue: true };
}

/**
 * Process permission request and decide whether to auto-allow.
 *
 * Decision flow:
 * 1. Escalation check — if too many denials, stop and escalate
 * 2. MCP tool annotations — readOnlyHint tools auto-approved
 * 3. Bash safe patterns — known-safe CLI commands auto-approved
 * 4. Bash heredoc — safe base commands with heredoc content auto-approved
 * 5. Default — pass through to Copilot CLI's native permission prompt
 */
export function processPermissionRequest(input: PermissionRequestInput): HookOutput {
  const toolName = input.tool_name.replace(/^proxy_/, '');
  const command = input.tool_input.command;
  const directory = input.cwd;

  // Escalation: if consecutive or total denials exceeded, deny-and-escalate
  if (shouldEscalate()) {
    return makeDecision(
      'deny',
      `Escalation: ${sessionDenyTracker.consecutiveDenials} consecutive or ${sessionDenyTracker.totalDenials} total denials — stopping to prevent unsafe retry loops`,
      toolName,
      command,
      directory,
    );
  }

  // MCP tool annotation check — auto-approve read-only plugin tools
  if (toolName.startsWith('mcp__t__')) {
    const annotations = input.tool_input._annotations as ToolAnnotations | undefined;
    if (isAnnotationSafe(annotations)) {
      return makeDecision('allow', 'Read-only MCP tool (annotation)', toolName, command, directory);
    }
  }

  // Only process Bash commands beyond this point
  if (toolName !== 'Bash') {
    return makeDecision('ask', 'Non-Bash tool — defer to Copilot CLI', toolName, command, directory);
  }

  if (!command || typeof command !== 'string') {
    return { continue: true };
  }

  // Auto-allow safe commands
  if (isSafeCommand(command)) {
    return makeDecision('allow', 'Safe read-only or test command', toolName, command, directory);
  }

  // Auto-allow heredoc commands with safe base commands (Issue #608)
  if (isHeredocWithSafeBase(command)) {
    return makeDecision('allow', 'Safe command with heredoc content', toolName, command, directory);
  }

  // Default: let normal permission flow handle it
  return makeDecision('ask', 'No safe pattern match — defer to Copilot CLI prompt', toolName, command, directory);
}

/** Get current deny tracker state (for diagnostics/omc-doctor) */
export function getPermissionDenyStats(): Readonly<DenyTracker> {
  return { ...sessionDenyTracker };
}

/** Reset deny tracker (e.g., after user explicitly approves) */
export function resetDenyTracker(): void {
  sessionDenyTracker.consecutiveDenials = 0;
  sessionDenyTracker.totalDenials = 0;
  sessionDenyTracker.totalAllows = 0;
  sessionDenyTracker.lastDecision = null;
}

/**
 * Main hook entry point
 */
export async function handlePermissionRequest(input: PermissionRequestInput): Promise<HookOutput> {
  return processPermissionRequest(input);
}
