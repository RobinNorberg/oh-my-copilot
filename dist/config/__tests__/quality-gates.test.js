import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { getAdvisoryGatesForStage, getBlockingGatesForStage, normalizeGate, readQualityGatesConfig, readValidatedQualityGates, resolveQualityGateSkillPath, validateSkillName, } from "../quality-gates.js";
describe("quality gates", () => {
    let tempDir;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "omc-quality-gates-"));
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it("defaults omitted mode to advisory and preserves an explicit blocking mode", () => {
        expect(normalizeGate({ skill: "requirements-check" })).toEqual({
            skill: "requirements-check",
            mode: "advisory",
        });
        expect(normalizeGate({ skill: "security-check", mode: "blocking" })).toEqual({
            skill: "security-check",
            mode: "blocking",
        });
    });
    it("rejects malformed and retired skill names with replacement hints", () => {
        expect(validateSkillName("bad_name").valid).toBe(false);
        expect(validateSkillName("learner")).toMatchObject({
            valid: false,
            error: expect.stringContaining("remember"),
        });
        expect(validateSkillName("swarm")).toMatchObject({
            valid: false,
            error: expect.stringContaining("team"),
        });
        expect(validateSkillName("project-audit").valid).toBe(true);
        expect(validateSkillName("constructor").valid).toBe(true);
    });
    it("rejects workflow-controller skills as gates on their matching stages", () => {
        for (const skill of ["deep-interview", "ralplan", "omc-review"]) {
            const { gates, errors } = readValidatedQualityGates(skill, {
                qualityGates: { [skill]: [skill] },
            });
            expect(gates).toEqual([]);
            expect(errors).toEqual([
                expect.objectContaining({
                    stage: skill,
                    skillIndex: 0,
                    error: `Workflow-controller skill '${skill}' is reserved and cannot be configured as a quality gate for stage '${skill}'`,
                }),
            ]);
        }
    });
    it("rejects dollar-prefixed workflow-controller aliases across stages", () => {
        const crossStageCases = [
            ["deep-interview", "ralplan"],
            ["ralplan", "omc-review"],
            ["omc-review", "deep-interview"],
        ];
        for (const [skill, stage] of crossStageCases) {
            const { gates, errors } = readValidatedQualityGates(stage, {
                qualityGates: { [stage]: [`$${skill}`] },
            });
            expect(gates).toEqual([]);
            expect(errors).toEqual([
                expect.objectContaining({
                    stage,
                    skillIndex: 0,
                    error: `Workflow-controller skill '${skill}' is reserved and cannot be configured as a quality gate for stage '${stage}'`,
                }),
            ]);
        }
    });
    it("rejects workflow-controller skills in object-form gate entries, including dollar-prefixed aliases", () => {
        const objectCases = [
            ["ralplan", "ralplan", { skill: "ralplan", mode: "blocking" }],
            ["omc-review", "ralplan", { skill: "$omc-review", mode: "advisory" }],
            ["deep-interview", "omc-review", { skill: "$deep-interview", model: "sonnet" }],
        ];
        for (const [skill, stage, entry] of objectCases) {
            const { gates, errors } = readValidatedQualityGates(stage, {
                qualityGates: { [stage]: [entry, { skill: "security-check", mode: "blocking" }] },
            });
            expect(gates).toEqual([{ skill: "security-check", mode: "blocking" }]);
            expect(errors).toEqual([
                expect.objectContaining({
                    stage,
                    skillIndex: 0,
                    error: `Workflow-controller skill '${skill}' is reserved and cannot be configured as a quality gate for stage '${stage}'`,
                }),
            ]);
        }
    });
    it("reports legacy stage keys with their exact replacement and does not accept them", () => {
        const config = {
            qualityGates: {
                "code-review": [{ skill: "old-review-gate" }],
                interview: [],
                plan: [],
                codeReview: [],
            },
        };
        const { gates, errors } = readValidatedQualityGates("omc-review", config);
        expect(gates).toEqual([]);
        expect(errors.map(({ stage, error }) => [stage, error])).toEqual([
            [
                "code-review",
                "Legacy stage key 'code-review' is not accepted; use 'omc-review'",
            ],
            [
                "interview",
                "Legacy stage key 'interview' is not accepted; use 'deep-interview'",
            ],
            ["plan", "Legacy stage key 'plan' is not accepted; use 'ralplan'"],
            [
                "codeReview",
                "Legacy stage key 'codeReview' is not accepted; use 'omc-review'",
            ],
        ]);
    });
    it("reads user and project quality gates through the merged PluginConfig loader", () => {
        const project = join(tempDir, "project");
        const xdgConfig = join(tempDir, "xdg");
        const userConfigPath = join(xdgConfig, "claude-omc", "config.jsonc");
        mkdirSync(join(project, ".copilot"), { recursive: true });
        mkdirSync(join(xdgConfig, "claude-omc"), { recursive: true });
        writeFileSync(userConfigPath, JSON.stringify({
            qualityGates: {
                "deep-interview": [{ skill: "user-interview-check" }],
                ralplan: [{ skill: "user-plan-check" }],
            },
        }));
        writeFileSync(join(project, ".copilot", "omg.jsonc"), JSON.stringify({
            qualityGates: {
                ralplan: [{ skill: "project-plan-check", mode: "blocking" }],
            },
        }));
        const loaderUrl = pathToFileURL(resolve("src/config/loader.ts")).href;
        const tsxLoader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
        const script = `import { loadConfig } from ${JSON.stringify(loaderUrl)}; process.stdout.write(JSON.stringify(loadConfig().qualityGates));`;
        const mergedConfig = JSON.parse(execFileSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", script], {
            cwd: project,
            encoding: "utf8",
            // getConfigDir() reads APPDATA instead of XDG_CONFIG_HOME on win32.
            env: { ...process.env, XDG_CONFIG_HOME: xdgConfig, APPDATA: xdgConfig },
        }));
        expect(readQualityGatesConfig({ qualityGates: mergedConfig })).toMatchObject({
            "deep-interview": [{ skill: "user-interview-check" }],
            ralplan: [{ skill: "project-plan-check", mode: "blocking" }],
        });
        expect(readValidatedQualityGates("deep-interview", {
            qualityGates: mergedConfig,
        }).gates).toEqual([{ skill: "user-interview-check", mode: "advisory" }]);
        expect(readValidatedQualityGates("ralplan", {
            qualityGates: mergedConfig,
        }).gates).toEqual([{ skill: "project-plan-check", mode: "blocking" }]);
    });
    it("resolves project (.copilot then .claude), OMC project, compatibility, user, plugin, and bundled skill roots in order", () => {
        const project = join(tempDir, "project");
        const userConfig = join(tempDir, "user-config");
        const omcRoot = join(tempDir, "omc-root");
        const bundled = join(tempDir, "bundled");
        const pluginRoot = join(tempDir, "plugin");
        const options = {
            cwd: project,
            userConfigDir: userConfig,
            omcRoot,
            bundledSkillsDir: bundled,
            pluginRoot,
        };
        const roots = [
            join(project, ".copilot", "skills"),
            join(project, ".claude", "skills"),
            join(omcRoot, "skills"),
            join(project, ".agents", "skills"),
            join(userConfig, "skills"),
            join(pluginRoot, "skills"),
            bundled,
            join(project, "skills"),
        ];
        const createSkill = (root, name) => {
            const path = join(root, name, "SKILL.md");
            mkdirSync(join(root, name), { recursive: true });
            writeFileSync(path, `---\nname: ${name}\n---\n`);
            return path;
        };
        const projectPath = createSkill(roots[0], "project-check");
        const claudeFallbackPath = createSkill(roots[1], "claude-check");
        // The same name in both project roots resolves to .copilot/skills.
        createSkill(roots[1], "project-check");
        const omcPath = createSkill(roots[2], "omc-check");
        const compatibilityPath = createSkill(roots[3], "compat-check");
        const userPath = createSkill(roots[4], "user-check");
        const pluginPath = createSkill(roots[5], "plugin-check");
        const bundledPath = createSkill(roots[6], "bundled-check");
        const cwdPath = createSkill(roots[7], "cwd-check");
        expect(resolveQualityGateSkillPath("project-check", options)).toBe(projectPath);
        expect(resolveQualityGateSkillPath("claude-check", options)).toBe(claudeFallbackPath);
        expect(resolveQualityGateSkillPath("omc-check", options)).toBe(omcPath);
        expect(resolveQualityGateSkillPath("compat-check", options)).toBe(compatibilityPath);
        expect(resolveQualityGateSkillPath("user-check", options)).toBe(userPath);
        expect(resolveQualityGateSkillPath("plugin-check", options)).toBe(pluginPath);
        expect(resolveQualityGateSkillPath("bundled-check", options)).toBe(bundledPath);
        expect(resolveQualityGateSkillPath("cwd-check", options)).toBe(cwdPath);
        expect(resolveQualityGateSkillPath("missing-check", options)).toBeNull();
    });
    it("uses PLUGIN_ROOT for the plugin skill root ahead of CLAUDE_PLUGIN_ROOT", () => {
        const pluginRoot = join(tempDir, "copilot-plugin");
        const skillPath = join(pluginRoot, "skills", "plugin-check", "SKILL.md");
        mkdirSync(join(pluginRoot, "skills", "plugin-check"), { recursive: true });
        writeFileSync(skillPath, "---\nname: plugin-check\n---\n");
        vi.stubEnv("PLUGIN_ROOT", pluginRoot);
        vi.stubEnv("CLAUDE_PLUGIN_ROOT", join(tempDir, "claude-plugin"));
        try {
            expect(resolveQualityGateSkillPath("plugin-check", {
                cwd: join(tempDir, "project"),
                userConfigDir: join(tempDir, "user-config"),
                omcRoot: join(tempDir, "omc-root"),
                bundledSkillsDir: join(tempDir, "bundled"),
            })).toBe(skillPath);
        }
        finally {
            vi.unstubAllEnvs();
        }
    });
    it("resolves OMC bundled names that differ from their skill directory names", () => {
        const path = resolveQualityGateSkillPath("omc-review", {
            cwd: tempDir,
            userConfigDir: join(tempDir, "user"),
            omcRoot: join(tempDir, "omc"),
            pluginRoot: null,
        });
        expect(path).toMatch(/skills[\\/]review[\\/]SKILL\.md$/);
    });
    it("filters gates by mode after normalization", () => {
        const config = {
            qualityGates: {
                ralplan: [
                    "advisory-check",
                    { skill: "blocking-check", mode: "blocking" },
                ],
            },
        };
        expect(getAdvisoryGatesForStage("ralplan", config)).toEqual([
            { skill: "advisory-check", mode: "advisory" },
        ]);
        expect(getBlockingGatesForStage("ralplan", config)).toEqual([
            { skill: "blocking-check", mode: "blocking" },
        ]);
    });
});
//# sourceMappingURL=quality-gates.test.js.map