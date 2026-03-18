/**
 * Native tmux shell launch for omg
 * Launches Copilot CLI with tmux session management
 */
import { execFileSync } from 'child_process';
import { resolveLaunchPolicy, buildTmuxSessionName, buildTmuxShellCommand, wrapWithLoginShell, isCopilotAvailable, } from './tmux-utils.js';
// Flag mapping
const MADMAX_FLAG = '--madmax';
const YOLO_FLAG = '--yolo';
const COPILOT_BYPASS_FLAG = '--dangerously-skip-permissions';
const NOTIFY_FLAG = '--notify';
const TELEGRAM_FLAG = '--telegram';
const DISCORD_FLAG = '--discord';
const SLACK_FLAG = '--slack';
const WEBHOOK_FLAG = '--webhook';
const TEAMS_FLAG = '--teams';
/**
 * Extract the OMC-specific --notify flag from launch args.
 * --notify false  → disable notifications (OMC_NOTIFY=0)
 * --notify true   → enable notifications (default)
 * This flag must be stripped before passing args to Copilot CLI.
 */
export function extractNotifyFlag(args) {
    let notifyEnabled = true;
    const remainingArgs = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === NOTIFY_FLAG) {
            const next = args[i + 1];
            if (next !== undefined) {
                const lowered = next.toLowerCase();
                if (lowered === 'true' || lowered === 'false' || lowered === '1' || lowered === '0') {
                    notifyEnabled = lowered !== 'false' && lowered !== '0';
                    i++; // skip explicit value token
                }
            }
        }
        else if (arg.startsWith(`${NOTIFY_FLAG}=`)) {
            const val = arg.slice(NOTIFY_FLAG.length + 1).toLowerCase();
            notifyEnabled = val !== 'false' && val !== '0';
        }
        else {
            remainingArgs.push(arg);
        }
    }
    return { notifyEnabled, remainingArgs };
}
/**
 * Extract the OMC-specific --telegram flag from launch args.
 * Purely presence-based:
 *   --telegram        -> enable Telegram notifications (OMC_TELEGRAM=1)
 *   --telegram=true   -> enable
 *   --telegram=false  -> disable
 *   --telegram=1      -> enable
 *   --telegram=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Copilot CLI.
 */
export function extractTelegramFlag(args) {
    let telegramEnabled = undefined;
    const remainingArgs = [];
    for (const arg of args) {
        if (arg === TELEGRAM_FLAG) {
            telegramEnabled = true;
            continue;
        }
        if (arg.startsWith(`${TELEGRAM_FLAG}=`)) {
            const val = arg.slice(TELEGRAM_FLAG.length + 1).toLowerCase();
            telegramEnabled = val !== 'false' && val !== '0';
            continue;
        }
        remainingArgs.push(arg);
    }
    return { telegramEnabled, remainingArgs };
}
/**
 * Extract the OMC-specific --discord flag from launch args.
 * Purely presence-based:
 *   --discord        -> enable Discord notifications (OMC_DISCORD=1)
 *   --discord=true   -> enable
 *   --discord=false  -> disable
 *   --discord=1      -> enable
 *   --discord=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Copilot CLI.
 */
export function extractDiscordFlag(args) {
    let discordEnabled = undefined;
    const remainingArgs = [];
    for (const arg of args) {
        if (arg === DISCORD_FLAG) {
            discordEnabled = true;
            continue;
        }
        if (arg.startsWith(`${DISCORD_FLAG}=`)) {
            const val = arg.slice(DISCORD_FLAG.length + 1).toLowerCase();
            discordEnabled = val !== 'false' && val !== '0';
            continue;
        }
        remainingArgs.push(arg);
    }
    return { discordEnabled, remainingArgs };
}
/**
 * Extract the OMC-specific --slack flag from launch args.
 * Purely presence-based:
 *   --slack        -> enable Slack notifications (OMC_SLACK=1)
 *   --slack=true   -> enable
 *   --slack=false  -> disable
 *   --slack=1      -> enable
 *   --slack=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Copilot CLI.
 */
export function extractSlackFlag(args) {
    let slackEnabled = undefined;
    const remainingArgs = [];
    for (const arg of args) {
        if (arg === SLACK_FLAG) {
            slackEnabled = true;
            continue;
        }
        if (arg.startsWith(`${SLACK_FLAG}=`)) {
            const val = arg.slice(SLACK_FLAG.length + 1).toLowerCase();
            slackEnabled = val !== 'false' && val !== '0';
            continue;
        }
        remainingArgs.push(arg);
    }
    return { slackEnabled, remainingArgs };
}
/**
 * Extract the OMC-specific --webhook flag from launch args.
 * Purely presence-based:
 *   --webhook        -> enable Webhook notifications (OMC_WEBHOOK=1)
 *   --webhook=true   -> enable
 *   --webhook=false  -> disable
 *   --webhook=1      -> enable
 *   --webhook=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Copilot CLI.
 */
