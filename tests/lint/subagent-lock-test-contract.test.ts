import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");
const PERF_GLOB = "tests/perf/**";
const QUOTED_PERF_GLOB = `"${PERF_GLOB}"`;
const PERF_TARGET = "tests/perf/subagent-lock.bench.ts";
const PERF_SCRIPT = "test:perf:subagent-lock";
const PERF_COMMAND = `npm exec vitest -- run ${PERF_TARGET} --fileParallelism=false --maxWorkers=1`;
const FUNCTIONAL_SCRIPTS = {
  test: ["vitest"],
  "test:run": ["vitest", "run"],
  "test:ui": ["vitest", "--ui"],
  "test:coverage": ["vitest", "run", "--coverage"],
} as const;
// Live scripts run against real host binaries through their own config whose
// include list is tests/live/** only, so the perf glob can never be collected;
// they are exempt from the functional perf-exclusion contract above.
const LIVE_SCRIPTS = {
  "test:live": ["vitest", "run", "--config", "vitest.live.config.ts"],
} as const;

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function tokens(command: string): string[] {
  return command.trim().split(/\s+/);
}

function extractJob(workflow: string, jobName: string): string {
  const jobs = workflow.match(/^jobs:\s*$/m);
  expect(jobs, "workflow must define jobs").toBeTruthy();

  const start = workflow.indexOf(`  ${jobName}:`, jobs?.index);
  expect(
    start,
    `workflow must define the ${jobName} job`,
  ).toBeGreaterThanOrEqual(0);

  const remainder = workflow.slice(start);
  const nextJob = remainder.slice(1).search(/^  [\w-]+:\s*$/m);
  return nextJob < 0 ? remainder : remainder.slice(0, nextJob + 1);
}

type WorkflowStep = { raw: string; run?: string };

function extractSteps(job: string): WorkflowStep[] {
  const stepStarts = [...job.matchAll(/^      - (?=name:|uses:|run:)/gm)].map(
    (match) => match.index!,
  );
  return stepStarts.map((start, index) => {
    const raw = job.slice(start, stepStarts[index + 1]);
    const inlineRun = raw
      .match(/^        run:\s*([^\n|>][^\n]*)$/m)?.[1]
      ?.trim();
    const blockRun = raw.match(
      /^        run:\s*[>|][-+]?\s*\n((?:          .*\n?)*)/m,
    )?.[1];
    const run = inlineRun ?? blockRun?.replace(/^          /gm, "").trim();
    return { raw, run };
  });
}

function assertWorkflowCommands(
  workflow: string,
  jobName: string,
  release = false,
): void {
  const job = extractJob(workflow, jobName);
  expect(job).toMatch(/^    runs-on: ubuntu-latest$/m);

  const steps = extractSteps(job);
  const functional = steps.filter((step) =>
    step.run?.includes("npm test -- --run"),
  );
  const perf = steps.filter((step) => step.run?.includes(PERF_TARGET));

  expect(
    functional,
    `${jobName} must have one functional package step`,
  ).toHaveLength(1);
  expect(perf, `${jobName} must have one serialized perf step`).toHaveLength(1);
  expect(functional[0].run).toBe("npm test -- --run");
  expect(perf[0].run).toBe(PERF_COMMAND);
  expect(functional[0]).not.toBe(perf[0]);
  expect(steps.indexOf(functional[0])).toBeLessThan(steps.indexOf(perf[0]));

  for (const step of [...functional, ...perf]) {
    expect(step.raw, `${jobName} test steps must block failures`).not.toMatch(
      /^        continue-on-error:\s*true\s*$/m,
    );
  }

  const commands = steps.flatMap((step) => (step.run ? [step.run] : []));
  expect(
    commands.join("\n"),
    `${jobName} must not recombine the test commands`,
  ).not.toMatch(/npm test\s+--\s+--run\s*[;&|]/);
  expect(
    job.split(PERF_COMMAND).length - 1,
    `${jobName} job must have exactly one serialized perf command`,
  ).toBe(1);
  expect(
    workflow,
    `${jobName} workflow must not invoke the removed perf package script`,
  ).not.toContain(`npm run ${PERF_SCRIPT}`);

  if (release) {
    const sideEffect = steps.findIndex(
      (step) =>
        step.raw.includes("npm publish") ||
        step.raw.includes("action-gh-release"),
    );
    expect(
      sideEffect,
      "release must retain a publish or release side effect",
    ).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(perf[0])).toBeLessThan(sideEffect);
  }
}

