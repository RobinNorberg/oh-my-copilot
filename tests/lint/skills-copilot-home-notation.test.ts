/**
 * Doc-lint: skills and commands must not use the bash-only `${COPILOT_HOME:-...}` notation.
 * Copilot CLI's shell on Windows is PowerShell, which cannot parse it, so a model that pastes
 * it into a command fails. Say "COPILOT_HOME if set, else `~/.copilot`" (or `<copilot-home>`).
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");

// Justified exceptions: file -> reason. Each is a statusLine command written into settings.json,
// which the host executes through bash, not a command the model runs in its own shell.
const ALLOWED: Record<string, string> = {
  "skills/hud/SKILL.md": "statusLine command in settings.json is executed by the host through bash",
};

describe("COPILOT_HOME fallback notation in skills and commands", () => {
  it("does not appear outside the host-gated allow-list", () => {
    const files = execFileSync("git", ["ls-files", "--", "skills", "commands"], { cwd: REPO_ROOT, encoding: "utf-8" })
      .split("\n")
      .filter(Boolean);
    const offenders: string[] = [];
    for (const file of files) {
      if (file in ALLOWED) continue;
      if (readFileSync(join(REPO_ROOT, file), "utf-8").includes("${COPILOT_HOME:-")) offenders.push(file);
    }
    expect(offenders, "bash-only ${COPILOT_HOME:-...} notation").toEqual([]);
  });

  it("allow-listed files only use it inside a settings.json statusLine command", () => {
    for (const file of Object.keys(ALLOWED)) {
      const lines = readFileSync(join(REPO_ROOT, file), "utf-8").split("\n");
      for (const line of lines.filter((l) => l.includes("${COPILOT_HOME:-"))) {
        expect(line, `${file}: ${ALLOWED[file]}`).toMatch(/^\s*"command": "node \$\{COPILOT_HOME:-\$HOME\/\.copilot\}\/hud\/omg-hud\.mjs"$/);
      }
    }
  });
});
