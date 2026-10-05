import chalk from 'chalk';
import { isTmuxAvailable } from './tmux-utils.js';
/**
 * Warn if running on native Windows (win32) without tmux available.
 * Called at CLI startup from src/cli/index.ts.
 * If a tmux-compatible binary (e.g. psmux) is on PATH, the warning is skipped.
 *
 * Always written via console.warn (stderr), never stdout, so `--json`
 * consumers that only read stdout get a pure JSON document. The warning is
 * additionally suppressed outright whenever `--json` appears anywhere in
 * argv, so naive callers that merge both streams (e.g. `2>&1`, or a shell
 * wrapper that captures combined output) still see nothing but the report.
 */
export function warnIfWin32(argv = process.argv) {
    if (argv.includes('--json'))
        return;
    if (process.platform === 'win32' && !isTmuxAvailable()) {
        console.warn(chalk.yellow.bold('\n⚠  WARNING: Native Windows (win32) detected — no tmux found'));
        console.warn(chalk.yellow('   OMC features that require tmux will not work.'));
        console.warn(chalk.yellow('   Install psmux for native Windows tmux support: winget install psmux'));
        console.warn(chalk.yellow('   Or use WSL2: https://learn.microsoft.com/en-us/windows/wsl/install'));
        console.warn('');
    }
}
//# sourceMappingURL=win32-warning.js.map