export function extractWebhookFlag(args) {
    let webhookEnabled = undefined;
    const remainingArgs = [];
    for (const arg of args) {
        if (arg === WEBHOOK_FLAG) {
            webhookEnabled = true;
            continue;
        }
        if (arg.startsWith(`${WEBHOOK_FLAG}=`)) {
            const val = arg.slice(WEBHOOK_FLAG.length + 1).toLowerCase();
            webhookEnabled = val !== 'false' && val !== '0';
            continue;
        }
        remainingArgs.push(arg);
    }
    return { webhookEnabled, remainingArgs };
}
/**
 * Extract the OMC-specific --teams flag from launch args.
 * Purely presence-based:
 *   --teams        -> enable Teams notifications (OMC_MICROSOFT_TEAMS=1)
 *   --teams=true   -> enable
 *   --teams=false  -> disable
 *   --teams=1      -> enable
 *   --teams=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Claude CLI.
 */
export function extractTeamsFlag(args) {
    let teamsEnabled = undefined;
    const remainingArgs = [];
    for (const arg of args) {
        if (arg === TEAMS_FLAG) {
            teamsEnabled = true;
            continue;
        }
        if (arg.startsWith(`${TEAMS_FLAG}=`)) {
            const val = arg.slice(TEAMS_FLAG.length + 1).toLowerCase();
            teamsEnabled = val !== 'false' && val !== '0';
            continue;
        }
        remainingArgs.push(arg);
    }
    return { teamsEnabled, remainingArgs };
}
/**
 * Normalize Copilot launch arguments
 * Maps --madmax/--yolo to --dangerously-skip-permissions
 * All other flags pass through unchanged
 */
export function normalizeCopilotLaunchArgs(args) {
    const normalized = [];
    let wantsBypass = false;
    let hasBypass = false;
    for (const arg of args) {
        if (arg === MADMAX_FLAG || arg === YOLO_FLAG) {
            wantsBypass = true;
            continue;
        }
        if (arg === COPILOT_BYPASS_FLAG) {
            wantsBypass = true;
            if (!hasBypass) {
                normalized.push(arg);
                hasBypass = true;
            }
            continue;
        }
        normalized.push(arg);
    }
    if (wantsBypass && !hasBypass) {
        normalized.push(COPILOT_BYPASS_FLAG);
    }
    return normalized;
}
/**
 * preLaunch: Prepare environment before Copilot starts
 * Currently a placeholder - can be extended for:
 * - Session state initialization
 * - Environment setup
 * - Pre-launch checks
 */
export async function preLaunch(_cwd, _sessionId) {
    // Placeholder for future pre-launch logic
    // e.g., session state, environment prep, etc.
}
/**
 * runCopilot: Launch Copilot CLI (blocks until exit)
 * Handles 3 scenarios:
 * 1. inside-tmux: Launch copilot in current pane
 * 2. outside-tmux: Create new tmux session with copilot
 * 3. direct: tmux not available, run copilot directly
 */
export function runCopilot(cwd, args, sessionId) {
    const policy = resolveLaunchPolicy(process.env);
    switch (policy) {
        case 'inside-tmux':
            runCopilotInsideTmux(cwd, args);
            break;
        case 'outside-tmux':
            runCopilotOutsideTmux(cwd, args, sessionId);
            break;
        case 'direct':
            runCopilotDirect(cwd, args);
            break;
    }
}
/**
 * Run Copilot inside existing tmux session
 * Launches Copilot in current pane
 */
function runCopilotInsideTmux(cwd, args) {
    // Enable mouse scrolling in the current tmux session (non-fatal if it fails)
    try {
        execFileSync('tmux', ['set-option', 'mouse', 'on'], { stdio: 'ignore' });
    }
    catch { /* non-fatal — user's tmux may not support these options */ }
    // Launch Copilot in current pane
    try {
        execFileSync('copilot', args, { cwd, stdio: 'inherit' });
    }
    catch (error) {
        const err = error;
        if (err.code === 'ENOENT') {
            console.error('[omg] Error: gh CLI not found in PATH.');
            process.exit(1);
        }
        // Propagate Copilot's exit code so omg does not swallow failures
        process.exit(typeof err.status === 'number' ? err.status : 1);
    }
}
/**
 * Run Copilot outside tmux - create new session
 * Creates tmux session with Copilot
 */
