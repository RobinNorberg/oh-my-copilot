#!/usr/bin/env node
/**
 * Refresh .github/ci/test-durations.json from durations reports of FULL runs
 * (`test-durations.json` in the `vitest-report` artifact of CI's Test job,
 * written by scripts/ci/durations-reporter.mjs: repo path to import plus
 * test ms). Each file's value is the median across the given reports, in
 * whole ms; files absent from every report are dropped. Stale data only
 * affects shard balance (scripts/ci/duration-sequencer.mjs), never which
 * tests run.
 *
 * A vitest JSON report (`--reporter=json`, e.g. `omg release`'s
 * `.omg/release/<version>-vitest.json`) also works: each file counts as its
 * endTime - startTime, and its absolute paths are made relative to --root.
 * That is how the Windows table `.github/ci/test-durations.win32.json` is
 * refreshed (`--out .github/ci/test-durations.win32.json`).
 *
 * Run: node scripts/ci/update-test-durations.mjs [--root <dir>] [--out <file>] <report.json>...
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DURATIONS_PATH, median } from './duration-sequencer.mjs';

const USAGE = 'usage: update-test-durations.mjs [--root <dir>] [--out <file>] <report.json>...';

/** A vitest JSON report as repo path to wall ms per file, or the report unchanged. */
function fileDurations(report, root) {
  if (!Array.isArray(report?.testResults)) return report;
  return Object.fromEntries(report.testResults.map((file) => [relative(root, file.name), file.endTime - file.startTime]));
}

/**
 * Map repo-relative test path to median ms over `reports` (parsed durations
 * reports or vitest JSON reports, whose paths are taken relative to `root`).
 */
export function durationsFromReports(reports, root = process.cwd()) {
  const samples = new Map();
  for (const input of reports) {
    const report = fileDurations(input, root);
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      throw new Error('not a durations report: expected an object of test path to ms or a vitest JSON report');
    }
    for (const [name, ms] of Object.entries(report)) {
      const path = name.replace(/\\/g, '/');
      if (!Number.isFinite(ms) || ms < 0 || isAbsolute(path) || path.startsWith('../')) continue;
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
    if (argv[i] === '--root' || argv[i] === '--out') {
      const value = argv[++i];
      if (value === undefined) {
        console.error(USAGE);
        return 2;
      }
      if (argv[i - 1] === '--root') root = resolve(value);
      else out = value;
    } else files.push(argv[i]);
  }
  if (files.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const durations = durationsFromReports(files.map((f) => JSON.parse(readFileSync(f, 'utf8'))), root);
  if (Object.keys(durations).length === 0) {
    console.error('no file durations in the given report(s): an empty report, or a vitest JSON report without testResults, would wipe the table');
    return 1;
  }
  const target = resolve(root, out ?? DURATIONS_PATH);
  writeFileSync(target, `${JSON.stringify(durations, null, 2)}\n`);
  console.log(`wrote ${Object.keys(durations).length} file durations to ${relative(root, target).replace(/\\/g, '/')}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
