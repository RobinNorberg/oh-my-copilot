/**
 * Pins CI's sharded Linux Test: the duration-balanced split in
 * scripts/ci/duration-sequencer.mjs, the durations report from
 * scripts/ci/durations-reporter.mjs, the refresh in
 * scripts/ci/update-test-durations.mjs, the committed duration data and the
 * Windows path-suite list the workflow reads, and the serial-budget project
 * split in vitest.config.ts.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import DurationSequencer, { assignShards, DURATIONS_PATH, readDurations, WIN32_DURATIONS_PATH } from "../../scripts/ci/duration-sequencer.mjs";
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
    const durations = readDurations(REPO_ROOT, "linux");
    expect(durations, `${DURATIONS_PATH} must parse`).not.toBeNull();
    const loads = assignShards(Object.keys(durations!), durations!, 4).map((s) => s.ms);
    expect(Math.max(...loads) / Math.min(...loads)).toBeLessThanOrEqual(1.3);
  });
});

describe("longest-first test order", () => {
  type Spec = { moduleId: string; project: { name: string; config: { sequence: { groupOrder: number }; isolate: boolean } } };
  const project = (name: string, groupOrder: number) => ({ name, config: { sequence: { groupOrder }, isolate: true } });
  const MAIN = project("main", 0);
  const SERIAL = project("serial-budget", 1);

  function withTables(tables: Record<string, Record<string, number>>, body: (root: string) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), "omg-sort-"));
    mkdirSync(join(root, ".github/ci"), { recursive: true });
    for (const [path, table] of Object.entries(tables)) writeFileSync(join(root, path), JSON.stringify(table));
    return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
  }
  const sequencer = (root: string, shard?: { index: number; count: number }) =>
    new DurationSequencer({ config: { root, shard } } as never);
  const names = (root: string, specs: Spec[]) => specs.map((spec) => `${spec.project.name}:${spec.moduleId.slice(root.length + 1).replace(/\\/g, "/")}`);

  it("starts the longest file first, unmeasured files before all measured ones", () =>
    withTables({ [DURATIONS_PATH]: { "a.test.ts": 10, "b.test.ts": 500, "c.test.ts": 90, "d.test.ts": 90 } }, async (root) => {
      const specs = ["a.test.ts", "new-2.test.ts", "c.test.ts", "b.test.ts", "d.test.ts", "new-1.test.ts"].map((file) => ({ moduleId: join(root, file), project: MAIN }));
      expect(names(root, await sequencer(root).sort(specs as never))).toEqual([
        "main:new-1.test.ts",
        "main:new-2.test.ts",
        "main:b.test.ts",
        "main:c.test.ts",
        "main:d.test.ts",
        "main:a.test.ts",
      ]);
    }));

  it("keeps the serial-budget project after main and never mixes projects", () =>
    withTables({ [DURATIONS_PATH]: { "s-long.test.ts": 9000, "s-short.test.ts": 5, "m-long.test.ts": 800, "m-short.test.ts": 1 } }, async (root) => {
      const specs = [
        { moduleId: join(root, "s-short.test.ts"), project: SERIAL },
        { moduleId: join(root, "m-short.test.ts"), project: MAIN },
        { moduleId: join(root, "s-long.test.ts"), project: SERIAL },
        { moduleId: join(root, "m-long.test.ts"), project: MAIN },
      ];
      expect(names(root, await sequencer(root).sort(specs as never))).toEqual([
        "main:m-long.test.ts",
        "main:m-short.test.ts",
        "serial-budget:s-long.test.ts",
        "serial-budget:s-short.test.ts",
      ]);
    }));

  it("picks the Windows table on win32 only, and the Linux table when Windows has none", () =>
    withTables({ [DURATIONS_PATH]: { "a.test.ts": 1 }, [WIN32_DURATIONS_PATH]: { "a.test.ts": 2 } }, async (root) => {
      expect(readDurations(root, "win32")).toEqual({ "a.test.ts": 2 });
      expect(readDurations(root, "linux")).toEqual({ "a.test.ts": 1 });
      rmSync(join(root, WIN32_DURATIONS_PATH));
      expect(readDurations(root, "win32")).toEqual({ "a.test.ts": 1 });
    }));

  it("still runs every file exactly once across 4 shards, each shard longest first", () =>
    withTables({ [DURATIONS_PATH]: { "a.test.ts": 90, "b.test.ts": 70, "c.test.ts": 50, "d.test.ts": 30, "e.test.ts": 20, "f.test.ts": 10, "s.test.ts": 40 } }, async (root) => {
      const specs = [
        ...["f.test.ts", "a.test.ts", "new.test.ts", "c.test.ts", "e.test.ts", "b.test.ts", "d.test.ts"].map((file) => ({ moduleId: join(root, file), project: MAIN })),
        { moduleId: join(root, "s.test.ts"), project: SERIAL },
      ];
      const runs = await Promise.all([1, 2, 3, 4].map(async (index) => {
        const seq = sequencer(root, { index, count: 4 });
        return seq.sort((await seq.shard(specs as never)) as never);
      }));
      const ids = runs.flat().map((spec) => (spec as Spec).moduleId);
      expect(ids.sort()).toEqual(specs.map((spec) => spec.moduleId).sort());
      const ms: Record<string, number> = { "new.test.ts": Infinity, ...readDurations(root, "linux") };
      for (const run of runs) {
        const order = run as Spec[];
        const groups = order.map((spec) => spec.project.config.sequence.groupOrder);
        expect(groups).toEqual([...groups].sort((a, b) => a - b));
        const main = order.filter((spec) => spec.project === MAIN).map((spec) => ms[spec.moduleId.slice(root.length + 1)]);
        expect(main).toEqual([...main].sort((a, b) => b - a));
      }
    }));

  it("commits a Windows table that names the slow factory suite", () => {
    const durations = readDurations(REPO_ROOT, "win32");
    expect(durations).not.toBeNull();
    expect(existsSync(join(REPO_ROOT, WIN32_DURATIONS_PATH))).toBe(true);
    expect(durations!["src/factory/run/__tests__/prepare-gates.test.ts"]).toBeGreaterThan(0);
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

  it("reads a vitest JSON report as each file's wall time, relative to the root", () => {
    const root = join(tmpdir(), "omg-repo");
    const file = (path: string, startTime: number, endTime: number) => ({ name: join(root, path).replace(/\\/g, "/"), startTime, endTime });
    const vitestReport = { startTime: 0, testResults: [file("src/a.test.ts", 100, 1100.6), file("tests/b.test.ts", 5, 12), { name: join(tmpdir(), "elsewhere.test.ts"), startTime: 0, endTime: 1 }] };
    expect(durationsFromReports([vitestReport, { "src/a.test.ts": 3000 }, { "src/a.test.ts": 2000 }], root)).toEqual({
      "src/a.test.ts": 2000,
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

describe("serial-budget vitest project", () => {
  it("partitions the suite: its existing files leave main and run one at a time after it", async () => {
    type Project = { test: { name: string; include: string[]; exclude: string[]; fileParallelism?: boolean; sequence?: { groupOrder?: number } } };
    const { default: config } = await import("../../vitest.config.ts");
    const projects = (config as { test: { projects: Project[] } }).test.projects;
    expect(projects.map((p) => p.test.name)).toEqual(["main", "serial-budget"]);
    const [main, serial] = projects.map((p) => p.test);
    expect(serial.include.length).toBeGreaterThan(0);
    for (const file of serial.include) {
      expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
      expect(main.exclude, file).toContain(file);
    }
    expect(serial.fileParallelism).toBe(false);
    expect(serial.sequence?.groupOrder ?? 0).toBeGreaterThan(main.sequence?.groupOrder ?? 0);
  });

  it("hands a CLI --exclude on to the projects", () => {
    const file = "src/__tests__/session-end-process-exit.test.ts";
    const list = (...extra: string[]) =>
      spawnSync(process.execPath, [join(REPO_ROOT, "node_modules/vitest/vitest.mjs"), "list", "--filesOnly", file, ...extra], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).stdout;
    expect(list()).toContain(`[serial-budget] ${file}`);
    expect(list("--exclude", file)).not.toContain(file);
  });
});
