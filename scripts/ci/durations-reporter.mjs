/**
 * Vitest reporter that writes each test file's cost to the file named by
 * `--outputFile.durations=<path>`: repo-relative path to whole ms of import
 * (collect plus setup files) and test time, the share of a worker the file
 * occupies. CI's Test job runs it over the merged shard reports; feed its
 * output to scripts/ci/update-test-durations.mjs. Without the option it
 * writes nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export default class DurationsReporter {
  durations = {};

  onInit(ctx) {
    this.ctx = ctx;
  }

  // Per module, not from onTestRunEnd's list: a merged blob from another
  // machine keeps its runner's absolute paths, which that list drops.
  onTestModuleEnd(module) {
    const { collectDuration, setupDuration, duration } = module.diagnostic();
    this.durations[module.relativeModuleId.replace(/\\/g, '/')] = Math.round(collectDuration + setupDuration + duration);
  }

  onTestRunEnd() {
    const { outputFile, root } = this.ctx.config;
    const out = typeof outputFile === 'object' ? outputFile?.durations : undefined;
    if (!out) return;
    const target = resolve(root, out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(this.durations, null, 2)}\n`);
  }
}
