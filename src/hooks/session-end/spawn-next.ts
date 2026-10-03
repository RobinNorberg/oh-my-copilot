import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn, type SpawnOptions } from 'child_process';
import { decideNextStage, VERIFY_COMMAND_PATTERN, MAX_VERIFY_COMMAND_LENGTH, MAX_VERIFY_COMMANDS, type ChainOutcome, type RouteTable } from './routing.js';
import { getOmcRoot, validateSessionId } from '../../lib/worktree-paths.js';
import { buildHostBinarySpawn } from '../../cli/tmux-utils.js';
import { getHostCliBinary, getHostCliType } from '../../utils/host-detection.js';

export interface SpawnNextTracker {
  repo: string;
  issue: number;
  nextLabel: string;
  failedLabel: string;
}

/** How a finished session hands the chain to the next stage. Supplied by the enqueuer in the action payload under `chain`. */
export interface SpawnNextChain {
  outcome: ChainOutcome;
  reason: string;
  routeTable: RouteTable;
  sessionId: string;
  /** Ledger identity carried through so the next link's ledger keeps it. */
  intentId?: string;
  handoffContext?: string;
  tracker?: SpawnNextTracker;
  /** Per-stage link counts carried forward so the enqueuer can cap route loops. */
  visits?: Record<string, number>;
}

export interface SpawnNextPlan {
  directive: { stage: string; skill: string };
  handoffPath: string;
  spawnArgv: string[];
  /** Pre-generated id of the next link, passed via --session-id so its SessionEnd finds the ledger. */
  nextSessionId: string;
  trackerCommands: string[][];
}

export type SpawnFn = (command: string, args: string[], ctx?: SpawnContext) => { unref(): void };

/** Factory links spawn headless (AFK): their cwd must match the ledger's state root and their permission profile must be narrow. */
export interface SpawnContext {
  cwd?: string;
}

/**
 * AFK allowlist for factory-spawned sessions: gh read/comment, file read/write,
 * and github.com-only WebFetch. Everything else is denied in -p mode and must
 * fall back to HITL (the session's issue-comment contract), never silent failure.
 */
export const AFK_ALLOWED_TOOLS = [
  'Bash(gh issue view:*)',
  'Bash(gh issue comment:*)',
  'Bash(gh issue edit:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr list:*)',
  'Bash(gh label list:*)',
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'WebFetch(domain:github.com)',
].join(',');

export const AFK_SPAWN_FLAGS = [
  '--permission-mode', 'acceptEdits',
  '--allowedTools', AFK_ALLOWED_TOOLS,
  // Isolation: AFK links run with project+local settings only — user-level
  // hooks/settings must never fire in a headless chain link.
  '--setting-sources', 'project,local',
];

/**
 * Copilot CLI translation of AFK_SPAWN_FLAGS: the same gh/file-write/
 * github.com-WebFetch surface as `--allow-tool` / `--allow-url` rules
 * (Copilot's reads need no rule), with `--no-ask-user` so a headless link never
 * blocks on a question. Copilot has no `--setting-sources` equivalent, so the
 * user-level settings isolation of a Claude link does not carry over.
 */
export const COPILOT_AFK_SPAWN_FLAGS = [
  '--no-ask-user',
  '--allow-tool=shell(gh issue view)',
  '--allow-tool=shell(gh issue comment)',
  '--allow-tool=shell(gh issue edit)',
  '--allow-tool=shell(gh pr view)',
  '--allow-tool=shell(gh pr list)',
  '--allow-tool=shell(gh label list)',
  '--allow-tool=write',
  '--allow-url=github.com',
  // Deny beats allow (even --allow-all-tools). A relative write(path) matches
  // by trailing path components, so these cover the names in any directory:
  // no git plumbing edits, and no package.json rewrite that would turn an
  // allowed `npm test`/`npm run x` verify rule into arbitrary shell.
  '--deny-tool=write(.git)',
  '--deny-tool=write(package.json)',
  '--deny-tool=shell(git push)',
];

/**
 * Interpreters whose `--allow-tool=shell(<name> -<flag>)` rule would admit
 * inline code (`node -e`, `python -c`, `bash -c`, `pwsh -Command`, ...).
 */
