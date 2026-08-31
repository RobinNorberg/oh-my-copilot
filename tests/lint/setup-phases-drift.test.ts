/**
 * Setup-phase drift enforcement (issue #3871).
 *
 * The shipped `skills/omc-setup/phases/*` instructions previously told the
 * setup agent to invoke skills removed in 5.0.0 (`mcp-setup`) and to persist
 * `defaultExecutionMode: "ultrawork"`. That happened because the workflow
 * registry moved under #3698 consolidation while the setup phase files were
 * not updated with it.
 *
 * This test locks the setup phases to the shipped surface so they cannot
 * drift again:
 *  - every `/oh-my-copilot:<skill>` reference in the setup phases must
 *    resolve to a skill the plugin actually ships (`.claude-plugin/plugin.json`)
 *  - no setup phase may reference a name retired in 5.0.0 (the canonical
 *    retired list in docs/CLAUDE.md, kept byte-identical to CLAUDE.md)
 *  - no setup phase may instruct writing a retired config value
 *    (`defaultExecutionMode`), and the config keys the phases touch must be
 *    current contract keys (doctor's knownFields minus the retired one)
 *
 * Rollback boundary: delete tests/lint/setup-phases-drift.test.ts — no
 * runtime change.
 */

import { execFileSync } from "child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");
const PHASES_DIR = join(REPO_ROOT, "skills", "omc-setup", "phases");
const PHASE_FILES = [
  "01-install-claude-md.md",
  "02-configure.md",
  "03-integrations.md",
  "04-welcome.md",
] as const;

function readPhase(file: string): string {
  const path = join(PHASES_DIR, file);
  expect(existsSync(path), `missing setup phase ${file}`).toBe(true);
  return readFileSync(path, "utf-8");
}

