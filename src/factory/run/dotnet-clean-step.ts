/**
 * The sandboxed step before a dotnet gate (engine.ts ensureLocalGate): run as
 * `node <omg>/dist/factory/run/dotnet-clean-step.js [kept path...]` through
 * the gate's OS sandbox runner, with the prepare checkout as cwd and no
 * network. The arguments are the tracked repository paths under a build dir
 * (they stay). Prints one `removed <n>` line, then one line per error, and
 * exits 1 when anything could not be removed. See dotnet-clean.ts.
 */
import { cleanDotnetBuildOutput } from './dotnet-clean.js';

const r = cleanDotnetBuildOutput(process.cwd(), process.argv.slice(2));
process.stdout.write(`removed ${r.removed}\n${r.errors.map((e) => `error ${e}\n`).join('')}`);
process.exitCode = r.errors.length > 0 ? 1 : 0;
