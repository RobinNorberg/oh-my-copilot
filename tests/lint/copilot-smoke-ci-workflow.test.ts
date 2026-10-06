/**
 * Pins the `smoke` job in .github/workflows/ci.yml (docs/DEVELOPERS.md,
 * "Tier 2 in CI"): static tier 2 checks on every run, billed scenarios on v*
 * tags only, a clean skip without the COPILOT_GITHUB_TOKEN secret, the secret
 * only through step env and never printed, and a token-leak scan that must
 * pass before any artifact upload.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");
const SECRET_REF = "${{ secrets.COPILOT_GITHUB_TOKEN }}";
const SECRET_ENV_LINE = `          COPILOT_GITHUB_TOKEN: ${SECRET_REF}`;
const GATE = "steps.gate.outputs.enabled == 'true'";
const TAG_ONLY = "github.event_name == 'push' && github.ref_type == 'tag'";
const STATIC_CMD = "node bridge/cli.cjs smoke copilot --tier 2 --sdk-static --keep-home --json";
const SCENARIO_CMD = "node bridge/cli.cjs smoke copilot --tier 2 --keep-home --json";

const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

function extractJob(workflow: string, jobName: string): string {
  const jobs = workflow.match(/^jobs:\s*$/m);
  expect(jobs, "workflow must define jobs").toBeTruthy();
  const start = workflow.indexOf(`\n  ${jobName}:\n`, jobs?.index);
  expect(start, `workflow must define the ${jobName} job`).toBeGreaterThanOrEqual(0);
  const remainder = workflow.slice(start + 1);
  const nextJob = remainder.slice(1).search(/^ {2}[\w-]+:\s*$/m);
  return nextJob < 0 ? remainder : remainder.slice(0, nextJob + 1);
}

interface Step { raw: string; name: string; id?: string; if?: string; run: string }

function extractSteps(job: string): Step[] {
  const starts = [...job.matchAll(/^ {6}- (?=name:|uses:|run:|id:)/gm)].map((m) => m.index!);
  return starts.map((start, i) => {
    const raw = job.slice(start, starts[i + 1]);
    const field = (key: string) => raw.match(new RegExp(`^(?: {6}- | {8})${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    const block = raw.match(/^ {8}run:\s*[>|][-+]?\s*\n((?: {10}.*\n?| *\n)*)/m)?.[1];
    const run = field("run")?.replace(/^\|$/, "") || block?.replace(/^ {10}/gm, "").trim() || "";
    return { raw, name: field("name") ?? field("uses") ?? "", id: field("id"), if: field("if"), run };
  });
}

const job = extractJob(ci, "smoke");
const steps = extractSteps(job);
const step = (name: string): Step => {
  const found = steps.find((s) => s.name === name);
  expect(found, `smoke job must have the step "${name}"`).toBeTruthy();
  return found!;
};

describe("copilot smoke CI workflow", () => {
  it("runs on ubuntu after build, and on v* tags where build is skipped", () => {
    expect(job).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    expect(job).toMatch(/^ {4}needs: \[build\]$/m);
    expect(job).toContain(
      "if: ${{ !cancelled() && (needs.build.result == 'success' || (github.event_name == 'push' && github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v'))) }}",
    );
  });

  it("gates every later step on a first step that reads the secret, so a missing secret skips cleanly", () => {
    const [gate, ...rest] = steps;
    expect(gate.name).toBe("Check for the Copilot token");
    expect(gate.id).toBe("gate");
    expect(gate.if).toBeUndefined();
    expect(gate.raw).toContain(SECRET_ENV_LINE);
    expect(gate.run).toContain('echo "enabled=true" >> "$GITHUB_OUTPUT"');
    expect(gate.run).toContain('echo "enabled=false" >> "$GITHUB_OUTPUT"');
    expect(gate.run).toContain("::notice title=Copilot smoke skipped::");
    expect(gate.raw).not.toMatch(/continue-on-error/);
    for (const s of rest) expect(s.if, `step "${s.name}" must be gated`).toContain(GATE);
    // `secrets.*` is not allowed in a job/step `if`; the gate output replaces it.
    expect(job).not.toMatch(/if:[^\n]*secrets\./);
  });

  it("installs the Copilot CLI from npm and the SDK without its bundled runtime", () => {
    const install = step("Install Copilot CLI and SDK");
    expect(install.run).toContain('npm install --global --no-audit --no-fund --omit=optional --ignore-scripts "@github/copilot-sdk@$SMOKE_SDK_RANGE"');
    expect(install.run).toContain('npm install --global --no-audit --no-fund "@github/copilot@$SMOKE_CLI_DIST_TAG"');
    expect(install.run).toContain("copilot --version");
    expect(steps.indexOf(step("Build"))).toBeLessThan(steps.indexOf(step("Tier 2 static checks (no model call)")));
  });

  it("isolates COPILOT_HOME and TMPDIR under the runner temp", () => {
    const prep = step("Prepare isolated smoke dirs");
    expect(prep.run).toContain('SMOKE_ROOT="$RUNNER_TEMP/copilot-smoke"');
    expect(prep.run).toContain(`printf 'COPILOT_HOME=%s\\n' "$SMOKE_ROOT/user-home" >> "$GITHUB_ENV"`);
    expect(prep.run).toContain(`printf 'TMPDIR=%s\\n' "$SMOKE_ROOT/tmp" >> "$GITHUB_ENV"`);
  });

  it("runs the free static tier on every gated run and the billed scenarios on tags only", () => {
    const stat = step("Tier 2 static checks (no model call)");
    expect(stat.if).toBe(GATE);
    expect(stat.run).toContain(STATIC_CMD);
    expect(stat.run).toContain('exit "$status"');

    const scn = step("Tier 2 default scenarios (tags only, ~2 premium requests)");
    expect(scn.if).toBe(`${GATE} && ${TAG_ONLY}`);
    expect(scn.raw).toContain("OMC_LIVE_SMOKE: '2'");
    expect(scn.run).toContain(SCENARIO_CMD);
    expect(scn.run).not.toMatch(/--scenario|--sdk-static/);
    expect(scn.run).toContain('exit "$status"');
    expect(steps.indexOf(stat)).toBeLessThan(steps.indexOf(scn));

    const billed = steps.filter((s) => /smoke copilot/.test(s.run) && !/--sdk-static/.test(s.run));
    expect(billed, "only the tag-gated step may run billed scenarios").toEqual([scn]);
  });

  it("passes the secret only as step env and never prints it", () => {
    const occurrences = ci.split("secrets.COPILOT_GITHUB_TOKEN").length - 1;
    const envLines = ci.split(`\n${SECRET_ENV_LINE}\n`).length - 1;
    expect(occurrences, "every secret reference must be a step-level env line").toBe(envLines);
    expect(job.split(SECRET_ENV_LINE).length - 1).toBe(occurrences);
    for (const s of steps) {
      expect(s.run, `step "${s.name}" must not inline secrets`).not.toContain("secrets.");
      expect(s.run, `step "${s.name}" must not trace commands`).not.toMatch(/set -[a-z]*x|set -o xtrace/);
      // Every shell expansion of the token; a bare mention of the name is fine.
      const uses = s.run.split("\n").filter((line) => /\$\{?COPILOT_GITHUB_TOKEN\b/.test(line));
      for (const line of uses) {
        expect([
          'if [ -n "$COPILOT_GITHUB_TOKEN" ]; then',
          `if printf '%s\\n' "$COPILOT_GITHUB_TOKEN" | grep -rlF -f - "$SMOKE_ROOT"; then leaked=1; fi`,
        ], `step "${s.name}" uses the token in an unexpected way: ${line.trim()}`).toContain(line.trim());
      }
    }
    expect(job).not.toMatch(/^ {4}env:\n(?: {6}.*\n)*? {6}COPILOT_GITHUB_TOKEN:/m);
    expect(extractJob(ci, "release")).not.toContain("COPILOT_GITHUB_TOKEN");
  });

  it("scans for leaked tokens before uploading, and uploads only when the scan passed", () => {
    const leak = step("Check smoke artifacts for token leaks");
    expect(leak.id).toBe("leak-check");
    expect(leak.if).toBe(`always() && ${GATE}`);
    const pattern = leak.run.match(/grep -rlE '([^']+)' "\$SMOKE_ROOT"/)?.[1];
    expect(pattern, "leak scan must grep token shapes recursively").toBeTruthy();
    const re = new RegExp(pattern!);
    for (const sample of [`gho_${"a".repeat(36)}`, `ghu_${"B".repeat(36)}`, `ghp_${"1".repeat(36)}`, `github_pat_${"x".repeat(22)}_${"y".repeat(59)}`]) {
      expect(re.test(sample), `leak scan must catch ${sample.slice(0, 12)}...`).toBe(true);
    }
    expect(leak.run).not.toMatch(/grep -[a-zA-Z]*I/);
    expect(leak.run).toContain('rm -rf "$SMOKE_ROOT"');
    expect(leak.run).toMatch(/exit 1\n/);

    const upload = step("Upload smoke report and artifacts");
    expect(upload.raw).toContain("uses: actions/upload-artifact@v4");
    expect(upload.if).toBe(`always() && ${GATE} && steps.leak-check.outcome == 'success'`);
    expect(upload.raw).toContain("path: ${{ runner.temp }}/copilot-smoke/");
    expect(steps.indexOf(leak)).toBeLessThan(steps.indexOf(upload));
    expect(steps.indexOf(step("Tier 2 default scenarios (tags only, ~2 premium requests)"))).toBeLessThan(steps.indexOf(leak));
  });
});