const COPILOT_INTERPRETERS = new Set([
  'node', 'python', 'python3', 'py', 'bash', 'sh', 'zsh', 'npx', 'pnpx', 'bunx', 'bun', 'deno',
  'pwsh', 'powershell', 'cmd', 'ruby', 'perl', 'env', 'uv', 'uvx',
]);

/**
 * Copilot matches a shell rule on the command stem, so a single-token rule
 * (`shell(node)`) admits that program with any arguments. A Copilot verify
 * rule must therefore name a subcommand or script, and an interpreter's second
 * token must not be a flag. `%` is refused on win32 because the rule rides
 * cmd.exe argv when copilot is a .cmd shim.
 */
export function isCopilotVerifyCommandAllowed(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  if (COPILOT_INTERPRETERS.has(tokens[0].toLowerCase()) && tokens[1].startsWith('-')) return false;
  return !(process.platform === 'win32' && command.includes('%'));
}

/** Host CLI binary that runs factory links: `copilot` on a Copilot host, `claude` under Claude Code. */
export function factoryLinkCommand(): string {
  return getHostCliBinary();
}

/**
 * Args (command excluded) for one factory chain link: intent prompt + AFK
 * permission profile. A stage's declared `verify` commands extend the profile
 * with exactly those `Bash(...)` entries — the argv is a trust boundary, so
 * they are re-checked against the routing pattern here rather than trusted from
 * whatever route table produced the directive.
 *
 * On a Copilot host the profile is COPILOT_AFK_SPAWN_FLAGS plus one
 * `--allow-tool=shell(<command>)` per extra command. Copilot cannot pin a
 * session id at launch, so `sessionId` is not passed to it.
 */
