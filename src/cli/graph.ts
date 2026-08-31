/**
 * Graph command - Execute sealed graph descriptors via graph runtime v2.
 *
 * Thin CLI adapter only: descriptor load/seal/resume-identity checks live
 * here; all execution logic lives in src/graph/runtime/.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  parseSealedGraphDescriptor,
  sealGraphDescriptor,
} from '../graph/descriptor.js';
import type { SealedGraphDescriptor } from '../graph/types.js';
import {
  EXIT_CODES,
  FenceError,
  JournalCorruptionError,
} from '../graph/runtime/types.js';
import type { RunOptions, RunResult } from '../graph/runtime/types.js';
import { AgentNodeExecutor } from '../graph/runtime/executors/agent.js';
import { CommandNodeExecutor } from '../graph/runtime/executors/command.js';
import { createStdinApprovalGate } from '../graph/runtime/approval.js';
import { createAsciiProgressReporter } from '../graph/runtime/progress.js';
import { resolveRunDirHandle } from '../graph/runtime/run-dir.js';
import type { RunDirHandle } from '../graph/runtime/run-dir.js';
import {
  assertContainedFsSupported,
  readContainedFileNoFollow,
  readFileNoFollow,
} from '../graph/runtime/safe-fs.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * CLI-only exit code for unmapped runtime crashes (contract violations,
 * aborts) so they never collide with FAILED_TERMINAL (1). Not part of the
 * frozen EXIT_CODES surface.
 */
const CRASH_EXIT_CODE = 70;

function fail(message: string, code: number): void {
  console.error(chalk.red(`Error: ${message}`));
  process.exitCode = code;
}

async function loadSealedDescriptor(
  descriptorPath: string,
  runsRoot: string,
): Promise<SealedGraphDescriptor | null> {
  let parsedUser: unknown;
  try {
    parsedUser = JSON.parse(readFileNoFollow(descriptorPath));
  } catch (error) {
    fail(`cannot read descriptor file "${descriptorPath}": ${errorMessage(error)}`, 1);
    return null;
  }

  let fresh: SealedGraphDescriptor;
  try {
    fresh = sealGraphDescriptor(parsedUser);
  } catch (error) {
    fail(`invalid graph descriptor "${descriptorPath}": ${errorMessage(error)}`, 1);
    return null;
  }

  // Contained run dir (P1-3): the resume probe must not follow a symlinked or
  // traversal-shaped run directory outside the runs root.
  let storedPath: string;
  let runDirHandle: RunDirHandle;
  try {
    runDirHandle = resolveRunDirHandle(runsRoot, fresh.run_id);
    storedPath = join(runDirHandle.path, 'descriptor.json');
  } catch (error) {
    fail(`invalid run directory for run "${fresh.run_id}": ${errorMessage(error)}`, 1);
    return null;
  }
  if (!existsSync(storedPath)) {
    return fresh;
  }

  let stored: SealedGraphDescriptor;
  try {
    stored = parseSealedGraphDescriptor(
      JSON.parse(
        readContainedFileNoFollow(
          runDirHandle,
          'descriptor.json',
        ),
      ),
    );
  } catch (error) {
    fail(`stored descriptor "${storedPath}" is not a valid sealed descriptor: ${errorMessage(error)}`, 1);
    return null;
  }

  // Resume identity: the stored sealed revision must be exactly the one the
  // user asked to run, otherwise resuming would mix revisions (fail closed).
  if (canonicalJson(stored) !== canonicalJson(fresh)) {
    fail(
      `descriptor mismatch for run "${fresh.run_id}": ${storedPath} belongs to a different revision than "${descriptorPath}"`,
      EXIT_CODES.DESCRIPTOR_MISMATCH,
    );
    return null;
  }
  return stored;
}

async function runAction(descriptorPath: string, runsRoot: string): Promise<void> {
  try {
    // Reject unsupported POSIX before descriptor/run-directory resolution so
    // the fail-closed contract cannot create persistence state as a side
    // effect of a CLI preflight.
    assertContainedFsSupported(process.platform);
  } catch (error) {
    fail(`graph runtime is unavailable on ${process.platform}: ${errorMessage(error)}`, 1);
    return;
  }
  const sealed = await loadSealedDescriptor(descriptorPath, runsRoot);
  if (sealed === null) return;

  // runGraph is imported lazily so `omg graph --help` does not load the whole
  // runtime, and so this adapter stays decoupled from runtime module order.
  const [{ runGraph }] = await Promise.all([import('../graph/runtime/runner.js')]);

  const options: RunOptions = {
    runsRoot,
    executors: [new CommandNodeExecutor(), new AgentNodeExecutor()],
    prompter: createStdinApprovalGate(),
    reporter: createAsciiProgressReporter(),
  };

  try {
    const result: RunResult = await runGraph(sealed, options);
    process.exitCode = result.exit_code;
  } catch (error) {
    // Normative exit codes for failures the runner surfaces as thrown errors.
    if (error instanceof JournalCorruptionError) {
      fail(errorMessage(error), EXIT_CODES.CORRUPT_JOURNAL);
      return;
    }
    if (error instanceof FenceError) {
      fail(errorMessage(error), EXIT_CODES.FENCED_OUT);
      return;
    }
    fail(`[crash] ${errorMessage(error)}`, CRASH_EXIT_CODE);
  }
}

/**
 * Returns the `graph` command:
 *
 *   omg graph run <descriptorPath> [--runs-root <dir>]
 */
export function graphCommand(): Command {
  const command = new Command('graph');
  command.description('Execute sealed graph descriptors (graph runtime v2)');

  command
    .command('run <descriptorPath>')
    .description('Run a graph descriptor with kill/resume support')
    .option('--runs-root <dir>', 'Directory holding per-run state', '.omg/graph-runs')
    .addHelpText(
      'after',
      `
Examples:
  $ omg graph run ./my-graph.json
  $ omg graph run ./my-graph.json --runs-root .omg/graph-runs

Exit codes:
  0   run succeeded
  1   failed terminal
  19  fenced out by another owner
  20  corrupt journal
  21  descriptor mismatch on resume
  70  runtime crash (unmapped error)`,
    )
    .action(async (descriptorPath: string, options: { runsRoot: string }) => {
      await runAction(descriptorPath, options.runsRoot);
    });

  return command;
}
