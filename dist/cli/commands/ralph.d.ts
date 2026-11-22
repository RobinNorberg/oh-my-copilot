/**
 * `omg ralph afk "<task>" [--verify "<command>"]...` — launch a headless,
 * narrowly-permissioned ralph session and return to the prompt.
 *
 * Reuses the factory chain's AFK link profile (scoped allowlist +
 * project,local settings) and its argv builder, so a ralph run spawned here
 * obeys the same default isolation contract as a chain link: user-level hooks
 * and settings are excluded unless OMC_AFK_INCLUDE_USER_SETTINGS=1 is set, no
 * general Bash is allowed, and only the gh/file/WebFetch surface, the
 * read-only git commands ralph's own stale-state detection needs, and exactly
 * the declared `--verify` commands are available.
 *
 * Two consequences of the default isolation shape the launch:
 * - A session with `--setting-sources project,local` cannot see
 *   plugin-bundled skills, so a `/oh-my-copilot:ralph` prompt degrades
 *   into a plain one-shot request. The ralph skill is materialized as a
 *   PROJECT skill before launch (the chain-ring contract) and invoked as
 *   `/ralph`.
 * - The mandatory deslop pass (Step 7.5) invokes the plugin-bundled
 *   `ai-slop-cleaner` skill, which such a session equally cannot see — the
 *   pass could never complete and the loop would stall. The launch
 *   therefore injects `--no-deslop`; HITL ralph runs keep the pass.
 *
 * On a Copilot host the launch spawns `copilot` with the Copilot translation
 * of the AFK profile (`--allow-tool` / `--allow-url` rules, see
 * COPILOT_AFK_SPAWN_FLAGS) and materializes the skill under `.copilot/skills`.
 */
import type { Command } from 'commander';
import { type CommandBaseline } from '../../hooks/ralph/feedback-baseline.js';
/**
 * The session's own feedback gate must be runnable inside the session: the
 * loop's continuation context (getRalphContext), the startup notice, and the
 * skill's NON-NEGOTIABLE precondition block all call `omg ralph verify` and
 * nothing else. Prefix-matched so `--write-baseline` / `--session <id>` /
 * `--json` all pass.
 *
 * Deliberately no OMC MCP entries: a live probe of an isolated session
 * (`--setting-sources project,local`) showed the bridge MCP server does not
 * register there at all — trace_summary / state_write / state_read simply do
 * not exist, so allowlist entries for them would be cargo-cult. Consequence,
 * documented in the skill's budget rule: the token-budget stop is
 * attended-only; headless cost control is task sizing.
 */
export declare const RALPH_AFK_SESSION_COMMANDS: string[];
/** Copilot `--allow-tool` form of RALPH_AFK_SESSION_COMMANDS (shell rules are prefix-matched). */
export declare const COPILOT_RALPH_AFK_SESSION_FLAGS: string[];
/**
 * Env var carrying the launcher's declared --verify list (JSON array) into the
 * headless session. When present, `omg ralph verify` runs exactly these
 * commands and ignores the PRD's feedbackCommands and package.json detection:
 * the session can edit both with its file tools, so trusting them would turn
 * the always-granted `omg ralph verify` entry into an arbitrary-shell escape
 * from the allowlist.
 */
export declare const RALPH_AFK_FEEDBACK_ENV = "OMC_RALPH_AFK_FEEDBACK";
/** The declared --verify commands that pass the same boundary check as the allowlist. */
export declare function afkFeedbackCommands(verifyCommands: readonly string[]): string[];
/** Args (command excluded) for one headless AFK ralph launch. */
export declare function ralphAfkArgv(task: string, verifyCommands?: readonly string[], sessionId?: string): string[];
export type SkillMaterialization = {
    status: 'created';
    path: string;
} | {
    status: 'present' | 'diverged';
    path: string;
};
/**
 * Materialize the bundled ralph skill into the project's skill scope so the
 * isolated session can load it. An existing project copy is never clobbered:
 * identical content is a no-op, diverged content is reported so a stale copy
 * from an older OMC install cannot silently persist across upgrades.
 */
export declare function materializeRalphSkill(directory: string): SkillMaterialization | null;
export declare function ralphCommand(program: Command): Command;
/**
 * Feedback commands for judgment. Inside an `omg ralph afk` session only the
 * launcher-declared list counts; otherwise the PRD's declared list, else
 * package-script detection. A found but unreadable PRD returns its error
 * instead of falling through to package-script detection.
 */