describe("subagent-lock test contract", () => {
  it("keeps all functional Vitest scripts explicitly out of perf", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };

    for (const [name, expectedPrefix] of Object.entries(FUNCTIONAL_SCRIPTS)) {
      const command = pkg.scripts[name];
      expect(command, `missing ${name}`).toBeTypeOf("string");
      const commandTokens = tokens(command);
      expect(commandTokens.slice(0, expectedPrefix.length)).toEqual(
        expectedPrefix,
      );
      const excludeIndexes = commandTokens.flatMap((token, index) =>
        token === "--exclude" ? [index] : [],
      );
      expect(
        excludeIndexes,
        `${name} must have exactly one perf exclusion`,
      ).toHaveLength(1);
      expect(commandTokens[excludeIndexes[0] + 1]).toBe(QUOTED_PERF_GLOB);
      expect(
        commandTokens.filter((token) => token.includes(PERF_GLOB)),
      ).toEqual([QUOTED_PERF_GLOB]);
      expect(command).not.toMatch(
        new RegExp(`(?:${PERF_TARGET}|${PERF_SCRIPT}|--ci|threshold)`, "i"),
      );
    }

    for (const [name, expectedTokens] of Object.entries(LIVE_SCRIPTS)) {
      expect(tokens(pkg.scripts[name])).toEqual(expectedTokens);
    }

    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (/(?:^|\s)vitest(?:\s|$)/.test(command)) {
        expect(
          [...Object.keys(FUNCTIONAL_SCRIPTS), ...Object.keys(LIVE_SCRIPTS)],
          `unclassified Vitest script: ${name}`,
        ).toContain(name);
      }
    }
  });

  it("does not publish a subagent-lock benchmark script", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts).not.toHaveProperty(PERF_SCRIPT);
  });

  it("keeps CI and release as ordered, blocking functional and serialized perf gates", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");

    assertWorkflowCommands(ci, "release", true);

    // CI shards the functional run; the Test summary job merges the shard
    // reports, then runs the one serialized perf gate.
    const shardJob = extractJob(ci, "test-shards");
    // Fail-closed: every shard runs to the end on Linux, and the matrix covers
    // exactly the 1..N the --shard total and the Test blob count assume.
    expect(shardJob).toMatch(/^    runs-on: ubuntu-latest$/m);
    expect(shardJob).toMatch(/^      fail-fast: false$/m);
    expect(shardJob).toMatch(/^        shard: \[1, 2, 3, 4\]$/m);
    const shardSteps = extractSteps(shardJob);
    const functional = shardSteps.filter((step) => step.run?.includes("npm test -- --run"));
    expect(functional, "test-shards must have one functional package step").toHaveLength(1);
    expect(functional[0].run).toMatch(/^npm test -- --run --shard=\$\{\{ matrix\.shard \}\}\/4 /);
    expect(shardSteps.some((step) => step.run?.includes(PERF_TARGET))).toBe(false);
    const summary = extractJob(ci, "test");
    expect(summary).toMatch(/^    name: Test$/m);
    expect(summary).toMatch(/^    if: \$\{\{ always\(\) && /m);
    expect(summary).toMatch(/^    needs: \[test-shards\]$/m);
    const summarySteps = extractSteps(summary);
    const merge = summarySteps.findIndex((step) => step.raw.includes("npx vitest --merge-reports"));
    const perf = summarySteps.filter((step) => step.run?.includes(PERF_TARGET));
    expect(merge, "Test must merge the shard reports").toBeGreaterThanOrEqual(0);
    // Test fails unless every shard succeeded and all 4 blobs arrived.
    // From raw: extractSteps reads `run: |` as the inline command "|".
    const mergeRun = summarySteps[merge].raw.replace(/^ {10}/gm, "");
    expect(summarySteps[merge].raw).toMatch(/^          SHARDS_RESULT: \$\{\{ needs\.test-shards\.result \}\}$/m);
    expect(mergeRun).toMatch(/^if \[ "\$SHARDS_RESULT" != "success" \]; then\n {2}echo "::error[^\n]*\n {2}status=1\nfi$/m);
    expect(mergeRun).toMatch(/^if \[ "\$blobs" -ne 4 \]; then\n {2}echo "::error[^\n]*\n {2}status=1\nfi$/m);
    expect(mergeRun).toMatch(/\nexit \$status$/m);
    expect(perf, "Test must have one serialized perf step").toHaveLength(1);
    expect(perf[0].run).toBe(PERF_COMMAND);
    expect(summarySteps.indexOf(perf[0])).toBeGreaterThan(merge);
    for (const step of [...functional, ...perf, summarySteps[merge]]) {
      expect(step.raw, "test steps must block failures").not.toMatch(/^        continue-on-error:\s*true\s*$/m);
    }
    // Build runs beside Test (build once); CI Gate is the job that blocks on both.
    expect(extractJob(ci, "build")).not.toMatch(/^    needs:/m);
    expect(extractJob(ci, "ci-gate")).toMatch(/^      - test$/m);
  });
});
