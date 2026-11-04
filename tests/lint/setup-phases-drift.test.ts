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
 *  - every `/<skill>` reference in the setup phases must
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

import { execFileSync, spawnSync } from "child_process";
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
// The phase snippets run `node "<plugin-root>/scripts/setup-config.mjs" <subcommand>`, and the
// setup agent writes the resolved root in literally, so substitute this checkout the same way.
function withPluginRoot(snippet: string): string {
  return snippet.split("<plugin-root>").join(REPO_ROOT.replace(/\\/g, "/"));
}

/** A standalone `/<name>` slash reference (not a path segment). */
const SLASH_REFERENCE = /(?<![\w./:~-])\/([a-z][a-z0-9-]*)(?![\w/.:-])/g;

/** Drops the retirement notices, which name removed skills on purpose. */
function stripRetirementNotices(content: string): string {
  return content
    .replace(/^#{1,6} Retired in 5\.0\.0[^\n]*\n[\s\S]*?(?=\n#{1,6} |$(?![\s\S]))/gim, "")
    .replace(/RETIRED IN 5\.0\.0[\s\S]*?(?=\n[A-Z#]|\n```|$)/g, "")
    .replace(/[^.\n]*removed in 5\.0\.0[^.\n]*\.?/gi, "");
}

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

  it("every referenced /<skill> exists in the shipped plugin", () => {
    for (const file of PHASE_FILES) {
      const content = stripRetirementNotices(readPhase(file));
      const referenced = [...content.matchAll(SLASH_REFERENCE)].map(
        (m) => m[1],
      );
      for (const name of referenced) {
        expect(
          skills.has(name),
          `${file} references /${name}, but the plugin does not ship a skill with that name`,
        ).toBe(true);
      }
    }
  });

  it("no setup phase references a 5.0.0-retired skill name as an invocation target", () => {
    for (const file of PHASE_FILES) {
      const content = readPhase(file);
      // An invocation-shaped reference is any of:
      //   /<name>   <name>: <task>   "invoke the <name> skill"
      // Plain-prose retirement notices (a dedicated block listing removed
      // names, or a "removed in 5.0.0" sentence) are allowed — users and the
      // setup agent must still be told what no longer exists.
      const stripped = stripRetirementNotices(content);
      for (const name of retired) {
        const invocationPatterns = [
          new RegExp(`(?<![\\w./:~-])/(?:oh-my-copilot:)?${name}\\b`),
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
      execFileSync("bash", ["-c", withPluginRoot(snippet!)], { env: { ...process.env, COPILOT_HOME: root } });
      const cleaned = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
      expect(cleaned).toEqual({ silentAutoUpdate: false });

      const tildeConfigDir = join(root, "nested");
      const tildeConfig = join(tildeConfigDir, ".omc-config.json");
      mkdirSync(tildeConfigDir, { recursive: true });
      writeFileSync(tildeConfig, original);
      // os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
      execFileSync("bash", ["-c", withPluginRoot(snippet!)], {
        env: { ...process.env, HOME: root, USERPROFILE: root, COPILOT_HOME: "~/nested" },
      });
      expect(JSON.parse(readFileSync(tildeConfig, "utf8"))).toEqual({ silentAutoUpdate: false });
      writeFileSync(tildeConfig, original);
      execFileSync("bash", ["-c", withPluginRoot(snippet!)], {
        env: { ...process.env, HOME: root, USERPROFILE: root, COPILOT_HOME: "~\\nested" },
      });
      expect(JSON.parse(readFileSync(tildeConfig, "utf8"))).toEqual({ silentAutoUpdate: false });

      const malformed = "{ \"defaultExecutionMode\":";
      writeFileSync(config, malformed);
      execFileSync("bash", ["-c", withPluginRoot(snippet!)], {
        env: { ...process.env, COPILOT_HOME: root },
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
          execFileSync("bash", ["-c", withPluginRoot(snippet!)], {
            env: { ...process.env, COPILOT_HOME: denied },
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
      execFileSync("bash", ["-c", withPluginRoot(snippet!)], {
        env: { ...process.env, COPILOT_HOME: root },
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
        const out = execFileSync("bash", ["-c", withPluginRoot(snippet!)], { cwd: root, encoding: "utf-8", env: { ...process.env } });
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

  // withPluginRoot() normalizes to forward slashes; a Windows agent running PowerShell writes the
  // native backslash root into the same snippet, so prove that spelling resolves identically.
  const pwshAvailable = process.platform === "win32" && spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
  const pwshTest = process.platform === "win32" ? (pwshAvailable ? it : it.skip) : it.skip;
  pwshTest(`executes the resume boundary with the native backslash plugin root through pwsh (win32 only; skipped when pwsh is missing: ${pwshAvailable ? "pwsh found" : "pwsh NOT found"})`, () => {
    const phase = readPhase("02-configure.md");
    const snippet = phase.match(/## Resume Boundary[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
    expect(snippet, "Phase 2 must keep an executable resume-boundary snippet").toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), "setup-drift-pwsh-"));
    try {
      mkdirSync(join(root, ".omg", "state"), { recursive: true });
      writeFileSync(join(root, ".omg", "state", "setup-state.json"), JSON.stringify({ lastCompletedStep: 7 }));
      const command = snippet!.split("<plugin-root>").join(REPO_ROOT);
      expect(command).toContain(REPO_ROOT);
      const out = execFileSync("pwsh", ["-NoProfile", "-Command", command], { cwd: root, encoding: "utf-8", env: { ...process.env } });
      expect(out).toContain("RESUMED_PHASE_TWO_BOUNDARY=true");
      expect(out).toContain("RESUME_LAST_COMPLETED_STEP=7");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the installed plan and review skill names in the welcome text", () => {
    const welcome = readPhase("04-welcome.md");
    // Copilot CLI registers plugin skills by bare name; bare /plan and /review are its own commands.
    expect(welcome).toContain("/omc-plan");
    expect(welcome).toContain("/omc-review");
    expect(welcome).not.toMatch(/(?<![\w-])\/(?:oh-my-copilot:)?(?:plan|review)\b/);
  });

  it("carries no Claude Code-only team or MCP setup", () => {
    // The fork path-renamed upstream's Claude Code steps, so Copilot users were
    // asked to set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS and teammateMode, which
    // Copilot CLI ignores, and were pointed at `claude mcp add`.
    const claudeOnly = [
      /CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/,
      /teammateMode/,
      /\bclaude mcp\b/,
      /CLAUDE_MCP_CONFIG_PATH/,
      /\.claude\.json/,
      /TeamCreate|TeamDelete/,
      /Claude Code's (?:implicit agent team|native MCP)/,
    ];
    const skillMd = readFileSync(join(REPO_ROOT, "skills", "omc-setup", "SKILL.md"), "utf-8");
    const targets: Array<[string, string]> = [
      ["SKILL.md", skillMd],
      ...PHASE_FILES.map((file): [string, string] => [file, readPhase(file)]),
    ];
    for (const [file, content] of targets) {
      for (const pattern of claudeOnly) {
        expect(pattern.test(content), `${file} carries Claude Code-only ${pattern}`).toBe(false);
      }
    }
  });

  it("points Phase 3 at Copilot CLI MCP registration and keeps its progress contract", () => {
    const phase = readPhase("03-integrations.md");
    expect(phase).toContain("copilot mcp add");
    expect(phase).toContain("mcp-config.json");
    expect(phase).toMatch(/\*\*Skip condition\*\*: If resuming and `lastCompletedStep >= 6`/);
    expect(phase).toMatch(/scripts\/setup-progress\.mjs" save 6\n/);
    // Teams need no setting on Copilot: the phase must not write one.
    expect(phase).not.toMatch(/merge-json|MERGE_JSON_FILE|AskUserQuestion/);
  });

  it("locates scripts through a literal <plugin-root>, never a shell fallback expansion", () => {
    // `${A:-${B}}` is bash-only: PowerShell, Copilot CLI's shell on Windows, rejects it as a
    // parse error, and nothing exports OMC_SETUP_PLUGIN_ROOT, so it expanded to "/scripts/...".
    const skillMd = readFileSync(join(REPO_ROOT, "skills", "omc-setup", "SKILL.md"), "utf-8");
    const targets: Array<[string, string]> = [
      ["SKILL.md", skillMd],
      ...PHASE_FILES.map((file): [string, string] => [file, readPhase(file)]),
    ];
    for (const [file, content] of targets) {
      expect(content, `${file} uses a nested shell fallback expansion`).not.toMatch(/\$\{\w+:-\$\{?\w/);
      expect(content, `${file} names OMC_SETUP_PLUGIN_ROOT`).not.toContain("OMC_SETUP_PLUGIN_ROOT");
      expect(content, `${file} uses the bash-only COPILOT_HOME fallback notation`).not.toContain("${COPILOT_HOME:-");
      for (const match of content.matchAll(/node\s+"([^"]*)\/scripts\//g)) {
        expect(match[1], `${file} runs a script outside <plugin-root>`).toBe("<plugin-root>");
      }
      for (const match of content.matchAll(/([^\s`"]*)\/skills\/omc-setup\/phases\//g)) {
        expect(match[1], `${file} reads a phase outside <plugin-root>`).toBe("<plugin-root>");
      }
    }
    // The resolution step the placeholder depends on, with its stop message.
    expect(skillMd).toMatch(/## Plugin Root[\s\S]*Base directory for this skill[\s\S]*scripts\/setup-config\.mjs` exists[\s\S]*copilot plugin marketplace add RobinNorberg\/oh-my-copilot/);
  });
});
