import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  findLegacyProjectConfigs,
  getCanonicalProjectConfigPath,
  resolveProjectConfigPath,
} from "../project-config-path.js";
import { getConfigPaths, loadConfig } from "../loader.js";
import { clearSecurityConfigCache, getSecurityConfig } from "../../lib/security-config.js";

function writeConfig(root: string, dir: string, file: string, value: unknown): string {
  mkdirSync(join(root, dir), { recursive: true });
  const path = join(root, dir, file);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("project config path (.copilot/omg.jsonc)", () => {
  let project: string;
  let userConfigHome: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "omg-project-config-"));
    // Isolate from the real user config (~/.config/claude-omc/config.jsonc).
    userConfigHome = mkdtempSync(join(tmpdir(), "omg-user-config-"));
    vi.stubEnv("XDG_CONFIG_HOME", userConfigHome);
    vi.stubEnv("APPDATA", userConfigHome);
    vi.stubEnv("OMC_SECURITY", "");
    clearSecurityConfigCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    clearSecurityConfigCache();
    rmSync(project, { recursive: true, force: true });
    rmSync(userConfigHome, { recursive: true, force: true });
  });

  describe("resolveProjectConfigPath", () => {
    it("returns the canonical path when no config exists", () => {
      expect(resolveProjectConfigPath(project)).toBe(join(project, ".copilot", "omg.jsonc"));
      expect(getCanonicalProjectConfigPath(project)).toBe(join(project, ".copilot", "omg.jsonc"));
    });

    it("falls back to the legacy .copilot/omc.jsonc", () => {
      const legacy = writeConfig(project, ".copilot", "omc.jsonc", {});
      expect(resolveProjectConfigPath(project)).toBe(legacy);
    });

    it("prefers the canonical file when both exist", () => {
      writeConfig(project, ".copilot", "omc.jsonc", {});
      const canonical = writeConfig(project, ".copilot", "omg.jsonc", {});
      expect(resolveProjectConfigPath(project)).toBe(canonical);
    });

    it("does not read the upstream .claude/omc.jsonc", () => {
      writeConfig(project, ".claude", "omc.jsonc", {});
      expect(resolveProjectConfigPath(project)).toBe(join(project, ".copilot", "omg.jsonc"));
    });
  });

  describe("loadConfig", () => {
    it("reads the legacy file when the canonical one is absent", () => {
      writeConfig(project, ".copilot", "omc.jsonc", { planOutput: { directory: "legacy/plans" } });
      process.chdir(project);
      expect(getConfigPaths().project).toBe(resolveProjectConfigPath(process.cwd()));
      expect(loadConfig().planOutput?.directory).toBe("legacy/plans");
    });

    it("uses only the canonical file when both exist (no merge)", () => {
      writeConfig(project, ".copilot", "omc.jsonc", {
        planOutput: { directory: "legacy/plans", filenameTemplate: "legacy-{{name}}.md" },
      });
      writeConfig(project, ".copilot", "omg.jsonc", { planOutput: { directory: "canonical/plans" } });
      process.chdir(project);
      const config = loadConfig();
      expect(config.planOutput?.directory).toBe("canonical/plans");
      // The legacy file's other keys must not leak in.
      expect(config.planOutput?.filenameTemplate).toBe("{{name}}.md");
    });
  });

  describe("security config", () => {
    it("reads the security section from the legacy file as a fallback", () => {
      writeConfig(project, ".copilot", "omc.jsonc", { security: { restrictToolPaths: true } });
      process.chdir(project);
      expect(getSecurityConfig().restrictToolPaths).toBe(true);
    });

    it("prefers the canonical file's security section", () => {
      writeConfig(project, ".copilot", "omc.jsonc", { security: { restrictToolPaths: true } });
      writeConfig(project, ".copilot", "omg.jsonc", { security: { restrictToolPaths: false } });
      process.chdir(project);
      expect(getSecurityConfig().restrictToolPaths).toBe(false);
    });
  });

  describe("findLegacyProjectConfigs", () => {
    it("reports nothing for a canonical-only project", () => {
      writeConfig(project, ".copilot", "omg.jsonc", {});
      expect(findLegacyProjectConfigs(project)).toEqual([]);
    });

    it("gives the rename command for .copilot/omc.jsonc", () => {
      const legacy = writeConfig(project, ".copilot", "omc.jsonc", {});
      expect(findLegacyProjectConfigs(project)).toEqual([
        {
          legacyPath: legacy,
          canonicalPath: join(project, ".copilot", "omg.jsonc"),
          canonicalExists: false,
          renameCommand: 'mv ".copilot/omc.jsonc" ".copilot/omg.jsonc"',
        },
      ]);
    });

    it("creates .copilot first when moving the upstream .claude/omc.jsonc", () => {
      writeConfig(project, ".claude", "omc.jsonc", {});
      const [only] = findLegacyProjectConfigs(project);
      expect(only.renameCommand).toBe('mkdir -p ".copilot" && mv ".claude/omc.jsonc" ".copilot/omg.jsonc"');
    });

    it("reports a legacy file next to the canonical one as ignored, without a rename", () => {
      writeConfig(project, ".copilot", "omg.jsonc", {});
      writeConfig(project, ".copilot", "omc.jsonc", {});
      const [only] = findLegacyProjectConfigs(project);
      expect(only.canonicalExists).toBe(true);
      expect(only.renameCommand).toBeNull();
    });

    it("renames only the higher-precedence legacy file", () => {
      writeConfig(project, ".copilot", "omc.jsonc", {});
      writeConfig(project, ".claude", "omc.jsonc", {});
      const found = findLegacyProjectConfigs(project);
      expect(found.map((entry) => entry.renameCommand)).toEqual([
        'mv ".copilot/omc.jsonc" ".copilot/omg.jsonc"',
        null,
      ]);
    });
  });
});
