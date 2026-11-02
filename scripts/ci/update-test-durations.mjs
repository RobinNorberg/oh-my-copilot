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
 * Run: node scripts/ci/update-test-durations.mjs [--root <dir>] [--out <file>] <test-durations.json>...
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DURATIONS_PATH, median } from './duration-sequencer.mjs';

const USAGE = 'usage: update-test-durations.mjs [--root <dir>] [--out <file>] <test-durations.json>...';

/** Map repo-relative test path to median ms over `reports` (parsed durations reports). */
export function durationsFromReports(reports) {
  const samples = new Map();
  for (const report of reports) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      throw new Error('not a durations report: expected an object of test path to ms');
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
  const durations = durationsFromReports(files.map((f) => JSON.parse(readFileSync(f, 'utf8'))));
  const target = resolve(root, out ?? DURATIONS_PATH);
  writeFileSync(target, `${JSON.stringify(durations, null, 2)}\n`);
  console.log(`wrote ${Object.keys(durations).length} file durations to ${relative(root, target).replace(/\\/g, '/')}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
