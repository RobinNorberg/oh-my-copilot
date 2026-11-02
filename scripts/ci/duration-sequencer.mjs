/**
 * Vitest sequencer that orders and shards test files by measured duration.
 *
 * `sort` starts the longest files first (longest-processing-time-first), so a
 * multi-minute file does not start late and set the run's tail; vitest's own
 * order is failed-first from a per-checkout cache. `shard` balances
 * `--shard=<i>/<n>` by duration instead of vitest's file-count split, which
 * leaves one shard about twice as long when a few files take minutes.
 *
 * Durations come from `.github/ci/test-durations.json` (Linux, CI) or, on
 * Windows, `.github/ci/test-durations.win32.json` (falling back to the Linux
 * table): repo path to median import plus test ms, refreshed with
 * `scripts/ci/update-test-durations.mjs`. Without a table both fall back to
 * vitest's. Stale data only affects order and balance: every file still runs
 * once, in exactly one shard.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BaseSequencer } from 'vitest/node';

export const DURATIONS_PATH = '.github/ci/test-durations.json';
export const WIN32_DURATIONS_PATH = '.github/ci/test-durations.win32.json';

function readTable(root, path) {
  try {
    const data = JSON.parse(readFileSync(join(root, path), 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Load the durations map for `platform`, or null when it is missing or
 * malformed. Windows prefers its own table, whose per-file costs differ from
 * Linux by 30-50x for the real-git suites.
 */
export function readDurations(root, platform = process.platform) {
  return (platform === 'win32' && readTable(root, WIN32_DURATIONS_PATH)) || readTable(root, DURATIONS_PATH);
}

export function median(values) {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Longest-processing-time-first bin packing of `paths` (repo-relative, `/`
 * separators) into `count` shards. Deterministic for a given input set:
 * every shard computes the same assignment and keeps its own 1-based `index`.
 */
export function assignShards(paths, durations, count) {
  const known = paths.map((p) => durations[p]).filter((ms) => Number.isFinite(ms) && ms >= 0);
  const fallback = median(known);
  const weighted = paths.map((path) => {
    const ms = durations[path];
    return { path, ms: Number.isFinite(ms) && ms >= 0 ? ms : fallback };
  });
  weighted.sort((a, b) => b.ms - a.ms || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ ms: 0, paths: [] }));
  for (const file of weighted) {
    let target = shards[0];
    for (const shard of shards) if (shard.ms < target.ms) target = shard;
    target.ms += file.ms;
    target.paths.push(file.path);
  }
  return shards;
}

export default class DurationSequencer extends BaseSequencer {
  async shard(specs) {
    const { root, shard } = this.ctx.config;
    const durations = readDurations(root);
    if (!durations) return super.shard(specs);
    const keyOf = (spec) => relative(root, spec.moduleId).replace(/\\/g, '/');
    const shards = assignShards([...new Set(specs.map(keyOf))], durations, shard.count);
    const mine = new Set(shards[shard.index - 1].paths);
    return specs.filter((spec) => mine.has(keyOf(spec)));
  }

  /**
   * Longest file first within each project, keeping vitest's project rules
   * (groupOrder, then project name, then isolated first) so the serial-budget
   * project still runs after `main`. A file without a measurement sorts first,
   * as in vitest: it is usually new or just split, and starting it late is the
   * costly mistake when it turns out long, while starting a short one early
   * costs only its own seconds.
   */
  async sort(files) {
    const { root } = this.ctx.config;
    const durations = readDurations(root);
    if (!durations) return super.sort(files);
    const keyOf = (spec) => relative(root, spec.moduleId).replace(/\\/g, '/');
    const msOf = (spec) => {
      const ms = durations[keyOf(spec)];
      return Number.isFinite(ms) && ms >= 0 ? ms : Infinity;
    };
    return [...files].sort((a, b) => {
      const groupOrderDiff = a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder;
      if (groupOrderDiff !== 0) return groupOrderDiff;
      if (a.project.name !== b.project.name) return a.project.name < b.project.name ? -1 : 1;
      if (a.project.config.isolate && !b.project.config.isolate) return -1;
      if (!a.project.config.isolate && b.project.config.isolate) return 1;
      const msA = msOf(a);
      const msB = msOf(b);
      if (msA !== msB) return msA > msB ? -1 : 1;
      const keyA = keyOf(a);
      const keyB = keyOf(b);
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });
  }
}
