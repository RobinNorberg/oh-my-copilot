#!/usr/bin/env node
/**
 * Oh-My-Copilot CLI
 *
 * Command-line interface for the OMC multi-agent system.
 *
 * Commands:
 * - run: Start an interactive session
 * - config: Show or edit configuration
 * - setup: Sync all OMC components (hooks, agents, skills)
 */
import { Command } from 'commander';
/**
 * Returns the fully-configured commander program.
 *
 * Exported so tests can drive the real CLI pipeline (e.g.
 * `await buildProgram().parseAsync(['node','omc','setup','--plugin-dir-mode'], { from: 'user' })`)
 * without spawning a subprocess. The program is built once at module load
 * (commander does not support re-registration), so this just returns the
 * singleton.
 */
export declare function buildProgram(): Command;
//# sourceMappingURL=index.d.ts.map