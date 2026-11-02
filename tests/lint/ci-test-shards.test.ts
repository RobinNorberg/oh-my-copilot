/**
 * Pins CI's sharded Linux Test: the duration-balanced split in
 * scripts/ci/duration-sequencer.mjs, the durations report from
 * scripts/ci/durations-reporter.mjs, the refresh in
 * scripts/ci/update-test-durations.mjs, the committed duration data and the
 * Windows path-suite list the workflow reads.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import DurationSequencer, { assignShards, DURATIONS_PATH, readDurations } from "../../scripts/ci/duration-sequencer.mjs";
import DurationsReporter from "../../scripts/ci/durations-reporter.mjs";
import { durationsFromReports } from "../../scripts/ci/update-test-durations.mjs";

const REPO_ROOT = join(import.meta.dirname, "../..");
const UPDATER = join(REPO_ROOT, "scripts/ci/update-test-durations.mjs");

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

  it("shards vitest specs disjointly and deterministically, unmeasured files included", async () => {
    const root = mkdtempSync(join(tmpdir(), "omg-shard-"));
    try {
      mkdirSync(join(root, ".github/ci"), { recursive: true });
      const durations = { "a.test.ts": 90, "b.test.ts": 70, "c.test.ts": 50, "d.test.ts": 30, "e.test.ts": 20, "f.test.ts": 10 };
      writeFileSync(join(root, DURATIONS_PATH), JSON.stringify(durations));
      const specs = [...Object.keys(durations), "new.test.ts"].map((file) => ({ moduleId: join(root, file) }));
      const run = (index: number, input: typeof specs) =>
        new DurationSequencer({ config: { root, shard: { index, count: 4 } } } as never).shard(input as never);
      const shards = await Promise.all([1, 2, 3, 4].map((index) => run(index, specs)));
      const ids = shards.flat().map((spec) => spec.moduleId);
      expect(ids).toHaveLength(specs.length);
      expect(new Set(ids)).toEqual(new Set(specs.map((spec) => spec.moduleId)));
      for (const shard of shards) expect(shard.length).toBeGreaterThan(0);
      expect(await Promise.all([1, 2, 3, 4].map((index) => run(index, [...specs].reverse())))).toEqual(
        shards.map((shard) => [...shard].reverse()),
      );
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
  it("takes the median per file across reports and drops paths outside the repo", () => {
    const report = (ms: number) => ({ "src\\a.test.ts": ms, "tests/b.test.ts": 7, "../x.test.ts": 1, "/abs.test.ts": 1, "c.test.ts": -1 });
    expect(durationsFromReports([report(10), report(40), report(20)])).toEqual({
      "src/a.test.ts": 20,
      "tests/b.test.ts": 7,
    });
  });

  it("rejects a file that is not a durations report", () => {
    expect(() => durationsFromReports([[]])).toThrow(/durations report/);
    expect(() => durationsFromReports([null])).toThrow(/durations report/);
  });

  it.each([["--root"], ["--out"], ["report.json", "--out"]])("prints the usage for %s without a value", (...args) => {
    const result = spawnSync(process.execPath, [UPDATER, ...args], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^usage: update-test-durations\.mjs/);
  });
});

describe("durations reporter", () => {
  it("writes each module's import plus test ms by repo path to --outputFile.durations", () => {
    const root = mkdtempSync(join(tmpdir(), "omg-durations-"));
    try {
      const reporter = new DurationsReporter();
      reporter.onInit({ config: { root, outputFile: { durations: "out/test-durations.json" } } } as never);
      const module = (relativeModuleId: string, collectDuration: number, setupDuration: number, duration: number) =>
        ({ relativeModuleId, diagnostic: () => ({ collectDuration, setupDuration, duration }) }) as never;
      reporter.onTestModuleEnd(module("src\\a.test.ts", 100.4, 20, 300));
      reporter.onTestModuleEnd(module("tests/b.test.ts", 5, 0, 1.2));
      reporter.onTestRunEnd();
      expect(JSON.parse(readFileSync(join(root, "out/test-durations.json"), "utf8"))).toEqual({
        "src/a.test.ts": 420,
        "tests/b.test.ts": 6,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes nothing without the durations output option", () => {
    const root = mkdtempSync(join(tmpdir(), "omg-durations-"));
    try {
      const reporter = new DurationsReporter();
      reporter.onInit({ config: { root, outputFile: { json: "report.json" } } } as never);
      reporter.onTestRunEnd();
      expect(existsSync(join(root, "report.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
