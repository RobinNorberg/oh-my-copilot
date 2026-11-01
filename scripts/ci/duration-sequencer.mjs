/**
 * Vitest sequencer that balances `--shard=<i>/<n>` by measured file duration
 * instead of vitest's file-count split, which leaves one shard about twice as
 * long when a few files take minutes. Ordering within a shard (`sort`) is
 * vitest's own. Durations come from `.github/ci/test-durations.json` (repo
 * path to median ms, refreshed with `scripts/ci/update-test-durations.mjs`);
 * a file without a measurement counts as the median. Without the file the
 * split falls back to vitest's. Stale data only affects balance: every file
 * still lands in exactly one shard.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BaseSequencer } from 'vitest/node';

export const DURATIONS_PATH = '.github/ci/test-durations.json';

/** Load the durations map, or null when it is missing or malformed. */
export function readDurations(root) {
  try {
    const data = JSON.parse(readFileSync(join(root, DURATIONS_PATH), 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
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
}