export function factoryLinkArgv(
  prompt: string,
  sessionId: string,
  verifyCommands: readonly string[] = [],
  fixedBashCommands: readonly string[] = [],
): string[] {
  const isValid = (command: string) => command.length <= MAX_VERIFY_COMMAND_LENGTH && VERIFY_COMMAND_PATTERN.test(command);
  if (getHostCliType() === 'copilot') {
    const isCopilotValid = (command: string) => isValid(command) && isCopilotVerifyCommandAllowed(command);
    const extra = [
      ...fixedBashCommands.filter(isCopilotValid),
      ...verifyCommands.filter(isCopilotValid).slice(0, MAX_VERIFY_COMMANDS),
    ].map((command) => `--allow-tool=shell(${command})`);
    return ['-p', prompt, ...COPILOT_AFK_SPAWN_FLAGS, ...extra];
  }
  if (verifyCommands.length === 0 && fixedBashCommands.length === 0) {
    return ['-p', prompt, '--session-id', sessionId, ...AFK_SPAWN_FLAGS];
  }
  // fixedBashCommands are caller-owned constants (e.g. ralph's read-only git
  // set); only the user/route-declared verify list counts against the cap.
  const allowedTools = [
    AFK_ALLOWED_TOOLS,
    ...fixedBashCommands.filter(isValid).map((command) => `Bash(${command})`),
    ...verifyCommands
      .filter(isValid)
      .slice(0, MAX_VERIFY_COMMANDS)
      .map((command) => `Bash(${command})`),
  ].join(',');
  const flags = [...AFK_SPAWN_FLAGS];
  flags[flags.indexOf('--allowedTools') + 1] = allowedTools;
  return ['-p', prompt, '--session-id', sessionId, ...flags];
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
/** Shared label charset (stage/skill/labels): safe for paths and argv. */
export const LABEL_PATTERN = /^[\w.-]+$/;

/**
 * The chain rides a detached manifest job: every field that lands in a
 * spawned argv or a filesystem path is validated here. An invalid chain is a
 * hard reject (manifest failure), not a partial spawn.
 */
export function validateChainFields(chain: SpawnNextChain): void {
  validateSessionId(chain.sessionId);
  const tracker = chain.tracker;
  if (tracker) {
    if (!REPO_PATTERN.test(tracker.repo)) throw new Error(`invalid tracker repo: ${tracker.repo}`);
    if (!LABEL_PATTERN.test(tracker.nextLabel) || !LABEL_PATTERN.test(tracker.failedLabel)) {
      throw new Error(`invalid tracker label: ${tracker.nextLabel}/${tracker.failedLabel}`);
    }
  }
  if (chain.visits) {
    for (const [stage, count] of Object.entries(chain.visits)) {
      if (!LABEL_PATTERN.test(stage) || !Number.isInteger(count) || count < 0 || count > 99) {
        throw new Error(`invalid visits entry: ${stage}=${count}`);
      }
    }
  }
}

export function spawnNextAlertComment(chain: SpawnNextChain): string {
  return `链已停住：会话结束状态 ${chain.outcome}:${chain.reason} 触发下一环启动失败，需人工修复（v1 无自动重试）。`;
}

export function planSpawnNext(chain: SpawnNextChain, omcRoot: string): SpawnNextPlan | null {
  validateChainFields(chain);
  const directive = decideNextStage(chain.outcome, chain.reason, chain.routeTable);
  if (!directive) return null;
  const handoffPath = path.join(omcRoot, 'handoffs', `${chain.sessionId}-${directive.stage}.json`);
  const trackerCommands = chain.tracker
    ? [
        ['gh', 'issue', 'edit', String(chain.tracker.issue), '--repo', chain.tracker.repo, '--add-label', chain.tracker.nextLabel],
        ['gh', 'issue', 'comment', String(chain.tracker.issue), '--repo', chain.tracker.repo, '--body', `链已推进到 ${directive.stage}，交接上下文：${path.basename(handoffPath)}`],
      ]
    : [];
  const nextSessionId = randomUUID();
  return {
    directive,
    handoffPath,
    spawnArgv: [factoryLinkCommand(), ...factoryLinkArgv(`/${directive.skill} 继续 ${directive.stage} 环；交接上下文：${path.basename(handoffPath)}`, nextSessionId, directive.verify)],
    nextSessionId,
    trackerCommands,
  };
}

/** IO orchestration only: the routing decision comes from the T1 pure function via planSpawnNext. */
export function executeSpawnNext(chain: SpawnNextChain, directory: string, spawnFn: SpawnFn = defaultSpawnFn): void {
  const omcRoot = getOmcRoot(directory);
  const plan = planSpawnNext(chain, omcRoot);
  if (!plan) return;
  fs.mkdirSync(path.dirname(plan.handoffPath), { recursive: true });
  fs.writeFileSync(plan.handoffPath, JSON.stringify({
    sessionId: chain.sessionId,
    from: { outcome: chain.outcome, reason: chain.reason },
    next: plan.directive,
    context: chain.handoffContext ?? '',
  }, null, 2), 'utf8');
  const factoryDir = path.join(omcRoot, 'state', 'factory');
  const ledgerPath = path.join(factoryDir, `chain-${plan.nextSessionId}.json`);
  try {
    // The next link's ledger must exist before it ends its session, so the
    // SessionEnd enqueuer finds it; written under the same failure alerts.
    fs.mkdirSync(factoryDir, { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify({
      intentId: chain.intentId ?? `chain-${chain.sessionId}`,
      stage: plan.directive.stage,
      routeTable: chain.routeTable,
      tracker: chain.tracker,
      visits: { ...(chain.visits ?? {}), [plan.directive.stage]: (chain.visits?.[plan.directive.stage] ?? 0) + 1 },
    }, null, 2), 'utf8');
    spawnFn(plan.spawnArgv[0], plan.spawnArgv.slice(1), { cwd: directory });
  } catch (error) {
    // Don't leave a dead ledger pointing at a session that never started.
    try { fs.unlinkSync(ledgerPath); } catch { /* never written */ }
    if (chain.tracker) {
      spawnFn('gh', ['issue', 'comment', String(chain.tracker.issue), '--repo', chain.tracker.repo, '--body', spawnNextAlertComment(chain)]);
      spawnFn('gh', ['issue', 'edit', String(chain.tracker.issue), '--repo', chain.tracker.repo, '--add-label', chain.tracker.failedLabel]);
    }
    throw error;
  }
  for (const argv of plan.trackerCommands) {
    spawnFn(argv[0], argv.slice(1));
  }
}



/**
 * `claude`, `copilot` and `gh` may be .cmd shims on Windows, which
 * CreateProcess cannot exec directly; those route through cmd.exe, native
 * .exe installs spawn directly. The -p prompt and the gh --body go through
 * stdin on Windows: cmd.exe's ANSI codepage mangles non-ASCII argv (dogfood:
 * Chinese intent prompts and issue bodies mojibake'd), while the stdin pipe
 * stays UTF-8 end to end. It also keeps free text away from cmd.exe, whose
 * quote parity disagrees with CRT argv parsing (`\"` splits argv) and which
 * expands %VAR% inside quotes. The remaining fixed argv is quoted by
 * quoteForCmd (CRT-correct, rejects `%` and CR/LF).
 *
 * The .cmd-shim constraint is a Windows PLATFORM fact, not a shell fact: gate
 * on process.platform, never on shell detection. Gating on the shell made
 * Git Bash (MSYSTEM set) skip the cmd.exe route and spawn the .cmd shim
 * directly, which CreateProcess cannot exec — the child died instantly and
 * silently (stdio ignored), so `omg ralph afk` under Git Bash launched
 * nothing. Factory chain links escaped this only by accident: the detached
 * worker's env is an allowlist that drops MSYSTEM. The long-running factory
 * listener (src/factory/listener.ts), which spawns links from its own
 * inherited environment, had the same broken route under Git Bash.
 *
 * detached:true is win32-hostile here (dogfood bisect: cmd.exe children
 * spawned detached exit 1 before writing a transcript), so it is only
 * applied off-win32. Orphaning still holds: Windows children survive
 * parent exit without the detached flag.
 */
export function defaultSpawnFn(command: string, args: string[], ctx?: SpawnContext): { unref(): void } {
  const baseOpts: SpawnOptions =
    process.platform === 'win32'
      ? { windowsHide: true, cwd: ctx?.cwd }
      : { detached: true, windowsHide: true, cwd: ctx?.cwd };
  // A launcher-level COPILOT_ALLOW_ALL would override the AFK allowlist of
  // every copilot link, so the child always gets the documented off value.
  if (command === 'copilot') baseOpts.env = { ...process.env, COPILOT_ALLOW_ALL: 'false' };
  if (process.platform === 'win32' && (command === 'claude' || command === 'copilot' || command === 'gh')) {
    // Free text never rides argv: the -p prompt goes to stdin (claude keeps
    // `-p`; copilot reads a piped prompt without it, verified on 1.0.91) and a
    // gh --body becomes `--body-file -`. A native .exe is then spawned
    // directly; only a .cmd shim goes through cmd.exe (buildHostBinarySpawn).
    let argv = args;
    let stdinText: string | undefined;
    if (command === 'gh') {
      const bodyIdx = args.indexOf('--body');
      if (bodyIdx !== -1 && bodyIdx + 1 < args.length) {
        stdinText = args[bodyIdx + 1];
        argv = [...args.slice(0, bodyIdx), '--body-file', '-', ...args.slice(bodyIdx + 2)];
      }
    } else {
      const pIdx = args.indexOf('-p');
      const inlinePrompt = pIdx !== -1 && pIdx + 1 < args.length ? args[pIdx + 1] : undefined;
      if (inlinePrompt !== undefined && !inlinePrompt.startsWith('--')) {
        stdinText = inlinePrompt;
        argv = [...args.slice(0, command === 'claude' ? pIdx + 1 : pIdx), ...args.slice(pIdx + 2)];
      }
    }
    const launch = buildHostBinarySpawn(command, argv, 'cmd.exe');
    const child = spawn(launch.command, launch.args, {
      ...baseOpts,
      stdio: stdinText === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore'],
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    if (stdinText !== undefined) {
      child.stdin?.write(stdinText, 'utf8');
      child.stdin?.end();
    }
    child.unref();
    return child;
  }
  const child = spawn(command, args, { ...baseOpts, stdio: 'ignore' });
  child.unref();
  return child;
}
