/**
 * The sandboxed step before a dotnet gate (engine.ts ensureLocalGate): run as
 * `node <omg>/dist/factory/run/dotnet-clean-step.js <n> <tree>... [kept path...]`
 * through the gate's OS sandbox runner, with the prepare checkout as cwd and
 * no network. `<n>` package trees (the node_modules dirs the engine links or
 * copies there, never entered), then the tracked repository paths under a
 * build dir (they stay); parseCleanStepArgs. Prints one `removed <n>` line,
 * then one line per error, and exits 1 when anything could not be removed.
 * See dotnet-clean.ts.
 */
import { cleanDotnetBuildOutput, parseCleanStepArgs } from './dotnet-clean.js';

const { trees, keep } = parseCleanStepArgs(process.argv.slice(2));
const r = cleanDotnetBuildOutput(process.cwd(), keep, process.platform, trees);
process.stdout.write(`removed ${r.removed}\n${r.errors.map((e) => `error ${e}\n`).join('')}`);
process.exitCode = r.errors.length > 0 ? 1 : 0;
