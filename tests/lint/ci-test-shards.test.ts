/**
 * Pins CI's sharded Linux Test: the duration-balanced split in
 * scripts/ci/duration-sequencer.mjs, the duration refresh in
 * scripts/ci/update-test-durations.mjs, the committed duration data and the
 * Windows path-suite list the workflow reads.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { assignShards, DURATIONS_PATH, readDurations } from "../../scripts/ci/duration-sequencer.mjs";
import { durationsFromReports } from "../../scripts/ci/update-test-durations.mjs";

const REPO_ROOT = join(import.meta.dirname, "../..");

describe("duration-balanced test shards", () => {
  it("puts every file in exactly one shard, longest first onto the lightest shard", () => {
    const durations = { "a.test.ts": 100, "b.test.ts": 60, "c.test.ts": 50, "d.test.ts": 40, "e.test.ts": 10 };
    const shards = assignShards(Object.keys(durations).reverse(), durations, 2);
    expect(shards.map((s) => s.paths)).toEqual([["a.test.ts", "d.test.ts"], ["b.test.ts", "c.test.ts", "e.test.ts"]]);
    expect(shards.map((s) => s.ms)).toEqual([140, 120]);
  });

  it("weights an unmeasured file as the median and stays deterministic", () => {
    const durations = { "a.test.ts": 30, "b.test.ts": 20, "c.test.ts": 10 };
    const files = ["new.test.ts", "c.test.ts", "a.test.ts", "b.test.ts"];
    const first = assignShards(files, durations, 2);
    expect(first.map((s) => s.ms)).toEqual([40, 40]);
    expect(first.flatMap((s) => s.paths).sort()).toEqual([...files].sort());
    expect(assignShards([...files].reverse(), durations, 2)).toEqual(first);
  });

  it("returns null without usable duration data so vitest's own split applies", () => {
    const root = mkdtempSync(join(tmpdir(), "omg-shard-"));
    try {
      expect(readDurations(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("balances the committed suite into 4 shards within 1.3x", () => {
    const durations = readDurations(REPO_ROOT);
    expect(durations, `${DURATIONS_PATH} must parse`).not.toBeNull();
    const loads = assignShards(Object.keys(durations!), durations!, 4).map((s) => s.ms);
    expect(Math.max(...loads) / Math.min(...loads)).toBeLessThanOrEqual(1.3);
  });
});

describe("update-test-durations", () => {
  it("takes the median per file across reports, relative to the root", () => {
    const root = join(tmpdir(), "repo");
    const report = (ms: number) => ({
      testResults: [
        { name: join(root, "src", "a.test.ts"), startTime: 1000, endTime: 1000 + ms },
        { name: "tests/b.test.ts", startTime: 0, endTime: 7 },
      ],
    });
    expect(durationsFromReports([report(10), report(40), report(20)], root)).toEqual({
      "src/a.test.ts": 20,
      "tests/b.test.ts": 7,
    });
  });

  it("rejects a file that is not a vitest JSON report", () => {
    expect(() => durationsFromReports([{}], REPO_ROOT)).toThrow(/testResults/);
  });
});

describe("Windows path suite list", () => {
  it("lists existing test files that the workflow reads", () => {
    const files = readFileSync(join(REPO_ROOT, ".github/ci/windows-path-suite.txt"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
    expect(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")).toContain(".github/ci/windows-path-suite.txt");
  });
});