/** Skills the plugin actually ships, from the shipped manifest. */
function shippedSkills(): Set<string> {
  const pluginJson = JSON.parse(
    readFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf-8"),
  ) as { skills?: string[] };
  const entries = pluginJson.skills ?? [];
  expect(entries.length, "plugin.json must list skills").toBeGreaterThan(0);
  const names = new Set<string>();
  for (const dirRef of entries) {
    const directory = dirRef.replace(/^\.\//, "").replace(/\/$/, "");
    const directoryName = directory.split("/")[1];
    if (directoryName) names.add(directoryName);
    const skillPath = join(REPO_ROOT, directory, "SKILL.md");
    if (existsSync(skillPath)) {
      const match = readFileSync(skillPath, "utf-8").match(/^name:\s*([^\n]+)$/m);
      if (match?.[1]) names.add(match[1].trim());
    }
  }
  return names;
}

/**
 * Names retired in 5.0.0, parsed from the canonical retired sentence in
 * docs/CLAUDE.md (kept identical to the shipped CLAUDE.md by the fable
 * routing doc contract test, so this cannot drift from shipped docs).
 */
function retiredNames(): Set<string> {
  const doc = readFileSync(join(REPO_ROOT, "docs", "CLAUDE.md"), "utf-8");
  const match = doc.match(/\*\*Retired in 5\.0\.0 \(removed, not aliased\):\*\* ([^.]+)\./);
  expect(match, "docs/CLAUDE.md must keep the canonical 5.0.0 retired list").not.toBeNull();
  return new Set(
    match![1]
      .split(",")
      .map((name) => name.trim().replace(/`/g, ""))
      .filter(Boolean),
  );
}

describe("setup phases drift enforcement (issue #3871)", () => {
  const skills = shippedSkills();
  const retired = retiredNames();

  it("knows the shipped and retired sets are non-trivial and disjoint", () => {
    expect(retired.size).toBeGreaterThanOrEqual(15);
    expect(retired.has("mcp-setup")).toBe(true);
    expect(retired.has("ultrawork")).toBe(true);
    expect(skills.has("mcp-setup")).toBe(false);
    expect(skills.has("ultrawork")).toBe(false);
    expect(skills.has("omc-setup")).toBe(true);
    for (const name of retired) {
      expect(skills.has(name), `retired ${name} must not be shipped`).toBe(false);
    }
  });

  it("every referenced /oh-my-copilot:<skill> exists in the shipped plugin", () => {
    for (const file of PHASE_FILES) {
      const content = readPhase(file);
      const referenced = [...content.matchAll(/\/oh-my-copilot:([a-z0-9-]+)/g)].map(
        (m) => m[1],
      );
      for (const name of referenced) {
        expect(
          skills.has(name),
          `${file} references /oh-my-copilot:${name}, but the plugin does not ship a skill with that name`,
        ).toBe(true);
      }
    }
  });

  it("no setup phase references a 5.0.0-retired skill name as an invocation target", () => {
    for (const file of PHASE_FILES) {
      const content = readPhase(file);
      // An invocation-shaped reference is any of:
      //   /oh-my-copilot:<name>   <name>: <task>   "invoke the <name> skill"
      // Plain-prose retirement notices (a dedicated block listing removed
      // names, or a "removed in 5.0.0" sentence) are allowed — users and the
      // setup agent must still be told what no longer exists.
      const stripped = content
        .replace(/RETIRED IN 5\.0\.0[\s\S]*?(?=\n[A-Z#]|\n```|$)/g, "")
        .replace(/[^.\n]*removed in 5\.0\.0[^.\n]*\.?/gi, "");
      for (const name of retired) {
        const invocationPatterns = [
          new RegExp(`/oh-my-copilot:${name}\\b`),
          new RegExp(`^#{1,6}.*\\b${name}\\b.*(step|skill|invoke)`, "im"),
          new RegExp(`invoke (?:the )?.{0,20}\\b${name}\\b (?:skill|workflow)`, "i"),
        ];
        for (const pattern of invocationPatterns) {
          expect(
            pattern.test(stripped),
            `${file} treats retired '${name}' as an invocable target`,
          ).toBe(false);
        }
      }
    }
  });

  it("never instructs writing the retired defaultExecutionMode config value", () => {
    for (const file of PHASE_FILES) {
      const content = readPhase(file);
      // Deletion instructions are fine (Step 2.4 clears a stale value);
      // writes/sets are not.
      const writePatterns = [
        /jq[^|]*--arg\s+mode[^|]*defaultExecutionMode/,
        /defaultExecutionMode:\s*["']?\$\{?USER_CHOICE/,
        /\. \{defaultExecutionMode/,
      ];
      for (const pattern of writePatterns) {
        expect(
          pattern.test(content),
          `${file} instructs writing defaultExecutionMode (removed in 5.0.0)`,
        ).toBe(false);
      }
      // If the key appears at all, it must only be in a del/clear context.
      for (const line of content.split("\n")) {
        if (line.includes("defaultExecutionMode") && /[a-z]{2,}\s*["']?defaultExecutionMode/.test(line)) {
          const isClearing = /del\(|del\s|Clear|clear|retired|Retired|grep -q/.test(line);
          expect(
            isClearing,
            `${file} mentions defaultExecutionMode outside a clearing context: ${line.trim()}`,
          ).toBe(true);
        }
      }
    }
  });

  it("executes cleanup for tilde paths and preserves the original when the write fails", () => {
    const phase = readPhase("02-configure.md");
    const snippet = phase.match(/## Step 2\.4:[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
    expect(snippet, "Step 2.4 must keep an executable cleanup snippet").toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), "setup-drift-cleanup-"));
    const original = JSON.stringify({ silentAutoUpdate: false, defaultExecutionMode: "ultrawork" }, null, 2) + "\n";
    try {
      const config = join(root, ".omc-config.json");
      writeFileSync(config, original);
      execFileSync("bash", ["-c", snippet!], { env: { ...process.env, COPILOT_CONFIG_DIR: root } });
      const cleaned = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
      expect(cleaned).toEqual({ silentAutoUpdate: false });

      const tildeConfigDir = join(root, "nested");
      const tildeConfig = join(tildeConfigDir, ".omc-config.json");
      mkdirSync(tildeConfigDir, { recursive: true });
      writeFileSync(tildeConfig, original);
      // os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
      execFileSync("bash", ["-c", snippet!], {
        env: { ...process.env, HOME: root, USERPROFILE: root, COPILOT_CONFIG_DIR: "~/nested" },
      });
      expect(JSON.parse(readFileSync(tildeConfig, "utf8"))).toEqual({ silentAutoUpdate: false });
      writeFileSync(tildeConfig, original);
      execFileSync("bash", ["-c", snippet!], {
        env: { ...process.env, HOME: root, USERPROFILE: root, COPILOT_CONFIG_DIR: "~\\nested" },
      });
      expect(JSON.parse(readFileSync(tildeConfig, "utf8"))).toEqual({ silentAutoUpdate: false });

      const malformed = "{ \"defaultExecutionMode\":";
      writeFileSync(config, malformed);
      execFileSync("bash", ["-c", snippet!], {
        env: { ...process.env, COPILOT_CONFIG_DIR: root },
        stdio: "ignore",
      });
      expect(readFileSync(config, "utf8")).toBe(malformed);

      // The snippet writes a sibling temp file and renames it, so the failure
      // has to be injected where it actually writes. Stubbing `mv` on PATH was
      // inert once the jq|mv pipeline became fs.renameSync: the cleanup simply
      // succeeded and the "original preserved" assertion was never exercised.
      // A read-only directory is the injection, but root and Windows both
      // ignore the bits, so prove the denial holds before asserting on it.
      const denied = join(root, "denied");
      const deniedConfig = join(denied, ".omc-config.json");
      mkdirSync(denied, { recursive: true });
      writeFileSync(deniedConfig, original);
      chmodSync(denied, 0o500);
      let denialEnforced = false;
      try {
        writeFileSync(join(denied, ".probe"), "x");
        rmSync(join(denied, ".probe"), { force: true });
      } catch {
        denialEnforced = true;
      }
      try {
        if (denialEnforced) {
          execFileSync("bash", ["-c", snippet!], {
            env: { ...process.env, COPILOT_CONFIG_DIR: denied },
            stdio: "ignore",
          });
          expect(readFileSync(deniedConfig, "utf8")).toBe(original);
          expect(readdirSync(denied).filter((entry) => entry.includes(".tmp.")).length).toBe(0);
        }
      } finally {
        chmodSync(denied, 0o700);
      }

      // Success path leaves no temp residue behind either.
      writeFileSync(config, original);
      execFileSync("bash", ["-c", snippet!], {
        env: { ...process.env, COPILOT_CONFIG_DIR: root },
        stdio: "ignore",
      });
      expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ silentAutoUpdate: false });
      expect(readdirSync(root).filter((entry) => entry.includes(".tmp.")).length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes the resume boundary without changing the original progress marker", () => {
    const phase = readPhase("02-configure.md");
    const snippet = phase.match(/## Resume Boundary[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
    expect(snippet, "Phase 2 must keep an executable resume-boundary snippet").toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), "setup-drift-resume-"));
    try {
      mkdirSync(join(root, ".omg", "state"), { recursive: true });
      writeFileSync(join(root, ".omg", "state", "setup-state.json"), JSON.stringify({ lastCompletedStep: 7 }));
      // The snippet reports the boundary as KEY=value lines on stdout for the
      // setup agent to read; it does not export shell variables of its own.
      const boundaryVars = () => {
        const out = execFileSync("bash", ["-c", snippet!], { cwd: root, encoding: "utf-8" });
        return Object.fromEntries(
          out.trim().split(/\r?\n/).filter(Boolean).map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1)];
          }),
        ) as Record<string, string>;
      };

      const resumed = boundaryVars();
      expect(resumed.RESUMED_PHASE_TWO_BOUNDARY).toBe("true");
      expect(resumed.RESUME_LAST_COMPLETED_STEP).toBe("7");

      writeFileSync(join(root, ".omg", "state", "setup-state.json"), JSON.stringify({ lastCompletedStep: 2 }));
      const fresh = boundaryVars();
      expect(fresh.RESUMED_PHASE_TWO_BOUNDARY).toBe("false");
      expect(fresh.RESUME_LAST_COMPLETED_STEP).toBe("2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the installed plan and review skill names in the welcome text", () => {
    const welcome = readPhase("04-welcome.md");
    expect(welcome).toContain("/oh-my-copilot:omc-plan");
    expect(welcome).toContain("/oh-my-copilot:omc-review");
    expect(welcome).not.toContain("/oh-my-copilot:plan");
    expect(welcome).not.toContain("/oh-my-copilot:review");
  });

  it("delegates the team config write instead of normalizing the path inline", () => {
    // The phase used to build $CONFIG_FILE with its own shell path normalizer,
    // which is where the backslash-tilde bug lived. It now hands the patch to
    // MERGE_JSON_FILE, so the guard is that no inline path building comes back.
    const phase = readPhase("03-integrations.md");
    const section = phase.match(/Store the team configuration[\s\S]*?(?=\n#{1,4} )/)?.[0];
    expect(section, "team config section must remain present").toBeTruthy();
    expect(section).toMatch(/MERGE_JSON_FILE/);
    expect(section).toMatch(/\.omc-config\.json/);
    expect(section, "team config must not rebuild the config path inline").not.toMatch(/CONFIG_FILE=/);
    expect(section, "team config must not expand ~ inline").not.toMatch(/COPILOT_CONFIG_DIR[^\n]*HOME/);
  });
});
