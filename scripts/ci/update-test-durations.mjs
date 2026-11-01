#!/usr/bin/env node
/**
 * Refresh .github/ci/test-durations.json from vitest JSON reports of FULL
 * runs (the `vitest-report` artifact of CI's Test job). Each file's value is
 * the median of its `endTime - startTime` across the given reports, in whole
 * ms; files absent from every report are dropped. Stale data only affects
 * shard balance (scripts/ci/duration-sequencer.mjs), never which tests run.
 *
 * Run: node scripts/ci/update-test-durations.mjs [--root <dir>] [--out <file>] <report.json>...
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DURATIONS_PATH, median } from './duration-sequencer.mjs';

/** Map repo-relative test path to median ms over `reports` (parsed vitest JSON reports). */
export function durationsFromReports(reports, root) {
  const samples = new Map();
  for (const report of reports) {
    if (!Array.isArray(report?.testResults)) throw new Error('not a vitest JSON report: testResults is missing');
    for (const result of report.testResults) {
      const ms = result.endTime - result.startTime;
      if (typeof result.name !== 'string' || !Number.isFinite(ms) || ms < 0) continue;
      const path = (isAbsolute(result.name) ? relative(root, result.name) : result.name).replace(/\\/g, '/');
      if (path.startsWith('../')) continue;
      samples.set(path, [...(samples.get(path) ?? []), ms]);
    }
  }
  return Object.fromEntries([...samples.keys()].sort().map((path) => [path, Math.round(median(samples.get(path)))]));
}

function main(argv) {
  let root = process.cwd();
  let out;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = resolve(argv[++i]);
    else if (argv[i] === '--out') out = argv[++i];
    else files.push(argv[i]);
  }
  if (files.length === 0) {
    console.error('usage: update-test-durations.mjs [--root <dir>] [--out <file>] <report.json>...');
    return 2;
  }
  const durations = durationsFromReports(files.map((f) => JSON.parse(readFileSync(f, 'utf8'))), root);
  const target = resolve(root, out ?? DURATIONS_PATH);
  writeFileSync(target, `${JSON.stringify(durations, null, 2)}\n`);
  console.log(`wrote ${Object.keys(durations).length} file durations to ${relative(root, target).replace(/\\/g, '/')}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