function runCopilotOutsideTmux(cwd, args, _sessionId) {
    const rawCopilotCmd = buildTmuxShellCommand('copilot', args);
    // Drain any pending terminal Device Attributes (DA1) response from stdin.
    // When tmux attach-session sends a DA1 query, the terminal replies with
    // \e[?6c which lands in the pty buffer before Copilot reads input.
    // A short sleep lets the response arrive, then tcflush discards it.
    // Wrap in login shell so .bashrc/.zshrc are sourced (PATH, nvm, etc.)
    const copilotCmd = wrapWithLoginShell(`sleep 0.3; perl -e 'use POSIX;tcflush(0,TCIFLUSH)' 2>/dev/null; ${rawCopilotCmd}`);
    const sessionName = buildTmuxSessionName(cwd);
    const tmuxArgs = [
        'new-session', '-d', '-s', sessionName, '-c', cwd,
        copilotCmd,
        ';', 'set-option', '-t', sessionName, 'mouse', 'on',
    ];
    // Attach to session
    tmuxArgs.push(';', 'attach-session', '-t', sessionName);
    try {
        execFileSync('tmux', tmuxArgs, { stdio: 'inherit' });
    }
    catch {
        // tmux failed, fall back to direct launch
        runCopilotDirect(cwd, args);
    }
}
/**
 * Run Copilot directly (no tmux)
 * Fallback when tmux is not available
 */
function runCopilotDirect(cwd, args) {
    try {
        execFileSync('copilot', args, { cwd, stdio: 'inherit' });
    }
    catch (error) {
        const err = error;
        if (err.code === 'ENOENT') {
            console.error('[omg] Error: gh CLI not found in PATH.');
            process.exit(1);
        }
        // Propagate Copilot's exit code so omg does not swallow failures
        process.exit(typeof err.status === 'number' ? err.status : 1);
    }
}
/**
 * postLaunch: Cleanup after Copilot exits
 * Currently a placeholder - can be extended for:
 * - Session cleanup
 * - State finalization
 * - Post-launch reporting
 */
export async function postLaunch(_cwd, _sessionId) {
    // Placeholder for future post-launch logic
    // e.g., cleanup, finalization, etc.
}
/**
 * Main launch command entry point
 * Orchestrates the 3-phase launch: preLaunch -> run -> postLaunch
 */
export async function launchCommand(args) {
    // Extract OMC-specific --notify flag before passing remaining args to Copilot CLI
    const { notifyEnabled, remainingArgs } = extractNotifyFlag(args);
    if (!notifyEnabled) {
        process.env.OMC_NOTIFY = '0';
    }
    // Extract OMC-specific --telegram flag (presence-based)
    const { telegramEnabled, remainingArgs: argsAfterTelegram } = extractTelegramFlag(remainingArgs);
    if (telegramEnabled === true) {
        process.env.OMC_TELEGRAM = '1';
    }
    else if (telegramEnabled === false) {
        process.env.OMC_TELEGRAM = '0';
    }
    // Extract OMC-specific --discord flag (presence-based)
    const { discordEnabled, remainingArgs: argsAfterDiscord } = extractDiscordFlag(argsAfterTelegram);
    if (discordEnabled === true) {
        process.env.OMC_DISCORD = '1';
    }
    else if (discordEnabled === false) {
        process.env.OMC_DISCORD = '0';
    }
    // Extract OMC-specific --slack flag (presence-based)
    const { slackEnabled, remainingArgs: argsAfterSlack } = extractSlackFlag(argsAfterDiscord);
    if (slackEnabled === true) {
        process.env.OMC_SLACK = '1';
    }
    else if (slackEnabled === false) {
        process.env.OMC_SLACK = '0';
    }
    // Extract OMC-specific --webhook flag (presence-based)
    const { webhookEnabled, remainingArgs: argsAfterWebhook } = extractWebhookFlag(argsAfterSlack);
    if (webhookEnabled === true) {
        process.env.OMC_WEBHOOK = '1';
    }
    else if (webhookEnabled === false) {
        process.env.OMC_WEBHOOK = '0';
    }
    // Extract OMC-specific --teams flag (presence-based)
    const { teamsEnabled, remainingArgs: argsAfterTeams } = extractTeamsFlag(argsAfterWebhook);
    if (teamsEnabled === true) {
        process.env.OMC_MICROSOFT_TEAMS = '1';
    }
    else if (teamsEnabled === false) {
        process.env.OMC_MICROSOFT_TEAMS = '0';
    }
    const cwd = process.cwd();
    // Pre-flight: check for nested session
    if (process.env.COPILOT_CLI) {
        console.error('[omg] Error: Already inside a Copilot CLI session. Nested launches are not supported.');
        process.exit(1);
    }
    // Pre-flight: check copilot CLI availability
    if (!isCopilotAvailable()) {
        console.error('[omg] Error: gh CLI not found. Install Copilot CLI first:');
        console.error('  npm install -g @anthropic-ai/copilot-cli');
        process.exit(1);
    }
    const normalizedArgs = normalizeCopilotLaunchArgs(argsAfterTeams);
    const sessionId = `omc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Phase 1: preLaunch
    try {
        await preLaunch(cwd, sessionId);
    }
    catch (err) {
        // preLaunch errors must NOT prevent Copilot from starting
        console.error(`[omg] preLaunch warning: ${err instanceof Error ? err.message : err}`);
    }
    // Phase 2: run
    try {
        runCopilot(cwd, normalizedArgs, sessionId);
    }
    finally {
        // Phase 3: postLaunch
        await postLaunch(cwd, sessionId);
    }
}
//# sourceMappingURL=launch.js.map