export declare function resolveFeedbackCommands(directory: string, sessionId?: string): {
    commands: string[];
    prdError?: string;
};
/** Default wall-clock budget for one feedback command (10 minutes). */
export declare const DEFAULT_FEEDBACK_TIMEOUT_MS = 600000;
/**
 * Resolve the per-command budget: `--timeout <seconds>`, then
 * OMC_RALPH_VERIFY_TIMEOUT_SECONDS, then the 10-minute default.
 * Returns null for a value that is not a positive number of milliseconds:
 * `spawnSync` treats a 0 timeout as "no deadline", so a budget that rounds to
 * zero (for example `--timeout 0.0001`) must be rejected, not passed through.
 */
export declare function resolveFeedbackTimeoutMs(raw?: string): number | null;
/**
 * Runs the feedback command under a deadline and, when the deadline passes,
 * kills the whole process tree, not only the shell. `spawnSync`'s own timeout
 * kills just the shell, which leaves a grandchild (a 10-minute `npm test`)
 * holding files, ports and its cwd. The runner inherits stdout/stderr, so the
 * caller's capture and buffer limit apply unchanged; it reports the outcome as
 * JSON on fd 3. The tree kill mirrors killProcessTree (platform/process-utils):
 * `taskkill /F /T` by absolute path on Windows, a process-group SIGKILL on
 * POSIX (the shell runs detached, so it leads its own group). Detaching leaves
 * the terminal's foreground group, so the runner forwards SIGINT/SIGTERM/SIGHUP
 * to that group (then SIGKILL after 2 s) before exiting. It also drops the
 * controlling tty, so a command that opens /dev/tty gets ENXIO. Known leaks:
 * on Windows, when the outer grace timeout fires or taskkill fails, the tree
 * is not killed (there is no process group to signal).
 * The runner itself starts without NODE_OPTIONS (no inherited --require or
 * --inspect output); the original env travels in the payload for the shell.
 */
export declare const FEEDBACK_RUNNER = "\nconst { spawn, execFileSync } = require('child_process');\nconst { writeSync } = require('fs');\nconst [command, timeoutMs, taskkill, env] = JSON.parse(process.argv[1]);\nlet timedOut = false;\nconst report = (outcome) => { try { writeSync(3, JSON.stringify(outcome)); } catch {} };\nconst child = spawn(command, { shell: true, env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, detached: process.platform !== 'win32' });\nif (process.platform !== 'win32') {\n  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) {\n    process.on(s, () => {\n      try { process.kill(-child.pid, s); } catch {}\n      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} process.exit(130); }, 2000);\n    });\n  }\n}\nconst timer = setTimeout(() => {\n  timedOut = true;\n  try {\n    if (process.platform === 'win32') execFileSync(taskkill, ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', timeout: 5000, windowsHide: true });\n    else process.kill(-child.pid, 'SIGKILL');\n  } catch {\n    try { child.kill('SIGKILL'); } catch {}\n  }\n}, timeoutMs);\nchild.on('error', (error) => { clearTimeout(timer); report({ error: error.code || 'unknown', spawned: Boolean(child.pid) }); process.exit(1); });\nchild.on('exit', (status, signal) => { clearTimeout(timer); report({ status, signal, timedOut }); process.exit(typeof status === 'number' ? status : 1); });\n";
/** Run one feedback command on the current tree and fingerprint its failures. */
export declare function runFeedbackCommand(command: string, directory: string, options?: {
    timeoutMs?: number;
}): CommandBaseline;
/**
 * Closeout state for the session's PRD.
 *
 * Ralph's terminal steps (the Step 7.5 deslop pass and the Step 8 closeout)
 * are prose in the skill; nothing failed when an agent skipped them. Once
 * every story is complete the gate therefore requires a record, bound to the
 * governing criteria revision so a later amendment invalidates it.
 */
export interface CloseoutGate {
    required: boolean;
    satisfied: boolean;
    criteriaRevision: string | null;
    deslop: string | null;
}
export declare function evaluateCloseoutGate(directory: string, stateRoot: string, sessionId: string): CloseoutGate;
/** The closeout action: write a revision-bound record, or check the existing one. */
export declare function ralphCloseout(options: {
    deslop?: string;
    check?: boolean;
    json?: boolean;
    session?: string;
}, directory?: string, now?: Date): number;
/** The verify action, extracted so tests can drive it directly. Exit code is the contract. */
export declare function ralphVerify(options: {
    json?: boolean;
    session?: string;
    writeBaseline?: boolean;
    timeoutMs?: number;
}, directory?: string, now?: Date): number;
//# sourceMappingURL=ralph.d.ts.map